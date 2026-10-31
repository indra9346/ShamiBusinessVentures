import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CalendarCheck, Check, Clock, Copy, Crosshair, Download, FileSpreadsheet, MapPin, RefreshCw, Save, UserCheck, UserPlus, Users, X } from "lucide-react";
import { Panel, StatCard } from "@/components/panel/widgets";
import { AttendanceStatusBadge, DecisionChips, FlagChips } from "@/components/attendance/AttendanceBits";
import { getBestFix } from "@/components/attendance/geolocation";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { downloadCSV } from "@/lib/export-utils";
import { downloadXlsx } from "@/lib/xlsx";
import { monthLabel, monthStart } from "@/lib/partners";
import {
  LEAVE_TYPES, REGISTER_LEGEND, STAFF_LOGIN_URL, SUMMARY_HEADER, WEEKDAYS, attendanceWorkbook, indiaDate, indiaTime, leaveDays, mapLink,
  monthDays, parseCoordinates, summariseMonth, summaryRow, weekday, type RegisterMark,
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
type Godown = { id: string; name: string; latitude: number | null; longitude: number | null; attendance_radius_m: number; shift_start: string; late_grace_min: number; weekly_off: number | null };
type Selfies = Record<string, { in?: string; out?: string }>;

const monthEnd = (month: string) => monthDays(month).at(-1)!;
const formatDay = (date: string) => new Date(`${date}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });

function useAttendanceDesk(viewer: Viewer, partnerBranchId: string | undefined, month: string) {
  const [godowns, setGodowns] = useState<Godown[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [partnerGodowns, setPartnerGodowns] = useState<Set<string>>(new Set());
  const [todayDays, setTodayDays] = useState<Day[]>([]);
  const [monthRows, setMonthRows] = useState<Day[]>([]);
  const [pendingDays, setPendingDays] = useState<Day[]>([]);
  const [leaves, setLeaves] = useState<Leave[]>([]);
  const [selfies, setSelfies] = useState<Selfies>({});
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const today = indiaDate();

  const load = useCallback(async () => {
    const end = monthEnd(month);
    let branchQuery = supabase.from("branches").select("id,name,vendor_id,latitude,longitude,attendance_radius_m,shift_start,late_grace_min,weekly_off").order("sort_order");
    if (partnerBranchId) branchQuery = branchQuery.eq("id", partnerBranchId);
    const [b, e, p, t, m, pd, l] = await Promise.all([
      branchQuery,
      supabase.from("staff_employees").select("*").order("name"),
      viewer === "admin" ? supabase.from("channel_partners").select("branch_id").eq("status", "active") : Promise.resolve({ data: partnerBranchId ? [{ branch_id: partnerBranchId }] : [], error: null }),
      supabase.from("attendance_days").select("*").eq("work_date", today),
      supabase.from("attendance_days").select("*").gte("work_date", month).lte("work_date", end),
      supabase.from("attendance_days").select("*").eq("status", "pending").order("work_date"),
      supabase.from("leave_requests").select("*").or(`status.eq.pending,and(to_date.gte.${month},from_date.lte.${end})`).order("from_date", { ascending: false }),
    ]);
    const failed = [b, e, t, m, pd, l].find((result) => result.error);
    if (failed?.error) {
      setError(/does not exist|schema cache/i.test(failed.error.message)
        ? "Attendance is not set up in the database yet (migration 20261031120000_staff_attendance)."
        : failed.error.message);
    } else setError("");
    setGodowns(((b.data ?? []) as (Godown & { vendor_id: string | null })[]).filter((row) => !row.vendor_id));
    setEmployees((e.data as Employee[] | null) ?? []);
    setPartnerGodowns(new Set(((p.data ?? []) as { branch_id: string }[]).map((row) => row.branch_id)));
    const todayRows = (t.data as Day[] | null) ?? [];
    const pending = (pd.data as Day[] | null) ?? [];
    setTodayDays(todayRows);
    setMonthRows((m.data as Day[] | null) ?? []);
    setPendingDays(pending);
    setLeaves((l.data as Leave[] | null) ?? []);
    setLoaded(true);
    const ids = [...new Set([...todayRows, ...pending].map((row) => row.id))].slice(0, 300);
    if (ids.length) {
      try {
        const { attendanceSelfieUrls } = await import("@/lib/attendance.functions");
        setSelfies(await attendanceSelfieUrls({ data: { ids } }));
      } catch { /* thumbnails are optional */ }
    }
  }, [viewer, partnerBranchId, month, today]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  return { godowns, employees, partnerGodowns, todayDays, monthRows, pendingDays, leaves, selfies, setSelfies, loaded, error, today, load };
}

type Desk = ReturnType<typeof useAttendanceDesk>;

export function AttendanceManager({ viewer, partnerBranchId }: { viewer: Viewer; partnerBranchId?: string }) {
  const [month, setMonth] = useState(monthStart());
  const desk = useAttendanceDesk(viewer, partnerBranchId, month);
  const [open, setOpen] = useState<Day | null>(null);
  const employeeOf = useMemo(() => new Map(desk.employees.map((employee) => [employee.id, employee])), [desk.employees]);
  const godownOf = useMemo(() => new Map(desk.godowns.map((godown) => [godown.id, godown])), [desk.godowns]);
  const pendingLeaves = desk.leaves.filter((leave) => leave.status === "pending");
  const waitingOnMe = [...desk.pendingDays, ...pendingLeaves].filter((item) => (viewer === "admin" ? item.head_office_decision : item.partner_decision) === null).length;
  const active = desk.employees.filter((employee) => employee.status === "active");
  const onLeaveToday = new Set(desk.leaves.filter((leave) => leave.status === "approved" && leave.from_date <= desk.today && desk.today <= leave.to_date).map((leave) => leave.employee_id));

  return (
    <div className="space-y-6">
      {desk.error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{desk.error}</p>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Present today" value={`${desk.todayDays.filter((day) => day.status === "present").length} of ${active.length}`} icon={UserCheck} />
        <StatCard label="Waiting for approval" value={String(desk.pendingDays.length + pendingLeaves.length)} icon={Clock} description={`${waitingOnMe} need your decision`} />
        <StatCard label="On leave today" value={String(onLeaveToday.size)} icon={CalendarCheck} />
        <StatCard label="Employees" value={String(active.length)} icon={Users} {...(viewer === "admin" ? { description: `${desk.godowns.length} godowns` } : {})} />
      </div>

      <Tabs defaultValue="today">
        <TabsList className="flex h-auto flex-wrap justify-start">
          <TabsTrigger value="today">Today</TabsTrigger>
          <TabsTrigger value="approvals">{`Approvals (${desk.pendingDays.length + pendingLeaves.length})`}</TabsTrigger>
          <TabsTrigger value="register">Monthly register</TabsTrigger>
          <TabsTrigger value="employees">Employees</TabsTrigger>
          {viewer === "admin" && <TabsTrigger value="godowns">Godown settings</TabsTrigger>}
        </TabsList>

        <TabsContent value="today" className="mt-4 space-y-6">
          {desk.loaded && desk.godowns.map((godown) => (
            <TodayBoard key={godown.id} godown={godown} desk={desk} onLeaveToday={onLeaveToday} onOpen={setOpen}
              employees={active.filter((employee) => employee.branch_id === godown.id)} viewer={viewer} />
          ))}
          {!desk.loaded && <p className="flex items-center gap-2 text-sm text-slate"><RefreshCw className="h-4 w-4 animate-spin" /> Loading…</p>}
        </TabsContent>

        <TabsContent value="approvals" className="mt-4">
          <Approvals viewer={viewer} desk={desk} employeeOf={employeeOf} godownOf={godownOf} onOpen={setOpen} />
        </TabsContent>

        <TabsContent value="register" className="mt-4">
          <Register desk={desk} month={month} setMonth={setMonth} onOpen={setOpen} />
        </TabsContent>

        <TabsContent value="employees" className="mt-4">
          <EmployeesPanel viewer={viewer} desk={desk} />
        </TabsContent>

        {viewer === "admin" && (
          <TabsContent value="godowns" className="mt-4 space-y-6">
            {desk.godowns.map((godown) => <GodownSettings key={godown.id} godown={godown} onSaved={desk.load} />)}
          </TabsContent>
        )}
      </Tabs>

      <DayDialog day={open} viewer={viewer} desk={desk} employee={open ? employeeOf.get(open.employee_id) ?? null : null}
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
  const present = [...dayOf.values()].filter((day) => day.status === "present").length;
  return (
    <Panel title={`${godown.name} · ${present} of ${employees.length} present`}
      action={<span className="text-xs text-slate">{`Shift ${indiaTime(`2000-01-01T${godown.shift_start.slice(0, 5)}:00+05:30`)} · grace ${godown.late_grace_min} min · radius ${godown.attendance_radius_m} m`}</span>}>
      {godown.latitude === null && (
        <p className="mb-3 flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {viewer === "admin" ? "Set this godown's location in Godown settings. Until then every check-in waits for approval." : "Head office has not set this godown's location yet, so every check-in waits for approval."}
        </p>
      )}
      {employees.length === 0 ? <p className="text-sm text-slate">No employees added for this godown yet.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead><tr className="border-b border-border text-left text-xs uppercase tracking-wider text-slate">
              <th className="py-2 pr-3">Employee</th><th className="py-2 pr-3">Check-in</th><th className="py-2 pr-3">Distance</th><th className="py-2 pr-3">Check-out</th><th className="py-2">Status</th>
            </tr></thead>
            <tbody>
              {employees.map((employee) => {
                const day = dayOf.get(employee.id);
                return (
                  <tr key={employee.id} className="border-b border-border/60 last:border-0">
                    <td className="py-2 pr-3"><p className="font-semibold text-charcoal">{employee.name}</p><p className="text-xs text-slate">{employee.designation || employee.phone}</p></td>
                    <td className="py-2 pr-3">{day ? <span className="flex items-center gap-2"><SelfieThumb url={desk.selfies[day.id]?.in} onClick={() => onOpen(day)} />{indiaTime(day.check_in_at)}</span> : <span className="text-slate">—</span>}</td>
                    <td className="py-2 pr-3 text-xs text-slate">{day ? (day.in_distance_m === null ? "—" : `${day.in_distance_m} m (±${Math.round(Number(day.in_accuracy_m))} m)`) : ""}</td>
                    <td className="py-2 pr-3">{day?.check_out_at ? <span className="flex items-center gap-2"><SelfieThumb url={desk.selfies[day.id]?.out} onClick={() => onOpen(day)} />{indiaTime(day.check_out_at)}</span> : <span className="text-slate">—</span>}</td>
                    <td className="py-2">
                      {day ? <span className="flex flex-wrap items-center gap-1"><AttendanceStatusBadge status={day.status} /><FlagChips flags={day.flags} lateMinutes={day.late_minutes} /></span>
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

function DecideButtons({ kind, id, viewer, current, onDone }: { kind: "leave" | "attendance"; id: string; viewer: Viewer; current: string | null; onDone: () => Promise<void> }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const decide = async (decision: "approved" | "rejected") => {
    setBusy(true);
    const { data, error } = await supabase.rpc("attendance_decide", { _kind: kind, _id: id, _decision: decision, _note: note });
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

function Approvals({ viewer, desk, employeeOf, godownOf, onOpen }: {
  viewer: Viewer; desk: Desk; employeeOf: Map<string, Employee>; godownOf: Map<string, Godown>; onOpen: (day: Day) => void;
}) {
  const mine = (item: { head_office_decision: string | null; partner_decision: string | null }) => (viewer === "admin" ? item.head_office_decision : item.partner_decision);
  const order = <T extends { head_office_decision: string | null; partner_decision: string | null }>(items: T[]) => [...items].sort((a, b) => Number(mine(a) !== null) - Number(mine(b) !== null));
  const leaves = order(desk.leaves.filter((leave) => leave.status === "pending"));
  const days = order(desk.pendingDays);
  const who = (employeeId: string, branchId: string) => `${employeeOf.get(employeeId)?.name ?? "Employee"} · ${godownOf.get(branchId)?.name ?? branchId}`;
  const required = (branchId: string) => viewer === "partner" || desk.partnerGodowns.has(branchId);

  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <Panel title={`Leave requests (${leaves.length})`}>
        {leaves.length === 0 ? <p className="text-sm text-slate">No leave requests waiting.</p> : (
          <ul className="divide-y divide-border">
            {leaves.map((leave) => (
              <li key={leave.id} className="space-y-2 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold text-charcoal">{who(leave.employee_id, leave.branch_id)}</p>
                  <span className="text-xs text-slate">{`Requested ${new Date(leave.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`}</span>
                </div>
                <p className="text-sm text-navy">
                  {leave.from_date === leave.to_date ? formatDay(leave.from_date) : `${formatDay(leave.from_date)} – ${formatDay(leave.to_date)}`}
                  {` · ${leaveDays(leave.from_date, leave.to_date)} day(s) · `}{LEAVE_TYPES.find((option) => option.value === leave.leave_type)?.label ?? leave.leave_type}
                </p>
                <p className="text-sm text-slate">{leave.reason}</p>
                <DecisionChips head={leave.head_office_decision} partner={leave.partner_decision} partnerRequired={required(leave.branch_id)} />
                <DecideButtons kind="leave" id={leave.id} viewer={viewer} current={mine(leave)} onDone={desk.load} />
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title={`Check-ins to approve (${days.length})`}>
        {days.length === 0 ? <p className="text-sm text-slate">No check-ins waiting.</p> : (
          <ul className="divide-y divide-border">
            {days.map((day) => (
              <li key={day.id} className="space-y-2 py-3">
                <div className="flex items-start gap-3">
                  <SelfieThumb url={desk.selfies[day.id]?.in} onClick={() => onOpen(day)} />
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="font-semibold text-charcoal">{who(day.employee_id, day.branch_id)}</p>
                    <p className="text-sm text-navy">{`${formatDay(day.work_date)} · ${indiaTime(day.check_in_at)}${day.in_distance_m !== null ? ` · ${day.in_distance_m} m from godown` : ""}`}</p>
                    <FlagChips flags={day.flags} lateMinutes={day.late_minutes} />
                    {day.employee_note && <p className="text-sm text-slate">{`“${day.employee_note}”`}</p>}
                    <a href={mapLink(day.in_lat, day.in_lng)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-navy underline"><MapPin className="h-3 w-3" /> Open location in Google Maps</a>
                  </div>
                </div>
                <DecisionChips head={day.head_office_decision} partner={day.partner_decision} partnerRequired={required(day.branch_id)} />
                <DecideButtons kind="attendance" id={day.id} viewer={viewer} current={mine(day)} onDone={desk.load} />
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

const MARK_STYLE: Record<RegisterMark, string> = {
  P: "bg-emerald-100 text-emerald-800", L: "bg-lime-100 text-lime-800", LV: "bg-sky-100 text-sky-800", WO: "bg-slate-100 text-slate-500", "?": "bg-amber-100 text-amber-900",
  X: "bg-red-100 text-red-700", A: "bg-red-50 text-red-600", "": "text-slate/40",
};

function Register({ desk, month, setMonth, onOpen }: {
  desk: Desk; month: string; setMonth: (month: string) => void; onOpen: (day: Day) => void;
}) {
  const [godownId, setGodownId] = useState("all");
  const dates = monthDays(month);
  const godowns = desk.godowns.filter((godown) => godownId === "all" || godown.id === godownId);
  const ids = new Set(godowns.map((godown) => godown.id));
  // Everyone who worked this month or is still active, so a deactivated employee's days still show.
  const staff = desk.employees.filter((employee) => ids.has(employee.branch_id) && (employee.status === "active" || desk.monthRows.some((day) => day.employee_id === employee.id)));
  const leaves = desk.leaves.filter((leave) => leave.status !== "cancelled" && leave.to_date >= month && leave.from_date <= monthEnd(month));
  const days = desk.monthRows.filter((day) => staff.some((employee) => employee.id === day.employee_id));
  const rows = staff.map((employee) => ({
    employee,
    ...summariseMonth(month, days.filter((day) => day.employee_id === employee.id), leaves.filter((leave) => leave.employee_id === employee.id), desk.today,
      { joined: employee.joined_on, weeklyOff: desk.godowns.find((godown) => godown.id === employee.branch_id)?.weekly_off ?? null }),
  }));
  const dayOf = new Map(days.map((day) => [`${day.employee_id}:${day.work_date}`, day]));

  const exportExcel = () => downloadXlsx(`attendance-${month.slice(0, 7)}`, attendanceWorkbook({
    month, monthName: monthLabel(month), today: desk.today, godowns, employees: staff, days,
    leaves: leaves.filter((leave) => staff.some((employee) => employee.id === leave.employee_id)),
  }));
  const exportCsv = () => downloadCSV(`attendance-summary-${month.slice(0, 7)}.csv`, SUMMARY_HEADER,
    rows.map(({ employee, summary }) => summaryRow(desk.godowns.find((godown) => godown.id === employee.branch_id)?.name ?? employee.branch_id, employee, summary)));

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
        <button type="button" onClick={exportExcel} className="inline-flex h-9 items-center gap-1.5 rounded-md bg-navy px-3 text-sm font-semibold text-white"><FileSpreadsheet className="h-4 w-4" /> Download Excel</button>
        <button type="button" onClick={exportCsv} className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-sm font-semibold text-navy"><Download className="h-4 w-4" /> CSV</button>
      </>
    }>
      <p className="mb-3 text-xs text-slate">{REGISTER_LEGEND}</p>
      <p className="mb-3 text-xs text-slate">Click a day to see the selfie and location.</p>
      {rows.length === 0 ? <p className="text-sm text-slate">No employees.</p> : (
        <div className="overflow-x-auto">
          <table className="text-xs">
            <thead><tr className="text-slate">
              <th className="sticky left-0 z-10 bg-card py-1 pr-3 text-left">Employee</th>
              {dates.map((date) => <th key={date} className={cn("w-7 px-0.5 py-1 text-center font-semibold", weekday(date) === 0 && "text-red-500")}>{Number(date.slice(8))}</th>)}
              {["P", "L", "LV", "WO", "?", "A", "Hours"].map((label) => <th key={label} className="px-1.5 py-1 text-center">{label}</th>)}
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
                  {[s.present, s.late, s.leave, s.weeklyOff, s.pending, s.absent, s.hours].map((value, index) => <td key={index} className="px-1.5 text-center font-semibold text-navy">{value}</td>)}
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
  const setField = async (employee: Employee, change: { status?: string; branch_id?: string }) => {
    const { error } = await supabase.from("staff_employees").update({ ...change, updated_at: new Date().toISOString() }).eq("id", employee.id);
    if (error) { toast.error("Could not update the employee", { description: error.message }); return; }
    toast.success(change.status === "inactive" ? `${employee.name} deactivated: they can no longer mark attendance` : change.status === "active" ? `${employee.name} reactivated` : `${employee.name} moved to ${godownName(change.branch_id ?? "")}`);
    await desk.load();
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[380px_minmax(0,1fr)]">
      {viewer === "admin" ? <AddEmployeeForm godowns={desk.godowns} onAdded={desk.load} /> : (
        <Panel title="Staff login"><p className="text-sm text-slate">Head office adds and removes employees. They mark attendance at <span className="font-semibold text-navy">{STAFF_LOGIN_URL}</span>.</p></Panel>
      )}
      <Panel title={`Employees (${desk.employees.length})`}>
        {desk.employees.length === 0 ? <p className="text-sm text-slate">No employees yet.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-sm">
              <thead><tr className="border-b border-border text-left text-xs uppercase tracking-wider text-slate">
                <th className="py-2 pr-3">Name</th><th className="py-2 pr-3">Mobile</th><th className="py-2 pr-3">Godown</th><th className="py-2 pr-3">Joined</th><th className="py-2 pr-3">Status</th>{viewer === "admin" && <th className="py-2" />}
              </tr></thead>
              <tbody>
                {desk.employees.map((employee) => (
                  <tr key={employee.id} className="border-b border-border/60 last:border-0">
                    <td className="py-2 pr-3"><p className="font-semibold text-charcoal">{employee.name}</p><p className="text-xs text-slate">{employee.designation}</p></td>
                    <td className="py-2 pr-3 tabular-nums">{employee.phone}</td>
                    <td className="py-2 pr-3">
                      {viewer === "admin" && desk.godowns.length > 1 ? (
                        <select value={employee.branch_id} onChange={(event) => void setField(employee, { branch_id: event.target.value })} aria-label="Godown"
                          className="h-8 rounded-md border border-input bg-white px-1 text-sm">
                          {desk.godowns.map((godown) => <option key={godown.id} value={godown.id}>{godown.name}</option>)}
                        </select>
                      ) : godownName(employee.branch_id)}
                    </td>
                    <td className="py-2 pr-3 text-xs text-slate">{new Date(`${employee.joined_on}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</td>
                    <td className="py-2 pr-3"><span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", employee.status === "active" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600")}>{employee.status === "active" ? "Active" : "Inactive"}</span></td>
                    {viewer === "admin" && (
                      <td className="py-2 text-right">
                        <button type="button" onClick={() => void setField(employee, { status: employee.status === "active" ? "inactive" : "active" })}
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
    </div>
  );
}

function AddEmployeeForm({ godowns, onAdded }: { godowns: Godown[]; onAdded: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [designation, setDesignation] = useState("");
  const [branchId, setBranchId] = useState("");
  const [busy, setBusy] = useState(false);
  const branch = branchId || godowns[0]?.id || "";

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const { addStaffEmployee } = await import("@/lib/attendance.functions");
      const result = await addStaffEmployee({ data: { branchId: branch, name, phone, designation } });
      toast.success(`${name} added to ${result.godown}`, {
        description: `They sign in at ${STAFF_LOGIN_URL} with an SMS code to ${result.phone}.${result.linkedExistingAccount ? " Their existing Grain Bazar account on this mobile is used." : ""}`,
      });
      setName(""); setPhone(""); setDesignation("");
      await onAdded();
    } catch (cause) {
      toast.error("Could not add the employee", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Add employee">
      <form onSubmit={(event) => void add(event)} className="space-y-3">
        <label className="block"><span className="mb-1 block text-xs font-semibold text-charcoal">Name</span><Input required minLength={2} value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label className="block"><span className="mb-1 block text-xs font-semibold text-charcoal">Mobile number</span>
          <Input required inputMode="numeric" value={phone} onChange={(event) => setPhone(event.target.value.replace(/[^\d+ ]/g, ""))} placeholder="98XXXXXXXX" /></label>
        <label className="block"><span className="mb-1 block text-xs font-semibold text-charcoal">Godown</span>
          <select value={branch} onChange={(event) => setBranchId(event.target.value)} className="h-10 w-full rounded-md border border-input bg-white px-2 text-sm">
            {godowns.map((godown) => <option key={godown.id} value={godown.id}>{godown.name}</option>)}
          </select></label>
        <label className="block"><span className="mb-1 block text-xs font-semibold text-charcoal">Designation (optional)</span>
          <Input value={designation} onChange={(event) => setDesignation(event.target.value)} placeholder="Loader, Supervisor…" /></label>
        <button type="submit" disabled={busy || !branch} className="flex w-full items-center justify-center gap-2 rounded-md bg-navy py-2.5 text-sm font-semibold text-white disabled:opacity-60">
          <UserPlus className="h-4 w-4" /> {busy ? "Adding…" : "Add employee"}
        </button>
        <div className="rounded-md bg-ivory p-3 text-xs text-slate">
          <p>{`Employees open ${STAFF_LOGIN_URL} on their phone and sign in with an SMS code. No password.`}</p>
          <button type="button" onClick={() => { void navigator.clipboard?.writeText(STAFF_LOGIN_URL); toast.success("Link copied"); }}
            className="mt-1 inline-flex items-center gap-1 font-semibold text-navy hover:underline"><Copy className="h-3 w-3" /> Copy link</button>
        </div>
      </form>
    </Panel>
  );
}

function GodownSettings({ godown, onSaved }: { godown: Godown; onSaved: () => Promise<void> }) {
  const [lat, setLat] = useState(godown.latitude?.toString() ?? "");
  const [lng, setLng] = useState(godown.longitude?.toString() ?? "");
  const [paste, setPaste] = useState("");
  const [radius, setRadius] = useState(String(godown.attendance_radius_m));
  const [shift, setShift] = useState(godown.shift_start.slice(0, 5));
  const [grace, setGrace] = useState(String(godown.late_grace_min));
  const [weeklyOff, setWeeklyOff] = useState(godown.weekly_off === null ? "none" : String(godown.weekly_off));
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
    if (!/^\d{2}:\d{2}$/.test(shift)) { toast.error("Enter the shift start time"); return; }
    setBusy(true);
    const { error } = await supabase.from("branches").update({ latitude, longitude, attendance_radius_m: radiusM, shift_start: shift, late_grace_min: graceMin, weekly_off: weeklyOff === "none" ? null : Number(weeklyOff), updated_at: new Date().toISOString() }).eq("id", godown.id);
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
        </div>
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <label className="block"><span className="mb-1 block text-xs font-semibold text-charcoal">Radius (m)</span><Input type="number" min={25} max={2000} value={radius} onChange={(event) => setRadius(event.target.value)} /></label>
            <label className="block"><span className="mb-1 block text-xs font-semibold text-charcoal">Shift starts</span><Input type="time" value={shift} onChange={(event) => setShift(event.target.value)} /></label>
            <label className="block"><span className="mb-1 block text-xs font-semibold text-charcoal">Grace (min)</span><Input type="number" min={0} max={240} value={grace} onChange={(event) => setGrace(event.target.value)} /></label>
          </div>
          <label className="block"><span className="mb-1 block text-xs font-semibold text-charcoal">Weekly off (not counted as absent)</span>
            <select value={weeklyOff} onChange={(event) => setWeeklyOff(event.target.value)} className="h-10 w-full rounded-md border border-input bg-white px-2 text-sm">
              {WEEKDAYS.map((day, index) => <option key={day} value={String(index)}>{day}</option>)}
              <option value="none">No weekly off (open every day)</option>
            </select></label>
          <p className="text-xs text-slate">{`Check-ins within ${radius || "?"} m of the godown, before ${shift || "?"} + ${grace || "0"} min, count as Present at once. Others wait for head office and the channel partner.`}</p>
          <button type="button" disabled={busy} onClick={() => void save()} className="inline-flex items-center gap-1.5 rounded-md bg-navy px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
            <Save className="h-4 w-4" /> {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </Panel>
  );
}

function DayDialog({ day, viewer, desk, employee, godown, onClose }: {
  day: Day | null; viewer: Viewer; desk: Desk; employee: Employee | null; godown: Godown | null; onClose: () => void;
}) {
  const urls = day ? desk.selfies[day.id] : undefined;
  const { setSelfies } = desk;
  // Days outside today / the approval list have no link yet: fetch this one.
  useEffect(() => {
    if (!day || urls) return;
    void (async () => {
      try {
        const { attendanceSelfieUrls } = await import("@/lib/attendance.functions");
        const result = await attendanceSelfieUrls({ data: { ids: [day.id] } });
        setSelfies((current) => ({ ...current, ...result }));
      } catch { /* shown without photo */ }
    })();
  }, [day, urls, setSelfies]);
  const live = day ? desk.monthRows.find((row) => row.id === day.id) ?? desk.pendingDays.find((row) => row.id === day.id) ?? desk.todayDays.find((row) => row.id === day.id) ?? day : null;

  return (
    <Dialog open={Boolean(day)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        {live && (
          <>
            <DialogHeader><DialogTitle>{`${employee?.name ?? "Employee"} · ${formatDay(live.work_date)}`}</DialogTitle></DialogHeader>
            <div className="grid gap-4 sm:grid-cols-2">
              {[{ label: "Check-in", url: urls?.in, at: live.check_in_at, lat: live.in_lat, lng: live.in_lng, distance: live.in_distance_m, accuracy: Number(live.in_accuracy_m) },
                ...(live.check_out_at && live.out_lat !== null && live.out_lng !== null ? [{ label: "Check-out", url: urls?.out, at: live.check_out_at, lat: live.out_lat, lng: live.out_lng, distance: live.out_distance_m, accuracy: Number(live.out_accuracy_m) }] : [])]
                .map((shot) => (
                  <figure key={shot.label} className="space-y-1">
                    {shot.url ? <img src={shot.url} alt={`${shot.label} selfie`} className="w-full rounded-lg" /> : <div className="grid aspect-[3/4] place-items-center rounded-lg bg-ivory text-xs text-slate">Loading photo…</div>}
                    <figcaption className="text-sm">
                      <span className="font-semibold text-navy">{`${shot.label} ${indiaTime(shot.at)}`}</span>
                      <span className="block text-xs text-slate">{shot.distance === null ? `GPS ±${Math.round(shot.accuracy)} m` : `${shot.distance} m from ${godown?.name ?? "godown"} · GPS ±${Math.round(shot.accuracy)} m`}</span>
                      <a href={mapLink(shot.lat, shot.lng)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-navy underline"><MapPin className="h-3 w-3" /> Google Maps</a>
                    </figcaption>
                  </figure>
                ))}
            </div>
            <div className="space-y-2 border-t border-border pt-3">
              <div className="flex flex-wrap items-center gap-2"><AttendanceStatusBadge status={live.status} /><FlagChips flags={live.flags} lateMinutes={live.late_minutes} /></div>
              {live.employee_note && <p className="text-sm text-slate">{`“${live.employee_note}”`}</p>}
              <DecisionChips head={live.head_office_decision} partner={live.partner_decision} partnerRequired={viewer === "partner" || desk.partnerGodowns.has(live.branch_id)} />
              {(live.head_office_note || live.partner_note) && <p className="text-xs italic text-slate">{[live.head_office_note, live.partner_note].filter(Boolean).join(" · ")}</p>}
              <DecideButtons kind="attendance" id={live.id} viewer={viewer} current={viewer === "admin" ? live.head_office_decision : live.partner_decision} onDone={desk.load} />
              {live.flags.length === 0 && <p className="text-xs text-slate">This day was Present at once. Reject it if the selfie or place is wrong.</p>}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
