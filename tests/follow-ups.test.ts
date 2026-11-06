import { test } from "node:test";
import assert from "node:assert/strict";
import { daysBetween, dueState, dueText, followUpCounts, followUpProblem, nextDueOn, sortFollowUps, todayInIndia } from "../src/lib/follow-ups.ts";

test("today is the Indian calendar day", () => {
  // 6 Nov 2026 20:00 UTC is 7 Nov 01:30 in India.
  assert.equal(todayInIndia(Date.parse("2026-11-06T20:00:00Z")), "2026-11-07");
  assert.equal(todayInIndia(Date.parse("2026-11-06T12:00:00Z")), "2026-11-06");
});

test("due states and wording", () => {
  const today = "2026-11-06";
  const task = (dueOn: string, remindDays = 7, status: "open" | "done" | "cancelled" = "open") => ({ dueOn, remindDays, status });
  assert.equal(dueState(task("2026-11-01"), today), "overdue");
  assert.equal(dueState(task("2026-11-06"), today), "today");
  assert.equal(dueState(task("2026-11-13"), today), "soon");
  assert.equal(dueState(task("2026-11-14"), today), "later");
  assert.equal(dueState(task("2026-11-08", 0), today), "later");
  assert.equal(dueState(task("2026-11-01", 7, "done"), today), "done");
  assert.equal(dueText("2026-11-05", today), "1 day late");
  assert.equal(dueText("2026-11-01", today), "5 days late");
  assert.equal(dueText("2026-11-06", today), "due today");
  assert.equal(dueText("2026-11-07", today), "tomorrow");
  assert.equal(dueText("2026-12-06", today), "in 30 days");
  assert.equal(daysBetween("2026-12-31", "2027-01-01"), 1);
});

test("the next one of a repeating task, as the database makes it", () => {
  assert.equal(nextDueOn("2026-11-06", "none"), null);
  assert.equal(nextDueOn("2026-11-06", "year"), "2027-11-06");
  assert.equal(nextDueOn("2026-11-30", "quarter"), "2027-02-28");
  assert.equal(nextDueOn("2027-01-31", "month"), "2027-02-28");
  assert.equal(nextDueOn("2028-01-31", "month"), "2028-02-29");
  assert.equal(nextDueOn("2026-08-31", "half_year"), "2027-02-28");
});

test("most urgent first, counts for the dashboard", () => {
  const today = "2026-11-06";
  const tasks = [
    { id: "later", dueOn: "2027-01-01", remindDays: 7, status: "open" as const, doneAt: null },
    { id: "done", dueOn: "2026-10-01", remindDays: 7, status: "done" as const, doneAt: "2026-10-02T10:00:00Z" },
    { id: "late", dueOn: "2026-11-02", remindDays: 7, status: "open" as const, doneAt: null },
    { id: "soon", dueOn: "2026-11-10", remindDays: 7, status: "open" as const, doneAt: null },
    { id: "today", dueOn: "2026-11-06", remindDays: 7, status: "open" as const, doneAt: null },
  ];
  assert.deepEqual(sortFollowUps(tasks, today).map((t) => t.id), ["late", "today", "soon", "later", "done"]);
  assert.deepEqual(followUpCounts(tasks, today), { overdue: 2, soon: 1, open: 4 });
});

test("form checks", () => {
  assert.equal(followUpProblem({ title: "Renew the FSSAI licence", dueOn: "2027-03-31", remindDays: 30 }), null);
  assert.match(followUpProblem({ title: " ", dueOn: "2027-03-31", remindDays: 7 })!, /what has to be done/);
  assert.match(followUpProblem({ title: "Renew", dueOn: "", remindDays: 7 })!, /due date/);
  assert.match(followUpProblem({ title: "Renew", dueOn: "2027-03-31", remindDays: 120 })!, /0 to 90/);
});
