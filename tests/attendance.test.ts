import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attendanceStatus, attendanceWorkbook, checkInFlags, cleanMobile, distanceMeters, indiaDate, lateMinutes, leaveDays, leaveProblem,
  locationVerdict, monthDays, parseCoordinates, registerMark, reviewStatus, selfiePath, summariseMonth,
} from "../src/lib/attendance.ts";
import { buildXlsx } from "../src/lib/xlsx.ts";

// A point in Challakere and offsets north of it (1e-5 degrees of latitude is about 1.11 m).
const GODOWN = { latitude: 14.312, longitude: 76.651, radiusM: 150 };
const north = (metres: number) => GODOWN.latitude + metres / 111_195;

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
});

test("a check-in needs approval when outside, imprecise, late or the godown has no location", () => {
  assert.deepEqual(checkInFlags("inside", 0), []);
  assert.deepEqual(checkInFlags("inside", 20), ["late"]);
  assert.deepEqual(checkInFlags("outside", 20), ["outside", "late"]);
  assert.deepEqual(checkInFlags("no_godown_location", 0), ["no_godown_location"]);
});

test("approval: head office AND channel partner; either rejects; head office alone without a partner", () => {
  assert.equal(reviewStatus(null, null, true), "pending");
  assert.equal(reviewStatus("approved", null, true), "pending");
  assert.equal(reviewStatus(null, "approved", true), "pending");
  assert.equal(reviewStatus("approved", "approved", true), "approved");
  assert.equal(reviewStatus("approved", "rejected", true), "rejected");
  assert.equal(reviewStatus("rejected", "approved", true), "rejected");
  assert.equal(reviewStatus("approved", null, false), "approved");
  assert.equal(reviewStatus(null, "approved", false), "pending");
  // Attendance days: one Present at once stays Present unless rejected.
  assert.equal(attendanceStatus(false, null, null, true), "present");
  assert.equal(attendanceStatus(false, null, "rejected", true), "rejected");
  assert.equal(attendanceStatus(true, "approved", null, true), "pending");
  assert.equal(attendanceStatus(true, "approved", "approved", true), "present");
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
  assert.equal(leaveProblem("2027-04-30", "2027-04-30", "Wedding", today), "Request leave at most 6 months ahead");
  assert.equal(leaveProblem("2026-11-03", "2026-11-03", " ", today), "Write the reason");
});

test("monthly register marks and summary", () => {
  assert.equal(monthDays("2026-02-01").length, 28);
  assert.equal(monthDays("2026-10-01").at(-1), "2026-10-31");
  const records = [
    { work_date: "2026-10-01", status: "present", late_minutes: 0, check_in_at: "2026-10-01T03:55:00Z", check_out_at: "2026-10-01T12:25:00Z" }, // 8.5 h
    { work_date: "2026-10-02", status: "present", late_minutes: 25, check_in_at: "2026-10-02T04:25:00Z", check_out_at: null },
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
  assert.deepEqual(summary, { present: 2, late: 1, leave: 2, weeklyOff: 0, pending: 1, rejected: 1, absent: 3, hours: 8.5 });
  const sundaysOff = summariseMonth("2026-10-01", [], [], "2026-10-31", { weeklyOff: 0 });
  assert.equal(sundaysOff.summary.weeklyOff, 4); // 4, 11, 18, 25 Oct
  assert.equal(sundaysOff.summary.absent, 26);
});

test("Excel workbook for payroll: summary, register per godown, check-ins, leave", () => {
  const sheets = attendanceWorkbook({
    month: "2026-10-01", monthName: "October 2026", today: "2026-10-03",
    godowns: [{ id: "BR-CLK", name: "Challakere", weekly_off: 0 }, { id: "BR-HBL", name: "Hubli", weekly_off: null }],
    employees: [
      { id: "e1", name: "Manju", phone: "9876500001", designation: "Loader", branch_id: "BR-CLK", joined_on: "2026-10-01" },
      { id: "e2", name: "Basava", phone: "9876500002", designation: "", branch_id: "BR-HBL", joined_on: "2026-10-01" },
    ],
    days: [{
      employee_id: "e1", work_date: "2026-10-01", status: "present", late_minutes: 0, check_in_at: "2026-10-01T03:55:00Z", check_out_at: "2026-10-01T12:25:00Z",
      in_distance_m: 35, in_accuracy_m: 12, flags: [], employee_note: "", head_office_decision: null, partner_decision: null,
    }, {
      employee_id: "e2", work_date: "2026-10-02", status: "pending", late_minutes: 20, check_in_at: "2026-10-02T04:20:00Z", check_out_at: null,
      in_distance_m: 400, in_accuracy_m: 15, flags: ["outside", "late"], employee_note: "Bus late", head_office_decision: "approved", partner_decision: null,
    }],
    leaves: [{ employee_id: "e1", from_date: "2026-10-02", to_date: "2026-10-02", status: "approved", leave_type: "sick", reason: "Fever" }],
  });
  assert.deepEqual(sheets.map((sheet) => sheet.name), ["Summary", "Register Challakere", "Register Hubli", "Check-ins", "Leave"]);
  assert.deepEqual(sheets[0]!.rows[2], ["Godown", "Employee", "Mobile", "Designation", "Present days", "Late days", "Leave days", "Weekly off", "Waiting for approval", "Rejected", "Absent", "Hours worked"]);
  assert.deepEqual(sheets[0]!.rows[3], ["Challakere", "Manju", "9876500001", "Loader", 1, 0, 1, 0, 0, 0, 0, 8.5]);
  assert.deepEqual(sheets[0]!.rows[4], ["Hubli", "Basava", "9876500002", "", 0, 0, 0, 0, 1, 0, 1, 0]);
  assert.deepEqual(sheets[1]!.rows[3]!.slice(0, 4), ["Manju", "P", "LV", ""]);
  assert.deepEqual(sheets[3]!.rows[2]!.slice(7, 13), ["Waiting for approval", 20, "Outside the godown, Late", "Bus late", "Approved", ""]);
  assert.deepEqual(sheets[4]!.rows[1], ["Manju", "Challakere", "2026-10-02", "2026-10-02", 1, "Sick leave", "Fever", "Approved"]);
  assert.ok(buildXlsx(sheets).length > 1000);
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
});
