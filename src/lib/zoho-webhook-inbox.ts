// What a Zoho webhook call is about, and how calls parked in public.zoho_webhook_inbox are worked through.
// No imports, so the tests can run it directly; the database and Zoho come in as `deps`.

export type WebhookRecord =
  | { kind: "salesorder" | "item"; id: string }
  | { kind: "invoice"; id: string; salesOrderId: string; reference: string };

const text = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value) : "");

/** Finds the sales order, invoice or item in a Zoho webhook body (JSON, or form data with a JSONString field). */
export function webhookRecordFrom(body: string): WebhookRecord | null {
  const candidates: unknown[] = [];
  try {
    candidates.push(JSON.parse(body));
  } catch {
    const form = new URLSearchParams(body);
    for (const value of form.values()) {
      try {
        candidates.push(JSON.parse(value));
      } catch {
        // not JSON
      }
    }
    candidates.push(Object.fromEntries(form.entries()));
  }
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Record<string, unknown>;
    const order = (record["salesorder"] ?? record["sales_order"]) as Record<string, unknown> | undefined;
    const orderId = order?.["salesorder_id"] ?? record["salesorder_id"];
    if (typeof orderId === "string" || typeof orderId === "number") return { kind: "salesorder", id: String(orderId) };
    const invoice = record["invoice"] as Record<string, unknown> | undefined;
    const invoiceId = invoice?.["invoice_id"];
    if (typeof invoiceId === "string" || typeof invoiceId === "number") {
      return { kind: "invoice", id: String(invoiceId), salesOrderId: text(invoice?.["salesorder_id"]), reference: text(invoice?.["reference_number"]) };
    }
    const item = record["item"] as Record<string, unknown> | undefined;
    const itemId = item?.["item_id"] ?? record["item_id"];
    if (typeof itemId === "string" || typeof itemId === "number") return { kind: "item", id: String(itemId) };
  }
  return null;
}

export type InboxRow = {
  id: number;
  body: string;
  signature: string;
  content_type: string | null;
  query: string;
  attempts: number;
};

export type InboxDeps = {
  secrets: string[];
  verify: (body: string, signature: string, secret: string, request: { query: Array<[string, string]>; contentType: string | null }) => Promise<string | null>;
  load: (limit: number) => Promise<InboxRow[]>;
  remove: (ids: number[]) => Promise<void>;
  setAttempts: (ids: number[], attempts: number) => Promise<void>;
  apply: (record: WebhookRecord) => Promise<unknown>;
  log: (event: string, fields: Record<string, string | number | boolean | null | undefined>) => void;
};

/** A call that keeps failing is dropped after this many runs; the hourly check and daily run still cover the record. */
export const MAX_INBOX_ATTEMPTS = 3;

export type InboxResult = { read: number; applied: number; failed: number; rejected: number; ignored: number; waiting: number };

/**
 * Works through the parked calls, oldest first. Each one must carry a valid Zoho signature (the Edge Function cannot
 * check it because only the website holds the secret); anything else is deleted unread. Several calls about the same
 * record become one, because the record is re-read from Zoho anyway, which saves Zoho API calls.
 */
export async function drainWebhookInbox(deps: InboxDeps, options: { readLimit?: number; maxApplied?: number } = {}): Promise<InboxResult> {
  const result: InboxResult = { read: 0, applied: 0, failed: 0, rejected: 0, ignored: 0, waiting: 0 };
  // Without the secret nothing can be proved good or bad: leave everything for a run that has it.
  if (deps.secrets.length === 0) {
    deps.log("webhook_inbox_skipped", { reason: "ZOHO_WEBHOOK_SECRET is not set" });
    return result;
  }
  const rows = await deps.load(options.readLimit ?? 300);
  result.read = rows.length;
  const maxApplied = options.maxApplied ?? 25;
  const rejected: number[] = [];
  const ignored: number[] = [];
  const groups = new Map<string, { record: WebhookRecord; ids: number[]; attempts: number }>();

  for (const row of rows) {
    let matched: string | null = null;
    for (const secret of deps.secrets) {
      matched = await deps.verify(row.body, row.signature, secret, {
        query: [...new URLSearchParams(row.query).entries()],
        contentType: row.content_type,
      });
      if (matched) break;
    }
    if (!matched) {
      rejected.push(row.id);
      continue;
    }
    const record = webhookRecordFrom(row.body);
    if (!record) {
      ignored.push(row.id);
      continue;
    }
    const key = `${record.kind}:${record.id}`;
    const group = groups.get(key);
    if (group) {
      // Newest wins: an invoice's sales order or reference may have been filled in by a later save.
      group.record = record;
      group.ids.push(row.id);
      group.attempts = Math.max(group.attempts, row.attempts);
    } else {
      groups.set(key, { record, ids: [row.id], attempts: row.attempts });
    }
  }

  if (rejected.length > 0) {
    await deps.remove(rejected);
    result.rejected = rejected.length;
    deps.log("webhook_inbox_rejected", { count: rejected.length, reason: "bad signature" });
  }
  if (ignored.length > 0) {
    await deps.remove(ignored);
    result.ignored = ignored.length;
  }

  let turn = 0;
  for (const { record, ids, attempts } of groups.values()) {
    if (turn >= maxApplied) {
      result.waiting += ids.length;
      continue;
    }
    turn += 1;
    try {
      const outcome = await deps.apply(record);
      await deps.remove(ids);
      result.applied += 1;
      deps.log("webhook_applied", { kind: record.kind, zohoId: record.id, via: "inbox", outcome: typeof outcome === "string" ? outcome : undefined });
    } catch (cause) {
      result.failed += 1;
      const nextAttempts = attempts + 1;
      const error = cause instanceof Error ? cause.message : "unknown";
      if (nextAttempts >= MAX_INBOX_ATTEMPTS) {
        await deps.remove(ids);
        deps.log("webhook_failed", { kind: record.kind, zohoId: record.id, via: "inbox", gaveUp: true, error });
      } else {
        await deps.setAttempts(ids, nextAttempts);
        deps.log("webhook_failed", { kind: record.kind, zohoId: record.id, via: "inbox", attempts: nextAttempts, error });
      }
    }
  }
  return result;
}
