/*
 * Channel partner monthly profit share (Type 2): what the screens show and warn about. The database works out the figures
 * and decides what is allowed (migration 20261111150000), and a partner only ever receives a month's totals.
 * Kept free of app imports so the node tests can load it.
 */

export const DEDUCTION_CATEGORIES = [
  { key: "rent", label: "Godown rent" },
  { key: "staff", label: "Godown staff" },
  { key: "marketing", label: "Marketing" },
  { key: "other", label: "Other" },
] as const;
export type DeductionCategory = (typeof DEDUCTION_CATEGORIES)[number]["key"];

export type MonthDeduction = {
  id: string;
  category: string;
  label: string;
  amount: number;
  added_by_name: string;
  added_by_role: string;
  created_at: string;
  can_remove: boolean;
};
export type MonthLine = {
  row_kind: string;
  order_no: string;
  product_name: string;
  qty: number;
  sales: number;
  coupon: number;
  cost: number;
  delivery: number;
  cost_known: boolean;
};
export type MonthEvent = { event: string; at: string; by_name: string; by_role: string; detail: Record<string, unknown> };

export type MonthStatement = {
  applies: true;
  month: string;
  branch_id: string;
  statement_id: string | null;
  status: "open" | "closed";
  month_over: boolean;
  partner_id: string | null;
  partner_name: string;
  share_percent: number | null;
  tax_percent: number;
  rates_custom: boolean;
  sales: number;
  coupons: number;
  cost: number;
  delivery: number;
  corrections: number;
  sales_without_cost: number;
  lines_without_cost: number;
  orders: number;
  income: number;
  deductions_total: number;
  profit_before_tax: number;
  tax_amount: number;
  remaining: number;
  share_amount: number;
  paid: number;
  due: number;
  closed_at: string | null;
  closed_by_name: string;
  deductions: MonthDeduction[];
  can_add: boolean;
  is_admin: boolean;
  lines?: MonthLine[];
  events?: MonthEvent[];
};

const num = (value: unknown) => Number(value) || 0;

/** The database's answer as a statement, or null when the month is on per-unit commission. */
export function asMonthStatement(raw: unknown): MonthStatement | null {
  const row = raw as Record<string, unknown> | null;
  if (!row || !row["applies"]) return null;
  const money = Object.fromEntries(["sales", "coupons", "cost", "delivery", "corrections", "sales_without_cost", "lines_without_cost", "orders", "income",
    "deductions_total", "profit_before_tax", "tax_amount", "remaining", "share_amount", "paid", "due", "tax_percent"].map((key) => [key, num(row[key])]));
  return {
    ...row,
    ...money,
    share_percent: row["share_percent"] === null || row["share_percent"] === undefined ? null : num(row["share_percent"]),
    deductions: ((row["deductions"] ?? []) as MonthDeduction[]).map((item) => ({ ...item, amount: num(item.amount) })),
    lines: row["lines"] ? (row["lines"] as MonthLine[]).map((item) => ({ ...item, qty: num(item.qty), sales: num(item.sales), coupon: num(item.coupon), cost: num(item.cost), delivery: num(item.delivery) })) : undefined,
  } as unknown as MonthStatement;
}

export const categoryLabel = (category: string) => DEDUCTION_CATEGORIES.find((item) => item.key === category)?.label ?? category;

/** Why this deduction should not be sent yet, or "". The database checks the same again. */
export function deductionProblem(input: { category: string; label: string; amount: string }) {
  if (!DEDUCTION_CATEGORIES.some((item) => item.key === input.category)) return "Choose what this deduction is for";
  const label = input.label.trim();
  if (input.category === "other" && label.length < 2) return "Say what this deduction is for";
  if (label.length > 120) return "The description is too long";
  const amount = Number(input.amount);
  if (input.amount.trim() === "" || !Number.isFinite(amount) || amount <= 0) return "Enter the amount of this deduction";
  if (amount > 999_999_999) return "Enter the amount of this deduction";
  return "";
}

/** Why these percentages will not do, or "". */
export function ratesProblem(share: string, tax: string) {
  const shareValue = Number(share);
  if (share.trim() === "" || !Number.isFinite(shareValue) || shareValue <= 0 || shareValue > 100) return "Enter the partner's share, above 0 and up to 100 percent";
  const taxValue = Number(tax);
  if (tax.trim() === "" || !Number.isFinite(taxValue) || taxValue < 0 || taxValue > 100) return "Enter an income tax percentage from 0 to 100";
  return "";
}

/** 25 or 25.5, for showing a percentage. */
export const percentText = (value: number | null) => (value === null ? "—" : String(Number(value.toFixed(2))));

export type Step = { key: string; label: string; amount: number; kind?: "minus" | "total" | "share" };

/** How the month's income is made up. Empty rows are left out. */
export function incomeSteps(s: MonthStatement): Step[] {
  const steps: Step[] = [{ key: "sales", label: "Sales before GST", amount: s.sales }];
  if (s.coupons) steps.push({ key: "coupons", label: "Coupons before GST", amount: s.coupons, kind: "minus" });
  steps.push({ key: "cost", label: "Purchase cost before GST", amount: s.cost, kind: "minus" });
  if (s.delivery) steps.push({ key: "delivery", label: "Delivery charges", amount: s.delivery });
  if (s.corrections) steps.push({ key: "corrections", label: "Corrections to earlier months", amount: s.corrections });
  steps.push({ key: "income", label: "Total income", amount: s.income, kind: "total" });
  return steps;
}

/** From the income down to what remains and the partner's share. */
export function resultSteps(s: MonthStatement, audience: "partner" | "admin"): Step[] {
  return [
    { key: "income", label: "Total income", amount: s.income },
    { key: "deductions", label: "Total deductions", amount: s.deductions_total, kind: "minus" },
    { key: "profit", label: "Profit after deductions", amount: s.profit_before_tax, kind: "total" },
    { key: "tax", label: `Income tax (${percentText(s.tax_percent)}%)`, amount: s.tax_amount, kind: "minus" },
    { key: "remaining", label: "Remaining (net profit after income tax)", amount: s.remaining, kind: "total" },
    { key: "share", label: `${audience === "partner" ? "Your share" : "Partner's share"} (${percentText(s.share_percent)}%)`, amount: s.share_amount, kind: "share" },
  ];
}

export type StatementState = "running" | "to_close" | "to_pay" | "part_paid" | "paid" | "nothing_to_pay";

/** Where a month stands. */
export function statementState(s: Pick<MonthStatement, "status" | "month_over" | "share_amount" | "paid" | "due">): StatementState {
  if (s.status === "open") return s.month_over ? "to_close" : "running";
  if (s.share_amount <= 0) return "nothing_to_pay";
  if (s.due <= 0) return "paid";
  return s.paid > 0 ? "part_paid" : "to_pay";
}

export const STATE_LABEL: Record<StatementState, string> = {
  running: "Month running",
  to_close: "Waiting to be closed",
  to_pay: "Closed, to pay",
  part_paid: "Closed, part paid",
  paid: "Closed and paid",
  nothing_to_pay: "Closed, nothing to pay",
};

export type SchemeRow = { id: string; branch_id: string; from_month: string; starts_at: string; scheme: string; share_percent: number | null; tax_percent: number };

/** The way of paying in force now, and any change already planned. No row in force means per-unit. */
export function schemeNow(rows: SchemeRow[], now = Date.now()) {
  const sorted = [...rows].sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
  const started = sorted.filter((row) => Date.parse(row.starts_at) <= now);
  return { current: started[started.length - 1] ?? null, planned: sorted.filter((row) => Date.parse(row.starts_at) > now) };
}

/** "Monthly profit share: 50% to the partner, income tax 25%" or "Per-unit commission". */
export function describeScheme(row: Pick<SchemeRow, "scheme" | "share_percent" | "tax_percent"> | null) {
  if (!row || row.scheme !== "net_profit") return "Per-unit commission";
  return `Monthly profit share: ${percentText(row.share_percent === null ? null : Number(row.share_percent))}% to the partner, income tax ${percentText(Number(row.tax_percent))}%`;
}

const EVENT_LABEL: Record<string, string> = {
  method_set: "Way of paying changed",
  rates_set: "Percentages changed for this month",
  deduction_added: "Deduction added",
  deduction_removed: "Deduction removed",
  closed: "Month closed",
  reopened: "Month reopened",
};
export const eventLabel = (event: string) => EVENT_LABEL[event] ?? event;
