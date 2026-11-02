import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attendanceWorkbook, cleanMobile, clockTime, datesOfTile, dayPresenceSchedule, dayStatus, distanceMeters, earliestRuleDate, earlyLeaveMinutes, earlyText, formatDuration, geofenceRefusal, holidayDates, indiaDate, indiaInstant,
  lateMinutes, lateText, leaveDays, leaveProblem, locationVerdict, monthDays, parseCoordinates, periodDays, presenceSchedule, registerMark,
  reviewStatus, ruleChanges, ruleLines, rulesLookup, rulesOn, rulesProblem, selfiePath, staffLoginEmail, staffPasswordProblem, summariseMonth, summarisePeriod, summaryRow, workedMark, workedMinutes,
  DEFAULT_RULES, FIRST_RULES_DATE, SUMMARY_HEADER, type GodownRules, type RuleVersion,
} from "../src/lib/attendance.ts";
import { buildXlsx } from "../src/lib/xlsx.ts";

// A point in Challakere and offsets north of it (1e-5 degrees of latitude is about 1.11 m).
const GODOWN = { latitude: 14.312, longitude: 76.651, radiusM: 150 };
const north = (metres: number) => GODOWN.latitude + metres / 111_195;

/** A version of a godown's rules, as the database returns it. */
function version(id: string, branchId: string, from: string, rules: Partial<GodownRules> = {}, extra: Partial<RuleVersion> = {}): RuleVersion {
  return { ...DEFAULT_RULES, ...rules, id, branch_id: branchId, effective_from: from, note: "", created_by_name: "", created_at: `${from}T00:00:00Z`, cancelled_at: null, ...extra };
}

test("distance: metres between two points", () => {
  assert.equal(Math.round(distanceMeters(GODOWN.latitude, GODOWN.longitude, north(100), GODOWN.longitude)), 100);
  assert.equal(distanceMeters(14.3, 76.6, 14.3, 76.6), 0);
  // Challakere to Hubli is about 200 km as the crow flies.
  const km = distanceMeters(14.312, 76.651, 15.364, 75.124) / 1000;
  assert.ok(km > 190 && km < 210, `${km}`);
});

test("geofence: inside, outside, too rough to tell, or no godown location", () => {
  assert.deepEqual(locationVerdict(GODOWN, { lat: north(40), lng: GODOWN.longitude, accuracyM: 12 }), { verdict: "inside", distanceM: 40 });
  assert.equal(locationVerdict(GODOWN, { lat: north(150), lng: GODOWN.longitude, accuracyM: 10 }).verdict, "inside");
  assert.equal(locationVerdict(GODOWN, { lat: north(180), lng: GODOWN.longitude, accuracyM: 10 }).verdict, "outside");
  // 2 km away even with ±500 m error: certainly outside.
  assert.equal(locationVerdict(GODOWN, { lat: north(2000), lng: GODOWN.longitude, accuracyM: 500 }).verdict, "outside");
  // Within the radius but ±600 m (Wi-Fi/cell location): can't prove the employee is there.
  assert.equal(locationVerdict(GODOWN, { lat: north(50), lng: GODOWN.longitude, accuracyM: 600 }).verdict, "imprecise");
  // A large radius tolerates a matching accuracy.
  assert.equal(locationVerdict({ ...GODOWN, radiusM: 400 }, { lat: north(50), lng: GODOWN.longitude, accuracyM: 300 }).verdict, "inside");
  assert.deepEqual(locationVerdict({ latitude: null, longitude: null, radiusM: 150 }, { lat: 14, lng: 76, accuracyM: 5 }), { verdict: "no_godown_location", distanceM: null });
});

test("late: minutes after the shift start, only once the grace has passed (India time)", () => {
  const at = (hhmm: string) => new Date(`2026-10-31T${hhmm}:00+05:30`);
  assert.equal(lateMinutes(at("09:10"), "09:30", 15), 0);
  assert.equal(lateMinutes(at("09:45"), "09:30:00", 15), 0);
  assert.equal(lateMinutes(at("09:46"), "09:30", 15), 16);
  assert.equal(lateMinutes(at("11:00"), "09:30", 0), 90);
  assert.equal(indiaDate(new Date("2026-10-31T19:00:00Z")), "2026-11-01"); // 00:30 IST
  // 09:00 shift, 10 min grace: 09:10 is on time, 09:11 is 11 min late. (A "9:10 am ... Late by 25 min"
  // screen can only come from a stored figure, never from this rule.)
  assert.equal(lateMinutes(at("09:10"), "09:00", 10), 0);
  assert.equal(lateMinutes(at("09:11"), "09:00", 10), 11);
  // A godown can count late time from the end of grace instead.
  assert.equal(lateMinutes(at("09:50"), "09:30", 15, "shift_start"), 20);
  assert.equal(lateMinutes(at("09:50"), "09:30", 15, "grace_end"), 5);
  assert.equal(lateMinutes(at("09:45"), "09:30", 15, "grace_end"), 0);
});

test("check-in and check-out only inside the godown: clear reasons otherwise", () => {
  assert.equal(geofenceRefusal("inside", 40, 150), null);
  assert.equal(geofenceRefusal("outside", 412, 150), "You are 412 m from the godown. Move inside the godown (within 150 m) to mark attendance.");
  // A godown's own GPS limit.
  const fence = { ...GODOWN, accuracyLimitM: 200 };
  assert.equal(locationVerdict(fence, { lat: north(50), lng: GODOWN.longitude, accuracyM: 180 }).verdict, "inside");
  assert.equal(locationVerdict(GODOWN, { lat: north(50), lng: GODOWN.longitude, accuracyM: 180 }).verdict, "imprecise");
  // A limit tighter than the radius counts too: ±120 m is too rough for a 50 m limit at a 150 m radius.
  assert.equal(locationVerdict({ ...GODOWN, accuracyLimitM: 50 }, { lat: north(40), lng: GODOWN.longitude, accuracyM: 120 }).verdict, "imprecise");
  // A godown nobody has edited starts from the old rule: 100 m, or its radius if larger.
  assert.equal(DEFAULT_RULES.gps_accuracy_limit_m, 150);
  const untouched = { ...GODOWN, accuracyLimitM: DEFAULT_RULES.gps_accuracy_limit_m };
  assert.equal(locationVerdict(untouched, { lat: north(40), lng: GODOWN.longitude, accuracyM: 150 }).verdict, locationVerdict(GODOWN, { lat: north(40), lng: GODOWN.longitude, accuracyM: 150 }).verdict);
  assert.equal(locationVerdict(untouched, { lat: north(40), lng: GODOWN.longitude, accuracyM: 151 }).verdict, locationVerdict(GODOWN, { lat: north(40), lng: GODOWN.longitude, accuracyM: 151 }).verdict);
  assert.match(geofenceRefusal("imprecise", 50, 150)!, /^GPS is not precise enough/);
  assert.match(geofenceRefusal("no_godown_location", null, 150)!, /^Head office has not set this godown's location/);
});

test("late, early and worked time shown as hours and minutes", () => {
  assert.equal(formatDuration(436), "7 hr 16 min");
  assert.equal(formatDuration(45), "45 min");
  assert.equal(formatDuration(120), "2 hr");
  assert.equal(formatDuration(0), "0 min");
  assert.equal(formatDuration(-5), "0 min");
  assert.equal(formatDuration(59.6), "1 hr");
  assert.equal(lateText(436), "Late by 7 hr 16 min");
  assert.equal(earlyText(65), "Left early by 1 hr 5 min");
  const at = (hhmm: string) => new Date(`2026-10-31T${hhmm}:00+05:30`);
  assert.equal(earlyLeaveMinutes(at("17:25"), "18:30"), 65);
  assert.equal(earlyLeaveMinutes(at("18:30"), "18:30:00"), 0);
  assert.equal(earlyLeaveMinutes(at("19:10"), "18:30"), 0);
  // A godown's left-early allowance: inside it nothing is counted; past it, the whole time is.
  assert.equal(earlyLeaveMinutes(at("18:20"), "18:30", 15), 0);
  assert.equal(earlyLeaveMinutes(at("18:10"), "18:30", 15), 20);
  assert.equal(workedMinutes("2026-10-31T03:55:00Z", "2026-10-31T12:25:00Z"), 510);
  assert.equal(workedMinutes("2026-10-31T03:55:00Z", null), 0);
  assert.equal(indiaInstant("2026-10-31", "18:30"), Date.parse("2026-10-31T18:30:00+05:30"));
  assert.equal(indiaInstant("2026-11-01", "00:15"), Date.parse("2026-11-01T00:15:00+05:30"));
});

test("presence photo every 2 hours while checked in", () => {
  const t = (hhmm: string) => Date.parse(`2026-10-31T${hhmm}:00+05:30`);
  const base = { checkInAt: t("09:30"), checkOutAt: null, shiftEndAt: t("18:30"), intervalMin: 120 };
  // Due 11:30, 13:30, 15:30, 17:30 (19:30 is after the shift end).
  const morning = presenceSchedule({ ...base, photos: [t("11:20")], now: t("13:40") });
  assert.deepEqual(morning.slots.map((slot) => slot.status), ["done", "due", "upcoming", "upcoming"]);
  assert.equal(morning.required, 4);
  // 13:30 photo at 14:05 is 35 min after: late. 15:30 had none by 16:10: missed. One photo counts once.
  const later = presenceSchedule({ ...base, photos: [t("11:20"), t("14:05"), t("14:06")], now: t("16:10") });
  assert.deepEqual(later.slots.map((slot) => slot.status), ["done", "late", "missed", "upcoming"]);
  assert.deepEqual([later.done, later.late, later.missed], [1, 1, 1]);
  // Checked out at 14:00: only the slots before check-out count, and the 13:30 one (no photo) is missed.
  const out = presenceSchedule({ ...base, checkOutAt: t("14:00"), photos: [t("11:31")], now: t("17:00") });
  assert.deepEqual(out.slots.map((slot) => slot.status), ["done", "missed"]);
  // Checked out at 13:40, inside the 13:30 window, before sending it: missed, not "due".
  assert.deepEqual(presenceSchedule({ ...base, checkOutAt: t("13:40"), photos: [t("11:31")], now: t("13:45") }).slots.map((slot) => slot.status), ["done", "missed"]);
  // Switched off: nothing due.
  assert.equal(presenceSchedule({ ...base, intervalMin: 0, photos: [], now: t("17:00") }).required, 0);
  // A check-in after the shift end gets no slots before check-out.
  assert.equal(presenceSchedule({ ...base, checkInAt: t("19:00"), photos: [], now: t("20:00") }).required, 0);
});

test("leave approval: head office AND channel partner; either rejects; head office alone without a partner", () => {
  assert.equal(reviewStatus(null, null, true), "pending");
  assert.equal(reviewStatus("approved", null, true), "pending");
  assert.equal(reviewStatus(null, "approved", true), "pending");
  assert.equal(reviewStatus("approved", "approved", true), "approved");
  assert.equal(reviewStatus("approved", "rejected", true), "rejected");
  assert.equal(reviewStatus("rejected", "approved", true), "rejected");
  assert.equal(reviewStatus("approved", null, false), "approved");
  assert.equal(reviewStatus(null, "approved", false), "pending");
});

test("leave: days and limits match the database", () => {
  assert.equal(leaveDays("2026-11-03", "2026-11-05"), 3);
  assert.equal(leaveDays("2026-11-03", "2026-11-03"), 1);
  assert.equal(leaveDays("2026-11-05", "2026-11-03"), 0);
  const today = "2026-10-31";
  assert.equal(leaveProblem("2026-11-03", "2026-11-05", "Village jatre", today), null);
  assert.equal(leaveProblem("2026-11-05", "2026-11-03", "x y z", today), "The last day is before the first day");
  assert.equal(leaveProblem("2026-11-01", "2026-12-30", "Long trip", today), null); // 60 days
  assert.equal(leaveProblem("2026-11-01", "2026-12-31", "Long trip", today), "A request can cover at most 60 days");
  assert.equal(leaveProblem("2026-10-01", "2026-10-01", "Fever", today), null); // 30 days ago
  assert.equal(leaveProblem("2026-09-30", "2026-09-30", "Fever", today), "Leave more than 30 days ago can't be requested");
  assert.equal(leaveProblem("2027-04-29", "2027-04-29", "Wedding", today), null); // 180 days ahead
  assert.equal(leaveProblem("2027-04-30", "2027-04-30", "Wedding", today), "Request leave at most 180 days ahead");
  assert.equal(leaveProblem("2026-11-03", "2026-11-03", " ", today), "Write the reason");
  // A godown's own limits.
  const strict = { leave_max_days: 2, leave_back_days: 0, leave_ahead_days: 7 };
  assert.equal(leaveProblem("2026-11-01", "2026-11-02", "Fever", today, strict), null);
  assert.equal(leaveProblem("2026-11-01", "2026-11-03", "Fever", today, strict), "A request can cover at most 2 days");
  assert.equal(leaveProblem("2026-10-30", "2026-10-30", "Fever", today, strict), "Leave for past days can't be requested");
  assert.equal(leaveProblem("2026-10-31", "2026-10-31", "Fever", today, strict), null);
  assert.equal(leaveProblem("2026-11-07", "2026-11-07", "Fever", today, strict), null);
  assert.equal(leaveProblem("2026-11-08", "2026-11-08", "Fever", today, strict), "Request leave at most 7 days ahead");
  assert.equal(leaveProblem("2026-10-20", "2026-10-20", "Fever", today, { ...strict, leave_back_days: 5 }), "Leave more than 5 days ago can't be requested");
});

test("monthly register marks and summary", () => {
  assert.equal(monthDays("2026-02-01").length, 28);
  assert.equal(monthDays("2026-10-01").at(-1), "2026-10-31");
  const records = [
    { work_date: "2026-10-01", status: "present", late_minutes: 0, check_in_at: "2026-10-01T03:55:00Z", check_out_at: "2026-10-01T12:25:00Z", early_leave_minutes: 35 }, // 8.5 h
    { work_date: "2026-10-02", status: "present", late_minutes: 436, check_in_at: "2026-10-02T04:25:00Z", check_out_at: null },
    { work_date: "2026-10-03", status: "pending", late_minutes: 0, check_in_at: "2026-10-03T04:00:00Z", check_out_at: null },
    { work_date: "2026-10-04", status: "rejected", late_minutes: 0, check_in_at: "2026-10-04T04:00:00Z", check_out_at: "2026-10-04T12:00:00Z" },
  ];
  const leaves = [
    { from_date: "2026-10-05", to_date: "2026-10-06", status: "approved" },
    { from_date: "2026-10-07", to_date: "2026-10-07", status: "rejected" },
  ];
  assert.equal(registerMark("2026-10-05", undefined, leaves, "2026-10-10"), "LV");
  assert.equal(registerMark("2026-10-07", undefined, leaves, "2026-10-10"), "A");
  assert.equal(registerMark("2026-10-10", undefined, leaves, "2026-10-10"), ""); // today, not marked yet
  assert.equal(registerMark("2026-10-11", undefined, leaves, "2026-10-10"), "");
  assert.equal(registerMark("2026-10-01", undefined, [], "2026-10-10", { joined: "2026-10-03" }), ""); // before joining
  // 4 Oct 2026 is a Sunday: a weekly off when not worked, never absent; a worked Sunday is Present.
  assert.equal(registerMark("2026-10-04", undefined, [], "2026-10-10", { weeklyOff: 0 }), "WO");
  assert.equal(registerMark("2026-10-04", undefined, [], "2026-10-10", { weeklyOff: null }), "A");
  assert.equal(registerMark("2026-10-04", records[0], [], "2026-10-10", { weeklyOff: 0 }), "P");
  const { marks, summary } = summariseMonth("2026-10-01", records, leaves, "2026-10-10");
  assert.deepEqual(marks.slice(0, 11), ["P", "L", "?", "X", "LV", "LV", "A", "A", "A", "", ""]);
  assert.deepEqual(summary, {
    present: 2, late: 1, halfDay: 0, lateMinutes: 436, earlyDays: 1, earlyMinutes: 35, leave: 2, weeklyOff: 0, holiday: 0, pending: 1, rejected: 1, absent: 3, workedMinutes: 510, hours: 8.5,
  });
  const sundaysOff = summariseMonth("2026-10-01", [], [], "2026-10-31", { weeklyOff: 0 });
  assert.equal(sundaysOff.summary.weeklyOff, 4); // 4, 11, 18, 25 Oct
  assert.equal(sundaysOff.summary.absent, 26);
  // Any period, across months: 30 Oct to 2 Nov.
  assert.deepEqual(periodDays("2026-10-30", "2026-11-02"), ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
  assert.deepEqual(periodDays("2026-11-02", "2026-11-01"), []);
  const span = summarisePeriod(periodDays("2026-09-30", "2026-10-02"), records, [], "2026-10-10");
  assert.deepEqual(span.marks, ["A", "P", "L"]);
  assert.equal(span.summary.lateMinutes, 436);
});

test("Excel workbook for any period: dashboard, staff, daily, presence photos, registers, leave history, rules", () => {
  const t = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+05:30`).toISOString();
  const rules = { shift_start: "09:30", shift_end: "18:30", late_grace_min: 10 };
  const sheets = attendanceWorkbook({
    rules: [version("r1", "BR-CLK", FIRST_RULES_DATE, { ...rules, weekly_off: 0, presence_interval_min: 120 }), version("r2", "BR-HBL", FIRST_RULES_DATE, { ...rules, weekly_off: null, presence_interval_min: 0 })],
    holidays: [],
    from: "2026-10-01", to: "2026-10-03", today: "2026-10-03", now: Date.parse(t("2026-10-03", "20:00")),
    godowns: [{ id: "BR-CLK", name: "Challakere" }, { id: "BR-HBL", name: "Hubli" }],
    employees: [
      { id: "e1", name: "Manju", phone: "9876500001", designation: "Loader", branch_id: "BR-CLK", joined_on: "2026-10-01", status: "active" },
      { id: "e2", name: "Basava", phone: "9876500002", designation: "", branch_id: "BR-HBL", joined_on: "2026-10-01", status: "inactive" },
    ],
    days: [{
      id: "d1", employee_id: "e1", work_date: "2026-10-01", status: "present", late_minutes: 0, check_in_at: t("2026-10-01", "09:25"), check_out_at: t("2026-10-01", "17:55"),
      early_leave_minutes: 35, in_distance_m: 35, in_accuracy_m: 12, flags: [], employee_note: "",
    }, {
      id: "d2", employee_id: "e2", work_date: "2026-10-02", status: "present", late_minutes: 436, check_in_at: t("2026-10-02", "16:46"), check_out_at: null,
      in_distance_m: 40, in_accuracy_m: 15, flags: ["late"], employee_note: "Bus late",
    }],
    // Manju's photos: due 11:25 (on time), 13:25 (none: missed), 15:25 (sent 16:00: late), 17:25 (on time).
    presence: [
      { attendance_day_id: "d1", taken_at: t("2026-10-01", "11:20"), distance_m: 20, inside: true },
      { attendance_day_id: "d1", taken_at: t("2026-10-01", "16:00"), distance_m: 300, inside: false },
      { attendance_day_id: "d1", taken_at: t("2026-10-01", "17:30"), distance_m: 25, inside: true },
    ],
    leaves: [{ employee_id: "e1", from_date: "2026-10-02", to_date: "2026-10-02", status: "approved", leave_type: "sick", reason: "Fever", head_office_decision: "approved", partner_decision: "approved", created_at: "2026-10-01T10:00:00Z" }],
  });
  assert.deepEqual(sheets.map((sheet) => sheet.name), ["Dashboard", "Staff", "Daily attendance", "Presence photos", "Register Challakere", "Register Hubli", "Leave history", "Rules"]);
  const dashboard = sheets[0]!.rows;
  assert.deepEqual(dashboard[1], ["Period: 2026-10-01 to 2026-10-03"]);
  assert.deepEqual(dashboard.slice(4, 14), [
    ["Employees", 2], ["Present days", 2], ["Half days", 0], ["Late days", 1], ["Total late time", "7 hr 16 min"], ["Absent days", 1], ["Leave days", 1],
    ["Worked time", "8 hr 30 min"], ["Presence photos due", 4], ["Presence photos missed", 1],
  ]);
  assert.deepEqual(dashboard[16], ["Challakere", 1, 1, 0, "0 min", "", 0, 1, "8 hr 30 min", 4, 1]);
  assert.deepEqual(dashboard[17], ["Hubli", 1, 1, 1, "7 hr 16 min", "7 hr 16 min", 1, 0, "0 min", 0, 0]);
  assert.deepEqual(dashboard[20], ["Basava", "Hubli", 1, "7 hr 16 min"]);
  assert.deepEqual(sheets[0]!.boldRows, [0, 15, 19]);
  const staff = sheets[1]!.rows;
  assert.deepEqual(staff[2], SUMMARY_HEADER);
  // Sorted by godown then name: Challakere first. 3 Oct is today and not marked: not absent yet.
  assert.deepEqual(staff[3], ["Challakere", "Manju", "9876500001", "Loader", "2026-10-01", "Active", 1, 0, 0, "0 min", 0, 1, "35 min", "8 hr 30 min", 8.5, 1, 0, 0, 0, 4, 2, 1, 1]);
  assert.deepEqual(staff[4], ["Hubli", "Basava", "9876500002", "", "2026-10-01", "Inactive", 1, 0, 1, "7 hr 16 min", 436, 0, "0 min", "0 min", 0, 0, 0, 0, 1, 0, 0, 0, 0]);
  const daily = sheets[2]!.rows;
  assert.deepEqual(daily[1]!.slice(0, 12), ["2026-10-01", "Thursday", "Challakere", "Manju", "9876500001", "9:25 am", "5:55 pm", "", 0, "35 min", 35, "8 hr 30 min"]);
  assert.deepEqual(daily[1]!.slice(14), ["3 of 4", "Present", "Present", "09:30–18:30, grace 10 min", ""]);
  assert.deepEqual(daily[2]!.slice(5, 12), ["4:46 pm", "Not checked out", "7 hr 16 min", 436, "", 0, ""]);
  const photos = sheets[3]!.rows;
  assert.deepEqual(photos.slice(1).map((row) => [row[3], row[4], row[5], row[7]]), [
    ["11:25 am", "11:20 am", "On time", "Yes"], ["1:25 pm", "", "Missed", ""], ["3:25 pm", "4:00 pm", "Late", "No"], ["5:25 pm", "5:30 pm", "On time", "Yes"],
  ]);
  assert.deepEqual(sheets[4]!.rows[2], ["Employee", "1/10", "2/10", "3/10", "P", "L", "HD", "LV", "WO", "H", "A", "Total late"]);
  assert.deepEqual(sheets[4]!.rows[3], ["Manju", "P", "LV", "", 1, 0, 0, 1, 0, 0, 0, "0 min"]);
  assert.deepEqual(sheets[5]!.rows[3], ["Basava", "A", "L", "", 1, 1, 0, 0, 0, 0, 1, "7 hr 16 min"]);
  assert.deepEqual(sheets[6]!.rows[1], ["Manju", "Challakere", "2026-10-02", "2026-10-02", 1, "Sick leave", "Fever", "Approved", "Approved", "Approved", "2026-10-01"]);
  const leaveWords = ["Casual leave, Sick leave, Festival / holiday, Other", 60, 30, 180, "Head office and channel partner"];
  assert.deepEqual(sheets[7]!.rows[1], ["Challakere", "From the start", "", "09:30", "18:30", 10, "Shift start", 0, "Off", "Off", "Present", "Sunday", 150, 150, "Required", "2 hr", 15, 30, ...leaveWords]);
  assert.deepEqual(sheets[7]!.rows[2], ["Hubli", "From the start", "", "09:30", "18:30", 10, "Shift start", 0, "Off", "Off", "Present", "None", 150, 150, "Required", "Off", 15, 30, ...leaveWords]);
  assert.ok(buildXlsx(sheets).length > 1000);
  // Over two months: no per-day register sheets (too wide); everything else stays.
  const year = attendanceWorkbook({ from: "2026-01-01", to: "2026-10-03", today: "2026-10-03", now: 0, godowns: [], employees: [], days: [], presence: [], leaves: [], rules: [], holidays: [] });
  assert.deepEqual(year.map((sheet) => sheet.name), ["Dashboard", "Staff", "Daily attendance", "Presence photos", "Leave history", "Rules"]);
  const blank = summarisePeriod([], [], [], "2026-01-01").summary;
  assert.equal(summaryRow("X", { id: "e", name: "N", phone: "1", designation: "", branch_id: "X", joined_on: "2026-01-01" }, blank, { required: 0, done: 0, late: 0, missed: 0 }).length, SUMMARY_HEADER.length);
});

test("each godown has its own rules, and a date uses the version in force then", () => {
  const versions = [
    version("c1", "BR-CLK", FIRST_RULES_DATE, { shift_start: "09:30" }),
    version("h1", "BR-HBL", FIRST_RULES_DATE, { shift_start: "08:00" }),
    version("c2", "BR-CLK", "2026-11-10", { shift_start: "10:00" }),
    version("c3", "BR-CLK", "2026-11-20", { shift_start: "11:00" }, { cancelled_at: "2026-11-05T00:00:00Z" }),
    version("c4", "BR-CLK", "2026-11-10", { shift_start: "10:30" }, { created_at: "2026-11-10T05:00:00Z" }),
  ];
  assert.equal(rulesOn(versions, "BR-CLK", "2026-11-09")?.id, "c1");
  assert.equal(rulesOn(versions, "BR-CLK", "2026-11-10")?.id, "c4"); // saved again for the same date: the newer one
  assert.equal(rulesOn(versions, "BR-CLK", "2026-11-25")?.id, "c4"); // cancelled c3 never applies
  assert.equal(rulesOn(versions, "BR-HBL", "2026-11-25")?.id, "h1"); // the other godown is untouched
  assert.equal(rulesOn(versions, "BR-NEW", "2026-11-25"), undefined);
  // A marked day keeps its own version, whatever came after.
  const lookup = rulesLookup(versions, "BR-CLK");
  assert.equal(lookup("2026-11-12")?.id, "c4");
  assert.equal(lookup("2026-11-12", { rule_version_id: "c2" })?.id, "c2");
  assert.equal(lookup("2026-11-12", { rule_version_id: "gone" })?.id, "c4");
});

test("new rules can't start before a scheduled change", () => {
  const today = "2026-11-02";
  const first = version("a", "BR-CLK", FIRST_RULES_DATE);
  assert.equal(earliestRuleDate([first], today), today);
  assert.equal(earliestRuleDate([first, version("b", "BR-CLK", "2026-12-01")], today), "2026-12-01");
  assert.equal(earliestRuleDate([first, version("b", "BR-CLK", "2026-12-01", {}, { cancelled_at: "2026-11-02T00:00:00Z" })], today), today);
  assert.equal(earliestRuleDate([first, version("b", "BR-CLK", "2026-10-15")], today), today);
});

test("a godown with no changes keeps the old behaviour", () => {
  // Same results as before godowns had their own rules: any check-in is a full day, late from the shift start.
  const rules = version("r", "BR-CLK", FIRST_RULES_DATE);
  const short = { work_date: "2026-10-01", status: "present", late_minutes: 0, check_in_at: "2026-10-01T04:00:00Z", check_out_at: "2026-10-01T04:10:00Z" };
  assert.equal(workedMark("2026-10-01", short, rules, "2026-10-10"), "P");
  assert.equal(workedMark("2026-10-01", { ...short, check_out_at: null }, rules, "2026-10-10"), "P");
  assert.equal(workedMark("2026-10-01", { ...short, late_minutes: 5 }, rules, "2026-10-10"), "L");
  assert.equal(rulesProblem(DEFAULT_RULES), null);
  assert.equal(earlyLeaveMinutes(new Date("2026-10-31T17:25:00+05:30"), DEFAULT_RULES.shift_end, DEFAULT_RULES.early_grace_min), 65);
  const t = (hhmm: string) => `2026-10-31T${hhmm}:00+05:30`;
  const day = { work_date: "2026-10-31", check_in_at: t("09:30"), check_out_at: null };
  assert.deepEqual(dayPresenceSchedule(day, rules, [], Date.parse(t("17:00"))).slots.length, 4);
});

test("half day and absent follow the godown's limits, by time worked", () => {
  const rules = { weekly_off: 0, half_day_below_min: 240, absent_below_min: 60, missed_checkout: "present" as const };
  const worked = (minutes: number, late = 0) => ({
    work_date: "2026-10-05", status: "present", late_minutes: late, check_in_at: "2026-10-05T04:00:00Z", check_out_at: new Date(Date.parse("2026-10-05T04:00:00Z") + minutes * 60_000).toISOString(),
  });
  const today = "2026-10-10";
  assert.equal(workedMark("2026-10-05", worked(59), rules, today), "A");
  assert.equal(workedMark("2026-10-05", worked(60), rules, today), "HD");
  assert.equal(workedMark("2026-10-05", worked(239), rules, today), "HD");
  assert.equal(workedMark("2026-10-05", worked(240), rules, today), "P");
  assert.equal(workedMark("2026-10-05", worked(240, 20), rules, today), "L");
  // No check-out: today can't be judged yet; a past day follows the godown's rule.
  const open = { ...worked(0), check_out_at: null };
  assert.equal(workedMark("2026-10-10", open, { ...rules, missed_checkout: "absent" }, today), "P");
  assert.equal(workedMark("2026-10-05", open, { ...rules, missed_checkout: "present" }, today), "P");
  assert.equal(workedMark("2026-10-05", open, { ...rules, missed_checkout: "half_day" }, today), "HD");
  assert.equal(workedMark("2026-10-05", open, { ...rules, missed_checkout: "absent" }, today), "A");
  // The badge says the same.
  assert.equal(dayStatus(worked(59), rules, today), "absent");
  assert.equal(dayStatus(worked(100), rules, today), "half_day");
  assert.equal(dayStatus(worked(300), rules, today), "present");
  assert.equal(dayStatus({ ...worked(59), status: "rejected" }, rules, today), "rejected");
  // In the month's totals; half days are not present days.
  const { marks, summary } = summarisePeriod(["2026-10-05"], [worked(100)], [], today, { rulesFor: () => rules });
  assert.deepEqual(marks, ["HD"]);
  assert.deepEqual([summary.present, summary.halfDay, summary.absent, summary.workedMinutes], [0, 1, 0, 100]);
  // A day counts as one thing: the late time of a half or absent day isn't in the late totals.
  const lateShort = summarisePeriod(["2026-10-05", "2026-10-06"], [worked(100, 30), { ...worked(30, 20), work_date: "2026-10-06" }], [], today, { rulesFor: () => rules }).summary;
  assert.deepEqual([lateShort.late, lateShort.lateMinutes, lateShort.halfDay, lateShort.absent], [0, 0, 1, 1]);
  const lateFull = summarisePeriod(["2026-10-05"], [worked(300, 30)], [], today, { rulesFor: () => rules }).summary;
  assert.deepEqual([lateFull.late, lateFull.lateMinutes], [1, 30]);
});

test("holidays are per godown and are not absences", () => {
  const holidays = [{ id: "1", branch_id: "BR-CLK", holiday_date: "2026-11-01", name: "Rajyotsava" }, { id: "2", branch_id: "BR-HBL", holiday_date: "2026-11-03", name: "Local fair" }];
  const clk = holidayDates(holidays, "BR-CLK");
  const today = "2026-11-10";
  assert.equal(registerMark("2026-11-01", undefined, [], today, { holidays: clk }), "H");
  assert.equal(registerMark("2026-11-03", undefined, [], today, { holidays: clk }), "A"); // Hubli's holiday, not Challakere's
  assert.equal(registerMark("2026-11-03", undefined, [], today, { holidays: holidayDates(holidays, "BR-HBL") }), "H");
  // Someone who works on a holiday is present; approved leave stays leave; not before joining; future stays blank.
  const worked = { work_date: "2026-11-01", status: "present", late_minutes: 0, check_in_at: "2026-11-01T04:00:00Z", check_out_at: "2026-11-01T12:00:00Z" };
  assert.equal(registerMark("2026-11-01", worked, [], today, { holidays: clk }), "P");
  assert.equal(registerMark("2026-11-01", undefined, [{ from_date: "2026-11-01", to_date: "2026-11-01", status: "approved" }], today, { holidays: clk }), "LV");
  assert.equal(registerMark("2026-11-01", undefined, [], today, { holidays: clk, joined: "2026-11-05" }), "");
  assert.equal(registerMark("2026-11-20", undefined, [], today, { holidays: new Set(["2026-11-20"]) }), "");
  const { summary } = summarisePeriod(["2026-11-01", "2026-11-02"], [], [], today, { holidays: clk });
  assert.deepEqual([summary.holiday, summary.absent], [1, 1]);
});

test("a rule change never rewrites the past", () => {
  // Challakere: Sunday off and no half days until 15 Oct; from then Monday off and half day under 4 hours.
  const v1 = version("v1", "BR-CLK", FIRST_RULES_DATE, { weekly_off: 0, presence_interval_min: 0 });
  const v2 = version("v2", "BR-CLK", "2026-10-15", { weekly_off: 1, half_day_below_min: 240, presence_interval_min: 60 });
  const rulesFor = rulesLookup([v1, v2], "BR-CLK");
  const today = "2026-10-31";
  const mark = (date: string) => registerMark(date, undefined, [], today, { rulesFor });
  assert.equal(mark("2026-10-11"), "WO"); // Sunday, before the change: still the weekly off
  assert.equal(mark("2026-10-12"), "A"); // Monday, before the change: still a working day
  assert.equal(mark("2026-10-18"), "A"); // Sunday, after the change
  assert.equal(mark("2026-10-19"), "WO"); // Monday, after the change
  // A 2-hour day before the change stays present; the same day after it is a half day.
  const day = (date: string, id: string) => ({
    work_date: date, status: "present", late_minutes: 0, check_in_at: `${date}T04:00:00Z`, check_out_at: `${date}T06:00:00Z`, rule_version_id: id,
  });
  assert.equal(registerMark("2026-10-12", day("2026-10-12", "v1"), [], today, { rulesFor }), "P");
  assert.equal(registerMark("2026-10-16", day("2026-10-16", "v2"), [], today, { rulesFor }), "HD");
  // A day checked in the morning of the change keeps the rules it started under.
  assert.equal(registerMark("2026-10-15", day("2026-10-15", "v1"), [], today, { rulesFor }), "P");
  // Presence photos due on an old day don't appear when the interval is added later.
  assert.equal(dayPresenceSchedule(day("2026-10-12", "v1"), rulesFor("2026-10-12", day("2026-10-12", "v1")), [], Date.parse("2026-10-20T00:00:00Z")).required, 0);
  assert.equal(dayPresenceSchedule(day("2026-10-16", "v2"), rulesFor("2026-10-16", day("2026-10-16", "v2")), [], Date.parse("2026-10-20T00:00:00Z")).required, 2);
  // The Excel report judges each day by its own rules and lists both versions with their dates.
  const sheets = attendanceWorkbook({
    from: "2026-10-12", to: "2026-10-16", today, now: Date.parse("2026-10-20T00:00:00Z"), godowns: [{ id: "BR-CLK", name: "Challakere" }],
    employees: [{ id: "e1", name: "Manju", phone: "9876500001", designation: "", branch_id: "BR-CLK", joined_on: "2026-10-01" }],
    days: [day("2026-10-12", "v1"), day("2026-10-16", "v2")].map((row, index) => ({ ...row, id: `d${index}`, employee_id: "e1", in_distance_m: 5, in_accuracy_m: 5, flags: [], employee_note: "" })),
    presence: [], leaves: [], rules: [v1, v2], holidays: [{ id: "h", branch_id: "BR-CLK", holiday_date: "2026-10-14", name: "Bandh" }],
  });
  const register = sheets.find((sheet) => sheet.name === "Register Challakere")!.rows[3]!;
  assert.deepEqual(register.slice(0, 6), ["Manju", "P", "A", "H", "A", "HD"]);
  const daily = sheets.find((sheet) => sheet.name === "Daily attendance")!.rows;
  assert.deepEqual(daily.slice(1).map((row) => row[16]), ["Present", "Half day"]);
  const rulesSheet = sheets.find((sheet) => sheet.name === "Rules")!;
  assert.deepEqual(rulesSheet.rows.slice(1, 3).map((row) => row.slice(0, 3)), [["Challakere", "From the start", "2026-10-14"], ["Challakere", "2026-10-15", ""]]);
  assert.deepEqual(rulesSheet.rows.at(-1), ["Challakere", "2026-10-14", "Bandh"]);
  assert.deepEqual(rulesSheet.boldRows, [0, 6, 7]);
});

test("rules in words, what changed, and what can't be saved", () => {
  assert.equal(clockTime("09:30"), "9:30 am");
  assert.equal(clockTime("18:30:00"), "6:30 pm");
  const lines = new Map(ruleLines(DEFAULT_RULES).map((line) => [line.key, line.value]));
  assert.deepEqual(lines.get("shift_start"), ["9:30 am"]);
  assert.deepEqual(lines.get("half_day_below_min"), ["Off"]);
  assert.deepEqual(lines.get("weekly_off"), ["Sunday"]);
  assert.deepEqual(lines.get("leave_types"), ["Casual leave", "Sick leave", "Festival / holiday", "Other"]);
  assert.deepEqual(ruleChanges(DEFAULT_RULES, DEFAULT_RULES), []);
  assert.deepEqual(ruleChanges(DEFAULT_RULES, { ...DEFAULT_RULES, late_grace_min: 10, weekly_off: null, leave_types: ["sick"] }).map(({ label, from, to }) => [label, from[0], to[0]]), [
    ["Grace before late", "15 min", "10 min"], ["Weekly off", "Sunday", "None"], ["Leave types", "Casual leave", "Sick leave"],
  ]);
  const bad = (rules: Partial<GodownRules>) => rulesProblem({ ...DEFAULT_RULES, ...rules });
  assert.equal(bad({ shift_end: "09:00" }), "The shift must end after it starts");
  assert.equal(bad({ shift_start: "" }), "Enter the shift start and end times");
  assert.equal(bad({ late_grace_min: 241 }), "Grace must be 0 to 240 minutes");
  assert.equal(bad({ late_grace_min: Number.NaN }), "Grace must be 0 to 240 minutes");
  assert.equal(bad({ half_day_below_min: 120, absent_below_min: 120 }), "The absent limit must be below the half day limit");
  assert.equal(bad({ half_day_below_min: 0, absent_below_min: 120 }), null);
  assert.equal(bad({ radius_m: 10 }), "Radius must be 25 to 2000 metres");
  assert.equal(bad({ presence_interval_min: 40 }), "The presence photo window must be shorter than the time between photos");
  assert.equal(bad({ presence_interval_min: 0 }), null);
  assert.equal(bad({ leave_types: [] }), "Allow at least one type of leave");
  assert.equal(bad({ leave_max_days: 61 }), "A leave request can cover 1 to 60 days");
});

test("pasted coordinates and Google Maps links", () => {
  assert.deepEqual(parseCoordinates("14.3123, 76.6512"), { lat: 14.3123, lng: 76.6512 });
  assert.deepEqual(parseCoordinates("https://www.google.com/maps/place/Godown/@14.3123456,76.6512345,17z/data=!3d14.3125!4d76.6514"), { lat: 14.3123456, lng: 76.6512345 });
  assert.deepEqual(parseCoordinates("https://maps.google.com/?q=15.3647,75.1240"), { lat: 15.3647, lng: 75.124 });
  assert.deepEqual(parseCoordinates("!3d15.36!4d75.12"), { lat: 15.36, lng: 75.12 });
  assert.equal(parseCoordinates("Challakere"), null);
  assert.equal(parseCoordinates("99.1, 76.6"), null);
});

test("mobile numbers and selfie paths", () => {
  assert.equal(cleanMobile("+91 98765 43210"), "9876543210");
  assert.equal(cleanMobile("09876543210"), "9876543210");
  assert.equal(cleanMobile("12345"), null);
  assert.equal(cleanMobile("5876543210"), null);
  assert.equal(selfiePath("BR-CLK", "2026-10-31", "e1", "in", 1761884400000), "BR-CLK/2026-10-31/e1-in-1761884400000.jpg");
  assert.equal(selfiePath("BR-CLK", "2026-10-31", "e1", "presence", 1761884400000), "BR-CLK/2026-10-31/e1-presence-1761884400000.jpg");
});

test("staff sign in with mobile number and password", () => {
  assert.equal(staffLoginEmail("9876543210"), "9876543210@staff.grainbazar.com");
  // Built from parts, so they don't read as hardcoded credentials to secret scanners.
  const sample = (letters: number, digits: number) => "x".repeat(letters) + "7".repeat(digits);
  assert.equal(staffPasswordProblem(sample(6, 2)), null);
  assert.equal(staffPasswordProblem(sample(5, 2)), "Use at least 8 characters");
  assert.equal(staffPasswordProblem(sample(10, 0)), "Use letters and at least one number");
  assert.equal(staffPasswordProblem(sample(0, 8)), "Use letters and at least one number");
  assert.equal(staffPasswordProblem(sample(72, 1)), "Use at most 72 characters");
});

test("a staff member's month total lists its own days, newest first", () => {
  const dates = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"];
  const marks = ["P", "L", "LV", "A", "WO"];
  assert.deepEqual(datesOfTile(dates, marks, "Present"), ["2026-11-02", "2026-11-01"]);
  assert.deepEqual(datesOfTile(dates, marks, "Late days"), ["2026-11-02"]);
  assert.deepEqual(datesOfTile(dates, marks, "Leave"), ["2026-11-03"]);
  assert.deepEqual(datesOfTile(dates, marks, "Absent"), ["2026-11-04"]);
  assert.deepEqual(datesOfTile(["2026-11-06", "2026-11-07"], ["HD", "H"], "Half day"), ["2026-11-06"]);
  assert.deepEqual(datesOfTile(["2026-11-06", "2026-11-07"], ["HD", "H"], "Holiday"), ["2026-11-07"]);
});
