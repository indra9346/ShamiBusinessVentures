import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { kn } from "../src/lib/i18n-kn.ts";
import { PARTNER_CONFIRM_WORDS } from "../src/lib/partner-confirm.ts";

// 16 Nov 2026, the owner: "Give option to approve payments of customers in their login for channel partners respective to
// their Godown orders only". The database side is tested on a real Postgres in tests/db/partner-payment-approval.db-test.mjs.

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const MIGRATION = "supabase/migrations/20261116100000_partner_payment_approval.sql";

test("the partner approves through partner_approve_payment only, with the UTR they looked at and where they saw it", () => {
  const store = read("src/lib/upi-store.ts");
  assert.match(store, /supabase\.rpc\("partner_approve_payment", \{ _order_no: orderNo, _expected_utr: utr, _checked: checked \}\)/);
  // The three places a partner may have seen the money are exactly the database's.
  const sql = read(MIGRATION);
  for (const code of ["bank_sms", "bank_statement", "upi_app"]) {
    assert.match(store, new RegExp(`value: "${code}"`), code);
    assert.match(sql, new RegExp(`WHEN '${code}' THEN`), code);
  }
  assert.match(store, /canApprove: row\["can_approve"\] === true/, "nothing to approve before the database change");
  const panel = read("src/components/panel/PartnerPaymentsPanel.tsx");
  assert.match(panel, /row\.utrStatus === "submitted" && row\.utr && row\.canApprove \?/, "the button only where the database allows it");
  assert.match(panel, /await approvePartnerPayment\(row\.orderNo, row\.utr, checked\);/);
  assert.match(panel, /pushOrderToZohoInBackground\(row\.orderNo\);/, "the same instant Zoho push as the office's Confirm");
  assert.match(panel, /window\.dispatchEvent\(new Event\(PARTNER_REFRESH_EVENT\)\);/, "Orders to confirm reads again");
  // The dialog asks where and that they saw it; the button stays off until both are given.
  assert.match(panel, /disabled=\{busy \|\| !checked \|\| !seen\}/);
  assert.match(panel, /I saw \$\{amount\} with UTR \$\{row\.utr \?\? ""\} arrive in the bank account the customer paid into\./);
  assert.ok(!/reject/i.test(panel.replace(/never reject one/, "")), "no reject for a partner");
  const widgets = read("src/components/partners/PartnerWidgets.tsx");
  assert.match(widgets, /window\.addEventListener\(PARTNER_REFRESH_EVENT, onFocus\);/);
});

test("the database: only the partner of the order's own godown, only to confirm, the office's checks unchanged, the office told", () => {
  const sql = read(MIGRATION);
  const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.partner_approve_payment"), sql.indexOf("REVOKE ALL ON FUNCTION public.partner_approve_payment"));
  assert.match(fn, /SELECT \* INTO me FROM public\.channel_partners WHERE user_id = auth\.uid\(\) AND status = 'active' AND branch_id IS NOT NULL;/);
  assert.match(fn, /IF NOT FOUND OR o\.branch_id IS DISTINCT FROM me\.branch_id THEN RAISE EXCEPTION 'This is not an order of your godown'; END IF;/);
  assert.match(fn, /PERFORM public\.review_upi_utr\(o\.order_no, 'confirmed', note, s\.utr\);/);
  assert.ok(!/'rejected'/.test(fn), "never rejects");
  assert.match(fn, /PERFORM set_config\('app\.partner_payment', '', true\);/);
  // A second person checks what a partner entered (review, 16 Nov 2026).
  assert.match(fn, /IF COALESCE\(s\.sent_by_role, ''\) = 'partner' OR s\.sent_by IS NOT DISTINCT FROM auth\.uid\(\) THEN\n\s+RAISE EXCEPTION 'You sent this UTR yourself, so our office checks it';/);
  assert.match(fn, /IF o\.user_id IS NOT DISTINCT FROM auth\.uid\(\) THEN RAISE EXCEPTION 'This is your own order, so our office checks its payment'; END IF;/);
  // An ended checkout: exactly the office's Place again (its own lock order), with the UTR the partner looked at; a clash
  // with an office decision on the same UTR at the same moment is said in plain words.
  assert.ok(!/pg_advisory_xact_lock/.test(fn), "no lock of its own before the office's");
  assert.match(fn, /WHEN deadlock_detected THEN\n\s+-- [^\n]*\n\s+RAISE EXCEPTION 'Our office is working on this payment right now\. Check the list again in a moment\.';/);
  assert.match(fn, /placed := public\.admin_place_ended_checkout\(o\.order_no, s\.utr, NULL, note\);/);
  assert.match(fn, /'Payment approved by channel partner'/);
  assert.match(fn, /FROM public\.user_roles ur WHERE ur\.role = 'admin';/);
  // The flag lets in only the caller's own active partner record, and only while approval is switched on.
  const acting = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION private.payment_partner_acting"), sql.indexOf("REVOKE ALL ON FUNCTION private.payment_partner_acting"));
  assert.match(acting, /p\.id::text = NULLIF\(current_setting\('app\.partner_payment', true\), ''\)/);
  assert.match(acting, /p\.user_id = auth\.uid\(\) AND p\.status = 'active'/);
  assert.match(acting, /private\.partner_payment_approval_on\(\)/);
  // Each office function checks the godown again and refuses a partner's reject.
  for (const name of ["admin_confirm_manual_payment", "review_upi_utr", "admin_place_ended_checkout"]) {
    const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    const body = sql.slice(start, sql.indexOf("$function$", sql.indexOf("$function$", start) + 10));
    assert.match(body, /SELECT \* INTO acting FROM private\.payment_partner_acting\(\);/, name);
    assert.match(body, /branch_id IS DISTINCT FROM acting\.branch_id THEN RAISE EXCEPTION 'This is not an order of your godown'/, name);
  }
  assert.match(sql, /IF by_partner AND _decision <> 'confirmed' THEN RAISE EXCEPTION 'Only our office can reject a UTR'; END IF;/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.partner_approve_payment\(text, text, text\) FROM PUBLIC, anon;\nGRANT EXECUTE ON FUNCTION public\.partner_approve_payment\(text, text, text\) TO authenticated;/);
  // On from today; the office can switch it off.
  assert.match(sql, /VALUES \('partner_payment_approval', jsonb_build_object\('enabled', true\), false, now\(\)\)\nON CONFLICT \(key\) DO NOTHING;/);
  const admin = read("src/routes/admin.upi-payments.tsx");
  assert.match(admin, /\{!STATIC_DATA_MODE && <PartnerPaymentApprovalPanel \/>\}/);
  assert.match(read("src/components/panel/PartnerPaymentApprovalPanel.tsx"), /setPartnerPaymentApproval\(enabled\)/);
});

test("Approved by names the channel partner for a partner's approval", () => {
  const store = read("src/lib/upi-store.ts");
  assert.match(store, /export const PARTNER_APPROVAL_NOTE = "Approved by channel partner ";/);
  assert.match(store, /if \(approvedByPartner\(row\.note\) && partners\.get\(id\)\) return `\$\{partners\.get\(id\)\} \(channel partner\)`;/);
  assert.match(store, /supabase\.from\("channel_partners"\)\.select\("user_id,name"\)\.in\("user_id", partnerIds\)/);
  // The database writes that note.
  assert.match(read(MIGRATION), /note := left\(format\('Approved by channel partner %s \(%s\) after checking %s', me\.name, godown, checked\), 200\);/);
});

test("the partner's words no longer say only our office confirms payments", () => {
  assert.match(PARTNER_CONFIRM_WORDS.checkout, /Approve the customer's UTR under Customer payments if our office allows it, or our office confirms it/);
  assert.match(PARTNER_CONFIRM_WORDS.needs_payment, /Our office confirms the rest of the payment/);
  assert.ok(!read("src/components/partners/PartnerOrdersToConfirm.tsx").includes("Our office confirms every payment first"));
  assert.ok(!read("src/components/panel/PartnerPaymentsPanel.tsx").includes("Only an admin confirms it"));
});

test("every new text has Kannada", () => {
  const texts = [
    "Checkouts at your godown that are waiting for payment, or ended without it in the last 15 days. If a customer paid and gives you the UTR, send it here. When our office allows it, you approve the UTR yourself once you have seen the money arrive in the bank account, as our office does, also a UTR you sent for the customer; otherwise our office checks it and places the order.",
    "UTR {0} for {1}", "Sent by the customer", "Sent by you", "Sent by our office", "after the checkout ended",
    "Seen this money arrive? Approve it, or leave it for our office.", "Approve payment", "Approving…", "Approve & place order",
    "Only send a UTR the customer showed you from their UPI app or bank. Once it is sent, check the money in the bank account: when our office allows it, the Approve payment box opens here for you.",
    "Approve {0} for {1}?", "Only approve after you have seen this money arrive with UTR {0}.",
    "This checkout ended before the payment was sent. Approving takes its stock again at your godown and places the order.",
    "Where did you see this money?", "The bank's SMS or alert", "The bank statement or passbook", "The business UPI app's received payments",
    "I saw {0} with UTR {1} arrive in the bank account the customer paid into.",
    "Our office is told of every payment you approve. An approval cannot be undone here: if you made a mistake, call our office at once.",
    "{0} is paid and placed", "It now waits for you under Orders to confirm.", "Could not approve the payment",
    "Channel partners approving payments", "Channel partners can approve their own godown's payments",
    "On: the channel partner of each godown can approve a customer's UTR for their own godown's checkouts, after seeing the money arrive. They cannot reject a UTR, and our office is told of every approval, shown under Approved by. Off: only our office approves payments.",
    "Last changed by {0} on {1}", "Channel partners can approve payments", "Only our office approves payments now", "{0} (channel partner)",
    PARTNER_CONFIRM_WORDS.checkout, PARTNER_CONFIRM_WORDS.needs_payment,
    "Paid orders of your godown wait here for you to confirm them, as our office does. A payment is approved first, by our office or, when our office allows it, by you under Customer payments. Open an order's invoice here or under Customer invoices to view, print or download it.",
    // The database's refusals and the office's notice.
    "Only an active channel partner can approve payments here",
    "Our office has turned off payment approval by channel partners. Our office will check this payment.",
    "Choose where you saw this payment", "No UTR is waiting for a check on this order",
    "The UTR for this order is now {0}. Check the payment again.", "This checkout ended more than 15 days ago. Our office checks it.",
    "This order is not waiting for payment", "Only our office can reject a UTR", "Approve only the UTR sent for this order",
    "This checkout is not a paid order yet. Approve the customer's UTR under Customer payments if our office allows it, or our office confirms it; the order then shows here to confirm",
    "This order is not fully paid yet. Our office confirms the rest of the payment; once it has, you can confirm the order here",
    "Payment approved by channel partner",
    "{0} (channel partner, {1}) approved UTR {2} for ₹{3} on order {4} after checking {5}. Check it in the bank account.",
    "Approved by channel partner {0} ({1}) after checking {2}",
    "You sent this UTR yourself, so our office checks it", "This is your own order, so our office checks its payment",
    "The bank shows a different amount for UTR {0}. Leave this payment for our office.",
    "Not enough stock is left at your godown to place this order again. Leave it for our office.",
    "This UTR was also sent on another order. Leave this payment for our office.",
    "This UTR was sent for another checkout. Leave this payment for our office.",
    "A channel partner approves only the full amount of a checkout, with the UTR sent for it",
    "the business UPI app's received payments",
    "Our office is working on this payment right now. Check the list again in a moment.",
  ];
  for (const text of texts) assert.ok(kn[text], `Kannada for: ${text}`);
  // The texts on screen are exactly these (a changed sentence without Kannada would show in English).
  const panel = read("src/components/panel/PartnerPaymentsPanel.tsx");
  for (const text of ["Seen this money arrive? Approve it, or leave it for our office.", "Where did you see this money?",
    "Our office is told of every payment you approve. An approval cannot be undone here: if you made a mistake, call our office at once."]) {
    assert.ok(panel.includes(text), text);
  }
  assert.ok(read("src/components/partners/PartnerOrdersToConfirm.tsx").includes(
    "Paid orders of your godown wait here for you to confirm them, as our office does. A payment is approved first, by our office or, when our office allows it, by you under Customer payments. Open an order's invoice here or under Customer invoices to view, print or download it."),
  "the Orders to confirm sentence");
});

// 16 Nov 2026 afternoon, the owner: "Channel partner should be able to approve the order just like admin".
test("a partner approves a UTR they sent for the customer, as our office does; their own order still waits", () => {
  const sql = read("supabase/migrations/20261116160000_partner_approve_own_utr.sql");
  assert.ok(!sql.includes("You sent this UTR yourself"), "no refusal of a UTR the partner sent");
  assert.ok(!sql.includes("COALESCE(s.sent_by_role, '') <> 'partner'"), "can_approve no longer skips a partner-sent UTR");
  assert.ok(sql.includes("IF o.user_id IS NOT DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'This is your own order, so our office checks its payment'; END IF;"));
  assert.ok(sql.includes("AND o.user_id IS DISTINCT FROM auth.uid()\n"));
  assert.ok(sql.includes("IF NOT FOUND OR o.branch_id IS DISTINCT FROM me.branch_id THEN RAISE EXCEPTION 'This is not an order of your godown'; END IF;"));
  assert.ok(sql.includes("IF NOT private.partner_payment_approval_on() THEN"));
  const panel = read("src/components/panel/PartnerPaymentsPanel.tsx");
  assert.ok(panel.includes("also a UTR you sent for the customer"));
  // Sending the UTR opens the Approve box at once when the database allows it, and the list reads again by itself.
  assert.ok(panel.includes("onSent={() => void sent(row.orderNo)}"));
  assert.ok(panel.includes('r.orderNo === orderNo && r.utrStatus === "submitted" && r.utr && r.canApprove'));
  assert.ok(panel.includes("useLiveRefresh(() => { void load(); }, [load]);"));
});
