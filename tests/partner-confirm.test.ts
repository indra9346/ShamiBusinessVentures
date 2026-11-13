import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CONFIRMED_STATUSES, PARTNER_CONFIRM_FROM, PARTNER_CONFIRM_TO, PARTNER_CONFIRM_WORDS, confirmQuestion, partnerConfirmState,
  partnerOrderInvoice, partnerOrderRows, rowConfirmState, type PartnerConfirmState,
} from "../src/lib/partner-confirm.ts";

// 13 Nov 2026, the owner: "Channel partner need option to confirm the order & get invoice also". The partner's confirm is
// the admin's "Mark as Confirmed" (to Accepted); payments stay with the office.

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const state = (orderStatus: string, paymentStatus: string, zohoVoid = false) => partnerConfirmState({ orderStatus, paymentStatus, zohoVoid });

test("a partner confirms only an order the office has settled in full, from Placed or Payment Confirmed", () => {
  assert.deepEqual([...PARTNER_CONFIRM_FROM], ["Placed", "Payment Confirmed"]);
  assert.equal(PARTNER_CONFIRM_TO, "Accepted", "the admin's Mark as Confirmed");
  assert.equal(state("Payment Confirmed", "Paid"), "ready");
  assert.equal(state("Placed", "Paid"), "ready");
  assert.equal(state(" payment confirmed ", "PAID"), "ready", "spacing and case do not matter");
  // Money is the office's: part paid, unpaid or refunded never.
  assert.equal(state("Payment Confirmed", "Partially Paid"), "needs_payment");
  assert.equal(state("Placed", "Pending"), "needs_payment");
  assert.equal(state("Placed", "Failed"), "needs_payment");
  assert.equal(state("Payment Confirmed", "Refunded"), "refunded");
  // Checkouts, cancelled and void orders never.
  assert.equal(state("Awaiting Payment", "Pending"), "checkout");
  assert.equal(state("Payment Expired", "Pending"), "checkout");
  assert.equal(state("Cancelled", "Paid"), "closed");
  assert.equal(state("Rejected", "Pending"), "closed");
  assert.equal(state("Payment Confirmed", "Paid", true), "void_in_zoho");
  // Already confirmed or further: nothing to do (a second press changes nothing).
  for (const status of CONFIRMED_STATUSES) assert.equal(state(status, "Paid"), "confirmed", status);
  assert.equal(state("Accepted", "Partially Paid"), "confirmed");
});

test("the database's order of checks: void before money, refunded before unpaid", () => {
  assert.equal(state("Payment Confirmed", "Refunded", true), "void_in_zoho");
  assert.equal(state("Payment Confirmed", "Partially Paid", true), "void_in_zoho");
  assert.equal(state("Cancelled", "Refunded", true), "closed");
  assert.equal(state("Awaiting Payment", "Paid", true), "checkout");
});

test("every state has plain words, and only ready ones offer Confirm", () => {
  const states: PartnerConfirmState[] = ["ready", "confirmed", "needs_payment", "refunded", "void_in_zoho", "checkout", "closed"];
  for (const s of states) assert.ok(PARTNER_CONFIRM_WORDS[s].trim().length > 5, s);
  assert.match(PARTNER_CONFIRM_WORDS.needs_payment, /Only our office confirms payments/);
  assert.match(PARTNER_CONFIRM_WORDS.checkout, /office confirms the payment first/);
  assert.match(confirmQuestion("CLK-1"), /^Confirm order CLK-1\? .*tax invoice is made in Zoho\.$/);
});

test("the list's rows: numbers as numbers, blanks as null", () => {
  const rows = partnerOrderRows([
    { order_no: "CLK-1", placed_at: "2026-11-13T05:00:00Z", order_status: "Payment Confirmed", payment_status: "Paid", payment_method: "UPI",
      shipping_method: "Pickup", total: "2150.00", paid_amount: "2150.00", customer: "TEST", items: "Sugar × 1", zoho_void: false,
      invoice_number: "INV-1", invoice_mine: true, confirmed_at: null },
    { order_no: "CLK-2", total: "105", paid_amount: null, customer: "", invoice_number: "  ", invoice_mine: false, zoho_void: true, confirmed_at: "2026-11-13T06:00:00Z" },
    { order_no: "" },
    "junk",
  ]);
  assert.equal(rows.length, 2, "rows without a number are dropped");
  assert.equal(rows[0]!.total, 2150);
  assert.equal(rows[0]!.paid_amount, 2150);
  assert.equal(rows[1]!.paid_amount, 0);
  assert.equal(rows[1]!.customer, "Customer");
  assert.equal(rows[1]!.invoice_number, null);
  assert.equal(rows[1]!.zoho_void, true);
  assert.equal(rows[1]!.confirmed_at, "2026-11-13T06:00:00Z");
  assert.equal(rowConfirmState(rows[0]!), "ready");
  assert.deepEqual(partnerOrderRows(null), []);
});

test("get invoice: it opens when the customer's does, with a clear word when it does not yet", () => {
  const row = (order_status: string, payment_status: string, invoice_number: string | null = null, invoice_mine = true) =>
    partnerOrderInvoice({ order_status, payment_status, invoice_number, invoice_mine });
  assert.deepEqual(row("Placed", "Paid"), { open: false, words: "Invoice is made when the order is confirmed." });
  assert.deepEqual(row("Placed", "Pending"), { open: false, words: "Invoice is made after the full payment and the confirmation." });
  assert.deepEqual(row("Payment Confirmed", "Partially Paid"), { open: false, words: "Invoice is made after the full payment and the confirmation." });
  assert.deepEqual(row("Cancelled", "Paid"), { open: false, words: "No invoice: order cancelled" });
  assert.deepEqual(row("Payment Confirmed", "Refunded"), { open: false, words: "No invoice: payment refunded" });
  assert.deepEqual(row("Accepted", "Paid", "INV-000123"), { open: true, words: "Invoice INV-000123" });
  assert.deepEqual(row("Payment Confirmed", "Paid", "INV-000124"), { open: true, words: "Invoice INV-000124" }, "a paid order the office confirmed has its invoice already");
  const proforma = row("Accepted", "Paid");
  assert.equal(proforma.open, true);
  assert.match(proforma.words, /Zoho is making the tax invoice\. Until then this opens as a proforma/);
  assert.deepEqual(row("Accepted", "Paid", "INV-1", false), { open: false, words: "Placed before you ran this godown: ask our office for this invoice." });
});

test("the database does the confirm, with the same UPDATE as the admin's and the money rule", () => {
  const sql = read("supabase/migrations/20261113230000_godown_location_partner_confirm.sql");
  const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.partner_confirm_order"), sql.indexOf("REVOKE ALL ON FUNCTION public.partner_confirm_order"));
  assert.match(fn, /SECURITY DEFINER/);
  assert.match(fn, /SELECT \* INTO me FROM public\.channel_partners WHERE user_id = auth\.uid\(\) AND status = 'active';/);
  assert.match(fn, /IF NOT FOUND OR o\.branch_id IS DISTINCT FROM me\.branch_id THEN\n\s+RAISE EXCEPTION 'This is not an order of your godown';/);
  // The checks in the order partnerConfirmState mirrors.
  const order = ["IN ('Accepted', 'Packed', 'Dispatched', 'Out for Delivery', 'Delivered')", "= 'Cancelled'", "IN ('Awaiting Payment', 'Payment Expired')",
    "NOT IN ('Placed', 'Payment Confirmed')", "IN ('void', 'cancelled')", "o.payment_status = 'Refunded'", "o.payment_status IS DISTINCT FROM 'Paid'"];
  const at = order.map((part) => fn.indexOf(part));
  assert.ok(at.every((index) => index > 0), `every check is there: ${at.join(",")}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, "in this order");
  // Only the status changes, as in admin_update_order_status; nothing about money.
  assert.match(fn, /UPDATE public\.orders SET order_status = 'Accepted' WHERE id = o\.id;/);
  assert.ok(!/payment_status\s*=\s*'Paid'\s*,|paid_amount\s*=|INSERT INTO public\.payments/.test(fn), "never writes money");
  assert.match(fn, /set_config\('app\.partner_confirm', 'on', true\)/);
  assert.match(fn, /actor_role, partner_id\)\n\s+VALUES \(o\.id, 'Accepted', format\('Confirmed by channel partner %s at %s\.', me\.name, COALESCE\(godown, o\.branch_id\)\), 'partner', me\.id\);/,
    "who confirmed: the partner's id, not only their name");
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.partner_confirm_order\(text\) FROM PUBLIC, anon;\nGRANT EXECUTE ON FUNCTION public\.partner_confirm_order\(text\) TO authenticated;/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.partner_orders_to_confirm\(\) FROM PUBLIC, anon;/);
  // The triggers know the flag: the guard lets only this step through, the fulfilments move as for an admin.
  assert.match(sql, /IF current_setting\('app\.partner_confirm', true\) = 'on'\n\s+AND OLD\.order_status IN \('Placed', 'Payment Confirmed'\) AND NEW\.order_status = 'Accepted'\n\s+AND OLD\.payment_status = 'Paid'\n\s+AND OLD\.branch_id IS NOT NULL AND OLD\.branch_id = public\.current_partner_branch\(\)/);
  assert.match(sql, /ELSIF public\.has_role\(auth\.uid\(\), 'admin'\) OR current_setting\('app\.partner_confirm', true\) = 'on' THEN/);
});

test("who confirmed cannot be made up from the site (review, 13 Nov 2026)", () => {
  const sql = read("supabase/migrations/20261113230000_godown_location_partner_confirm.sql");
  // Customers and vendors could add their own order_tracking rows (tracking_insert); only the database writes them now.
  assert.match(sql, /DROP POLICY IF EXISTS tracking_insert ON public\.order_tracking;\nREVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public\.order_tracking FROM PUBLIC, anon, authenticated;/);
  assert.match(sql, /ALTER TABLE public\.order_tracking ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES public\.channel_partners\(id\) ON DELETE SET NULL;/);
  // The partner's list reads the partner's own record, never the free-text role.
  const list = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.partner_orders_to_confirm"), sql.indexOf("REVOKE ALL ON FUNCTION public.partner_orders_to_confirm"));
  assert.match(list, /WHERE tr\.order_id = o\.id AND tr\.partner_id IS NOT NULL AND tr\.status = 'Accepted'/);
  assert.ok(!list.includes("actor_role"), "the list never trusts actor_role");
  // Nothing on the site writes order_tracking (the database's SECURITY DEFINER functions do).
  for (const path of ["src/lib/store.tsx", "src/lib/customer-data.ts", "src/components/partners/PartnerOrdersToConfirm.tsx"]) {
    assert.ok(!/from\("order_tracking"\)\.(insert|upsert|update|delete)/.test(read(path)), path);
  }
  const types = read("src/integrations/supabase/types.ts");
  const table = types.slice(types.indexOf("      order_tracking: {"), types.indexOf("      orders: {"));
  assert.match(table, /partner_id: string \| null/);
});

test("the partner's page: Orders to confirm with Confirm order and the invoice; the Zoho push is allowed for their godown", () => {
  const page = read("src/routes/partner.index.tsx");
  assert.match(page, /<PartnerOrdersToConfirm \/>/);
  const panel = read("src/components/partners/PartnerOrdersToConfirm.tsx");
  assert.match(panel, /<Panel id="orders-to-confirm" title="Orders to confirm"/);
  assert.match(panel, /supabase\.rpc\("partner_orders_to_confirm"\)/);
  assert.match(panel, /supabase\.rpc\("partner_confirm_order", \{ _order_no: row\.order_no \}\)/);
  assert.match(panel, /pushOrderToZohoInBackground\(row\.order_no\);/, "the same instant Zoho push as the admin's confirm");
  assert.match(panel, /\{state === "ready" && \(/, "Confirm order only when the money is settled");
  assert.match(panel, /supabase\.rpc\("partner_invoice_order", \{ _order_no: orderNo \}\)/, "the same copy as Customer invoices");
  assert.match(panel, /<DialogTitle>Confirm this order\?<\/DialogTitle>/, "asked before it is done");
  const invoices = read("src/components/partners/PartnerInvoices.tsx");
  assert.match(invoices, /partnerOrderInvoice\(\{ \.\.\.row, invoice_mine: true \}\)\.words/);
  // On a phone the longer words wrap beside the amount instead of pushing the page sideways (review, 13 Nov 2026).
  assert.match(invoices, /<div className="flex min-w-0 items-center gap-3">\n\s+<span className="shrink-0 whitespace-nowrap text-sm font-bold text-navy tabular-nums">/);
  assert.match(invoices, /<span className="min-w-0 max-w-\[16rem\] text-right text-xs text-charcoal">/);
  assert.ok(!invoices.includes('className="flex shrink-0 items-center gap-3"'), "the amount-and-words block may shrink");
  const zoho = read("src/lib/zoho-commerce.functions.ts");
  assert.match(zoho, /\.from\("channel_partners"\)\.select\("id"\)\n\s+\.eq\("user_id", userId\)\.eq\("status", "active"\)\.eq\("branch_id", order\.branch_id\)\.maybeSingle\(\);/);
  assert.equal((zoho.match(/\.select\("id,user_id(,zoho_salesorder_id)?,branch_id"\)/g) ?? []).length, 2, "both pushes read the order's godown");
});
