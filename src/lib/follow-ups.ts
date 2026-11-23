/*
 * Admin follow-ups (client's note, 6 Nov 2026): tasks assigned to employees, such as licence renewals, with a due date,
 * how early they show as due soon, and how often they repeat. Pure helpers, so the node tests can load them; the table
 * is public.follow_up_tasks and "done" goes through complete_follow_up_task().
 */

export const FOLLOW_UP_KINDS = [
  { value: "licence_renewal", label: "Licence renewal" },
  { value: "payment_follow_up", label: "Payment follow-up" },
  { value: "customer_follow_up", label: "Customer follow-up" },
  { value: "supplier_follow_up", label: "Supplier follow-up" },
  { value: "maintenance", label: "Maintenance" },
  { value: "other", label: "Other" },
] as const;
export type FollowUpKind = (typeof FOLLOW_UP_KINDS)[number]["value"];

export const FOLLOW_UP_REPEATS = [
  { value: "none", label: "Does not repeat" },
  { value: "month", label: "Every month" },
  { value: "quarter", label: "Every 3 months" },
  { value: "half_year", label: "Every 6 months" },
  { value: "year", label: "Every year" },
] as const;
export type FollowUpRepeat = (typeof FOLLOW_UP_REPEATS)[number]["value"];

export type FollowUpStatus = "open" | "done" | "cancelled";
export type FollowUpTask = {
  id: string; title: string; details: string; kind: FollowUpKind; employeeId: string | null; branchId: string | null;
  dueOn: string; repeatEvery: FollowUpRepeat; remindDays: number; status: FollowUpStatus;
  doneAt: string | null; doneNote: string; createdAt: string;
};

export const kindLabel = (kind: string) => FOLLOW_UP_KINDS.find((item) => item.value === kind)?.label ?? "Other";
export const repeatLabel = (repeat: string) => FOLLOW_UP_REPEATS.find((item) => item.value === repeat)?.label ?? "Does not repeat";

/** Today's date in India, as YYYY-MM-DD (due dates are calendar days there). */
export function todayInIndia(now = Date.now()) {
  return new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);
}

/** Whole days from one YYYY-MM-DD to another (negative when "to" is earlier). */
export function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export type DueState = "overdue" | "today" | "soon" | "later" | "done" | "cancelled";

/** Where a task stands today: late, due today, within its reminder days, later, or closed. */
export function dueState(task: Pick<FollowUpTask, "status" | "dueOn" | "remindDays">, today: string): DueState {
  if (task.status === "done") return "done";
  if (task.status === "cancelled") return "cancelled";
  const left = daysBetween(today, task.dueOn);
  if (left < 0) return "overdue";
  if (left === 0) return "today";
  return left <= task.remindDays ? "soon" : "later";
}

/** "3 days late", "due today", "in 5 days". */
export function dueText(dueOn: string, today: string) {
  const left = daysBetween(today, dueOn);
  if (left < 0) return left === -1 ? "1 day late" : `${-left} days late`;
  if (left === 0) return "due today";
  return left === 1 ? "tomorrow" : `in ${left} days`;
}

/** The next due date of a repeating task (the database makes that task when this one is done). */
export function nextDueOn(dueOn: string, repeat: FollowUpRepeat): string | null {
  const months = { none: 0, month: 1, quarter: 3, half_year: 6, year: 12 }[repeat];
  if (!months) return null;
  const [y, m, d] = dueOn.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  // The same day of the month, or the month's last day (31 Jan + 1 month = 28/29 Feb), as Postgres does.
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

const ORDER: Record<DueState, number> = { overdue: 0, today: 1, soon: 2, later: 3, done: 4, cancelled: 5 };

/** Open tasks first, the most urgent on top; closed ones after, the latest first. */
export function sortFollowUps<T extends Pick<FollowUpTask, "status" | "dueOn" | "remindDays" | "doneAt">>(tasks: readonly T[], today: string): T[] {
  return [...tasks].sort((a, b) => {
    const sa = ORDER[dueState(a, today)], sb = ORDER[dueState(b, today)];
    if (sa !== sb) return sa - sb;
    if (sa >= 4) return (b.doneAt ?? b.dueOn).localeCompare(a.doneAt ?? a.dueOn);
    return a.dueOn.localeCompare(b.dueOn);
  });
}

/** What the dashboard line counts: open tasks late or due today, and those due soon. */
export function followUpCounts(tasks: readonly Pick<FollowUpTask, "status" | "dueOn" | "remindDays">[], today: string) {
  let overdue = 0, soon = 0, open = 0;
  for (const task of tasks) {
    const state = dueState(task, today);
    if (state === "done" || state === "cancelled") continue;
    open += 1;
    if (state === "overdue" || state === "today") overdue += 1;
    else if (state === "soon") soon += 1;
  }
  return { overdue, soon, open };
}

/** What is wrong with a new or changed task, or null. */
export function followUpProblem(form: { title: string; dueOn: string; remindDays: number }): string | null {
  if (form.title.trim().length < 2) return "Write what has to be done";
  if (form.title.trim().length > 150) return "Keep the title under 150 characters";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.dueOn) || !Number.isFinite(Date.parse(form.dueOn))) return "Choose the due date";
  if (!Number.isInteger(form.remindDays) || form.remindDays < 0 || form.remindDays > 90) return "Show it as due soon 0 to 90 days before";
  return null;
}

/** The database row as the page uses it. */
export function followUpFromRow(row: {
  id: string; title: string; details: string; kind: string; employee_id: string | null; branch_id: string | null; due_on: string;
  repeat_every: string; remind_days: number; status: string; done_at: string | null; done_note: string; created_at: string;
}): FollowUpTask {
  return {
    id: row.id, title: row.title, details: row.details, kind: row.kind as FollowUpKind, employeeId: row.employee_id, branchId: row.branch_id,
    dueOn: row.due_on, repeatEvery: row.repeat_every as FollowUpRepeat, remindDays: Number(row.remind_days), status: row.status as FollowUpStatus,
    doneAt: row.done_at, doneNote: row.done_note, createdAt: row.created_at,
  };
}
