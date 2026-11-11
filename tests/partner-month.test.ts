import assert from "node:assert/strict";
import test from "node:test";
import {
  asMonthStatement, categoryLabel, deductionProblem, describeScheme, incomeSteps, percentText, ratesProblem, resultSteps, schemeNow, statementState,
  type MonthStatement,
} from "../src/lib/partner-month.ts";
import { commissionsByOrder, describeRate } from "../src/lib/partners.ts";
import { lineState, payoutMonthLabel } from "../src/lib/partner-payouts.ts";
import { ADMIN_PARTNER_COLUMNS, PARTNER_COLUMNS } from "../src/lib/partner-report.ts";
import { adminNavGroups } from "../src/lib/panel-menu.ts";

const raw = {
  applies: true, month: "2026-10-01", branch_id: "BR-CLK", statement_id: null, status: "open", month_over: true, partner_id: "p", partner_name: "P",
  share_percent: "50.00", tax_percent: "25.00", rates_custom: false, sales: "1000", coupons: "0", cost: "600", delivery: "50", corrections: "-20",
  sales_without_cost: "0", lines_without_cost: 0, orders: 2, income: "430", deductions_total: "130", profit_before_tax: "300", tax_amount: "75", remaining: "225",
  share_amount: "112.5", paid: "0", due: "0", closed_at: null, closed_by_name: "", can_add: true, is_admin: false,
  deductions: [{ id: "d", category: "rent", label: "", amount: "130", added_by_name: "P", added_by_role: "partner", created_at: "", can_remove: true }],
};

test("the database's answer becomes numbers; a per-unit month is nothing", () => {
  const s = asMonthStatement(raw)!;
  assert.equal(s.share_percent, 50); assert.equal(s.tax_percent, 25); assert.equal(s.income, 430); assert.equal(s.deductions[0]!.amount, 130);
  assert.equal(s.lines, undefined, "a partner gets no lines");
  assert.equal(asMonthStatement({ applies: false }), null);
  assert.equal(asMonthStatement(null), null);
  assert.equal(asMonthStatement({ ...raw, share_percent: null })!.share_percent, null);
});

test("income shows only what applies, and ends with the total", () => {
  const s = asMonthStatement(raw)!;
  assert.deepEqual(incomeSteps(s).map((step) => [step.label, step.amount]), [
    ["Sales before GST", 1000], ["Purchase cost before GST", 600], ["Delivery charges", 50], ["Corrections to earlier months", -20], ["Total income", 430],
  ]);
  assert.ok(incomeSteps({ ...s, coupons: 12 }).some((step) => step.label === "Coupons before GST"));
});

test("what remains reads in the owner's words, with the percentages", () => {
  const s = asMonthStatement(raw)!;
  assert.deepEqual(resultSteps(s, "partner").map((step) => step.label), [
    "Total income", "Total deductions", "Profit after deductions", "Income tax (25%)", "Remaining (net profit after income tax)", "Your share (50%)",
  ]);
  assert.equal(resultSteps(s, "admin").at(-1)!.label, "Partner's share (50%)");
  assert.equal(percentText(25.5), "25.5"); assert.equal(percentText(null), "—");
});

test("deductions are checked before they are sent", () => {
  assert.equal(deductionProblem({ category: "rent", label: "", amount: "6000" }), "");
  assert.match(deductionProblem({ category: "other", label: " ", amount: "10" }), /Say what/);
  assert.equal(deductionProblem({ category: "other", label: "Diesel", amount: "10" }), "");
  assert.match(deductionProblem({ category: "travel", label: "", amount: "10" }), /Choose/);
  for (const amount of ["", "0", "-5", "abc"]) assert.match(deductionProblem({ category: "rent", label: "", amount }), /amount/);
  assert.match(deductionProblem({ category: "rent", label: "x".repeat(121), amount: "1" }), /too long/);
  assert.equal(categoryLabel("staff"), "Godown staff");
});

test("percentages: a share above 0, tax from 0", () => {
  assert.equal(ratesProblem("50", "0"), "");
  assert.match(ratesProblem("0", "25"), /share/);
  assert.match(ratesProblem("101", "25"), /share/);
  assert.match(ratesProblem("50", ""), /income tax/);
  assert.match(ratesProblem("50", "-1"), /income tax/);
});

test("a month's state", () => {
  const base = { status: "open" as const, month_over: false, share_amount: 0, paid: 0, due: 0 };
  assert.equal(statementState(base), "running");
  assert.equal(statementState({ ...base, month_over: true }), "to_close");
  assert.equal(statementState({ ...base, status: "closed", month_over: true }), "nothing_to_pay");
  assert.equal(statementState({ ...base, status: "closed", month_over: true, share_amount: 10, due: 10 }), "to_pay");
  assert.equal(statementState({ ...base, status: "closed", month_over: true, share_amount: 10, paid: 4, due: 6 }), "part_paid");
  assert.equal(statementState({ ...base, status: "closed", month_over: true, share_amount: 10, paid: 10, due: 0 }), "paid");
});

test("the way of paying now, and what is planned", () => {
  const row = (id: string, starts: string, scheme: string) => ({ id, branch_id: "B", from_month: starts.slice(0, 10), starts_at: starts, scheme, share_percent: scheme === "net_profit" ? 50 : null, tax_percent: 25 });
  const now = Date.parse("2026-11-11T08:00:00Z");
  const { current, planned } = schemeNow([row("dec", "2026-11-30T18:30:00Z", "per_unit"), row("nov", "2026-11-11T07:00:00Z", "net_profit")], now);
  assert.equal(current?.id, "nov"); assert.deepEqual(planned.map((r) => r.id), ["dec"]);
  assert.equal(schemeNow([], now).current, null);
  assert.equal(describeScheme(null), "Per-unit commission");
  assert.equal(describeScheme(current), "Monthly profit share: 50% to the partner, income tax 25%");
});

test("lines and payouts on monthly profit share read as such", () => {
  assert.equal(describeRate("net_profit", 0), "Monthly profit share");
  assert.equal(describeRate("per_unit", 2.5), "₹2.50 per unit");
  assert.equal(payoutMonthLabel({ statement_id: "s", period_from: "2026-10-01" }), "Monthly profit share · October 2026");
  assert.equal(payoutMonthLabel({ statement_id: null, period_from: "2026-10-01" }), "");
});

test("a product with commission switched off earns nothing, and says so", () => {
  const line = { status: "earned", payable: 0, paid_amount: 0, due_amount: 0, amount: 0 };
  assert.equal(lineState(line), "No commission");
  assert.equal(lineState({ ...line, status: "pending" }), "No commission");
  assert.equal(lineState({ ...line, status: "cancelled" }), "Cancelled");
  assert.equal(lineState({ ...line, amount: 10, payable: 10, due_amount: 10 }), "To pay");
});

test("commissions by order: one row per order, newest first, the items inside", () => {
  const line = (order_no: string, placed_at: string, status: string, amount: number, line_total = 100) => ({
    order_no, placed_at, order_status: "Delivered", payment_status: "Paid", customer_name: "C", pin: "1", line_total, amount, paid_amount: 0, due_amount: status === "earned" ? amount : 0, status,
  });
  const orders = commissionsByOrder([
    line("A", "2026-11-01T05:00:00Z", "earned", 10), line("B", "2026-11-02T05:00:00Z", "pending", 5), line("A", "2026-11-01T05:00:00Z", "earned", 2.5, 50),
    line("C", "2026-10-30T05:00:00Z", "cancelled", 4),
  ]);
  assert.deepEqual(orders.map((o) => o.orderNo), ["B", "A", "C"]);
  assert.deepEqual([orders[1]!.lines.length, orders[1]!.commission, orders[1]!.sale, orders[1]!.balance, orders[1]!.status], [2, 12.5, 150, 12.5, "earned"]);
  assert.equal(orders[0]!.status, "pending");
  assert.equal(orders[2]!.status, "cancelled");
  assert.equal(commissionsByOrder([line("D", "2026-11-01T05:00:00Z", "earned", 1), line("D", "2026-11-01T05:00:00Z", "pending", 1)])[0]!.status, "pending", "one item still waiting");
});

test("partners no longer see the total of cancelled sales; the admin still does", () => {
  assert.ok(!PARTNER_COLUMNS.some(([label]) => label === "Cancelled sales (₹)"));
  const admin = ADMIN_PARTNER_COLUMNS.map(([label]) => label);
  assert.ok(admin.includes("Cancelled sales (₹)"));
  assert.equal(admin.indexOf("Cancelled sales (₹)"), admin.indexOf("Commission balance to pay (₹)") + 1, "in its old place");
  assert.equal(new Set(admin).size, admin.length, "no column twice");
});

test("the new admin page sits with the partners in the menu", () => {
  const groups = adminNavGroups([{ to: "/admin/partners" }, { to: "/admin/partner-income" }, { to: "/admin/partner-payouts" }]);
  const partners = groups.find((group) => group.key === "partners")!;
  assert.deepEqual(partners.items.map((item) => item.to), ["/admin/partners", "/admin/partner-income", "/admin/partner-payouts"]);
});

void ({} as MonthStatement);
