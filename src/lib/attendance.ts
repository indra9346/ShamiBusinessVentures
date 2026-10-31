/*
 * Godown employee attendance: rules shared by the staff app (/staff), the admin Attendance page,
 * the partner panel, the server functions and the tests. Kept free of app imports so the node tests
 * can load it. (Migrations 20261031120000_staff_attendance and 20261101090000_attendance_v2.)
 *
 *   * Staff sign in with their mobile number and a password set by head office, on the godown's own
 *     registered device, and mark attendance with a live selfie and the device's GPS position.
 *   * Check-in and check-out work only inside the godown's radius; there is no approval step.
 *     Arriving after the shift start + grace is recorded as late, by how long; leaving before the
 *     shift end is recorded as early leave.
 *   * While checked in, a live geotagged selfie is due every N minutes (admin sets N per godown).
 *   * Leave requests need head office (admin) AND the godown's channel partner to approve; either
 *     one can reject. A godown with no active channel partner needs head office only.
 *   * Head office sets each godown's rules: location, radius, shift start and end, grace minutes,
 *     weekly off and the presence-photo interval.
 */

import type { XlsxCell, XlsxSheet } from "./xlsx.ts";

export type LocationVerdict = "inside" | "outside" | "imprecise" | "no_godown_location";
export type AttendanceFlag = "outside" | "imprecise" | "late" | "no_godown_location";
export type Decision = "approved" | "rejected";
export type ReviewStatus = "pending" | "approved" | "rejected";
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
/** A presence photo counts on time from 15 minutes before it is due until 30 minutes after. */
export const PRESENCE_EARLY_MIN = 15;
export const PRESENCE_GRACE_MIN = 30;

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

/** Why check-in / check-out is refused at this position (null: inside, go ahead). */
export function geofenceRefusal(verdict: LocationVerdict, distanceM: number | null, radiusM: number) {
  if (verdict === "inside") return null;
  if (verdict === "no_godown_location") return "Head office has not set this godown's location yet. Ask head office to set it in Godown settings.";
  if (verdict === "imprecise") return "GPS is not precise enough here. Switch on precise location (GPS), stand near the door or a window and try again.";
  return `You are ${distanceM} m from the godown. Move inside the godown (within ${radiusM} m) to mark attendance.`;
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

/** The instant of an India clock time on an India date (yyyy-mm-dd, "18:30"). */
export function indiaInstant(date: string, time: string) {
  return Date.parse(`${date}T00:00:00Z`) - 330 * 60_000 + timeToMinutes(time) * 60_000;
}

/**
 * Minutes late for a check-in: counted from the shift start, but only once the grace period has
 * passed (09:30 shift with 15 min grace: 09:44 -> 0, 09:50 -> 20).
 */
export function lateMinutes(checkInAt: Date | number, shiftStart: string, graceMin: number) {
  const after = indiaMinutes(checkInAt) - timeToMinutes(shiftStart);
  return after > Math.max(0, graceMin) ? after : 0;
}

/** Minutes before the shift end at check-out (0 when leaving at or after the shift end). */
export function earlyLeaveMinutes(checkOutAt: Date | number, shiftEnd: string) {
  return Math.max(0, timeToMinutes(shiftEnd) - indiaMinutes(checkOutAt));
}

/** Whole minutes between check-in and check-out. */
export function workedMinutes(checkInAt: string, checkOutAt: string | null) {
  if (!checkOutAt) return 0;
  return Math.max(0, Math.round((Date.parse(checkOutAt) - Date.parse(checkInAt)) / 60_000));
}

/** 430 -> "7 hr 10 min", 45 -> "45 min", 120 -> "2 hr", 0 -> "0 min". */
export function formatDuration(minutes: number) {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60), rest = total % 60;
  if (!hours) return `${rest} min`;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

/** "Late by 7 hr 10 min" (one text node, so the Kannada dictionary can translate it whole). */
export function lateText(minutes: number) {
  return `Late by ${formatDuration(minutes)}`;
}

/** "Left early by 1 hr 5 min". */
export function earlyText(minutes: number) {
  return `Left early by ${formatDuration(minutes)}`;
}

/** Labels for the flags older records may carry (from before check-ins stopped needing approval). */
export const FLAG_LABELS: Record<AttendanceFlag, string> = {
  outside: "Outside the godown",
  imprecise: "GPS not precise",
  late: "Late",
  no_godown_location: "Godown location not set",
};

/** Leave approval, same rule as the database: either rejects -> rejected; head office approves and (partner approves or none needed) -> approved. */
export function reviewStatus(head: Decision | null, partner: Decision | null, partnerRequired: boolean): ReviewStatus {
  if (head === "rejected" || partner === "rejected") return "rejected";
  if (head === "approved" && (partner === "approved" || !partnerRequired)) return "approved";
  return "pending";
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

/** Every yyyy-mm-dd from `from` to `to`, both included (at most 400 days). */
export function periodDays(from: string, to: string) {
  const days: string[] = [];
  for (let at = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`); at <= end && days.length < 400; at += 86_400_000) {
    days.push(new Date(at).toISOString().slice(0, 10));
  }
  return days;
}

/** Every yyyy-mm-dd of a month (yyyy-mm-01). */
export function monthDays(month: string) {
  const [year, mon] = month.split("-").map(Number);
  const count = new Date(Date.UTC(year!, mon!, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => `${month.slice(0, 8)}${String(i + 1).padStart(2, "0")}`);
}

/* ------------------------------------------------------------------ presence photos */

export type PresenceSlotStatus = "done" | "late" | "missed" | "due" | "upcoming";
export type PresenceSlot = { due: number; status: PresenceSlotStatus; photoAt: number | null };

/**
 * The presence photos due while checked in: one every `intervalMin` minutes after check-in, until
 * check-out (or the shift end while still checked in). A photo from 15 min before to 30 min after a
 * due time counts on time; a later one, before the next window opens, counts late; none is missed.
 * Each photo counts for one slot only.
 */
export function presenceSchedule({ checkInAt, checkOutAt, shiftEndAt, intervalMin, photos, now }: {
  checkInAt: number; checkOutAt: number | null; shiftEndAt: number; intervalMin: number; photos: number[]; now: number;
}) {
  const slots: PresenceSlot[] = [];
  if (intervalMin > 0) {
    const end = checkOutAt ?? Math.max(shiftEndAt, checkInAt);
    const step = intervalMin * 60_000;
    const left = [...photos].sort((a, b) => a - b);
    for (let due = checkInAt + step; due <= end && slots.length < 48; due += step) {
      const opens = due - PRESENCE_EARLY_MIN * 60_000, closes = due + PRESENCE_GRACE_MIN * 60_000;
      const nextOpens = due + step - PRESENCE_EARLY_MIN * 60_000;
      let index = left.findIndex((at) => at >= opens && at <= closes);
      let status: PresenceSlotStatus = "done";
      if (index < 0) {
        index = left.findIndex((at) => at > closes && at < nextOpens);
        status = "late";
      }
      if (index >= 0) {
        slots.push({ due, status, photoAt: left[index]! });
        left.splice(index, 1);
        continue;
      }
      const finished = checkOutAt !== null && checkOutAt < closes;
      if (now < opens) slots.push({ due, status: finished ? "missed" : "upcoming", photoAt: null });
      else if (now <= closes && !finished) slots.push({ due, status: "due", photoAt: null });
      else slots.push({ due, status: "missed", photoAt: null });
    }
  }
  const count = (status: PresenceSlotStatus) => slots.filter((slot) => slot.status === status).length;
  return { slots, required: slots.length, done: count("done"), late: count("late"), missed: count("missed") };
}

/* ------------------------------------------------------------------ register and summaries */

export type DayRecord = {
  work_date: string;
  status: string;
  late_minutes: number;
  check_in_at: string;
  check_out_at: string | null;
  early_leave_minutes?: number;
};
/** status: LeaveStatus */
export type LeaveSpan = { from_date: string; to_date: string; status: string };

/**
 * P present, L present but late, LV approved leave, WO the godown's weekly off, A absent, "" future /
 * before joining. (? and X only appear on older records from when check-ins needed approval.)
 */
export type RegisterMark = "P" | "L" | "LV" | "WO" | "?" | "X" | "A" | "";
/** joined: the employee's first day (yyyy-mm-dd); weeklyOff: the godown's day off, 0 = Sunday, null = none. */
export type RegisterOptions = { joined?: string; weeklyOff?: number | null };

export const REGISTER_LEGEND = "P present · L present but late · LV approved leave · WO weekly off · A absent";
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

export type RegisterSummary = {
  present: number; late: number; lateMinutes: number; earlyDays: number; earlyMinutes: number; leave: number; weeklyOff: number;
  pending: number; rejected: number; absent: number; workedMinutes: number; hours: number;
};

/** One employee over a period: the mark of every day, and the totals. */
export function summarisePeriod(dates: string[], records: DayRecord[], leaves: LeaveSpan[], today: string, options: RegisterOptions = {}) {
  const inPeriod = new Set(dates);
  const mine = records.filter((record) => inPeriod.has(record.work_date));
  const byDate = new Map(mine.map((record) => [record.work_date, record]));
  const marks = dates.map((date) => registerMark(date, byDate.get(date), leaves, today, options));
  const summary: RegisterSummary = {
    present: 0, late: 0, lateMinutes: 0, earlyDays: 0, earlyMinutes: 0, leave: 0, weeklyOff: 0, pending: 0, rejected: 0, absent: 0, workedMinutes: 0, hours: 0,
  };
  for (const mark of marks) {
    if (mark === "P" || mark === "L") summary.present += 1;
    if (mark === "L") summary.late += 1;
    if (mark === "LV") summary.leave += 1;
    if (mark === "WO") summary.weeklyOff += 1;
    if (mark === "?") summary.pending += 1;
    if (mark === "X") summary.rejected += 1;
    if (mark === "A") summary.absent += 1;
  }
  for (const record of mine) {
    if (record.status === "rejected") continue;
    summary.lateMinutes += Math.max(0, record.late_minutes);
    if ((record.early_leave_minutes ?? 0) > 0) { summary.earlyDays += 1; summary.earlyMinutes += record.early_leave_minutes ?? 0; }
    summary.workedMinutes += workedMinutes(record.check_in_at, record.check_out_at);
  }
  summary.hours = Math.round(summary.workedMinutes / 6) / 10;
  return { marks, summary };
}

/** One employee's month (yyyy-mm-01). */
export function summariseMonth(month: string, records: DayRecord[], leaves: LeaveSpan[], today: string, options: RegisterOptions = {}) {
  return summarisePeriod(monthDays(month), records, leaves, today, options);
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

/** The sign-in address behind a staff login (staff type only their mobile number and password). */
export function staffLoginEmail(mobile: string) {
  return `${mobile}@staff.grainbazar.com`;
}

/** Why a staff password is not acceptable, or null. At least 8 characters with a letter and a digit. */
export function staffPasswordProblem(password: string) {
  if (password.length < 8) return "Use at least 8 characters";
  if (password.length > 72) return "Use at most 72 characters";
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return "Use letters and at least one number";
  return null;
}

/** Where a selfie is stored in the private bucket: godown/date/employee-kind-time.jpg. */
export function selfiePath(branchId: string, workDate: string, employeeId: string, kind: "in" | "out" | "presence", at: number) {
  return `${branchId}/${workDate}/${employeeId}-${kind}-${at}.jpg`;
}

/* ------------------------------------------------------------------ Excel report */

export type ReportGodown = {
  id: string; name: string; weekly_off: number | null; shift_start: string; shift_end: string; late_grace_min: number;
  attendance_radius_m: number; presence_interval_min: number;
};
export type RegisterEmployee = { id: string; name: string; phone: string; designation: string; branch_id: string; joined_on: string; status?: string };
export type RegisterDay = DayRecord & {
  id?: string; employee_id: string; in_distance_m: number | null; in_accuracy_m: number; flags: string[]; employee_note: string;
  out_distance_m?: number | null;
};
export type RegisterPresence = { attendance_day_id: string; taken_at: string; distance_m: number | null; inside: boolean };
export type RegisterLeave = LeaveSpan & {
  employee_id: string; leave_type: string; reason: string; head_office_decision?: string | null; partner_decision?: string | null; created_at?: string;
};

/** Columns of the staff summary (Excel "Staff" sheet and CSV). */
export const SUMMARY_HEADER = [
  "Godown", "Employee", "Mobile", "Designation", "Joined", "Status", "Present days", "Late days", "Total late", "Total late (min)",
  "Early leave days", "Total early leave", "Worked", "Worked (hours)", "Leave days", "Weekly off", "Absent",
  "Presence photos due", "On time", "Late", "Missed",
];
export function summaryRow(godown: string, employee: RegisterEmployee, s: RegisterSummary, presence: { required: number; done: number; late: number; missed: number }) {
  return [
    godown, employee.name, employee.phone, employee.designation, employee.joined_on, employee.status === "inactive" ? "Inactive" : "Active",
    s.present, s.late, formatDuration(s.lateMinutes), s.lateMinutes, s.earlyDays, formatDuration(s.earlyMinutes), formatDuration(s.workedMinutes), s.hours,
    s.leave, s.weeklyOff, s.absent, presence.required, presence.done, presence.late, presence.missed,
  ];
}

const STATUS_WORDS: Record<string, string> = { present: "Present", pending: "Waiting for approval", rejected: "Rejected", approved: "Approved", cancelled: "Cancelled" };
const decisionWord = (decision: string | null | undefined) => (decision === "approved" ? "Approved" : decision === "rejected" ? "Rejected" : "Waiting");
const SLOT_WORDS: Record<PresenceSlotStatus, string> = { done: "On time", late: "Late", missed: "Missed", due: "Due now", upcoming: "Upcoming" };
const dayName = (date: string) => WEEKDAYS[weekday(date)]!;
const leaveLabel = (type: string) => LEAVE_TYPES.find((option) => option.value === type)?.label ?? type;

/**
 * Attendance for any period as one Excel workbook: a dashboard, every employee with their totals,
 * every day's check-in and check-out with late / early / worked time, every presence photo, a
 * register per godown, the leave history and the rules in force.
 */
export function attendanceWorkbook({ from, to, today, now, godowns, employees, days, presence, leaves }: {
  from: string; to: string; today: string; now: number; godowns: ReportGodown[]; employees: RegisterEmployee[];
  days: RegisterDay[]; presence: RegisterPresence[]; leaves: RegisterLeave[];
}): XlsxSheet[] {
  const dates = periodDays(from, to);
  const period = from === to ? from : `${from} to ${to}`;
  const godownOf = new Map(godowns.map((godown) => [godown.id, godown]));
  const godownName = (id: string) => godownOf.get(id)?.name ?? id;
  const sorted = [...employees].sort((a, b) => godownName(a.branch_id).localeCompare(godownName(b.branch_id)) || a.name.localeCompare(b.name));
  const employeeOf = new Map(employees.map((employee) => [employee.id, employee]));
  const inPeriod = days.filter((day) => day.work_date >= from && day.work_date <= to);
  const photosOf = new Map<string, RegisterPresence[]>();
  for (const photo of presence) photosOf.set(photo.attendance_day_id, [...(photosOf.get(photo.attendance_day_id) ?? []), photo]);
  const scheduleOf = (day: RegisterDay) => {
    const godown = godownOf.get(employeeOf.get(day.employee_id)?.branch_id ?? "");
    return presenceSchedule({
      checkInAt: Date.parse(day.check_in_at), checkOutAt: day.check_out_at ? Date.parse(day.check_out_at) : null,
      shiftEndAt: indiaInstant(day.work_date, godown?.shift_end ?? "18:30"), intervalMin: godown?.presence_interval_min ?? 0,
      photos: (photosOf.get(day.id ?? "") ?? []).map((photo) => Date.parse(photo.taken_at)), now,
    });
  };
  const schedules = new Map(inPeriod.map((day) => [day, scheduleOf(day)]));
  const results = new Map(sorted.map((employee) => {
    const mine = inPeriod.filter((day) => day.employee_id === employee.id);
    const result = summarisePeriod(dates, mine, leaves.filter((leave) => leave.employee_id === employee.id), today,
      { joined: employee.joined_on, weeklyOff: godownOf.get(employee.branch_id)?.weekly_off ?? null });
    const photos = { required: 0, done: 0, late: 0, missed: 0 };
    for (const day of mine) {
      const schedule = schedules.get(day)!;
      photos.required += schedule.required; photos.done += schedule.done; photos.late += schedule.late; photos.missed += schedule.missed;
    }
    return [employee.id, { ...result, photos }];
  }));

  // Dashboard: the period at a glance, per godown, and who was late most.
  const totals = (list: RegisterEmployee[]) => list.reduce((sum, employee) => {
    const r = results.get(employee.id)!;
    sum.present += r.summary.present; sum.late += r.summary.late; sum.lateMinutes += r.summary.lateMinutes; sum.absent += r.summary.absent;
    sum.leave += r.summary.leave; sum.worked += r.summary.workedMinutes; sum.photosDue += r.photos.required; sum.photosMissed += r.photos.missed;
    return sum;
  }, { present: 0, late: 0, lateMinutes: 0, absent: 0, leave: 0, worked: 0, photosDue: 0, photosMissed: 0 });
  const all = totals(sorted);
  const godownRow = (name: string, list: RegisterEmployee[]) => {
    const t = totals(list);
    return [name, list.length, t.present, t.late, formatDuration(t.lateMinutes), t.late ? formatDuration(t.lateMinutes / t.late) : "", t.absent, t.leave,
      formatDuration(t.worked), t.photosDue, t.photosMissed];
  };
  const topLate = sorted.map((employee) => ({ employee, r: results.get(employee.id)! })).filter(({ r }) => r.summary.lateMinutes > 0)
    .sort((a, b) => b.r.summary.lateMinutes - a.r.summary.lateMinutes).slice(0, 10);
  const dashboardRows: XlsxCell[][] = [
    ["Grain Bazar · Godown attendance report"], [`Period: ${period}`], [`Generated: ${new Date(now).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`], [],
    ["Employees", sorted.length], ["Present days", all.present], ["Late days", all.late], ["Total late time", formatDuration(all.lateMinutes)],
    ["Absent days", all.absent], ["Leave days", all.leave], ["Worked time", formatDuration(all.worked)],
    ["Presence photos due", all.photosDue], ["Presence photos missed", all.photosMissed], [],
    ["Godown", "Employees", "Present days", "Late days", "Total late", "Average late (per late day)", "Absent", "Leave days", "Worked", "Presence photos due", "Missed"],
    ...godowns.map((godown) => godownRow(godown.name, sorted.filter((employee) => employee.branch_id === godown.id))),
    [], ["Most late", "Godown", "Late days", "Total late"],
    ...topLate.map(({ employee, r }) => [employee.name, godownName(employee.branch_id), r.summary.late, formatDuration(r.summary.lateMinutes)]),
  ];
  const dashboardBold = [0, 14, 16 + godowns.length];

  const staffSheet: XlsxSheet = {
    name: "Staff",
    rows: [[`Staff and totals · ${period}`], [], SUMMARY_HEADER,
      ...sorted.map((employee) => { const r = results.get(employee.id)!; return summaryRow(godownName(employee.branch_id), employee, r.summary, r.photos); })],
    boldRows: [0, 2],
    widths: [16, 22, 13, 14, 11, 9, 9, 9, 13, 11, 10, 13, 13, 10, 9, 9, 8, 11, 9, 8, 8],
  };

  const dailyRows = [...inPeriod].sort((a, b) => a.work_date.localeCompare(b.work_date)
    || godownName(employeeOf.get(a.employee_id)?.branch_id ?? "").localeCompare(godownName(employeeOf.get(b.employee_id)?.branch_id ?? ""))
    || (employeeOf.get(a.employee_id)?.name ?? "").localeCompare(employeeOf.get(b.employee_id)?.name ?? ""));
  const dailySheet: XlsxSheet = {
    name: "Daily attendance",
    rows: [
      ["Date", "Day", "Godown", "Employee", "Mobile", "Check-in", "Check-out", "Late", "Late (min)", "Left early", "Left early (min)", "Worked",
        "Check-in distance (m)", "GPS accuracy (m)", "Presence photos", "Status", "Note"],
      ...dailyRows.map((day) => {
        const employee = employeeOf.get(day.employee_id);
        const schedule = schedules.get(day)!;
        const early = day.early_leave_minutes ?? 0;
        return [day.work_date, dayName(day.work_date), godownName(employee?.branch_id ?? ""), employee?.name ?? "", employee?.phone ?? "",
          indiaTime(day.check_in_at), day.check_out_at ? indiaTime(day.check_out_at) : "Not checked out",
          day.late_minutes ? formatDuration(day.late_minutes) : "", day.late_minutes || 0, early ? formatDuration(early) : "", early,
          day.check_out_at ? formatDuration(workedMinutes(day.check_in_at, day.check_out_at)) : "", day.in_distance_m, Number(day.in_accuracy_m),
          schedule.required ? `${schedule.done + schedule.late} of ${schedule.required}` : "", STATUS_WORDS[day.status] ?? day.status, day.employee_note] as XlsxCell[];
      }),
    ],
    boldRows: [0],
    widths: [11, 10, 16, 20, 12, 10, 14, 13, 9, 13, 9, 13, 12, 11, 12, 10, 30],
  };

  const presenceSheet: XlsxSheet = {
    name: "Presence photos",
    rows: [
      ["Date", "Godown", "Employee", "Due at", "Taken at", "Result", "Distance (m)", "Inside godown"],
      ...dailyRows.flatMap((day) => {
        const employee = employeeOf.get(day.employee_id);
        const photos = photosOf.get(day.id ?? "") ?? [];
        return schedules.get(day)!.slots.map((slot) => {
          const photo = photos.find((entry) => Date.parse(entry.taken_at) === slot.photoAt);
          return [day.work_date, godownName(employee?.branch_id ?? ""), employee?.name ?? "", indiaTime(slot.due), slot.photoAt ? indiaTime(slot.photoAt) : "",
            SLOT_WORDS[slot.status], photo?.distance_m ?? "", photo ? (photo.inside ? "Yes" : "No") : ""] as XlsxCell[];
        });
      }),
    ],
    boldRows: [0],
    widths: [11, 16, 20, 10, 10, 10, 12, 13],
  };

  const registers: XlsxSheet[] = dates.length > 62 ? [] : godowns.map((godown) => {
    const staff = sorted.filter((employee) => employee.branch_id === godown.id);
    return {
      name: `Register ${godown.name}`,
      rows: [
        [`${godown.name} · ${period}`], [REGISTER_LEGEND],
        ["Employee", ...dates.map((date) => `${Number(date.slice(8))}/${Number(date.slice(5, 7))}`), "P", "L", "LV", "WO", "A", "Total late"],
        ...staff.map((employee) => {
          const { marks, summary: s } = results.get(employee.id)!;
          return [employee.name, ...marks, s.present, s.late, s.leave, s.weeklyOff, s.absent, formatDuration(s.lateMinutes)] as XlsxCell[];
        }),
      ],
      boldRows: [0, 2],
      widths: [22, ...dates.map(() => 5), 5, 5, 5, 5, 5, 13],
    };
  });

  const leaveSheet: XlsxSheet = {
    name: "Leave history",
    rows: [
      ["Employee", "Godown", "From", "To", "Days", "Type", "Reason", "Status", "Head office", "Channel partner", "Requested on"],
      ...leaves.filter((leave) => leave.to_date >= from && leave.from_date <= to).map((leave) => {
        const employee = employeeOf.get(leave.employee_id);
        return [employee?.name ?? "", godownName(employee?.branch_id ?? ""), leave.from_date, leave.to_date, leaveDays(leave.from_date, leave.to_date),
          leaveLabel(leave.leave_type), leave.reason, STATUS_WORDS[leave.status] ?? leave.status,
          leave.status === "cancelled" ? "" : decisionWord(leave.head_office_decision), leave.status === "cancelled" ? "" : decisionWord(leave.partner_decision),
          leave.created_at ? leave.created_at.slice(0, 10) : ""];
      }),
    ],
    boldRows: [0],
    widths: [20, 16, 11, 11, 6, 18, 36, 12, 12, 14, 12],
  };

  const rulesSheet: XlsxSheet = {
    name: "Rules",
    rows: [
      ["Godown", "Shift starts", "Shift ends", "Grace (min)", "Radius (m)", "Weekly off", "Presence photo every"],
      ...godowns.map((godown) => [godown.name, godown.shift_start.slice(0, 5), godown.shift_end.slice(0, 5), godown.late_grace_min, godown.attendance_radius_m,
        godown.weekly_off === null ? "None" : WEEKDAYS[godown.weekly_off]!, godown.presence_interval_min ? formatDuration(godown.presence_interval_min) : "Off"]),
      [], ["Late = check-in after the shift start + grace, counted from the shift start. Left early = check-out before the shift end."],
      ["Presence photo on time = from 15 min before to 30 min after it is due."],
    ],
    boldRows: [0],
    widths: [22, 12, 11, 11, 11, 12, 20],
  };

  return [{ name: "Dashboard", rows: dashboardRows, boldRows: dashboardBold, widths: [30, 12, 13, 11, 13, 22, 9, 11, 13, 18, 9] },
    staffSheet, dailySheet, presenceSheet, ...registers, leaveSheet, rulesSheet];
}
