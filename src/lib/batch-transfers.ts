/*
 * Moving stock between godowns with Zoho transfer orders (client, 10 Nov 2026):
 *   "When we receive batches, at that time we should enter to which warehouse it is unloaded & same should be updated
 *    to Zoho inventory."  "need feature to make batches from super batch and those batches can be sent for multiple any
 *    intended godowns"
 * Pure rules shared by the server, the Batches screen and the tests: no app imports. The database decides what moves
 * (supabase/migrations/20261110180000_batch_receive_and_split.sql); this file builds what goes to Zoho and reads what
 * comes back.
 */

export type BatchTransferLine = { product_id: string; zoho_item_id: string; name: string; qty: number; unit: string };

/** A transfer as the database returns it (private.batch_transfer_json). */
export type BatchTransfer = {
  id: number;
  transfer_no: string;
  kind: "receive" | "split";
  status: "pending" | "in_transit" | "done" | "cancelled";
  from_branch_id: string | null;
  from_location_id: string;
  from_location_name: string;
  /** The sending godown's name, else the Zoho location's (Head Office). */
  from_name?: string | null;
  to_branch_id: string;
  to_location_id: string;
  to_name: string | null;
  parent_batch_id: string | null;
  parent_batch_code: string | null;
  quantity: number | null;
  bill_number: string | null;
  lines: BatchTransferLine[];
  zoho_transfer_order_id: string;
  zoho_status: string;
  attempts: number;
  last_error: string;
  result: { batch_id: string; batch_code: string; qty?: number; line_id?: string }[] | null;
  created_at: string;
  created_by_name: string;
  /** When it left, and who at the receiving godown marked it received (staff, partner, admin, or Zoho itself). */
  sent_at?: string | null;
  received_at?: string | null;
  received_by_name?: string;
  received_by_role?: "admin" | "staff" | "partner" | "zoho" | null;
  /** When a create last went to Zoho; its answer may have been lost (see createHoldUntil). */
  create_sent_at?: string | null;
  /** Zoho answered "number already exists" but its list did not show it: not cancelled on a guess. */
  zoho_number_taken?: boolean;
  /** A batch sent on: how much left the sending godown's website stock when the send began. */
  reserved?: number | null;
  resumed?: boolean;
  /** Only in claim_batch_transfer's answer: whether this call holds the transfer now. */
  claimed?: boolean;
};

const text = (value: unknown) => (typeof value === "string" ? value : value === null || value === undefined ? "" : String(value));

/**
 * A create whose answer was lost may still be finishing in Zoho, and Zoho's search can take a moment to show it. Until
 * this long after the last create, a transfer Zoho doesn't show yet is neither created again nor cancelled (as the
 * order push waits after an unanswered create).
 */
export const CREATE_HOLD_MINUTES = 10;

/** Until when a transfer with no Zoho transfer order yet must wait (ms since 1970), or 0 when it need not. */
export function createHoldUntil(t: Pick<BatchTransfer, "create_sent_at" | "zoho_transfer_order_id">, now = Date.now()) {
  if (t.zoho_transfer_order_id || !t.create_sent_at) return 0;
  const until = Date.parse(t.create_sent_at) + CREATE_HOLD_MINUTES * 60_000;
  return Number.isFinite(until) && until > now ? until : 0;
}

/** Zoho saying a transfer order does not exist (deleted, or never made), as opposed to an error. */
export function zohoSaysMissing(status: number, body: Record<string, unknown> | null) {
  if (status === 404) return true;
  const code = Number(body?.["code"]);
  return status >= 400 && status < 500 && (code === 1002 || /does not exist|not found|no transfer order/i.test(text(body?.["message"])));
}

/**
 * A transfer as the staff and partner apps get it: what moves, where from and to, and who received it. No bill, costs,
 * supplier, Zoho ids or errors (those are for the office).
 */
export type GodownTransfer = Pick<BatchTransfer,
  "id" | "transfer_no" | "kind" | "status" | "from_branch_id" | "from_location_name" | "from_name" | "to_branch_id" | "to_name"
  | "parent_batch_code" | "quantity" | "lines" | "result" | "created_at" | "created_by_name" | "sent_at" | "received_at"
  | "received_by_name" | "received_by_role">;

/** Lines without anything but what and how many; result without anything but the new batch numbers. */
export function godownTransferLines(lines: unknown): BatchTransferLine[] {
  return (Array.isArray(lines) ? lines : []).map((raw) => {
    const line = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    return { product_id: text(line["product_id"]), zoho_item_id: "", name: text(line["name"]), qty: Number(line["qty"]) || 0, unit: text(line["unit"]) };
  });
}
export function godownTransferResult(result: unknown): BatchTransfer["result"] {
  if (!Array.isArray(result)) return null;
  return result.map((raw) => {
    const made = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    return { batch_id: "", batch_code: text(made["batch_code"]), ...(made["qty"] !== undefined ? { qty: Number(made["qty"]) || 0 } : {}) };
  });
}

/**
 * The transfer order Zoho gets: our number, the two locations, and the units of each item. A batch sent to another
 * godown travels: Zoho holds it in transit until that godown marks it received (owner, 10 Nov 2026). A bill received at
 * the godown where it was unloaded is already there.
 */
export function transferOrderBody(t: Pick<BatchTransfer, "transfer_no" | "kind" | "from_location_id" | "to_location_id" | "lines" | "bill_number" | "parent_batch_code" | "to_name">, date: string) {
  const why = t.kind === "receive"
    ? `Grain Bazar: bill ${t.bill_number ?? ""} unloaded at ${t.to_name ?? "another godown"}`
    : `Grain Bazar: batch ${t.parent_batch_code ?? ""} sent to ${t.to_name ?? "another godown"}`;
  return {
    transfer_order_number: t.transfer_no,
    date,
    description: why.slice(0, 500),
    from_location_id: t.from_location_id,
    to_location_id: t.to_location_id,
    is_intransit_order: t.kind === "split",
    line_items: t.lines.map((line) => ({ item_id: line.zoho_item_id, name: line.name, quantity_transfer: Number(line.qty), unit: line.unit })),
  };
}

/** A Zoho transfer order (create, get or list answer) reduced to what matters here. */
export function readZohoTransfer(raw: unknown): { id: string; number: string; status: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = text(r["transfer_order_id"]);
  return id ? { id, number: text(r["transfer_order_number"]), status: text(r["status"]).toLowerCase() } : null;
}

/** Zoho's list answer for one number: the transfer with exactly that number, if any. */
export function findTransferByNumber(listBody: unknown, number: string) {
  const list = listBody && typeof listBody === "object" ? (listBody as Record<string, unknown>)["transfer_orders"] : null;
  if (!Array.isArray(list)) return null;
  for (const raw of list) {
    const found = readZohoTransfer(raw);
    if (found && found.number.toUpperCase() === number.toUpperCase()) return found;
  }
  return null;
}

/**
 * What a create call's answer means.
 *   created: Zoho made it (its id and status).
 *   exists: Zoho says the number is taken: an earlier try made it, so look it up.
 *   refused: Zoho answered no to this create (nothing made by it). An earlier create may still be in Zoho, so the
 *     number is looked up before the units go back; the wording is never trusted on its own.
 *   unknown: no clear answer (no reply, a server error): it may have been made, so look it up before anything else.
 */
export type CreateAnswer =
  | { kind: "created"; id: string; status: string }
  | { kind: "exists" }
  | { kind: "refused"; message: string }
  | { kind: "unknown"; message: string };

export function readCreateAnswer(status: number, body: Record<string, unknown> | null): CreateAnswer {
  const message = text(body?.["message"]);
  if (status >= 200 && status < 300 && body && Number(body["code"]) === 0) {
    const made = readZohoTransfer(body["transfer_order"]);
    return made ? { kind: "created", id: made.id, status: made.status } : { kind: "unknown", message: "Zoho said yes but returned no transfer order" };
  }
  if (/already exists|already been used|duplicate|is already/i.test(message) && /number/i.test(message)) return { kind: "exists" };
  // 429 is "try later" (nothing done); other 4xx with Zoho's own error code are a definite no.
  if (status === 429) return { kind: "refused", message: message || "Zoho is busy: try again in a minute" };
  if (status >= 400 && status < 500 && body && Number(body["code"]) !== 0) return { kind: "refused", message: message || `Zoho refused the transfer (${status})` };
  return { kind: "unknown", message: message || `Zoho gave no clear answer (${status || "no reply"})` };
}

/** "Received" in Zoho: only then do the units count at the other godown. */
export const isTransferred = (status: string) => status.toLowerCase() === "transferred";

/** Why a plan to send units from a batch can't go ahead, or "" when it can. */
export function splitPlanProblem(available: number, sourceBranchId: string, targets: { branchId: string; qty: number }[]) {
  const chosen = targets.filter((target) => target.branchId || target.qty);
  if (!chosen.length) return "Choose a godown and how many to send";
  const seen = new Set<string>();
  let total = 0;
  for (const target of chosen) {
    if (!target.branchId) return "Choose a godown for every row";
    if (target.branchId === sourceBranchId) return "That is the batch's own godown";
    if (seen.has(target.branchId)) return "Each godown once";
    seen.add(target.branchId);
    if (!(target.qty > 0) || Math.round(target.qty * 100) !== target.qty * 100) return "Enter how many to send (up to 2 decimals)";
    total += target.qty;
  }
  if (Math.round(total * 100) > Math.round(available * 100)) return `Only ${available} left in this batch; ${Math.round(total * 100) / 100} chosen`;
  return "";
}

export const TRANSFER_STATUS_WORDS: Record<BatchTransfer["status"], string> = {
  pending: "Waiting for Zoho",
  in_transit: "On the way",
  done: "Received",
  cancelled: "Cancelled: units back",
};

const ROLE_WORDS: Record<string, string> = { admin: "office", staff: "staff", partner: "channel partner", zoho: "in Zoho" };

const at = (iso: string | null | undefined) => (iso
  ? new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
  : "");

/** Where a transfer stands, said from both ends: when it left, and who received it, where and when. */
export function transferProgress(t: Pick<BatchTransfer, "status" | "kind" | "to_name" | "sent_at" | "received_at" | "received_by_name" | "received_by_role" | "created_by_name">) {
  if (t.status === "in_transit") return `Sent ${at(t.sent_at)}${t.created_by_name ? ` by ${t.created_by_name}` : ""}. On the way: waiting for ${t.to_name ?? "the godown"} to mark it received.`;
  if (t.status === "done" && t.kind === "split") {
    const who = t.received_by_role === "zoho" ? "marked received in Zoho" : `by ${t.received_by_name || "the godown"}${t.received_by_role ? ` (${ROLE_WORDS[t.received_by_role] ?? t.received_by_role})` : ""}`;
    return `Sent ${at(t.sent_at)}. Received at ${t.to_name ?? "the godown"} ${at(t.received_at)} ${who}.`;
  }
  if (t.status === "done") return `Received at ${t.to_name ?? "the godown"} ${at(t.received_at)}${t.received_by_name ? ` by ${t.received_by_name}` : ""}.`;
  return "";
}

/** One line saying what a transfer moves, for lists and toasts. */
export function transferSummary(t: Pick<BatchTransfer, "kind" | "transfer_no" | "lines" | "to_name" | "from_location_name" | "parent_batch_code"> & { from_name?: string | null; bill_number?: string | null }) {
  const units = t.lines.map((line) => `${line.qty} ${line.name}`).join(", ");
  return t.kind === "receive"
    ? `${t.transfer_no}: bill ${t.bill_number ?? ""} from ${t.from_location_name || "the bill's Zoho location"} to ${t.to_name ?? "the godown"} (${units})`
    : `${t.transfer_no}: ${units} of batch ${t.parent_batch_code ?? ""} from ${t.from_name || t.from_location_name || "the godown"} to ${t.to_name ?? "the godown"}`;
}
