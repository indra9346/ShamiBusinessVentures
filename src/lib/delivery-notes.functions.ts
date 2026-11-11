import { createServerFn } from "@tanstack/react-start";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database, Json } from "@/integrations/supabase/types";
import type {
  DeliveryGate, DeliveryNote, DeliveryNoteEvent, DeliveryNoteView, DeliveryPrintRecord, DeliveryRegisterRow,
} from "@/lib/delivery-notes";
import {
  PAPER_CODE, type DeliveryHandoverRow, type DeliveryPaperRow, type DeliveryReopenRow, type DeliveryScanRow, type InvoiceScan, type PaperHandover,
  type PaperPrint, type PaperScan, type ReleasePrint,
} from "@/lib/delivery-papers";

/*
 * Delivery notes, admin only, and the godown's QR scans (admins, the godown in-charge, godown staff and channel
 * partners). Generate, Print, Check again and a handover read Zoho Books now (read-only) and hand that reading to
 * the database, which decides: see private.delivery_note_gate, public.delivery_invoice_scan and
 * public.delivery_paper_scan. Just opening a page uses what the website last read, which adds no Zoho call and cannot
 * generate anything. The database functions accept a Zoho reading, so only this server may call them. The one order
 * change here: a handover of the last item marks the order Delivered in the database, and this server then sends that
 * to Zoho like an admin's change.
 *
 * 12 Nov 2026 (owner, 11 Nov): the QR is on the customer's invoice, the note is released automatically once the
 * payment is confirmed in full (raiseDeliveryNoteAutomatically, called by the Zoho sync), and its papers carry no QR.
 * Papers printed before then keep working through the paper scan.
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
  let reopens: DeliveryReopenRow[] = [];
  let papers: DeliveryPaperRow[] = [];
  let scans: DeliveryScanRow[] = [];
  let qrReady = true;
  if (note) {
    const [eventRead, handoverRead, reopenRead, paperRead, scanRead] = await Promise.all([
      db.from("delivery_note_events")
        .select("id,kind,doc,slip_line,copy_no,gate_code,detail,actor_name,occurred_at")
        .eq("note_id", note.id).order("id", { ascending: false }).limit(200),
      db.from("delivery_handovers")
        .select("id,slip_line,round,actor_name,actor_role,actor_phone,branch_name,device_registered,device_label,gate_code,gate_source,handed_over_at")
        .eq("note_id", note.id).order("slip_line").order("round"),
      db.from("delivery_handover_reopens")
        .select("id,handover_id,slip_line,reason,actor_name,reopened_at")
        .eq("note_id", note.id).order("id"),
      db.from("delivery_paper_codes")
        .select("id,print_event_id,doc,slip_line,copy_no,kind,duplicate_no,reason,printed_by,printed_at")
        .eq("note_id", note.id).order("id"),
      db.from("delivery_scans")
        .select("id,action,result,doc,slip_line,copy_no,paper_kind,duplicate_no,asked,lines,gate_code,gate_source,order_delivered,actor_name,actor_role,branch_name,device_registered,device_label,code_hint,occurred_at")
        .eq("note_id", note.id).order("id", { ascending: false }).limit(100),
    ]);
    if (eventRead.error) throw new Error("Could not read the delivery note's history");
    for (const read of [handoverRead, reopenRead, paperRead, scanRead]) {
      if (!read.error) continue;
      // Code uploaded before the QR migration: the note still shows, and printing refuses (see recordDeliveryPrint).
      if (missingTable(read.error)) qrReady = false;
      else throw new Error("Could not read the delivery note's scans");
    }
    events = (eventRead.data ?? []) as DeliveryNoteEvent[];
    handovers = (handoverRead.data ?? []) as DeliveryHandoverRow[];
    reopens = (reopenRead.data ?? []) as DeliveryReopenRow[];
    papers = (paperRead.data ?? []) as DeliveryPaperRow[];
    scans = (scanRead.data ?? []) as DeliveryScanRow[];
  }
  return {
    checkedAt: new Date().toISOString(),
    fresh: zoho !== null,
    state: state as unknown as DeliveryGate,
    note: note ? { ...note, seq: Number(note.seq), invoice_total: Number(note.invoice_total), order_total: Number(note.order_total), paid_amount: Number(note.paid_amount) } as unknown as DeliveryNote : null,
    events,
    handovers,
    reopens,
    papers,
    scans,
    qrReady,
  };
}

/** PostgREST's answer for a table that isn't there: the QR migration hasn't been applied. */
const missingTable = (error: { code?: string; message?: string }) =>
  error.code === "PGRST205" || error.code === "42P01" || /does not exist|could not find the table/i.test(error.message ?? "");

/** PostgREST's answer for a database function that isn't there: the 12 Nov 2026 invoice QR update isn't applied. */
const missingFunction = (error: { code?: string; message?: string }) =>
  error.code === "PGRST202" || error.code === "42883" || /could not find the function/i.test(error.message ?? "");

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

/**
 * Generates the order's one delivery note if the database allows it now. Pressed twice, it returns the same note.
 * Since 12 Nov 2026 the note is released automatically when the payment is confirmed; this is the office's "Release
 * now" for when that did not happen (Zoho was behind, say).
 */
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
  /** A replacement original for a lost or unprinted one: why. Without it a reprint is a duplicate. */
  replaceReason: z.string().trim().min(3).max(300).optional(),
});

/**
 * One press of Print: checks the payment again, records who printed what, and returns the time, copy numbers, QR
 * codes and paper kinds (original, duplicate n, replacement original) that go on the paper.
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
      _replace_reason: data.replaceReason ?? null,
    });
    if (error || !result) throw new Error(error?.message ?? "Could not record the print");
    const printed = result as {
      printed_at: string; note_copy: number | null; slip_copies: Record<string, number>;
      note_code: string | null; slip_codes: Record<string, string>; handovers: Record<string, PaperHandover>;
      note_paper: PaperPrint | null; slip_papers: Record<string, PaperPrint>;
    };
    const record: DeliveryPrintRecord = {
      printedAt: printed.printed_at, noteCopy: printed.note_copy, slipCopies: printed.slip_copies ?? {},
      noteCode: printed.note_code ?? null, slipCodes: printed.slip_codes ?? {}, handovers: printed.handovers ?? {},
      notePaper: printed.note_paper ?? null, slipPapers: printed.slip_papers ?? {},
    };
    // Every paper printed must carry its code and kind; a paper without them could not be checked at the godown.
    const missing = (data.note && (!record.noteCode || !record.notePaper))
      || data.slipLines.some((line) => !record.slipCodes[String(line)] || !record.slipPapers[String(line)]);
    if (missing) throw new Error("The print was recorded but its QR codes are missing. Do not print; tell your developer.");
    return { record, view: await loadView(db, data.orderNo, zoho) };
  });

/**
 * The office's print or download of a released note and its slips (12 Nov 2026): checks the payment on Zoho read now,
 * records which copy of each paper this is and who printed it, and returns what the papers show. No QR codes: the
 * invoice's QR is the only one that hands goods over. See public.delivery_admin_release_print.
 */
export const printReleasedPapers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(orderInput.extend({
    note: z.boolean(),
    slipLines: z.array(z.number().int().min(1).max(10_000)).max(500),
  }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = serviceClient();
    const zoho = await zohoReading(data.orderNo) as unknown as Json;
    const { data: result, error } = await db.rpc("delivery_admin_release_print", {
      _order_no: data.orderNo, _note: data.note, _slip_lines: data.slipLines, _zoho: zoho, _actor: context.userId,
    });
    if (error || !result) throw new Error(error?.message ?? "Could not record the print");
    const print = result as unknown as ReleasePrint & { gate: DeliveryGate };
    return { print, view: await loadView(db, data.orderNo, zoho) };
  });

/**
 * The delivery note raised without anyone's press (owner, 11 Nov 2026: once the full payment is confirmed and Zoho has
 * the paid invoice). Called by the Zoho sync after the order's Books invoice is made and its payments are on it. Reads
 * Zoho Books now (read-only) and lets the database decide, as the office's Generate does: an order not paid in full,
 * or Zoho behind, gets no note yet, and the godown in-charge's scan or the office releases it later. An order that
 * already has its note costs no Zoho read. Never throws: the Zoho sync must go on whatever happens here.
 */
export async function raiseDeliveryNoteAutomatically(orderNo: string): Promise<{ issued: boolean; noteNo: string | null; gate: string | null }> {
  try {
    const db = serviceClient();
    const { data: existing } = await db.from("delivery_notes").select("note_no").eq("order_no", orderNo).maybeSingle();
    if (existing) return { issued: false, noteNo: existing.note_no, gate: null };
    const zoho = await zohoReading(orderNo) as unknown as Json;
    const { data: result, error } = await db.rpc("issue_delivery_note_auto", { _order_no: orderNo, _zoho: zoho, _how: "auto" });
    if (error || !result) throw new Error(error?.message ?? "no answer from the database");
    const answer = result as { issued?: boolean; note_no?: string | null; gate?: { code?: string } | null };
    if (answer.issued) console.info(JSON.stringify({ source: "delivery-notes", event: "delivery_note_released_automatically", order: orderNo, note: answer.note_no ?? null }));
    return { issued: answer.issued === true, noteNo: answer.note_no ?? null, gate: answer.gate?.code ?? null };
  } catch (cause) {
    console.warn(JSON.stringify({ source: "delivery-notes", event: "delivery_note_auto_failed", order: orderNo, error: cause instanceof Error ? cause.message.slice(0, 300) : String(cause) }));
    return { issued: false, noteNo: null, gate: null };
  }
}

/**
 * An administrator, an active godown employee or an active channel partner: the people who may scan a delivery QR.
 * mayRelease: an administrator or the godown in-charge, whose look at an invoice QR may release its note.
 */
async function ensureScanner(db: ReturnType<typeof serviceClient>, userId: string) {
  const [{ data: role }, { data: employee }, { data: partner }] = await Promise.all([
    db.from("user_roles").select("role").eq("user_id", userId).eq("role", "admin").maybeSingle(),
    db.from("staff_employees").select("status,is_incharge").eq("user_id", userId).maybeSingle(),
    db.from("channel_partners").select("status").eq("user_id", userId).maybeSingle(),
  ]);
  if (!role && employee?.status !== "active" && partner?.status !== "active") {
    throw new Error("Only godown staff, channel partners and administrators can check delivery papers. Sign in with your staff, partner or admin account.");
  }
  return { mayRelease: Boolean(role) || (employee?.status === "active" && employee.is_incharge === true) };
}

/** Whether the order has its delivery note yet. A failed read counts as no note: that only costs a Zoho read. */
async function hasDeliveryNote(db: ReturnType<typeof serviceClient>, orderNo: string) {
  const { data } = await db.from("delivery_notes").select("id").eq("order_no", orderNo).maybeSingle();
  return Boolean(data);
}

const scanInput = z.object({
  code: z.string().trim().min(1).max(200),
  /** check: look. handover: the ticked items (lines). print_note / print_slips: the released note's papers (lines: which slips, all if none). */
  action: z.enum(["check", "handover", "print_note", "print_slips"]).optional(),
  /** What the scan screen sent before 12 Nov 2026: true is a handover. */
  handover: z.boolean().optional(),
  lines: z.array(z.number().int().min(1).max(10_000)).max(500).optional(),
  device: z.string().trim().max(100).optional(),
});

/**
 * One scan of a delivery QR: the QR on a customer's invoice (12 Nov 2026), or a delivery note's or slip's printed
 * before then. The database decides and keeps the scan (public.delivery_invoice_scan, public.delivery_paper_scan).
 * Green comes only from a recorded handover, and only once per item. device is the godown phone's registration token,
 * if this phone has one.
 *
 * An invoice QR: a handover or a print checks the payment on Zoho Books read now (read-only). A look reads Zoho only
 * when it may release the note (the in-charge's or an admin's, while the order has none yet); otherwise the database
 * uses the website's last reading, which never releases one. A print returns what the paper shows; the phone makes the
 * PDF. A printed paper: only a handover reads Zoho, as before.
 *
 * When the handover was the last item, the database marked the order Delivered: that goes to Zoho now, as an admin's
 * change does (and the sync queue has it anyway).
 */
export const scanDeliveryPaper = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(scanInput)
  .handler(async ({ data, context }): Promise<PaperScan | InvoiceScan> => {
    const db = serviceClient();
    const scanner = await ensureScanner(db, context.userId);
    const action = data.action ?? (data.handover ? "handover" : "check");
    let zoho: Json | null = null;
    let orderNo: string | null = null;
    let scan: PaperScan | InvoiceScan;
    const lookup = PAPER_CODE.test(data.code)
      ? await db.rpc("delivery_invoice_order_no", { _code: data.code })
      : { data: null, error: null };
    // A failed lookup must not send a real invoice QR to the printed papers' check, which would call it forged. Only a
    // database without the 12 Nov update (no such function) falls back to the papers.
    if (lookup.error && !missingFunction(lookup.error)) throw new Error("Could not check the QR. Please scan again.");
    const invoiceOrder = lookup.error ? null : lookup.data;
    if (invoiceOrder) {
      orderNo = invoiceOrder;
      const release = action === "check" && scanner.mayRelease && !(await hasDeliveryNote(db, orderNo));
      // When Zoho can't be read, the database uses the website's last reading and the answer says so.
      if (action !== "check" || release) zoho = await zohoReading(orderNo) as unknown as Json;
      const { data: result, error } = await db.rpc("delivery_invoice_scan", {
        _code: data.code, _action: action, _zoho: zoho, _actor: context.userId, _lines: data.lines ?? null, _device: data.device || null,
      });
      if (error || !result) throw new Error(error?.message ?? "Could not check the invoice");
      scan = result as unknown as InvoiceScan;
    } else {
      if (action === "print_note" || action === "print_slips") throw new Error("Only the QR on a customer's invoice prints the released delivery note and slips.");
      const handover = action === "handover";
      if (handover && PAPER_CODE.test(data.code)) {
        ({ data: orderNo } = await db.rpc("delivery_paper_order_no", { _code: data.code }));
        // When Zoho can't be read, the database uses the website's last reading and the handover says so.
        if (orderNo) zoho = await zohoReading(orderNo) as unknown as Json;
      }
      const { data: result, error } = await db.rpc("delivery_paper_scan", {
        _code: data.code, _handover: handover, _zoho: zoho, _actor: context.userId, _lines: data.lines ?? null, _device: data.device || null,
      });
      if (error || !result) throw new Error(error?.message ?? "Could not check the paper");
      scan = result as unknown as PaperScan;
    }
    if (scan.order_delivered && orderNo) {
      const { pushOrderToZohoFromServer } = await import("@/lib/zoho-commerce.functions");
      await pushOrderToZohoFromServer(orderNo, "Website → Zoho: delivered on the godown's QR handover");
    }
    return scan;
  });

/**
 * An administrator reopens a handed-over item, with a reason: its original can hand it over again. The order's
 * status is left alone (Zoho has the delivery too); the answer says whether the order is Delivered, so the admin can
 * correct it if the goods did not go.
 */
export const reopenDeliveryHandover = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(orderInput.extend({ line: z.number().int().min(1).max(10_000), reason: z.string().trim().min(3).max(300) }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = serviceClient();
    const { data: result, error } = await db.rpc("reopen_delivery_handover", {
      _order_no: data.orderNo, _line: data.line, _reason: data.reason, _actor: context.userId, _actor_name: await actorName(db, context.userId),
    });
    if (error || !result) throw new Error(error?.message ?? "Could not reopen the item");
    const reopened = result as { order_status: string; delivered_by_handover: boolean };
    return { orderStatus: reopened.order_status, deliveredByHandover: reopened.delivered_by_handover, view: await loadView(db, data.orderNo, null) };
  });

/** Admin > Delivery Notes: the latest scans of every paper, including codes the system never made. */
export const listDeliveryScans = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = serviceClient();
    // order_no is kept on an invoice QR's scan (12 Nov 2026), so a scan before the note was released still names its order.
    const { data, error } = await db.from("delivery_scans")
      .select("id,note_id,order_no,action,result,doc,slip_line,copy_no,paper_kind,duplicate_no,asked,lines,gate_code,gate_source,order_delivered,actor_name,actor_role,branch_name,device_registered,device_label,code_hint,occurred_at")
      .order("id", { ascending: false }).limit(200);
    if (error) throw new Error("Could not read the scans");
    const rows = (data ?? []) as unknown as Array<Omit<DeliveryScanRow, "note_no" | "order_no"> & { note_id: string | null; order_no: string | null }>;
    const noteIds = [...new Set(rows.map((row) => row.note_id).filter((id): id is string => Boolean(id)))];
    const { data: notes, error: noteError } = noteIds.length
      ? await db.from("delivery_notes").select("id,note_no,order_no").in("id", noteIds)
      : { data: [], error: null };
    if (noteError) throw new Error("Could not read the scans");
    const byId = new Map((notes ?? []).map((note) => [note.id, note]));
    return rows.map(({ note_id, ...row }) => ({
      ...row, note_no: note_id ? byId.get(note_id)?.note_no ?? null : null, order_no: (note_id ? byId.get(note_id)?.order_no : null) ?? row.order_no ?? null,
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
