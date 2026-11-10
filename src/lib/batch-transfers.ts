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
  resumed?: boolean;
};

const text = (value: unknown) => (typeof value === "string" ? value : value === null || value === undefined ? "" : String(value));

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
 *   refused: Zoho answered no (nothing made): the units can go back.
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
export function transferSummary(t: Pick<BatchTransfer, "kind" | "transfer_no" | "lines" | "to_name" | "from_location_name" | "bill_number" | "parent_batch_code"> & { from_name?: string | null }) {
  const units = t.lines.map((line) => `${line.qty} ${line.name}`).join(", ");
  return t.kind === "receive"
    ? `${t.transfer_no}: bill ${t.bill_number ?? ""} from ${t.from_location_name || "the bill's Zoho location"} to ${t.to_name ?? "the godown"} (${units})`
    : `${t.transfer_no}: ${units} of batch ${t.parent_batch_code ?? ""} from ${t.from_name || t.from_location_name || "the godown"} to ${t.to_name ?? "the godown"}`;
}
