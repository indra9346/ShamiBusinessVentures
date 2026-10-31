import { createServerFn } from "@tanstack/react-start";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import { checkInFlags, cleanMobile, indiaDate, lateMinutes, locationVerdict, selfiePath } from "@/lib/attendance";

/*
 * Godown employee attendance (rules in src/lib/attendance.ts, tables in migration
 * 20261031120000_staff_attendance). The server, not the phone, decides the time, the distance from
 * the godown and whether the day needs approval, and it alone touches the private selfie bucket.
 */

const BUCKET = "attendance-selfies";
const MAX_SELFIE_BYTES = 1_500_000;

function serviceClient() {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!url || !key) throw new Error("Server configuration is missing the Supabase service settings");
  return createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function ensureAdmin(supabase: SupabaseClient<Database>, userId: string) {
  const { data, error } = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (error || !data) throw new Error("Administrator access is required");
}

/**
 * Adds a godown employee. They sign in at /staff with an SMS code to this mobile: an existing Grain
 * Bazar account on the number is reused (it keeps its customer access); otherwise a staff-only
 * login is created, with no password.
 */
export const addStaffEmployee = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({
    branchId: z.string().trim().min(1),
    name: z.string().trim().min(2).max(80),
    phone: z.string().trim().max(20),
    designation: z.string().trim().max(60).default(""),
  }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const phone = cleanMobile(data.phone);
    if (!phone) throw new Error("Enter the employee's 10-digit mobile number");
    const db = serviceClient();
    const { data: branch } = await db.from("branches").select("id,name,vendor_id").eq("id", data.branchId).maybeSingle();
    if (!branch || branch.vendor_id) throw new Error("Godown not found");
    const { data: existing } = await db.from("staff_employees").select("name,status").eq("phone", phone).maybeSingle();
    if (existing) throw new Error(`This mobile is already registered for ${existing.name}${existing.status === "inactive" ? " (deactivated: reactivate them instead)" : ""}`);

    const { data: linkedId } = await db.rpc("auth_user_id_for_phone", { _phone: phone });
    let userId = linkedId ?? null;
    let created = false;
    if (!userId) {
      const { data: made, error } = await db.auth.admin.createUser({
        phone: `+91${phone}`,
        phone_confirm: true,
        user_metadata: { full_name: data.name, phone: `+91${phone}`, account_type: "godown_staff" },
      });
      if (error || !made.user) throw new Error(`The login could not be created: ${error?.message ?? "unknown error"}`);
      userId = made.user.id;
      created = true;
      // New accounts start as customers; a staff login is only a staff login.
      await db.from("user_roles").delete().eq("user_id", userId).eq("role", "customer");
    }
    const { data: employee, error: insertError } = await db.from("staff_employees").insert({
      user_id: userId, branch_id: branch.id, name: data.name, phone, designation: data.designation, created_by: context.userId,
    }).select("id").single();
    if (insertError || !employee) {
      if (created) await db.auth.admin.deleteUser(userId);
      throw new Error(/duplicate|unique/i.test(insertError?.message ?? "")
        ? "This person is already an employee"
        : "The employee could not be saved; nothing was created. Try again.");
    }
    return { employeeId: employee.id, godown: branch.name, phone, linkedExistingAccount: !created };
  });

const selfieSchema = z.string().max(2_100_000).regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/, "The selfie must be a JPEG photo");

function decodeSelfie(dataUrl: string) {
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  if (bytes.length < 2_000 || bytes.length > MAX_SELFIE_BYTES) throw new Error("The selfie photo is not valid. Take it again.");
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new Error("The selfie must be a JPEG photo");
  return bytes;
}

/**
 * Marks the signed-in employee's check-in or check-out: the phone's position and a live selfie.
 * A check-in that needs approval (outside, GPS too rough, late, godown location not set) needs a
 * reason; without one the answer is { ok: false, needsReason: true } so the phone can ask for it.
 */
export const markAttendance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({
    kind: z.enum(["in", "out"]),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracy: z.number().min(0).max(100_000),
    selfie: selfieSchema,
    note: z.string().max(300).default(""),
  }))
  .handler(async ({ data, context }) => {
    const db = serviceClient();
    const { data: employee } = await db.from("staff_employees").select("id,branch_id,status").eq("user_id", context.userId).maybeSingle();
    if (!employee || employee.status !== "active") throw new Error("Only active godown employees can mark attendance");
    const { data: branch } = await db.from("branches")
      .select("latitude,longitude,attendance_radius_m,shift_start,late_grace_min").eq("id", employee.branch_id).maybeSingle();
    if (!branch) throw new Error("Your godown was not found. Contact the office.");

    const now = Date.now();
    const workDate = indiaDate(now);
    const { verdict, distanceM } = locationVerdict(
      { latitude: branch.latitude, longitude: branch.longitude, radiusM: branch.attendance_radius_m },
      { lat: data.lat, lng: data.lng, accuracyM: data.accuracy },
    );
    const { data: day } = await db.from("attendance_days").select("id,check_in_at,check_out_at,status,employee_note")
      .eq("employee_id", employee.id).eq("work_date", workDate).maybeSingle();
    const note = data.note.trim();

    if (data.kind === "in") {
      if (day) throw new Error("Attendance is already marked for today");
      const late = lateMinutes(now, branch.shift_start, branch.late_grace_min);
      const flags = checkInFlags(verdict, late);
      if (flags.length && note.length < 3) return { ok: false as const, needsReason: true, flags, distanceM, lateMinutes: late };
      const bytes = decodeSelfie(data.selfie);
      const path = selfiePath(employee.branch_id, workDate, employee.id, "in", now);
      const upload = await db.storage.from(BUCKET).upload(path, bytes, { contentType: "image/jpeg", upsert: false });
      if (upload.error) throw new Error("The selfie could not be saved. Check your internet and try again.");
      const { error } = await db.from("attendance_days").insert({
        employee_id: employee.id, branch_id: employee.branch_id, work_date: workDate, check_in_at: new Date(now).toISOString(),
        in_lat: data.lat, in_lng: data.lng, in_accuracy_m: Math.round(data.accuracy * 10) / 10, in_distance_m: distanceM,
        in_selfie: path, late_minutes: late, flags, employee_note: note, status: flags.length ? "pending" : "present",
      });
      if (error) {
        await db.storage.from(BUCKET).remove([path]);
        throw new Error(/duplicate|unique/i.test(error.message) ? "Attendance is already marked for today" : "Attendance could not be saved. Try again.");
      }
      return { ok: true as const, kind: "in" as const, at: new Date(now).toISOString(), status: flags.length ? "pending" : "present", flags, distanceM, lateMinutes: late };
    }

    if (!day) throw new Error("Mark your check-in first");
    if (day.check_out_at) throw new Error("You have already checked out today");
    const bytes = decodeSelfie(data.selfie);
    const path = selfiePath(employee.branch_id, workDate, employee.id, "out", now);
    const upload = await db.storage.from(BUCKET).upload(path, bytes, { contentType: "image/jpeg", upsert: false });
    if (upload.error) throw new Error("The selfie could not be saved. Check your internet and try again.");
    const { data: updated, error } = await db.from("attendance_days").update({
      check_out_at: new Date(now).toISOString(), out_lat: data.lat, out_lng: data.lng,
      out_accuracy_m: Math.round(data.accuracy * 10) / 10, out_distance_m: distanceM, out_inside: verdict === "inside",
      out_selfie: path, ...(note ? { employee_note: `${day.employee_note ? `${day.employee_note} · ` : ""}Check-out: ${note}` } : {}),
      updated_at: new Date(now).toISOString(),
    }).eq("id", day.id).is("check_out_at", null).select("id");
    if (error || !updated?.length) {
      await db.storage.from(BUCKET).remove([path]);
      throw new Error("Check-out could not be saved. Try again.");
    }
    return { ok: true as const, kind: "out" as const, at: new Date(now).toISOString(), status: day.status, flags: [], distanceM, lateMinutes: 0 };
  });

/**
 * Short-lived links to the selfies of attendance days the caller may see. The caller's own
 * database access decides which days those are (admin: all; partner: their godown; employee: own).
 */
export const attendanceSelfieUrls = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ ids: z.array(z.string().uuid()).min(1).max(300) }))
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase.from("attendance_days").select("id,in_selfie,out_selfie").in("id", data.ids);
    if (error) throw new Error("Could not load the selfies");
    const paths = (rows ?? []).flatMap((row) => [row.in_selfie, row.out_selfie].filter((path): path is string => Boolean(path)));
    if (!paths.length) return {} as Record<string, { in?: string; out?: string }>;
    const { data: signed } = await serviceClient().storage.from(BUCKET).createSignedUrls(paths, 3600);
    const urlOf = new Map((signed ?? []).map((item) => [item.path, item.signedUrl]));
    const result: Record<string, { in?: string; out?: string }> = {};
    for (const row of rows ?? []) {
      const inUrl = urlOf.get(row.in_selfie);
      const outUrl = row.out_selfie ? urlOf.get(row.out_selfie) : undefined;
      result[row.id] = { ...(inUrl ? { in: inUrl } : {}), ...(outUrl ? { out: outUrl } : {}) };
    }
    return result;
  });
