import { createServerFn } from "@tanstack/react-start";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database, Json } from "@/integrations/supabase/types";
import type {
  DeliveryGate, DeliveryNote, DeliveryNoteEvent, DeliveryNoteView, DeliveryPrintRecord, DeliveryRegisterRow,
} from "@/lib/delivery-notes";

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
  if (note) {
    const { data: rows, error: eventError } = await db.from("delivery_note_events")
      .select("id,kind,doc,slip_line,copy_no,gate_code,detail,actor_name,occurred_at")
      .eq("note_id", note.id).order("id", { ascending: false }).limit(200);
    if (eventError) throw new Error("Could not read the delivery note's history");
    events = (rows ?? []) as DeliveryNoteEvent[];
  }
  return {
    checkedAt: new Date().toISOString(),
    fresh: zoho !== null,
    state: state as unknown as DeliveryGate,
    note: note ? { ...note, seq: Number(note.seq), invoice_total: Number(note.invoice_total), order_total: Number(note.order_total), paid_amount: Number(note.paid_amount) } as unknown as DeliveryNote : null,
    events,
  };
}

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
    const zoho = await zohoReading(data.orderNo) as unknown as Json;
    const { data: result, error } = await db.rpc("record_delivery_print", {
      _note_id: note.id, _note: data.note, _slip_lines: data.slipLines, _zoho: zoho, _actor: context.userId, _actor_name: await actorName(db, context.userId),
    });
    if (error || !result) throw new Error(error?.message ?? "Could not record the print");
    const printed = result as { printed_at: string; note_copy: number | null; slip_copies: Record<string, number> };
    const record: DeliveryPrintRecord = { printedAt: printed.printed_at, noteCopy: printed.note_copy, slipCopies: printed.slip_copies ?? {} };
    return { record, view: await loadView(db, data.orderNo, zoho) };
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
