import { createServerFn } from "@tanstack/react-start";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import {
  cleanMobile, earlyLeaveMinutes, geofenceRefusal, indiaDate, indiaTime, lateMinutes, locationVerdict, selfiePath, staffLoginEmail,
  staffPasswordProblem,
} from "@/lib/attendance";

/*
 * Godown employee attendance (rules in src/lib/attendance.ts, tables in migrations
 * 20261031120000_staff_attendance and 20261101090000_attendance_v2). The server, not the phone,
 * decides the time, the distance from the godown and late / early minutes; it alone touches the
 * private selfie bucket and checks that the photo comes from the godown's registered device.
 */

const BUCKET = "attendance-selfies";
const MAX_SELFIE_BYTES = 1_500_000;
const DEVICE_CODE_MINUTES = 15;
/** No two presence photos within this many minutes. */
const PRESENCE_MIN_GAP_MIN = 20;

function serviceClient() {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!url || !key) throw new Error("Server configuration is missing the Supabase service settings");
  return createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
type Db = ReturnType<typeof serviceClient>;

async function ensureAdmin(supabase: SupabaseClient<Database>, userId: string) {
  const { data, error } = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (error || !data) throw new Error("Administrator access is required");
}

async function sha256(text: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 8 characters without look-alikes (no 0/O, 1/I/L). */
function randomCode() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

const passwordSchema = z.string().superRefine((value, ctx) => {
  const problem = staffPasswordProblem(value);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});

/** A staff-only login (mobile number + password) for an employee; returns the new auth user id. */
async function createStaffLogin(db: Db, mobile: string, name: string, password: string) {
  const { data: made, error } = await db.auth.admin.createUser({
    email: staffLoginEmail(mobile),
    password,
    email_confirm: true,
    user_metadata: { full_name: name, phone: `+91${mobile}`, account_type: "godown_staff" },
  });
  if (error || !made.user) {
    throw new Error(/already been registered|already exists/i.test(error?.message ?? "")
      ? "A staff login for this mobile number already exists."
      : `The login could not be created: ${error?.message ?? "unknown error"}`);
  }
  // New accounts start as customers; a staff login is only a staff login.
  await db.from("user_roles").delete().eq("user_id", made.user.id).eq("role", "customer");
  return made.user.id;
}

/**
 * Adds a godown employee with their own staff login: they sign in at /staff with their mobile
 * number and the password head office sets here. The record can't be edited afterwards.
 */
export const addStaffEmployee = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({
    branchId: z.string().trim().min(1),
    name: z.string().trim().min(2).max(80),
    phone: z.string().trim().max(20),
    designation: z.string().trim().max(60).default(""),
    password: passwordSchema,
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
    const userId = await createStaffLogin(db, phone, data.name, data.password);
    const { data: employee, error: insertError } = await db.from("staff_employees").insert({
      user_id: userId, branch_id: branch.id, name: data.name, phone, designation: data.designation, created_by: context.userId,
      login_email: staffLoginEmail(phone),
    }).select("id").single();
    if (insertError || !employee) {
      await db.auth.admin.deleteUser(userId);
      throw new Error("The employee could not be saved; nothing was created. Try again.");
    }
    return { employeeId: employee.id, godown: branch.name, phone };
  });

/** Sets a new password for an employee (head office shares it with them); gives older records a staff login. */
export const setStaffPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ employeeId: z.string().uuid(), password: passwordSchema }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = serviceClient();
    const { data: employee } = await db.from("staff_employees").select("id,user_id,name,phone,login_email").eq("id", data.employeeId).maybeSingle();
    if (!employee) throw new Error("Employee not found");
    if (!employee.login_email) {
      // Added before password logins (signed in with an SMS code on a shared customer account).
      const userId = await createStaffLogin(db, employee.phone, employee.name, data.password);
      const { error } = await db.from("staff_employees").update({ user_id: userId, login_email: staffLoginEmail(employee.phone), updated_at: new Date().toISOString() }).eq("id", employee.id);
      if (error) {
        await db.auth.admin.deleteUser(userId);
        throw new Error("The password could not be set. Try again.");
      }
      return { ok: true };
    }
    const { error } = await db.auth.admin.updateUserById(employee.user_id, { password: data.password });
    if (error) throw new Error(`The password could not be changed: ${error.message}`);
    return { ok: true };
  });

/* ------------------------------------------------------------------ godown devices */

/** Head office: a one-time code (15 minutes) to register a godown's attendance phone or tablet. */
export const createDeviceCode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ branchId: z.string().trim().min(1), label: z.string().trim().max(60).default("") }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = serviceClient();
    const { data: branch } = await db.from("branches").select("id,name,vendor_id").eq("id", data.branchId).maybeSingle();
    if (!branch || branch.vendor_id) throw new Error("Godown not found");
    const code = randomCode();
    const expiresAt = new Date(Date.now() + DEVICE_CODE_MINUTES * 60_000).toISOString();
    const { error } = await db.from("godown_device_codes").insert({
      code_hash: await sha256(code), branch_id: branch.id, label: data.label || `${branch.name} attendance device`, created_by: context.userId, expires_at: expiresAt,
    });
    if (error) throw new Error("The code could not be made. Try again.");
    return { code, expiresAt, godown: branch.name };
  });

/** On the godown's device: exchanges the one-time code for the device's own secret token. */
export const registerGodownDevice = createServerFn({ method: "POST" })
  .validator(z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{8}$/, "Enter the 8-character code") }))
  .handler(async ({ data }) => {
    const db = serviceClient();
    const codeHash = await sha256(data.code);
    const { data: entry } = await db.from("godown_device_codes").select("code_hash,branch_id,label,expires_at,used_at").eq("code_hash", codeHash).maybeSingle();
    if (!entry || entry.used_at || Date.parse(entry.expires_at) < Date.now()) throw new Error("This code is wrong, used or expired. Ask head office for a new code.");
    const token = randomToken();
    const { data: device, error } = await db.from("godown_devices").insert({ branch_id: entry.branch_id, label: entry.label, token_hash: await sha256(token) }).select("id").single();
    if (error || !device) throw new Error("The device could not be registered. Try again.");
    const { data: claimed } = await db.from("godown_device_codes").update({ used_at: new Date().toISOString(), device_id: device.id })
      .eq("code_hash", codeHash).is("used_at", null).select("code_hash");
    if (!claimed?.length) {
      await db.from("godown_devices").delete().eq("id", device.id);
      throw new Error("This code was just used. Ask head office for a new code.");
    }
    const { data: branch } = await db.from("branches").select("name").eq("id", entry.branch_id).maybeSingle();
    return { token, branchId: entry.branch_id, godown: branch?.name ?? entry.branch_id, label: entry.label };
  });

/** Which godown this device belongs to (for the staff app's banner); null when unknown or removed. */
export const describeGodownDevice = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string().min(20).max(100) }))
  .handler(async ({ data }) => {
    const db = serviceClient();
    const { data: device } = await db.from("godown_devices").select("id,branch_id,label,active").eq("token_hash", await sha256(data.token)).maybeSingle();
    if (!device?.active) return null;
    const { data: branch } = await db.from("branches").select("name").eq("id", device.branch_id).maybeSingle();
    return { branchId: device.branch_id, godown: branch?.name ?? device.branch_id, label: device.label };
  });

/** Head office: removes a device (lost, replaced); it can no longer mark attendance. */
export const revokeGodownDevice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ deviceId: z.string().uuid() }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const { error } = await serviceClient().from("godown_devices").update({ active: false, revoked_at: new Date().toISOString() }).eq("id", data.deviceId);
    if (error) throw new Error("The device could not be removed");
    return { ok: true };
  });

/** The registered, active device of the employee's own godown, or a clear refusal. */
async function godownDevice(db: Db, token: string, branchId: string) {
  if (!token) throw new Error("Use your godown's attendance device. This phone is not registered for attendance.");
  const { data: device } = await db.from("godown_devices").select("id,branch_id,active").eq("token_hash", await sha256(token)).maybeSingle();
  if (!device?.active) throw new Error("This device is not registered for attendance (or was removed). Ask head office for a device code.");
  if (device.branch_id !== branchId) {
    const { data: other } = await db.from("branches").select("name").eq("id", device.branch_id).maybeSingle();
    throw new Error(`This device belongs to ${other?.name ?? "another godown"}. Use your own godown's attendance device.`);
  }
  await db.from("godown_devices").update({ last_seen_at: new Date().toISOString() }).eq("id", device.id);
  return device.id;
}

/* ------------------------------------------------------------------ marking attendance */

const selfieSchema = z.string().max(2_100_000).regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/, "The selfie must be a JPEG photo");
const positionSchema = {
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(100_000),
  selfie: selfieSchema,
  deviceToken: z.string().max(100).default(""),
};

function decodeSelfie(dataUrl: string) {
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  if (bytes.length < 2_000 || bytes.length > MAX_SELFIE_BYTES) throw new Error("The selfie photo is not valid. Take it again.");
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new Error("The selfie must be a JPEG photo");
  return bytes;
}

async function uploadSelfie(db: Db, path: string, dataUrl: string) {
  const upload = await db.storage.from(BUCKET).upload(path, decodeSelfie(dataUrl), { contentType: "image/jpeg", upsert: false });
  if (upload.error) throw new Error("The selfie could not be saved. Check your internet and try again.");
}

/** The signed-in active employee and their godown's rules. */
async function employeeAndGodown(db: Db, userId: string) {
  const { data: employee } = await db.from("staff_employees").select("id,branch_id,status").eq("user_id", userId).maybeSingle();
  if (!employee || employee.status !== "active") throw new Error("Only active godown employees can mark attendance");
  const { data: branch } = await db.from("branches")
    .select("latitude,longitude,attendance_radius_m,shift_start,shift_end,late_grace_min,presence_interval_min").eq("id", employee.branch_id).maybeSingle();
  if (!branch) throw new Error("Your godown was not found. Contact the office.");
  return { employee, branch };
}

/**
 * Check-in or check-out with a live selfie from the godown's registered device. Refused outside the
 * godown's radius (or with GPS too rough to tell); no approval step. Late and early-leave minutes
 * are worked out from the godown's shift.
 */
export const markAttendance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ kind: z.enum(["in", "out"]), note: z.string().max(300).default(""), ...positionSchema }))
  .handler(async ({ data, context }) => {
    const db = serviceClient();
    const { employee, branch } = await employeeAndGodown(db, context.userId);
    const deviceId = await godownDevice(db, data.deviceToken, employee.branch_id);
    const { verdict, distanceM } = locationVerdict(
      { latitude: branch.latitude, longitude: branch.longitude, radiusM: branch.attendance_radius_m },
      { lat: data.lat, lng: data.lng, accuracyM: data.accuracy },
    );
    const refusal = geofenceRefusal(verdict, distanceM, branch.attendance_radius_m);
    if (refusal) throw new Error(refusal);

    const now = Date.now();
    const workDate = indiaDate(now);
    const { data: day } = await db.from("attendance_days").select("id,check_out_at,employee_note")
      .eq("employee_id", employee.id).eq("work_date", workDate).maybeSingle();
    const note = data.note.trim();

    if (data.kind === "in") {
      if (day) throw new Error("Attendance is already marked for today");
      const late = lateMinutes(now, branch.shift_start, branch.late_grace_min);
      const path = selfiePath(employee.branch_id, workDate, employee.id, "in", now);
      await uploadSelfie(db, path, data.selfie);
      const { error } = await db.from("attendance_days").insert({
        employee_id: employee.id, branch_id: employee.branch_id, work_date: workDate, check_in_at: new Date(now).toISOString(),
        in_lat: data.lat, in_lng: data.lng, in_accuracy_m: Math.round(data.accuracy * 10) / 10, in_distance_m: distanceM,
        in_selfie: path, late_minutes: late, flags: late > 0 ? ["late"] : [], employee_note: note, status: "present", in_device_id: deviceId,
      });
      if (error) {
        await db.storage.from(BUCKET).remove([path]);
        throw new Error(/duplicate|unique/i.test(error.message) ? "Attendance is already marked for today" : "Attendance could not be saved. Try again.");
      }
      return { kind: "in" as const, at: new Date(now).toISOString(), lateMinutes: late, earlyMinutes: 0, distanceM };
    }

    if (!day) throw new Error("Mark your check-in first");
    if (day.check_out_at) throw new Error("You have already checked out today");
    const early = earlyLeaveMinutes(now, branch.shift_end);
    const path = selfiePath(employee.branch_id, workDate, employee.id, "out", now);
    await uploadSelfie(db, path, data.selfie);
    const { data: updated, error } = await db.from("attendance_days").update({
      check_out_at: new Date(now).toISOString(), out_lat: data.lat, out_lng: data.lng,
      out_accuracy_m: Math.round(data.accuracy * 10) / 10, out_distance_m: distanceM, out_inside: true, out_selfie: path,
      early_leave_minutes: early, out_device_id: deviceId,
      ...(note ? { employee_note: `${day.employee_note ? `${day.employee_note} · ` : ""}Check-out: ${note}` } : {}),
      updated_at: new Date(now).toISOString(),
    }).eq("id", day.id).is("check_out_at", null).select("id");
    if (error || !updated?.length) {
      await db.storage.from(BUCKET).remove([path]);
      throw new Error("Check-out could not be saved. Try again.");
    }
    return { kind: "out" as const, at: new Date(now).toISOString(), lateMinutes: 0, earlyMinutes: early, distanceM };
  });

/**
 * A presence photo while checked in: live selfie + GPS from the godown's device, due every N minutes
 * (the godown's presence interval). Recorded with the distance from the godown and whether it was
 * inside, so head office sees where each one was taken.
 */
export const markPresence = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object(positionSchema))
  .handler(async ({ data, context }) => {
    const db = serviceClient();
    const { employee, branch } = await employeeAndGodown(db, context.userId);
    if (!branch.presence_interval_min) throw new Error("Presence photos are switched off for your godown");
    const deviceId = await godownDevice(db, data.deviceToken, employee.branch_id);
    const now = Date.now();
    const { data: day } = await db.from("attendance_days").select("id,check_out_at")
      .eq("employee_id", employee.id).eq("work_date", indiaDate(now)).maybeSingle();
    if (!day) throw new Error("Mark your check-in first");
    if (day.check_out_at) throw new Error("You have already checked out today");
    const { data: last } = await db.from("attendance_presence").select("taken_at").eq("attendance_day_id", day.id)
      .order("taken_at", { ascending: false }).limit(1).maybeSingle();
    if (last && now - Date.parse(last.taken_at) < PRESENCE_MIN_GAP_MIN * 60_000) {
      throw new Error(`A presence photo was sent at ${indiaTime(last.taken_at)}. Send the next one when it is due.`);
    }
    const { verdict, distanceM } = locationVerdict(
      { latitude: branch.latitude, longitude: branch.longitude, radiusM: branch.attendance_radius_m },
      { lat: data.lat, lng: data.lng, accuracyM: data.accuracy },
    );
    const path = selfiePath(employee.branch_id, indiaDate(now), employee.id, "presence", now);
    await uploadSelfie(db, path, data.selfie);
    const { error } = await db.from("attendance_presence").insert({
      attendance_day_id: day.id, employee_id: employee.id, branch_id: employee.branch_id, taken_at: new Date(now).toISOString(),
      lat: data.lat, lng: data.lng, accuracy_m: Math.round(data.accuracy * 10) / 10, distance_m: distanceM, inside: verdict === "inside",
      selfie: path, device_id: deviceId,
    });
    if (error) {
      await db.storage.from(BUCKET).remove([path]);
      throw new Error("The presence photo could not be saved. Try again.");
    }
    return { at: new Date(now).toISOString(), inside: verdict === "inside", distanceM };
  });

export type DaySelfies = { in?: string; out?: string; presence: { id: string; url: string; takenAt: string; inside: boolean; distanceM: number | null }[] };

/**
 * Short-lived links to the selfies (check-in, check-out, presence) of attendance days the caller may
 * see. The caller's own database access decides which days those are (admin: all; partner: their
 * godown; employee: own).
 */
export const attendanceSelfieUrls = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ ids: z.array(z.string().uuid()).min(1).max(300) }))
  .handler(async ({ data, context }) => {
    const [days, photos] = await Promise.all([
      context.supabase.from("attendance_days").select("id,in_selfie,out_selfie").in("id", data.ids),
      context.supabase.from("attendance_presence").select("id,attendance_day_id,selfie,taken_at,inside,distance_m").in("attendance_day_id", data.ids).order("taken_at"),
    ]);
    if (days.error) throw new Error("Could not load the selfies");
    const paths = [
      ...(days.data ?? []).flatMap((row) => [row.in_selfie, row.out_selfie].filter((path): path is string => Boolean(path))),
      ...(photos.data ?? []).map((row) => row.selfie),
    ];
    const result: Record<string, DaySelfies> = {};
    if (!paths.length) return result;
    const { data: signed } = await serviceClient().storage.from(BUCKET).createSignedUrls(paths, 3600);
    const urlOf = new Map((signed ?? []).map((item) => [item.path, item.signedUrl]));
    for (const row of days.data ?? []) {
      const inUrl = urlOf.get(row.in_selfie);
      const outUrl = row.out_selfie ? urlOf.get(row.out_selfie) : undefined;
      result[row.id] = { ...(inUrl ? { in: inUrl } : {}), ...(outUrl ? { out: outUrl } : {}), presence: [] };
    }
    for (const row of photos.data ?? []) {
      const url = urlOf.get(row.selfie);
      if (url && result[row.attendance_day_id]) {
        result[row.attendance_day_id]!.presence.push({ id: row.id, url, takenAt: row.taken_at, inside: row.inside, distanceM: row.distance_m });
      }
    }
    return result;
  });
