/*
 * Godown employee attendance: rules shared by the staff app (/staff), the admin Attendance page,
 * the partner panel, the server functions and the tests. The database applies the same approval
 * rule (migration 20261031120000_staff_attendance). Kept free of app imports so the node tests
 * can load it.
 *
 *   * An employee marks attendance from their phone: the phone's GPS position and a live selfie.
 *   * Inside the godown's radius and on time -> Present at once.
 *   * Outside the radius, GPS too imprecise, late, or the godown has no location set -> the record
 *     waits for approval, with the employee's reason.
 *   * Leave requests and those check-ins need head office (admin) AND the godown's channel partner
 *     to approve; either one can reject. A godown with no active channel partner needs head office only.
 */

import type { XlsxCell, XlsxSheet } from "./xlsx.ts";

export type LocationVerdict = "inside" | "outside" | "imprecise" | "no_godown_location";
export type AttendanceFlag = "outside" | "imprecise" | "late" | "no_godown_location";
export type Decision = "approved" | "rejected";
export type ReviewStatus = "pending" | "approved" | "rejected";
export type AttendanceStatus = "present" | "pending" | "rejected";
export type LeaveStatus = "pending" | "approved" | "rejected" | "cancelled";
export type LeaveType = "casual" | "sick" | "festival" | "other";

export const LEAVE_TYPES: { value: LeaveType; label: string }[] = [
  { value: "casual", label: "Casual leave" },
  { value: "sick", label: "Sick leave" },
  { value: "festival", label: "Festival / holiday" },
  { value: "other", label: "Other" },
];

export const DEFAULT_RADIUS_M = 150;
/** Positions less precise than this (or than the radius, if larger) can't prove the employee is inside. */
export const MIN_TRUSTED_ACCURACY_M = 100;
export const STAFF_LOGIN_URL = "https://grainbazar.com/staff";

/** Great-circle distance in metres (haversine). */
export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(a)));
}

export type Geofence = { latitude: number | null; longitude: number | null; radiusM: number };
export type Fix = { lat: number; lng: number; accuracyM: number };

/**
 * Where the phone is, relative to the godown. Clearly outside (even allowing for the GPS error) is
 * "outside"; a position too rough to tell is "imprecise"; otherwise within the radius is "inside".
 */
export function locationVerdict(fence: Geofence, fix: Fix): { verdict: LocationVerdict; distanceM: number | null } {
  if (fence.latitude === null || fence.longitude === null) return { verdict: "no_godown_location", distanceM: null };
  const distanceM = Math.round(distanceMeters(fence.latitude, fence.longitude, fix.lat, fix.lng));
  const radius = fence.radiusM > 0 ? fence.radiusM : DEFAULT_RADIUS_M;
  const accuracy = Math.max(0, fix.accuracyM);
  if (distanceM - accuracy > radius) return { verdict: "outside", distanceM };
  if (accuracy > Math.max(MIN_TRUSTED_ACCURACY_M, radius)) return { verdict: "imprecise", distanceM };
  return { verdict: distanceM <= radius ? "inside" : "outside", distanceM };
}

/** India date (yyyy-mm-dd) of an instant. */
export function indiaDate(at: Date | number = Date.now()) {
  const india = new Date((typeof at === "number" ? at : at.getTime()) + 330 * 60_000);
  return india.toISOString().slice(0, 10);
}

/** Minutes since India midnight of an instant. */
export function indiaMinutes(at: Date | number) {
  const india = new Date((typeof at === "number" ? at : at.getTime()) + 330 * 60_000);
  return india.getUTCHours() * 60 + india.getUTCMinutes();
}

/** "09:30" / "09:30:00" -> minutes after midnight. */
export function timeToMinutes(value: string) {
  const [h, m] = value.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Minutes late for a check-in: counted from the shift start, but only once the grace period has
 * passed (09:30 shift with 15 min grace: 09:44 -> 0, 09:50 -> 20).
 */
export function lateMinutes(checkInAt: Date | number, shiftStart: string, graceMin: number) {
  const after = indiaMinutes(checkInAt) - timeToMinutes(shiftStart);
  return after > Math.max(0, graceMin) ? after : 0;
}

/** Why a check-in needs approval (empty: Present at once). */
export function checkInFlags(verdict: LocationVerdict, late: number): AttendanceFlag[] {
  const flags: AttendanceFlag[] = [];
  if (verdict !== "inside") flags.push(verdict);
  if (late > 0) flags.push("late");
  return flags;
}

export const FLAG_LABELS: Record<AttendanceFlag, string> = {
  outside: "Outside the godown",
  imprecise: "GPS not precise",
  late: "Late",
  no_godown_location: "Godown location not set",
};

/** Same rule as the database: either rejects -> rejected; head office approves and (partner approves or none needed) -> approved. */
export function reviewStatus(head: Decision | null, partner: Decision | null, partnerRequired: boolean): ReviewStatus {
  if (head === "rejected" || partner === "rejected") return "rejected";
  if (head === "approved" && (partner === "approved" || !partnerRequired)) return "approved";
  return "pending";
}

/** A day's attendance status: a check-in that needed no review is Present unless someone rejects it. */
export function attendanceStatus(needsReview: boolean, head: Decision | null, partner: Decision | null, partnerRequired: boolean): AttendanceStatus {
  if (head === "rejected" || partner === "rejected") return "rejected";
  if (!needsReview) return "present";
  return reviewStatus(head, partner, partnerRequired) === "approved" ? "present" : "pending";
}

/** Days in a leave request, both ends included. */
export function leaveDays(from: string, to: string) {
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  return Number.isFinite(days) && days > 0 ? days : 0;
}

/** Why a leave request can't be sent, or null. Same limits as request_leave() in the database. */
export function leaveProblem(from: string, to: string, reason: string, today = indiaDate()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return "Choose the dates";
  if (to < from) return "The last day is before the first day";
  if (leaveDays(from, to) > 60) return "A request can cover at most 60 days";
  if (leaveDays(from, today) > 31) return "Leave more than 30 days ago can't be requested";
  if (leaveDays(today, from) > 181) return "Request leave at most 6 months ahead";
  if (reason.trim().length < 3) return "Write the reason";
  return null;
}

/** Every yyyy-mm-dd of a month (yyyy-mm-01). */
export function monthDays(month: string) {
  const [year, mon] = month.split("-").map(Number);
  const count = new Date(Date.UTC(year!, mon!, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => `${month.slice(0, 8)}${String(i + 1).padStart(2, "0")}`);
}

export type DayRecord = {
  work_date: string;
  /** AttendanceStatus */
  status: string;
  late_minutes: number;
  check_in_at: string;
  check_out_at: string | null;
};
/** status: LeaveStatus */
export type LeaveSpan = { from_date: string; to_date: string; status: string };

/**
 * P present, L present but late, LV approved leave, WO the godown's weekly off, ? waiting for
 * approval, X rejected, A absent, "" future / before joining.
 */
export type RegisterMark = "P" | "L" | "LV" | "WO" | "?" | "X" | "A" | "";
/** joined: the employee's first day (yyyy-mm-dd); weeklyOff: the godown's day off, 0 = Sunday, null = none. */
export type RegisterOptions = { joined?: string; weeklyOff?: number | null };

export const REGISTER_LEGEND = "P present · L present but late · LV approved leave · WO weekly off · ? waiting for approval · X rejected · A absent";
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Day of the week of yyyy-mm-dd, 0 = Sunday. */
export function weekday(date: string) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function registerMark(date: string, record: DayRecord | undefined, leaves: LeaveSpan[], today: string, { joined = "", weeklyOff = null }: RegisterOptions = {}): RegisterMark {
  if (record) {
    if (record.status === "pending") return "?";
    if (record.status === "rejected") return "X";
    return record.late_minutes > 0 ? "L" : "P";
  }
  if (joined && date < joined) return "";
  if (leaves.some((leave) => leave.status === "approved" && leave.from_date <= date && date <= leave.to_date)) return "LV";
  if (date > today) return "";
  if (weeklyOff !== null && weekday(date) === weeklyOff) return "WO";
  return date === today ? "" : "A";
}

export type RegisterSummary = { present: number; late: number; leave: number; weeklyOff: number; pending: number; rejected: number; absent: number; hours: number };

/** One employee's month: counts per mark and hours worked (check-in to check-out, Present days only). */
export function summariseMonth(month: string, records: DayRecord[], leaves: LeaveSpan[], today: string, options: RegisterOptions = {}) {
  const byDate = new Map(records.map((record) => [record.work_date, record]));
  const marks = monthDays(month).map((date) => registerMark(date, byDate.get(date), leaves, today, options));
  const summary: RegisterSummary = { present: 0, late: 0, leave: 0, weeklyOff: 0, pending: 0, rejected: 0, absent: 0, hours: 0 };
  for (const mark of marks) {
    if (mark === "P" || mark === "L") summary.present += 1;
    if (mark === "L") summary.late += 1;
    if (mark === "LV") summary.leave += 1;
    if (mark === "WO") summary.weeklyOff += 1;
    if (mark === "?") summary.pending += 1;
    if (mark === "X") summary.rejected += 1;
    if (mark === "A") summary.absent += 1;
  }
  let minutes = 0;
  for (const record of records) {
    if (record.status !== "present" || !record.check_out_at) continue;
    minutes += Math.max(0, (Date.parse(record.check_out_at) - Date.parse(record.check_in_at)) / 60_000);
  }
  summary.hours = Math.round(minutes / 6) / 10;
  return { marks, summary };
}

/** "9:05 am" in India time. */
export function indiaTime(at: string | number | Date) {
  return new Date(at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });
}

/** A Google Maps link to a point (for checking where a selfie was taken). */
export function mapLink(lat: number, lng: number) {
  return `https://www.google.com/maps?q=${lat.toFixed(6)},${lng.toFixed(6)}`;
}

/**
 * Latitude/longitude from what an admin pastes: "14.3123, 76.6512", a Google Maps link with
 * @lat,lng or ?q=lat,lng, or "!3dLAT!4dLNG". Null when no valid pair is found.
 */
export function parseCoordinates(text: string): { lat: number; lng: number } | null {
  const value = text.trim();
  const patterns = [/@(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/, /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/, /[?&](?:q|query|ll)=(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/, /^(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)$/];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (!match) continue;
    const lat = Number(match[1]), lng = Number(match[2]);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
  }
  return null;
}

/** 10-digit Indian mobile number, or null. */
export function cleanMobile(value: string) {
  const digits = value.replace(/\D/g, "").replace(/^(?:91|0)(?=\d{10}$)/, "");
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

/** Where a selfie is stored in the private bucket: godown/date/employee-kind-time.jpg. */
export function selfiePath(branchId: string, workDate: string, employeeId: string, kind: "in" | "out", at: number) {
  return `${branchId}/${workDate}/${employeeId}-${kind}-${at}.jpg`;
}

export type RegisterEmployee = { id: string; name: string; phone: string; designation: string; branch_id: string; joined_on: string };
export type RegisterDay = DayRecord & {
  employee_id: string; in_distance_m: number | null; in_accuracy_m: number; flags: string[]; employee_note: string;
  head_office_decision: string | null; partner_decision: string | null;
};
export type RegisterLeave = LeaveSpan & { employee_id: string; leave_type: string; reason: string };

/** Columns of the payroll summary (Excel sheet and CSV). */
export const SUMMARY_HEADER = ["Godown", "Employee", "Mobile", "Designation", "Present days", "Late days", "Leave days", "Weekly off", "Waiting for approval", "Rejected", "Absent", "Hours worked"];
export function summaryRow(godown: string, employee: Pick<RegisterEmployee, "name" | "phone" | "designation">, s: RegisterSummary) {
  return [godown, employee.name, employee.phone, employee.designation, s.present, s.late, s.leave, s.weeklyOff, s.pending, s.rejected, s.absent, s.hours];
}

const STATUS_WORDS: Record<string, string> = { present: "Present", pending: "Waiting for approval", rejected: "Rejected", approved: "Approved", cancelled: "Cancelled" };
const decisionWord = (decision: string | null) => (decision === "approved" ? "Approved" : decision === "rejected" ? "Rejected" : "");

/**
 * The month's attendance as an Excel workbook for payroll: a summary per employee, a day-by-day
 * register per godown, every check-in with its location and approvals, and the leave requests.
 */
export function attendanceWorkbook({ month, monthName, today, godowns, employees, days, leaves }: {
  month: string; monthName: string; today: string; godowns: { id: string; name: string; weekly_off: number | null }[];
  employees: RegisterEmployee[]; days: RegisterDay[]; leaves: RegisterLeave[];
}): XlsxSheet[] {
  const dates = monthDays(month);
  const godownName = new Map(godowns.map((godown) => [godown.id, godown.name]));
  const weeklyOffOf = new Map(godowns.map((godown) => [godown.id, godown.weekly_off]));
  const sorted = [...employees].sort((a, b) => (godownName.get(a.branch_id) ?? "").localeCompare(godownName.get(b.branch_id) ?? "") || a.name.localeCompare(b.name));
  const results = new Map(sorted.map((employee) => [employee.id, summariseMonth(
    month, days.filter((day) => day.employee_id === employee.id), leaves.filter((leave) => leave.employee_id === employee.id), today,
    { joined: employee.joined_on, weeklyOff: weeklyOffOf.get(employee.branch_id) ?? null },
  )]));
  const employeeOf = new Map(employees.map((employee) => [employee.id, employee]));

  const summary: XlsxSheet = {
    name: "Summary",
    rows: [
      [`Attendance summary · ${monthName}`], [],
      SUMMARY_HEADER,
      ...sorted.map((employee) => summaryRow(godownName.get(employee.branch_id) ?? employee.branch_id, employee, results.get(employee.id)!.summary)),
      [], [REGISTER_LEGEND],
    ],
    boldRows: [0, 2],
    widths: [16, 22, 13, 16, 12, 10, 11, 11, 12, 10, 9, 12],
  };

  const registers: XlsxSheet[] = godowns.map((godown) => {
    const staff = sorted.filter((employee) => employee.branch_id === godown.id);
    return {
      name: `Register ${godown.name}`,
      rows: [
        [`${godown.name} · ${monthName}`], [],
        ["Employee", ...dates.map((date) => Number(date.slice(8))), "P", "L", "LV", "WO", "A"],
        ...staff.map((employee) => {
          const { marks, summary: s } = results.get(employee.id)!;
          return [employee.name, ...marks, s.present, s.late, s.leave, s.weeklyOff, s.absent] as XlsxCell[];
        }),
      ],
      boldRows: [0, 2],
      widths: [22, ...dates.map(() => 4), 5, 5, 5, 5, 5],
    };
  });

  const checkIns: XlsxSheet = {
    name: "Check-ins",
    rows: [
      ["Date", "Godown", "Employee", "Check-in", "Check-out", "Distance (m)", "GPS accuracy (m)", "Status", "Late (min)", "Needs approval because", "Employee's reason", "Head office", "Channel partner"],
      ...[...days].sort((a, b) => a.work_date.localeCompare(b.work_date) || (employeeOf.get(a.employee_id)?.name ?? "").localeCompare(employeeOf.get(b.employee_id)?.name ?? "")).map((day) => {
        const employee = employeeOf.get(day.employee_id);
        return [day.work_date, godownName.get(employee?.branch_id ?? "") ?? "", employee?.name ?? "", indiaTime(day.check_in_at), day.check_out_at ? indiaTime(day.check_out_at) : "",
          day.in_distance_m, Number(day.in_accuracy_m), STATUS_WORDS[day.status] ?? day.status, day.late_minutes || "",
          day.flags.map((flag) => FLAG_LABELS[flag as AttendanceFlag] ?? flag).join(", "), day.employee_note, decisionWord(day.head_office_decision), decisionWord(day.partner_decision)] as XlsxCell[];
      }),
    ],
    boldRows: [0],
    widths: [11, 14, 20, 10, 10, 11, 12, 18, 9, 24, 30, 11, 14],
  };

  const leaveSheet: XlsxSheet = {
    name: "Leave",
    rows: [
      ["Employee", "Godown", "From", "To", "Days", "Type", "Reason", "Status"],
      ...leaves.map((leave) => {
        const employee = employeeOf.get(leave.employee_id);
        return [employee?.name ?? "", godownName.get(employee?.branch_id ?? "") ?? "", leave.from_date, leave.to_date, leaveDays(leave.from_date, leave.to_date),
          LEAVE_TYPES.find((option) => option.value === leave.leave_type)?.label ?? leave.leave_type, leave.reason, STATUS_WORDS[leave.status] ?? leave.status];
      }),
    ],
    boldRows: [0],
    widths: [20, 14, 11, 11, 6, 18, 36, 18],
  };

  return [summary, ...registers, checkIns, leaveSheet];
}
