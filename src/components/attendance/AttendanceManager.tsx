import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle, CalendarCheck, Camera, Check, Clock, Copy, Crosshair, Download, FileSpreadsheet, KeyRound, MapPin, RefreshCw, Save, Smartphone,
  Trash2, UserCheck, UserPlus, Users, X,
} from "lucide-react";
import { Panel, StatCard } from "@/components/panel/widgets";
import { AttendanceStatusBadge, DecisionChips } from "@/components/attendance/AttendanceBits";
import { getBestFix } from "@/components/attendance/geolocation";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { downloadCSV } from "@/lib/export-utils";
import { downloadXlsx } from "@/lib/xlsx";
import { monthLabel, monthStart, suggestPartnerPassword } from "@/lib/partners";
import type { DaySelfies } from "@/lib/attendance.functions";
import {
  LEAVE_TYPES, REGISTER_LEGEND, STAFF_LOGIN_URL, SUMMARY_HEADER, WEEKDAYS, attendanceWorkbook, earlyText, formatDuration, indiaDate, indiaInstant,
  indiaTime, lateText, leaveDays, mapLink, monthDays, parseCoordinates, periodDays, presenceSchedule, staffPasswordProblem, summarisePeriod,
  summariseMonth, summaryRow, weekday, workedMinutes, type RegisterMark,
} from "@/lib/attendance";
import { cn } from "@/lib/utils";

/*
 * The attendance desk shared by Admin > Attendance (head office, every godown) and the channel
 * partner panel (their own godown; the database limits what they can read and decide).
 */

export type Viewer = "admin" | "partner";
type Employee = Database["public"]["Tables"]["staff_employees"]["Row"];
type Day = Database["public"]["Tables"]["attendance_days"]["Row"];
type Leave = Database["public"]["Tables"]["leave_requests"]["Row"];
type Presence = Database["public"]["Tables"]["attendance_presence"]["Row"];
type Device = Pick<Database["public"]["Tables"]["godown_devices"]["Row"], "id" | "branch_id" | "label" | "active" | "created_at" | "last_seen_at" | "revoked_at">;
type Godown = {
  id: string; name: string; latitude: number | null; longitude: number | null; attendance_radius_m: number; shift_start: string; shift_end: string;
  late_grace_min: number; weekly_off: number | null; presence_interval_min: number;
};
type Selfies = Record<string, DaySelfies>;

const GODOWN_COLUMNS = "id,name,vendor_id,latitude,longitude,attendance_radius_m,shift_start,shift_end,late_grace_min,weekly_off,presence_interval_min";
const monthEnd = (month: string) => monthDays(month).at(-1)!;
const formatDay = (date: string) => new Date(`${date}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
const clock = (time: string) => indiaTime(`2000-01-01T${time.slice(0, 5)}:00+05:30`);
const istStart = (date: string) => `${date}T00:00:00+05:30`;
const nextDay = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

function scheduleFor(day: Day, godown: Godown | undefined, photos: Presence[], now: number) {
  return presenceSchedule({
    checkInAt: Date.parse(day.check_in_at), checkOutAt: day.check_out_at ? Date.parse(day.check_out_at) : null,
    shiftEndAt: indiaInstant(day.work_date, godown?.shift_end ?? "18:30"), intervalMin: godown?.presence_interval_min ?? 0,
    photos: photos.filter((photo) => photo.attendance_day_id === day.id).map((photo) => Date.parse(photo.taken_at)), now,
  });
}

function useAttendanceDesk(viewer: Viewer, partnerBranchId: string | undefined, month: string) {
  const [godowns, setGodowns] = useState<Godown[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [partnerGodowns, setPartnerGodowns] = useState<Set<string>>(new Set());
  const [todayDays, setTodayDays] = useState<Day[]>([]);
  const [todayPhotos, setTodayPhotos] = useState<Presence[]>([]);
  const [monthRows, setMonthRows] = useState<Day[]>([]);
  const [leaves, setLeaves] = useState<Leave[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [selfies, setSelfies] = useState<Selfies>({});
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const today = indiaDate();

  const load = useCallback(async () => {
    const end = monthEnd(month);
    let branchQuery = supabase.from("branches").select(GODOWN_COLUMNS).order("sort_order");
    if (partnerBranchId) branchQuery = branchQuery.eq("id", partnerBranchId);
    const [b, e, p, t, tp, m, l, dv] = await Promise.all([
      branchQuery,
      supabase.from("staff_employees").select("*").order("name"),
      viewer === "admin" ? supabase.from("channel_partners").select("branch_id").eq("status", "active") : Promise.resolve({ data: partnerBranchId ? [{ branch_id: partnerBranchId }] : [], error: null }),
      supabase.from("attendance_days").select("*").eq("work_date", today),
      supabase.from("attendance_presence").select("*").gte("taken_at", istStart(today)).lt("taken_at", istStart(nextDay(today))).order("taken_at"),
      supabase.from("attendance_days").select("*").gte("work_date", month).lte("work_date", end),
      supabase.from("leave_requests").select("*").or(`status.eq.pending,and(to_date.gte.${month},from_date.lte.${end})`).order("from_date", { ascending: false }),
      viewer === "admin" ? supabase.from("godown_devices").select("id,branch_id,label,active,created_at,last_seen_at,revoked_at").order("created_at", { ascending: false }) : Promise.resolve({ data: [], error: null }),
    ]);
    const failed = [b, e, t, tp, m, l].find((result) => result.error);
    if (failed?.error) {
      setError(/does not exist|schema cache/i.test(failed.error.message)
        ? "Attendance is not fully set up in the database yet (migration 20261101090000_attendance_v2)."
        : failed.error.message);
    } else setError("");
    setGodowns(((b.data ?? []) as (Godown & { vendor_id: string | null })[]).filter((row) => !row.vendor_id));
    setEmployees((e.data as Employee[] | null) ?? []);
    setPartnerGodowns(new Set(((p.data ?? []) as { branch_id: string }[]).map((row) => row.branch_id)));
    const todayRows = (t.data as Day[] | null) ?? [];
    setTodayDays(todayRows);
    setTodayPhotos((tp.data as Presence[] | null) ?? []);
    setMonthRows((m.data as Day[] | null) ?? []);
    setLeaves((l.data as Leave[] | null) ?? []);
    setDevices((dv.data as Device[] | null) ?? []);
    setLoaded(true);
    const ids = todayRows.map((row) => row.id).slice(0, 300);
    if (ids.length) {
      try {
        const { attendanceSelfieUrls } = await import("@/lib/attendance.functions");
        const urls = await attendanceSelfieUrls({ data: { ids } });
        setSelfies((current) => ({ ...current, ...urls }));
      } catch { /* thumbnails are optional */ }
    }
  }, [viewer, partnerBranchId, month, today]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  return { godowns, employees, partnerGodowns, todayDays, todayPhotos, monthRows, leaves, devices, selfies, setSelfies, loaded, error, today, load };
}

type Desk = ReturnType<typeof useAttendanceDesk>;

export function AttendanceManager({ viewer, partnerBranchId }: { viewer: Viewer; partnerBranchId?: string }) {
  const [month, setMonth] = useState(monthStart());
  const desk = useAttendanceDesk(viewer, partnerBranchId, month);
  const [open, setOpen] = useState<Day | null>(null);
  const employeeOf = useMemo(() => new Map(desk.employees.map((employee) => [employee.id, employee])), [desk.employees]);
  const godownOf = useMemo(() => new Map(desk.godowns.map((godown) => [godown.id, godown])), [desk.godowns]);
  const pendingLeaves = desk.leaves.filter((leave) => leave.status === "pending");
  const waitingOnMe = pendingLeaves.filter((leave) => (viewer === "admin" ? leave.head_office_decision : leave.partner_decision) === null).length;
  const active = desk.employees.filter((employee) => employee.status === "active");
  // Today's counts cover active employees only: a deactivated employee's day stays in the register, not here.
  const activeIds = new Set(active.map((employee) => employee.id));
  const todayActive = desk.todayDays.filter((day) => activeIds.has(day.employee_id));
  const lateToday = todayActive.filter((day) => day.late_minutes > 0);
  const onLeaveToday = new Set(desk.leaves.filter((leave) => leave.status === "approved" && leave.from_date <= desk.today && desk.today <= leave.to_date && activeIds.has(leave.employee_id)).map((leave) => leave.employee_id));

  return (
    <div className="space-y-6">
      {desk.error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{desk.error}</p>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Present today" value={`${todayActive.length} of ${active.length}`} icon={UserCheck} />
        <StatCard label="Late today" value={String(lateToday.length)} icon={Clock} {...(lateToday.length ? { description: `Total ${formatDuration(lateToday.reduce((sum, day) => sum + day.late_minutes, 0))}` } : {})} />
        <StatCard label="On leave today" value={String(onLeaveToday.size)} icon={CalendarCheck} description={`${pendingLeaves.length} leave request(s) waiting · ${waitingOnMe} need your decision`} />
        <StatCard label="Employees" value={String(active.length)} icon={Users} {...(viewer === "admin" ? { description: `${desk.godowns.length} godowns` } : {})} />
      </div>

      <Tabs defaultValue="today">
        <TabsList className="flex h-auto flex-wrap justify-start">
          <TabsTrigger value="today">Today</TabsTrigger>
          <TabsTrigger value="approvals">{`Leave approvals (${pendingLeaves.length})`}</TabsTrigger>
          <TabsTrigger value="register">Monthly register</TabsTrigger>
          <TabsTrigger value="reports">Reports & Excel</TabsTrigger>
          <TabsTrigger value="employees">Employees</TabsTrigger>
          {viewer === "admin" && <TabsTrigger value="godowns">Godown settings</TabsTrigger>}
          {viewer === "admin" && <TabsTrigger value="devices">Godown devices</TabsTrigger>}
        </TabsList>

        <TabsContent value="today" className="mt-4 space-y-6">
          {desk.loaded && desk.godowns.map((godown) => (
            <TodayBoard key={godown.id} godown={godown} desk={desk} onLeaveToday={onLeaveToday} onOpen={setOpen}
              employees={active.filter((employee) => employee.branch_id === godown.id)} viewer={viewer} />
          ))}
          {!desk.loaded && <p className="flex items-center gap-2 text-sm text-slate"><RefreshCw className="h-4 w-4 animate-spin" /> Loading…</p>}
        </TabsContent>

        <TabsContent value="approvals" className="mt-4">
          <LeaveApprovals viewer={viewer} desk={desk} employeeOf={employeeOf} godownOf={godownOf} />
        </TabsContent>

        <TabsContent value="register" className="mt-4">
          <Register desk={desk} month={month} setMonth={setMonth} onOpen={setOpen} />
        </TabsContent>

        <TabsContent value="reports" className="mt-4">
          <Reports desk={desk} />
        </TabsContent>

        <TabsContent value="employees" className="mt-4">
          <EmployeesPanel viewer={viewer} desk={desk} />
        </TabsContent>

        {viewer === "admin" && (
          <TabsContent value="godowns" className="mt-4 space-y-6">
            {desk.godowns.map((godown) => <GodownSettings key={godown.id} godown={godown} onSaved={desk.load} />)}
          </TabsContent>
        )}
        {viewer === "admin" && (
          <TabsContent value="devices" className="mt-4 space-y-6">
            {desk.godowns.map((godown) => <GodownDevices key={godown.id} godown={godown} devices={desk.devices.filter((device) => device.branch_id === godown.id)} onChange={desk.load} />)}
          </TabsContent>
        )}
      </Tabs>

      <DayDialog day={open} desk={desk} employee={open ? employeeOf.get(open.employee_id) ?? null : null}
        godown={open ? godownOf.get(open.branch_id) ?? null : null} onClose={() => setOpen(null)} />
    </div>
  );
}

function SelfieThumb({ url, onClick }: { url?: string | undefined; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="h-10 w-10 shrink-0 overflow-hidden rounded-md border border-border bg-ivory" aria-label="Open selfie">
      {url ? <img src={url} alt="" loading="lazy" className="h-full w-full object-cover" /> : <UserCheck className="m-auto h-4 w-4 text-slate" />}
    </button>
  );
}

function TodayBoard({ godown, employees, desk, onLeaveToday, onOpen, viewer }: {
  godown: Godown; employees: Employee[]; desk: Desk; onLeaveToday: Set<string>; onOpen: (day: Day) => void; viewer: Viewer;
}) {
  const dayOf = new Map(desk.todayDays.filter((day) => day.branch_id === godown.id).map((day) => [day.employee_id, day]));
  const present = employees.filter((employee) => dayOf.has(employee.id)).length;
  const now = Date.now();
  return (
    <Panel title={`${godown.name} · ${present} of ${employees.length} present`}
      action={<span className="text-xs text-slate">{`Shift ${clock(godown.shift_start)} – ${clock(godown.shift_end)} · grace ${godown.late_grace_min} min · radius ${godown.attendance_radius_m} m${godown.presence_interval_min ? ` · photo every ${formatDuration(godown.presence_interval_min)}` : ""}`}</span>}>
      {godown.latitude === null && (
        <p className="mb-3 flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {viewer === "admin" ? "Set this godown's location in Godown settings. Until then nobody at this godown can check in." : "Head office has not set this godown's location yet, so nobody can check in."}
        </p>
      )}
      {employees.length === 0 ? <p className="text-sm text-slate">No employees added for this godown yet.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead><tr className="border-b border-border text-left text-xs uppercase tracking-wider text-slate">
              <th className="py-2 pr-3">Employee</th><th className="py-2 pr-3">Check-in</th><th className="py-2 pr-3">Check-out</th><th className="py-2 pr-3">Presence photos</th><th className="py-2">Status</th>
            </tr></thead>
            <tbody>
              {employees.map((employee) => {
                const day = dayOf.get(employee.id);
                const schedule = day ? scheduleFor(day, godown, desk.todayPhotos, now) : null;
                return (
                  <tr key={employee.id} className="border-b border-border/60 align-top last:border-0">
                    <td className="py-2 pr-3"><p className="font-semibold text-charcoal">{employee.name}</p><p className="text-xs text-slate">{employee.designation || employee.phone}</p></td>
                    <td className="py-2 pr-3">{day ? (
                      <span className="flex items-start gap-2"><SelfieThumb url={desk.selfies[day.id]?.in} onClick={() => onOpen(day)} />
                        <span>{indiaTime(day.check_in_at)}{day.late_minutes > 0 && <span className="block text-xs font-semibold text-amber-800">{lateText(day.late_minutes)}</span>}
                          {day.in_distance_m !== null && <span className="block text-xs text-slate">{`${day.in_distance_m} m (±${Math.round(Number(day.in_accuracy_m))} m)`}</span>}</span></span>
                    ) : <span className="text-slate">—</span>}</td>
                    <td className="py-2 pr-3">{day?.check_out_at ? (
                      <span className="flex items-start gap-2"><SelfieThumb url={desk.selfies[day.id]?.out} onClick={() => onOpen(day)} />
                        <span>{indiaTime(day.check_out_at)}{day.early_leave_minutes > 0 && <span className="block text-xs font-semibold text-amber-800">{earlyText(day.early_leave_minutes)}</span>}
                          <span className="block text-xs text-slate">{`Worked ${formatDuration(workedMinutes(day.check_in_at, day.check_out_at))}`}</span></span></span>
                    ) : <span className="text-slate">—</span>}</td>
                    <td className="py-2 pr-3 text-xs">{schedule && schedule.required ? (
                      <button type="button" onClick={() => day && onOpen(day)} className="text-left">
                        <span className="font-semibold text-navy">{`${schedule.done + schedule.late} of ${schedule.required} sent`}</span>
                        {schedule.missed > 0 && <span className="block font-semibold text-red-700">{`${schedule.missed} missed`}</span>}
                      </button>
                    ) : day ? <span className="text-slate">{day.check_out_at ? "None due" : "None due yet"}</span> : ""}</td>
                    <td className="py-2">
                      {day ? <AttendanceStatusBadge status={day.status} />
                        : onLeaveToday.has(employee.id) ? <span className="rounded-full bg-sky-50 px-2 py-0.5 text-xs font-semibold text-sky-800">On leave</span>
                        : <span className="text-xs text-slate">Not marked yet</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function DecideButtons({ id, current, onDone }: { id: string; current: string | null; onDone: () => Promise<void> }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const decide = async (decision: "approved" | "rejected") => {
    setBusy(true);
    const { data, error } = await supabase.rpc("attendance_decide", { _kind: "leave", _id: id, _decision: decision, _note: note });
    setBusy(false);
    if (error) { toast.error("Could not save the decision", { description: error.message }); return; }
    toast.success(decision === "approved" ? "Approved" : "Rejected", { description: data === "pending" ? "Waiting for the other approval." : undefined });
    setNote("");
    await onDone();
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input value={note} onChange={(event) => setNote(event.target.value)} maxLength={300} placeholder="Note (optional)" className="h-9 w-48" />
      <button type="button" disabled={busy || current === "approved"} onClick={() => void decide("approved")}
        className="inline-flex h-9 items-center gap-1 rounded-md bg-emerald-600 px-3 text-sm font-semibold text-white disabled:opacity-50"><Check className="h-4 w-4" /> Approve</button>
      <button type="button" disabled={busy || current === "rejected"} onClick={() => void decide("rejected")}
        className="inline-flex h-9 items-center gap-1 rounded-md border border-red-300 px-3 text-sm font-semibold text-red-700 disabled:opacity-50"><X className="h-4 w-4" /> Reject</button>
      {current && <span className="text-xs text-slate">{`Your decision: ${current === "approved" ? "Approved" : "Rejected"}`}</span>}
    </div>
  );
}

function LeaveApprovals({ viewer, desk, employeeOf, godownOf }: {
  viewer: Viewer; desk: Desk; employeeOf: Map<string, Employee>; godownOf: Map<string, Godown>;
}) {
  const mine = (leave: Leave) => (viewer === "admin" ? leave.head_office_decision : leave.partner_decision);
  const leaves = desk.leaves.filter((leave) => leave.status === "pending").sort((a, b) => Number(mine(a) !== null) - Number(mine(b) !== null));
  const required = (branchId: string) => viewer === "partner" || desk.partnerGodowns.has(branchId);
  return (
    <Panel title={`Leave requests waiting (${leaves.length})`}>
      <p className="mb-3 text-xs text-slate">Check-ins need no approval. Leave needs head office and the godown's channel partner.</p>
      {leaves.length === 0 ? <p className="text-sm text-slate">No leave requests waiting.</p> : (
        <ul className="divide-y divide-border">
          {leaves.map((leave) => (
            <li key={leave.id} className="space-y-2 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold text-charcoal">{`${employeeOf.get(leave.employee_id)?.name ?? "Employee"} · ${godownOf.get(leave.branch_id)?.name ?? leave.branch_id}`}</p>
                <span className="text-xs text-slate">{`Requested ${new Date(leave.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`}</span>
              </div>
              <p className="text-sm text-navy">
                {leave.from_date === leave.to_date ? formatDay(leave.from_date) : `${formatDay(leave.from_date)} – ${formatDay(leave.to_date)}`}
                {` · ${leaveDays(leave.from_date, leave.to_date)} day(s) · `}{LEAVE_TYPES.find((option) => option.value === leave.leave_type)?.label ?? leave.leave_type}
              </p>
              <p className="text-sm text-slate">{leave.reason}</p>
              <DecisionChips head={leave.head_office_decision} partner={leave.partner_decision} partnerRequired={required(leave.branch_id)} />
              <DecideButtons id={leave.id} current={mine(leave)} onDone={desk.load} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

const MARK_STYLE: Record<RegisterMark, string> = {
  P: "bg-emerald-100 text-emerald-800", L: "bg-lime-100 text-lime-800", LV: "bg-sky-100 text-sky-800", WO: "bg-slate-100 text-slate-500", "?": "bg-amber-100 text-amber-900",
  X: "bg-red-100 text-red-700", A: "bg-red-50 text-red-600", "": "text-slate/40",
};

function Register({ desk, month, setMonth, onOpen }: { desk: Desk; month: string; setMonth: (month: string) => void; onOpen: (day: Day) => void }) {
  const [godownId, setGodownId] = useState("all");
  const dates = monthDays(month);
  const godowns = desk.godowns.filter((godown) => godownId === "all" || godown.id === godownId);
  const ids = new Set(godowns.map((godown) => godown.id));
  // Everyone who worked this month or is still active, so a deactivated employee's days still show.
  const staff = desk.employees.filter((employee) => ids.has(employee.branch_id) && (employee.status === "active" || desk.monthRows.some((day) => day.employee_id === employee.id)));
  const leaves = desk.leaves.filter((leave) => leave.status !== "cancelled" && leave.to_date >= month && leave.from_date <= monthEnd(month));
  const rows = staff.map((employee) => ({
    employee,
    ...summariseMonth(month, desk.monthRows.filter((day) => day.employee_id === employee.id), leaves.filter((leave) => leave.employee_id === employee.id), desk.today,
      { joined: employee.joined_on, weeklyOff: desk.godowns.find((godown) => godown.id === employee.branch_id)?.weekly_off ?? null }),
  }));
  const dayOf = new Map(desk.monthRows.map((day) => [`${day.employee_id}:${day.work_date}`, day]));

  return (
    <Panel title={`Monthly register · ${monthLabel(month)}`} action={
      <>
        <input type="month" value={month.slice(0, 7)} max={monthStart().slice(0, 7)} aria-label="Month"
          onChange={(event) => event.target.value && setMonth(`${event.target.value}-01`)} className="h-9 rounded-md border border-input bg-white px-2 text-sm" />
        {desk.godowns.length > 1 && (
          <select value={godownId} onChange={(event) => setGodownId(event.target.value)} aria-label="Godown" className="h-9 rounded-md border border-input bg-white px-2 text-sm">
            <option value="all">All godowns</option>
            {desk.godowns.map((godown) => <option key={godown.id} value={godown.id}>{godown.name}</option>)}
          </select>
        )}
      </>
    }>
      <p className="mb-1 text-xs text-slate">{REGISTER_LEGEND}</p>
      <p className="mb-3 text-xs text-slate">Click a day to see the selfies and location. Excel for any period: Reports & Excel.</p>
      {rows.length === 0 ? <p className="text-sm text-slate">No employees.</p> : (
        <div className="overflow-x-auto">
          <table className="text-xs">
            <thead><tr className="text-slate">
              <th className="sticky left-0 z-10 bg-card py-1 pr-3 text-left">Employee</th>
              {dates.map((date) => <th key={date} className={cn("w-7 px-0.5 py-1 text-center font-semibold", weekday(date) === 0 && "text-red-500")}>{Number(date.slice(8))}</th>)}
              {["P", "L", "LV", "WO", "A", "Total late", "Worked"].map((label) => <th key={label} className="whitespace-nowrap px-1.5 py-1 text-center">{label}</th>)}
            </tr></thead>
            <tbody>
              {rows.map(({ employee, marks, summary: s }) => (
                <tr key={employee.id} className="border-t border-border/60">
                  <td className="sticky left-0 z-10 whitespace-nowrap bg-card py-1 pr-3">
                    <span className="font-semibold text-charcoal">{employee.name}</span>
                    {employee.status !== "active" && <span className="ml-1 text-[10px] text-slate">(inactive)</span>}
                  </td>
                  {marks.map((mark, index) => {
                    const day = dayOf.get(`${employee.id}:${dates[index]}`);
                    return (
                      <td key={dates[index]} className="px-0.5 py-0.5 text-center">
                        {day ? (
                          <button type="button" onClick={() => onOpen(day)} className={cn("h-6 w-6 rounded text-[10px] font-bold", MARK_STYLE[mark])}>{mark}</button>
                        ) : <span className={cn("inline-grid h-6 w-6 place-items-center rounded text-[9px] font-bold", MARK_STYLE[mark])}>{mark || "·"}</span>}
                      </td>
                    );
                  })}
                  {[s.present, s.late, s.leave, s.weeklyOff, s.absent, formatDuration(s.lateMinutes), formatDuration(s.workedMinutes)].map((value, index) => (
                    <td key={index} className="whitespace-nowrap px-1.5 text-center font-semibold text-navy">{value}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/** Any period: per-employee totals on screen, and the full Excel workbook (dashboard, staff, days, photos, leave). */
function Reports({ desk }: { desk: Desk }) {
  const thisMonth = monthStart();
  const [from, setFrom] = useState(thisMonth);
  const [to, setTo] = useState(desk.today);
  const [godownId, setGodownId] = useState("all");
  const [data, setData] = useState<{ days: Day[]; photos: Presence[]; leaves: Leave[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!from || !to || to < from) { toast.error("Choose a valid period"); return; }
    if (periodDays(from, to).length > 366) { toast.error("Choose at most one year"); return; }
    setBusy(true);
    const [d, p, l] = await Promise.all([
      supabase.from("attendance_days").select("*").gte("work_date", from).lte("work_date", to).order("work_date").limit(10_000),
      supabase.from("attendance_presence").select("*").gte("taken_at", istStart(from)).lt("taken_at", istStart(nextDay(to))).order("taken_at").limit(20_000),
      supabase.from("leave_requests").select("*").gte("to_date", from).lte("from_date", to).order("from_date").limit(5_000),
    ]);
    setBusy(false);
    if (d.error || p.error || l.error) { toast.error("Could not load the report", { description: (d.error ?? p.error ?? l.error)?.message }); return; }
    setData({ days: (d.data as Day[]) ?? [], photos: (p.data as Presence[]) ?? [], leaves: (l.data as Leave[]) ?? [] });
  }, [from, to]);
  useEffect(() => { void load(); }, [load]);

  const godowns = desk.godowns.filter((godown) => godownId === "all" || godown.id === godownId);
  const ids = new Set(godowns.map((godown) => godown.id));
  const staff = desk.employees.filter((employee) => ids.has(employee.branch_id) && (employee.status === "active" || data?.days.some((day) => day.employee_id === employee.id)));
  const dates = periodDays(from, to);
  const now = Date.now();
  const rows = staff.map((employee) => {
    const days = (data?.days ?? []).filter((day) => day.employee_id === employee.id);
    const godown = desk.godowns.find((entry) => entry.id === employee.branch_id);
    const { summary } = summarisePeriod(dates, days, (data?.leaves ?? []).filter((leave) => leave.employee_id === employee.id), desk.today,
      { joined: employee.joined_on, weeklyOff: godown?.weekly_off ?? null });
    const photos = days.reduce((sum, day) => {
      const schedule = scheduleFor(day, godown, data?.photos ?? [], now);
      return { required: sum.required + schedule.required, done: sum.done + schedule.done, late: sum.late + schedule.late, missed: sum.missed + schedule.missed };
    }, { required: 0, done: 0, late: 0, missed: 0 });
    return { employee, godown, summary, photos };
  });

  const workbook = () => attendanceWorkbook({
    from, to, today: desk.today, now: Date.now(), godowns,
    employees: staff, days: (data?.days ?? []).filter((day) => staff.some((employee) => employee.id === day.employee_id)),
    presence: (data?.photos ?? []).filter((photo) => ids.has(photo.branch_id)),
    leaves: (data?.leaves ?? []).filter((leave) => staff.some((employee) => employee.id === leave.employee_id)),
  });
  const exportExcel = () => downloadXlsx(`attendance-${from}-to-${to}`, workbook());
  const exportCsv = () => downloadCSV(`attendance-summary-${from}-to-${to}.csv`, SUMMARY_HEADER,
    rows.map(({ employee, godown, summary, photos }) => summaryRow(godown?.name ?? employee.branch_id, employee, summary, photos)));
  const lastMonth = (() => { const [y, m] = thisMonth.split("-").map(Number); return new Date(Date.UTC(y!, m! - 2, 1)).toISOString().slice(0, 10); })();

  return (
    <Panel title="Reports & Excel">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1 text-xs text-slate">From <input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} className="h-9 rounded-md border border-input bg-white px-2 text-sm" /></label>
        <label className="flex items-center gap-1 text-xs text-slate">To <input type="date" value={to} min={from} max={desk.today} onChange={(event) => setTo(event.target.value)} className="h-9 rounded-md border border-input bg-white px-2 text-sm" /></label>
        <button type="button" onClick={() => { setFrom(thisMonth); setTo(desk.today); }} className="h-9 rounded-md border border-border px-2 text-xs font-semibold text-navy">This month</button>
        <button type="button" onClick={() => { setFrom(lastMonth); setTo(monthEnd(lastMonth)); }} className="h-9 rounded-md border border-border px-2 text-xs font-semibold text-navy">Last month</button>
        {desk.godowns.length > 1 && (
          <select value={godownId} onChange={(event) => setGodownId(event.target.value)} aria-label="Godown" className="h-9 rounded-md border border-input bg-white px-2 text-sm">
            <option value="all">All godowns</option>
            {desk.godowns.map((godown) => <option key={godown.id} value={godown.id}>{godown.name}</option>)}
          </select>
        )}
        <button type="button" disabled={!data} onClick={exportExcel} className="inline-flex h-9 items-center gap-1.5 rounded-md bg-navy px-3 text-sm font-semibold text-white disabled:opacity-50"><FileSpreadsheet className="h-4 w-4" /> Download Excel</button>
        <button type="button" disabled={!data} onClick={exportCsv} className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-sm font-semibold text-navy disabled:opacity-50"><Download className="h-4 w-4" /> CSV</button>
      </div>
      <p className="mb-3 text-xs text-slate">The Excel file has these sheets: Dashboard, Staff (details and totals), Daily attendance (check-in, check-out, late, early, worked), Presence photos, Register per godown, Leave history and Rules.</p>
      {busy || !data ? <p className="flex items-center gap-2 text-sm text-slate"><RefreshCw className="h-4 w-4 animate-spin" /> Loading…</p> : rows.length === 0 ? <p className="text-sm text-slate">No employees.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead><tr className="border-b border-border text-left text-xs uppercase tracking-wider text-slate">
              <th className="py-2 pr-3">Employee</th><th className="py-2 pr-3">Godown</th><th className="py-2 pr-3 text-right">Present</th><th className="py-2 pr-3 text-right">Late days</th>
              <th className="py-2 pr-3 text-right">Total late</th><th className="py-2 pr-3 text-right">Left early</th><th className="py-2 pr-3 text-right">Worked</th>
              <th className="py-2 pr-3 text-right">Leave</th><th className="py-2 pr-3 text-right">Absent</th><th className="py-2 text-right">Photos missed</th>
            </tr></thead>
            <tbody>
              {rows.map(({ employee, godown, summary: s, photos }) => (
                <tr key={employee.id} className="border-b border-border/60 last:border-0">
                  <td className="py-2 pr-3"><p className="font-semibold text-charcoal">{employee.name}</p><p className="text-xs text-slate">{employee.phone}</p></td>
                  <td className="py-2 pr-3 text-xs">{godown?.name ?? employee.branch_id}</td>
                  <td className="py-2 pr-3 text-right font-semibold">{s.present}</td>
                  <td className="py-2 pr-3 text-right">{s.late}</td>
                  <td className={cn("py-2 pr-3 text-right", s.lateMinutes > 0 && "font-semibold text-amber-800")}>{formatDuration(s.lateMinutes)}</td>
                  <td className="py-2 pr-3 text-right">{s.earlyDays ? `${s.earlyDays} · ${formatDuration(s.earlyMinutes)}` : "—"}</td>
                  <td className="py-2 pr-3 text-right">{formatDuration(s.workedMinutes)}</td>
                  <td className="py-2 pr-3 text-right">{s.leave}</td>
                  <td className="py-2 pr-3 text-right">{s.absent}</td>
                  <td className={cn("py-2 text-right", photos.missed > 0 && "font-semibold text-red-700")}>{photos.required ? `${photos.missed} of ${photos.required}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function EmployeesPanel({ viewer, desk }: { viewer: Viewer; desk: Desk }) {
  const godownName = (id: string) => desk.godowns.find((godown) => godown.id === id)?.name ?? id;
  const [passwordFor, setPasswordFor] = useState<Employee | null>(null);
  const setStatus = async (employee: Employee, status: "active" | "inactive") => {
    const { error } = await supabase.from("staff_employees").update({ status, updated_at: new Date().toISOString() }).eq("id", employee.id);
    if (error) { toast.error("Could not update the employee", { description: error.message }); return; }
    toast.success(status === "inactive" ? `${employee.name} deactivated: they can no longer sign in` : `${employee.name} reactivated`);
    await desk.load();
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[380px_minmax(0,1fr)]">
      {viewer === "admin" ? <AddEmployeeForm godowns={desk.godowns} onAdded={desk.load} /> : (
        <Panel title="Staff login"><p className="text-sm text-slate">Head office adds and removes employees. They sign in at <span className="font-semibold text-navy">{STAFF_LOGIN_URL}</span> on the godown's attendance device.</p></Panel>
      )}
      <Panel title={`Employees (${desk.employees.length})`}>
        {viewer === "admin" && <p className="mb-3 text-xs text-slate">Staff records can't be edited once created. You can reset a password or deactivate someone who has left.</p>}
        {desk.employees.length === 0 ? <p className="text-sm text-slate">No employees yet.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-sm">
              <thead><tr className="border-b border-border text-left text-xs uppercase tracking-wider text-slate">
                <th className="py-2 pr-3">Name</th><th className="py-2 pr-3">Mobile</th><th className="py-2 pr-3">Godown</th><th className="py-2 pr-3">Joined</th><th className="py-2 pr-3">Status</th>{viewer === "admin" && <th className="py-2" />}
              </tr></thead>
              <tbody>
                {desk.employees.map((employee) => (
                  <tr key={employee.id} className="border-b border-border/60 last:border-0">
                    <td className="py-2 pr-3"><p className="font-semibold text-charcoal">{employee.name}</p><p className="text-xs text-slate">{employee.designation}</p></td>
                    <td className="py-2 pr-3 tabular-nums">{employee.phone}</td>
                    <td className="py-2 pr-3">{godownName(employee.branch_id)}</td>
                    <td className="py-2 pr-3 text-xs text-slate">{new Date(`${employee.joined_on}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</td>
                    <td className="py-2 pr-3">
                      <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", employee.status === "active" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600")}>{employee.status === "active" ? "Active" : "Inactive"}</span>
                      {viewer === "admin" && !employee.login_email && <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-900">Set a password</span>}
                    </td>
                    {viewer === "admin" && (
                      <td className="py-2 text-right">
                        <button type="button" onClick={() => setPasswordFor(employee)} className="mr-3 inline-flex items-center gap-1 text-xs font-semibold text-navy hover:underline"><KeyRound className="h-3.5 w-3.5" /> {employee.login_email ? "Reset password" : "Set password"}</button>
                        <button type="button" onClick={() => void setStatus(employee, employee.status === "active" ? "inactive" : "active")}
                          className={cn("text-xs font-semibold hover:underline", employee.status === "active" ? "text-red-700" : "text-emerald-700")}>
                          {employee.status === "active" ? "Deactivate" : "Reactivate"}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <PasswordDialog employee={passwordFor} onClose={() => setPasswordFor(null)} onSaved={desk.load} />
    </div>
  );
}

function PasswordField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="flex gap-2">
      <Input required value={value} onChange={(event) => onChange(event.target.value)} name="staff_new_password" autoComplete="new-password" className="font-mono" />
      <button type="button" onClick={() => onChange(suggestPartnerPassword())} className="shrink-0 rounded-md border border-border px-2 text-xs font-semibold text-navy">Suggest</button>
    </div>
  );
}

function PasswordDialog({ employee, onClose, onSaved }: { employee: Employee | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setPassword(employee ? suggestPartnerPassword() : ""); }, [employee]);
  const save = async () => {
    if (!employee) return;
    const problem = staffPasswordProblem(password);
    if (problem) { toast.error(problem); return; }
    setBusy(true);
    try {
      const { setStaffPassword } = await import("@/lib/attendance.functions");
      await setStaffPassword({ data: { employeeId: employee.id, password } });
      void navigator.clipboard?.writeText(password).catch(() => undefined);
      toast.success(`Password set for ${employee.name}`, { description: "Copied. Share it with them; they sign in with their mobile number and this password." });
      await onSaved();
      onClose();
    } catch (cause) {
      toast.error("Could not set the password", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={Boolean(employee)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{employee ? `Password for ${employee.name}` : ""}</DialogTitle></DialogHeader>
        <p className="text-sm text-slate">{employee ? `Mobile ${employee.phone}. They sign in at ${STAFF_LOGIN_URL} with this mobile number and the new password.` : ""}</p>
        <PasswordField value={password} onChange={setPassword} />
        <button type="button" disabled={busy} onClick={() => void save()} className="flex w-full items-center justify-center gap-2 rounded-md bg-navy py-2.5 text-sm font-semibold text-white disabled:opacity-60">
          <KeyRound className="h-4 w-4" /> {busy ? "Saving…" : "Save password"}
        </button>
      </DialogContent>
    </Dialog>
  );
}

function AddEmployeeForm({ godowns, onAdded }: { godowns: Godown[]; onAdded: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [designation, setDesignation] = useState("");
  const [branchId, setBranchId] = useState("");
  const [password, setPassword] = useState(() => suggestPartnerPassword());
  const [busy, setBusy] = useState(false);
  const branch = branchId || godowns[0]?.id || "";

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    const problem = staffPasswordProblem(password);
    if (problem) { toast.error(problem); return; }
    setBusy(true);
    try {
      const { addStaffEmployee } = await import("@/lib/attendance.functions");
      const result = await addStaffEmployee({ data: { branchId: branch, name, phone, designation, password } });
      void navigator.clipboard?.writeText(`${STAFF_LOGIN_URL}\nMobile: ${result.phone}\nPassword: ${password}`).catch(() => undefined);
      toast.success(`${name} added to ${result.godown}`, { description: `Login details copied: mobile ${result.phone} and the password. Share them with the employee.` });
      setName(""); setPhone(""); setDesignation(""); setPassword(suggestPartnerPassword());
      await onAdded();
    } catch (cause) {
      toast.error("Could not add the employee", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Add employee">
      <form autoComplete="off" onSubmit={(event) => void add(event)} className="space-y-3">
        <label className="block"><span className="mb-1 block text-xs font-semibold text-charcoal">Name</span><Input required minLength={2} value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label className="block"><span className="mb-1 block text-xs font-semibold text-charcoal">Mobile number</span>
          <Input required inputMode="numeric" value={phone} onChange={(event) => setPhone(event.target.value.replace(/[^\d+ ]/g, ""))} placeholder="98XXXXXXXX" /></label>
        <label className="block"><span className="mb-1 block text-xs font-semibold text-charcoal">Godown</span>
          <select value={branch} onChange={(event) => setBranchId(event.target.value)} className="h-10 w-full rounded-md border border-input bg-white px-2 text-sm">
            {godowns.map((godown) => <option key={godown.id} value={godown.id}>{godown.name}</option>)}
          </select></label>
        <label className="block"><span className="mb-1 block text-xs font-semibold text-charcoal">Designation (optional)</span>
          <Input value={designation} onChange={(event) => setDesignation(event.target.value)} placeholder="Loader, Supervisor…" /></label>
        <label className="block"><span className="mb-1 block text-xs font-semibold text-charcoal">Password</span><PasswordField value={password} onChange={setPassword} /></label>
        <p className="text-xs text-amber-800">Check the details: name, mobile and godown can't be changed after the employee is added.</p>
        <button type="submit" disabled={busy || !branch} className="flex w-full items-center justify-center gap-2 rounded-md bg-navy py-2.5 text-sm font-semibold text-white disabled:opacity-60">
          <UserPlus className="h-4 w-4" /> {busy ? "Adding…" : "Add employee"}
        </button>
        <div className="rounded-md bg-ivory p-3 text-xs text-slate">
          <p>{`Employees sign in at ${STAFF_LOGIN_URL} on the godown's attendance device with their mobile number and password.`}</p>
          <button type="button" onClick={() => { void navigator.clipboard?.writeText(STAFF_LOGIN_URL); toast.success("Link copied"); }}
            className="mt-1 inline-flex items-center gap-1 font-semibold text-navy hover:underline"><Copy className="h-3 w-3" /> Copy link</button>
        </div>
      </form>
    </Panel>
  );
}

const PRESENCE_OPTIONS = [0, 60, 90, 120, 180, 240];

function GodownSettings({ godown, onSaved }: { godown: Godown; onSaved: () => Promise<void> }) {
  const [lat, setLat] = useState(godown.latitude?.toString() ?? "");
  const [lng, setLng] = useState(godown.longitude?.toString() ?? "");
  const [paste, setPaste] = useState("");
  const [radius, setRadius] = useState(String(godown.attendance_radius_m));
  const [shift, setShift] = useState(godown.shift_start.slice(0, 5));
  const [shiftEnd, setShiftEnd] = useState(godown.shift_end.slice(0, 5));
  const [grace, setGrace] = useState(String(godown.late_grace_min));
  const [weeklyOff, setWeeklyOff] = useState(godown.weekly_off === null ? "none" : String(godown.weekly_off));
  const [presence, setPresence] = useState(String(godown.presence_interval_min));
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);

  const applyPasted = (text: string) => {
    setPaste(text);
    const point = parseCoordinates(text);
    if (point) { setLat(point.lat.toFixed(6)); setLng(point.lng.toFixed(6)); }
  };
  const takeDeviceLocation = async () => {
    setLocating(true);
    try {
      const fix = await getBestFix();
      setLat(fix.lat.toFixed(6)); setLng(fix.lng.toFixed(6));
      toast.success(`Location taken (±${fix.accuracyM} m)`, { description: "Save to use it." });
    } catch (cause) {
      toast.error("Location not found", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setLocating(false);
    }
  };
  const save = async () => {
    const latitude = lat.trim() === "" ? null : Number(lat), longitude = lng.trim() === "" ? null : Number(lng);
    if ((latitude === null) !== (longitude === null) || (latitude !== null && (!Number.isFinite(latitude) || Math.abs(latitude) > 90)) || (longitude !== null && (!Number.isFinite(longitude) || Math.abs(longitude) > 180))) {
      toast.error("Enter both latitude and longitude"); return;
    }
    const radiusM = Math.round(Number(radius)), graceMin = Math.round(Number(grace));
    if (!(radiusM >= 25 && radiusM <= 2000)) { toast.error("Radius must be 25 to 2000 metres"); return; }
    if (!(graceMin >= 0 && graceMin <= 240)) { toast.error("Grace must be 0 to 240 minutes"); return; }
    if (!/^\d{2}:\d{2}$/.test(shift) || !/^\d{2}:\d{2}$/.test(shiftEnd)) { toast.error("Enter the shift start and end times"); return; }
    if (shiftEnd <= shift) { toast.error("The shift must end after it starts"); return; }
    setBusy(true);
    const { error } = await supabase.from("branches").update({
      latitude, longitude, attendance_radius_m: radiusM, shift_start: shift, shift_end: shiftEnd, late_grace_min: graceMin,
      weekly_off: weeklyOff === "none" ? null : Number(weeklyOff), presence_interval_min: Number(presence), updated_at: new Date().toISOString(),
    }).eq("id", godown.id);
    setBusy(false);
    if (error) { toast.error("Could not save", { description: error.message }); return; }
    toast.success(`${godown.name} attendance settings saved`);
    await onSaved();
  };

  return (
    <Panel title={godown.name}>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <label className="block"><span className="mb-1 block text-xs font-semibold text-charcoal">Paste a Google Maps link or “latitude, longitude”</span>
            <Input value={paste} onChange={(event) => applyPasted(event.target.value)} placeholder="https://maps.google.com/…@14.31,76.65 or 14.3123, 76.6512" /></label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block"><span className="mb-1 block text-xs font-semibold text-charcoal">Latitude</span><Input value={lat} onChange={(event) => setLat(event.target.value)} inputMode="decimal" /></label>
            <label className="block"><span className="mb-1 block text-xs font-semibold text-charcoal">Longitude</span><Input value={lng} onChange={(event) => setLng(event.target.value)} inputMode="decimal" /></label>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <button type="button" disabled={locating} onClick={() => void takeDeviceLocation()} className="inline-flex items-center gap-1.5 font-semibold text-navy hover:underline disabled:opacity-60">
              <Crosshair className="h-4 w-4" /> {locating ? "Finding location…" : "Use this device's location"}
            </button>
            {lat && lng && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) && (
              <a href={mapLink(Number(lat), Number(lng))} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-navy hover:underline"><MapPin className="h-4 w-4" /> Check on Google Maps</a>
            )}
          </div>
          <p className="text-xs text-slate">Use this device's location only while standing inside the godown.</p>
          <label className="block"><span className="mb-1 block text-xs font-semibold text-charcoal">Radius (m): staff can check in and out only within it</span><Input type="number" min={25} max={2000} value={radius} onChange={(event) => setRadius(event.target.value)} /></label>
        </div>
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <label className="block"><span className="mb-1 block text-xs font-semibold text-charcoal">Shift starts</span><Input type="time" value={shift} onChange={(event) => setShift(event.target.value)} /></label>
            <label className="block"><span className="mb-1 block text-xs font-semibold text-charcoal">Shift ends</span><Input type="time" value={shiftEnd} onChange={(event) => setShiftEnd(event.target.value)} /></label>
            <label className="block"><span className="mb-1 block text-xs font-semibold text-charcoal">Grace (min)</span><Input type="number" min={0} max={240} value={grace} onChange={(event) => setGrace(event.target.value)} /></label>
          </div>
          <label className="block"><span className="mb-1 block text-xs font-semibold text-charcoal">Weekly off (not counted as absent)</span>
            <select value={weeklyOff} onChange={(event) => setWeeklyOff(event.target.value)} className="h-10 w-full rounded-md border border-input bg-white px-2 text-sm">
              {WEEKDAYS.map((day, index) => <option key={day} value={String(index)}>{day}</option>)}
              <option value="none">No weekly off (open every day)</option>
            </select></label>
          <label className="block"><span className="mb-1 block text-xs font-semibold text-charcoal">Presence photo (live geotagged selfie while checked in)</span>
            <select value={presence} onChange={(event) => setPresence(event.target.value)} className="h-10 w-full rounded-md border border-input bg-white px-2 text-sm">
              {PRESENCE_OPTIONS.map((minutes) => <option key={minutes} value={String(minutes)}>{minutes ? `Every ${formatDuration(minutes)}` : "Off"}</option>)}
            </select></label>
          <p className="text-xs text-slate">{`Late = check-in after ${shift || "?"} + ${grace || "0"} min, counted from ${shift || "?"}. Left early = check-out before ${shiftEnd || "?"}.`}</p>
          <button type="button" disabled={busy} onClick={() => void save()} className="inline-flex items-center gap-1.5 rounded-md bg-navy px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
            <Save className="h-4 w-4" /> {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </Panel>
  );
}

function GodownDevices({ godown, devices, onChange }: { godown: Godown; devices: Device[]; onChange: () => Promise<void> }) {
  const [label, setLabel] = useState("");
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const makeCode = async () => {
    setBusy(true);
    try {
      const { createDeviceCode } = await import("@/lib/attendance.functions");
      const result = await createDeviceCode({ data: { branchId: godown.id, label: label.trim() } });
      setCode({ code: result.code, expiresAt: result.expiresAt });
    } catch (cause) {
      toast.error("Could not make a code", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (device: Device) => {
    try {
      const { revokeGodownDevice } = await import("@/lib/attendance.functions");
      await revokeGodownDevice({ data: { deviceId: device.id } });
      toast.success(`${device.label} removed: it can no longer mark attendance`);
      await onChange();
    } catch (cause) {
      toast.error("Could not remove the device", { description: cause instanceof Error ? cause.message : undefined });
    }
  };
  const activeDevices = devices.filter((device) => device.active);
  return (
    <Panel title={`${godown.name} · attendance devices`}>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3">
          <p className="text-sm text-slate">Staff mark attendance only on this godown's registered phone or tablet. To register one, make a code here, then on that device open <span className="font-semibold text-navy">grainbazar.com/staff/device</span> and enter the code (valid 15 minutes, once).</p>
          <label className="block"><span className="mb-1 block text-xs font-semibold text-charcoal">Device name (optional)</span>
            <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Godown tablet" maxLength={60} /></label>
          <button type="button" disabled={busy} onClick={() => void makeCode()} className="inline-flex items-center gap-1.5 rounded-md bg-navy px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
            <Smartphone className="h-4 w-4" /> {busy ? "Making code…" : "Make device code"}
          </button>
          {code && (
            <div className="rounded-xl border border-gold/40 bg-ivory p-4 text-center">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate">Device code</p>
              <p className="mt-1 font-mono text-3xl font-extrabold tracking-[0.3em] text-navy">{code.code}</p>
              <p className="mt-1 text-xs text-slate">{`Valid until ${indiaTime(code.expiresAt)}, once.`}</p>
            </div>
          )}
        </div>
        <div>
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate">{`Registered devices (${activeDevices.length})`}</h3>
          {devices.length === 0 ? <p className="text-sm text-slate">No device registered yet: nobody at this godown can mark attendance.</p> : (
            <ul className="divide-y divide-border text-sm">
              {devices.map((device) => (
                <li key={device.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className={cn("font-semibold", device.active ? "text-charcoal" : "text-slate line-through")}>{device.label}</p>
                    <p className="text-xs text-slate">{`Registered ${new Date(device.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}${device.last_seen_at ? ` · last used ${new Date(device.last_seen_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })}` : ""}${device.active ? "" : " · removed"}`}</p>
                  </div>
                  {device.active && <button type="button" onClick={() => void revoke(device)} className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-red-700 hover:underline"><Trash2 className="h-3.5 w-3.5" /> Remove</button>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Panel>
  );
}

function DayDialog({ day, desk, employee, godown, onClose }: {
  day: Day | null; desk: Desk; employee: Employee | null; godown: Godown | null; onClose: () => void;
}) {
  const urls = day ? desk.selfies[day.id] : undefined;
  const { setSelfies } = desk;
  const [failed, setFailed] = useState(false);
  // Days outside today have no links yet: fetch this one.
  useEffect(() => {
    setFailed(false);
    if (!day || urls) return;
    void (async () => {
      try {
        const { attendanceSelfieUrls } = await import("@/lib/attendance.functions");
        const result = await attendanceSelfieUrls({ data: { ids: [day.id] } });
        setSelfies((current) => ({ ...current, [day.id]: { presence: [] }, ...result }));
      } catch {
        setFailed(true);
      }
    })();
  }, [day, urls, setSelfies]);
  const waiting = failed ? "Photos could not be loaded. Close and open again." : "Loading photo…";

  return (
    <Dialog open={Boolean(day)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto">
        {day && (
          <>
            <DialogHeader><DialogTitle>{`${employee?.name ?? "Employee"} · ${formatDay(day.work_date)}`}</DialogTitle></DialogHeader>
            <div className="grid gap-4 sm:grid-cols-2">
              {[{ label: "Check-in", url: urls?.in, at: day.check_in_at, lat: day.in_lat, lng: day.in_lng, distance: day.in_distance_m, accuracy: Number(day.in_accuracy_m), extra: day.late_minutes > 0 ? lateText(day.late_minutes) : "" },
                ...(day.check_out_at ? [{ label: "Check-out", url: urls?.out, at: day.check_out_at, lat: day.out_lat, lng: day.out_lng, distance: day.out_distance_m, accuracy: Number(day.out_accuracy_m), extra: day.early_leave_minutes > 0 ? earlyText(day.early_leave_minutes) : "" }] : [])]
                .map((shot) => (
                  <figure key={shot.label} className="space-y-1">
                    {shot.url ? <img src={shot.url} alt={`${shot.label} selfie`} className="w-full rounded-lg" /> : <div className="grid aspect-[3/4] place-items-center rounded-lg bg-ivory p-3 text-center text-xs text-slate">{urls ? "No photo" : waiting}</div>}
                    <figcaption className="text-sm">
                      <span className="font-semibold text-navy">{`${shot.label} ${indiaTime(shot.at)}`}</span>
                      {shot.extra && <span className="block text-xs font-semibold text-amber-800">{shot.extra}</span>}
                      <span className="block text-xs text-slate">{shot.distance === null ? `GPS ±${Math.round(shot.accuracy)} m` : `${shot.distance} m from ${godown?.name ?? "godown"} · GPS ±${Math.round(shot.accuracy)} m`}</span>
                      {shot.lat !== null && shot.lng !== null && (
                        <a href={mapLink(shot.lat, shot.lng)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-navy underline"><MapPin className="h-3 w-3" /> Google Maps</a>
                      )}
                    </figcaption>
                  </figure>
                ))}
            </div>
            {day.check_out_at && <p className="text-sm text-slate">{`Worked ${formatDuration(workedMinutes(day.check_in_at, day.check_out_at))}`}</p>}
            <div className="border-t border-border pt-3">
              <h3 className="mb-2 flex items-center gap-2 text-sm font-bold text-navy"><Camera className="h-4 w-4" /> Presence photos</h3>
              {!urls ? <p className="text-xs text-slate">{failed ? waiting : "Loading…"}</p> : urls.presence.length === 0 ? <p className="text-xs text-slate">No presence photos.</p> : (
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {urls.presence.map((photo) => (
                    <figure key={photo.id} className="space-y-0.5">
                      <img src={photo.url} alt={`Presence ${indiaTime(photo.takenAt)}`} className="w-full rounded-md" loading="lazy" />
                      <figcaption className="text-[11px]">
                        <span className="font-semibold text-navy">{indiaTime(photo.takenAt)}</span>
                        <span className={cn("block", photo.inside ? "text-emerald-700" : "font-semibold text-red-700")}>{photo.inside ? "Inside godown" : `Outside${photo.distanceM !== null ? ` (${photo.distanceM} m)` : ""}`}</span>
                      </figcaption>
                    </figure>
                  ))}
                </div>
              )}
            </div>
            {day.employee_note && <p className="text-sm text-slate">{`“${day.employee_note}”`}</p>}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
