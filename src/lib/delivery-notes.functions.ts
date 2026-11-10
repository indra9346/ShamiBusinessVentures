import { createServerFn } from "@tanstack/react-start";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database, Json } from "@/integrations/supabase/types";
import type {
  DeliveryGate, DeliveryNote, DeliveryNoteEvent, DeliveryNoteView, DeliveryPrintRecord, DeliveryRegisterRow,
} from "@/lib/delivery-notes";
import { PAPER_CODE, type DeliveryHandoverRow, type DeliveryScanRow, type PaperHandover, type PaperScan } from "@/lib/delivery-papers";

/*
 * Delivery notes, admin only. Generate, Print and Check again read Zoho Books now (read-only) and hand
 * that reading to the database, which decides: see private.delivery_note_gate. Just opening a page uses
 * what the website last read, which adds no Zoho call and cannot generate anything. The database functions
 * accept a Zoho reading, so only this server may call them. Nothing here writes to Zoho or changes an order.
 */

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

/** The name written on the record: what the admin is called, else their email. Never empty. */
async function actorName(db: ReturnType<typeof serviceClient>, userId: string) {
  const { data } = await db.from("profiles").select("full_name,email").eq("id", userId).maybeSingle();
  return data?.full_name?.trim() || data?.email?.trim() || `Admin ${userId.slice(0, 8)}`;
}

async function zohoReading(orderNo: string) {
  const { readOrderInvoiceFacts } = await import("@/lib/zoho-commerce.functions");
  return readOrderInvoiceFacts(orderNo);
}

async function loadView(db: ReturnType<typeof serviceClient>, orderNo: string, zoho: Json | null): Promise<DeliveryNoteView> {
  const { data: state, error } = await db.rpc("delivery_note_check", { _order_no: orderNo, _zoho: zoho });
  if (error || !state) throw new Error("Could not check the order's payment");
  const { data: note, error: noteError } = await db.from("delivery_notes").select("*").eq("order_no", orderNo).maybeSingle();
  if (noteError) throw new Error("Could not read the delivery note");
  let events: DeliveryNoteEvent[] = [];
  let handovers: DeliveryHandoverRow[] = [];
  let scans: DeliveryScanRow[] = [];
  let qrReady = true;
  if (note) {
    const [eventRead, handoverRead, scanRead] = await Promise.all([
      db.from("delivery_note_events")
        .select("id,kind,doc,slip_line,copy_no,gate_code,detail,actor_name,occurred_at")
        .eq("note_id", note.id).order("id", { ascending: false }).limit(200),
      db.from("delivery_handovers")
        .select("id,slip_line,actor_name,actor_role,branch_name,gate_code,gate_source,handed_over_at")
        .eq("note_id", note.id).order("slip_line"),
      db.from("delivery_scans")
        .select("id,action,result,doc,slip_line,copy_no,lines,gate_code,gate_source,actor_name,actor_role,branch_name,code_hint,occurred_at")
        .eq("note_id", note.id).order("id", { ascending: false }).limit(100),
    ]);
    if (eventRead.error) throw new Error("Could not read the delivery note's history");
    for (const read of [handoverRead, scanRead]) {
      if (!read.error) continue;
      // Code uploaded before the QR migration: the note still shows, and printing refuses (see recordDeliveryPrint).
      if (missingTable(read.error)) qrReady = false;
      else throw new Error("Could not read the delivery note's scans");
    }
    events = (eventRead.data ?? []) as DeliveryNoteEvent[];
    handovers = (handoverRead.data ?? []) as DeliveryHandoverRow[];
    scans = (scanRead.data ?? []) as DeliveryScanRow[];
  }
  return {
    checkedAt: new Date().toISOString(),
    fresh: zoho !== null,
    state: state as unknown as DeliveryGate,
    note: note ? { ...note, seq: Number(note.seq), invoice_total: Number(note.invoice_total), order_total: Number(note.order_total), paid_amount: Number(note.paid_amount) } as unknown as DeliveryNote : null,
    events,
    handovers,
    scans,
    qrReady,
  };
}

/** PostgREST's answer for a table that isn't there: the QR migration hasn't been applied. */
const missingTable = (error: { code?: string; message?: string }) =>
  error.code === "PGRST205" || error.code === "42P01" || /does not exist|could not find the table/i.test(error.message ?? "");

const QR_NOT_READY = "Printing is paused: the database doesn't have the delivery-slip QR update yet, so the papers would have no QR code. Nothing was recorded. Ask your developer to apply it.";

const orderInput = z.object({ orderNo: z.string().trim().min(1).max(80) });

/** The order's payment check and its delivery note if it has one. Zoho is read only when asked (fresh). */
export const getDeliveryNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(orderInput.extend({ fresh: z.boolean() }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    return loadView(serviceClient(), data.orderNo, data.fresh ? await zohoReading(data.orderNo) as unknown as Json : null);
  });

/** The office stops or lifts delivery on an order, with a reason. */
export const setDeliveryStop = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(orderInput.extend({ stopped: z.boolean(), reason: z.string().trim().min(3).max(300) }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = serviceClient();
    const { error } = await db.rpc("set_delivery_stop", {
      _order_no: data.orderNo, _stopped: data.stopped, _reason: data.reason, _actor: context.userId, _actor_name: await actorName(db, context.userId),
    });
    if (error) throw new Error(error.message);
    return loadView(db, data.orderNo, null);
  });

/** Generates the order's one delivery note if the database allows it now. Pressed twice, it returns the same note. */
export const generateDeliveryNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(orderInput)
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = serviceClient();
    const zoho = await zohoReading(data.orderNo) as unknown as Json;
    const { data: result, error } = await db.rpc("issue_delivery_note", {
      _order_no: data.orderNo, _zoho: zoho, _actor: context.userId, _actor_name: await actorName(db, context.userId),
    });
    if (error || !result) throw new Error(error?.message ?? "Could not generate the delivery note");
    return { issued: (result as { issued?: boolean }).issued === true, view: await loadView(db, data.orderNo, zoho) };
  });

const printInput = orderInput.extend({
  note: z.boolean(),
  slipLines: z.array(z.number().int().min(1).max(10_000)).max(500),
});

/**
 * One press of Print: checks the payment again, records who printed what, and returns the time and copy
 * numbers that go on the paper.
 */
export const recordDeliveryPrint = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(printInput)
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = serviceClient();
    const { data: note, error: noteError } = await db.from("delivery_notes").select("id").eq("order_no", data.orderNo).maybeSingle();
    if (noteError || !note) throw new Error("This order has no delivery note yet");
    // Before anything is recorded: a copy counted with no QR on its paper could never be checked at the godown.
    const { error: qrProbe } = await db.from("delivery_handovers").select("id").limit(1);
    if (qrProbe) throw new Error(missingTable(qrProbe) ? QR_NOT_READY : "Could not check the QR codes; nothing was printed");
    const zoho = await zohoReading(data.orderNo) as unknown as Json;
    const { data: result, error } = await db.rpc("record_delivery_print", {
      _note_id: note.id, _note: data.note, _slip_lines: data.slipLines, _zoho: zoho, _actor: context.userId, _actor_name: await actorName(db, context.userId),
    });
    if (error || !result) throw new Error(error?.message ?? "Could not record the print");
    const printed = result as {
      printed_at: string; note_copy: number | null; slip_copies: Record<string, number>;
      note_code: string | null; slip_codes: Record<string, string>; handovers: Record<string, PaperHandover>;
    };
    const record: DeliveryPrintRecord = {
      printedAt: printed.printed_at, noteCopy: printed.note_copy, slipCopies: printed.slip_copies ?? {},
      noteCode: printed.note_code ?? null, slipCodes: printed.slip_codes ?? {}, handovers: printed.handovers ?? {},
    };
    // Every paper printed must carry its code; a paper without one could not be checked at the godown.
    const missing = (data.note && !record.noteCode) || data.slipLines.some((line) => !record.slipCodes[String(line)]);
    if (missing) throw new Error("The print was recorded but its QR codes are missing. Do not print; tell your developer.");
    return { record, view: await loadView(db, data.orderNo, zoho) };
  });

/** An administrator, or an active godown employee: the people who may scan a delivery paper. */
async function ensureScanner(db: ReturnType<typeof serviceClient>, userId: string) {
  const [{ data: role }, { data: employee }] = await Promise.all([
    db.from("user_roles").select("role").eq("user_id", userId).eq("role", "admin").maybeSingle(),
    db.from("staff_employees").select("status").eq("user_id", userId).maybeSingle(),
  ]);
  if (!role && employee?.status !== "active") throw new Error("Only godown staff and administrators can check delivery papers. Sign in with your staff or admin account.");
}

/**
 * One scan of a delivery note's or slip's QR. handover false only checks; true records the handover if the paper may
 * be used now, and reads Zoho Books first (read-only). The database decides and keeps the scan: see
 * public.delivery_paper_scan. Green comes only from a recorded handover, and only once per item line.
 */
export const scanDeliveryPaper = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ code: z.string().trim().min(1).max(200), handover: z.boolean() }))
  .handler(async ({ data, context }) => {
    const db = serviceClient();
    await ensureScanner(db, context.userId);
    let zoho: Json | null = null;
    if (data.handover && PAPER_CODE.test(data.code)) {
      const { data: orderNo } = await db.rpc("delivery_paper_order_no", { _code: data.code });
      // When Zoho can't be read, the database uses the website's last reading and the handover says so.
      if (orderNo) zoho = await zohoReading(orderNo) as unknown as Json;
    }
    const { data: result, error } = await db.rpc("delivery_paper_scan", { _code: data.code, _handover: data.handover, _zoho: zoho, _actor: context.userId });
    if (error || !result) throw new Error(error?.message ?? "Could not check the paper");
    return result as unknown as PaperScan;
  });

/** Admin > Delivery Notes: the latest scans of every paper, including codes the system never made. */
export const listDeliveryScans = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = serviceClient();
    const { data: rows, error } = await db.from("delivery_scans")
      .select("id,note_id,action,result,doc,slip_line,copy_no,lines,gate_code,gate_source,actor_name,actor_role,branch_name,code_hint,occurred_at")
      .order("id", { ascending: false }).limit(200);
    if (error) throw new Error("Could not read the scans");
    const noteIds = [...new Set((rows ?? []).map((row) => row.note_id).filter((id): id is string => Boolean(id)))];
    const { data: notes, error: noteError } = noteIds.length
      ? await db.from("delivery_notes").select("id,note_no,order_no").in("id", noteIds)
      : { data: [], error: null };
    if (noteError) throw new Error("Could not read the scans");
    const byId = new Map((notes ?? []).map((note) => [note.id, note]));
    return (rows ?? []).map(({ note_id, ...row }) => ({
      ...row, note_no: note_id ? byId.get(note_id)?.note_no ?? null : null, order_no: note_id ? byId.get(note_id)?.order_no ?? null : null,
    })) as DeliveryScanRow[];
  });

/** Admin > Delivery Notes: every note, flagged from what the website last knew of Zoho. */
export const listDeliveryNotes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const { data, error } = await serviceClient().rpc("delivery_note_register", {});
    if (error) throw new Error("Could not read the delivery notes");
    return (data ?? []) as unknown as DeliveryRegisterRow[];
  });
