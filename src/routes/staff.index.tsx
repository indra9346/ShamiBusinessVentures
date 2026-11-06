import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Camera, CalendarDays, CheckCircle2, Clock, LogIn, LogOut, MapPin, RefreshCw, Send, Smartphone } from "lucide-react";
import { LogoMark } from "@/components/brand/Logo";
import { LanguageSwitcher } from "@/components/site/LanguageSwitcher";
import { AttendanceStatusBadge, DecisionChips, RuleList } from "@/components/attendance/AttendanceBits";
import { SelfieCamera } from "@/components/attendance/SelfieCamera";
import { StaffStockCount } from "@/components/attendance/StaffStockCount";
import { getBestFix } from "@/components/attendance/geolocation";
import { useGodownDevice, type GodownDevice } from "@/components/attendance/godownDevice";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { serverNow, syncServerClock } from "@/lib/server-clock";
import {
  DEFAULT_RULES, LEAVE_TYPES, clockTime, dayPresenceSchedule, dayStatus, earlyText, formatDuration, geofenceRefusal, holidayDates, indiaDate, indiaTime, lateMinutes, lateText,
  leaveDays, leaveProblem, locationVerdict, presenceSchedule, rulesLookup, rulesOn, summariseMonth, weekday, workedMinutes, type Fix, type GodownHoliday,
  type GodownRules, type LeaveType, type MonthTile, type RuleVersion,
  datesOfTile, monthDays,
} from "@/lib/attendance";

export const Route = createFileRoute("/staff/")({
  head: () => ({ meta: [{ title: "Staff Attendance | Grain Bazar" }, { name: "robots", content: "noindex" }] }),
  component: StaffHome,
});

type Employee = Database["public"]["Tables"]["staff_employees"]["Row"];
type Day = Database["public"]["Tables"]["attendance_days"]["Row"];
type Leave = Database["public"]["Tables"]["leave_requests"]["Row"];
type Photo = { taken_at: string; inside: boolean; distance_m: number | null };
type Godown = { name: string; latitude: number | null; longitude: number | null };
type Kind = "in" | "out" | "presence";
type Flow =
  | { step: "locating"; kind: Kind }
  | { step: "camera"; kind: Kind; fix: Fix }
  | { step: "confirm"; kind: Kind; fix: Fix; selfie: string }
  | { step: "done"; kind: Kind; at: string; lateMinutes: number; earlyMinutes: number; inside: boolean };

/**
 * The godown attendance device app: the employee signs in (mobile + password), marks check-in and
 * check-out inside the godown with a live selfie, sends a presence photo when due, requests leave
 * and counts stock. Works only on the godown's registered device.
 */
function StaffHome() {
  const navigate = useNavigate();
  const { device, checked: deviceChecked } = useGodownDevice();
  const [me, setMe] = useState<Employee | null>(null);
  const [godown, setGodown] = useState<Godown | null>(null);
  const [days, setDays] = useState<Day[]>([]);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [leaves, setLeaves] = useState<Leave[]>([]);
  const [versions, setVersions] = useState<RuleVersion[]>([]);
  const [holidays, setHolidays] = useState<GodownHoliday[]>([]);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [problem, setProblem] = useState("");
  const [now, setNow] = useState(() => serverNow());
  const today = indiaDate(now);
  const month = `${today.slice(0, 7)}-01`;

  useEffect(() => {
    const timer = setInterval(() => setNow(serverNow()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const load = useCallback(async (employee: Employee) => {
    const [d, l, rv, hd] = await Promise.all([
      supabase.from("attendance_days").select("*").eq("employee_id", employee.id).gte("work_date", month).order("work_date", { ascending: false }),
      supabase.from("leave_requests").select("*").eq("employee_id", employee.id).order("from_date", { ascending: false }).limit(20),
      supabase.from("godown_rule_versions").select("*").eq("branch_id", employee.branch_id).order("effective_from"),
      supabase.from("godown_holidays").select("id,branch_id,holiday_date,name").eq("branch_id", employee.branch_id).is("removed_at", null).order("holiday_date"),
    ]);
    setVersions((rv.data as RuleVersion[] | null) ?? []);
    setHolidays((hd.data as GodownHoliday[] | null) ?? []);
    const rows = (d.data as Day[] | null) ?? [];
    setDays(rows);
    setLeaves((l.data as Leave[] | null) ?? []);
    const todayRow = rows.find((row) => row.work_date === indiaDate(serverNow()));
    if (todayRow) {
      const { data } = await supabase.from("attendance_presence").select("taken_at,inside,distance_m").eq("attendance_day_id", todayRow.id).order("taken_at");
      setPhotos((data as Photo[] | null) ?? []);
    } else setPhotos([]);
  }, [month]);

  // Only an active employee may stay here; anyone else goes to the staff login.
  useEffect(() => {
    void syncServerClock();
    void (async () => {
      const { data: session } = await supabase.auth.getSession();
      const userId = session.session?.user.id;
      if (!userId) { navigate({ to: "/staff/login", replace: true }); return; }
      const { data: employee } = await supabase.from("staff_employees").select("*").eq("user_id", userId).maybeSingle();
      if (!employee || employee.status !== "active") { await supabase.auth.signOut({ scope: "local" }); navigate({ to: "/staff/login", replace: true }); return; }
      const [{ data: branch }] = await Promise.all([
        supabase.from("branches").select("name,latitude,longitude").eq("id", employee.branch_id).maybeSingle(),
        load(employee as Employee),
      ]);
      setMe(employee as Employee);
      setGodown((branch as Godown | null) ?? null);
    })();
  }, [navigate, load]);

  // The godown's device may stay open all day: rule changes and leave decisions reach it without a reload.
  useEffect(() => {
    if (!me) return undefined;
    const timer = setInterval(() => void load(me), 60_000);
    return () => clearInterval(timer);
  }, [me, load]);

  const todayRow = days.find((day) => day.work_date === today) ?? null;
  const onLeaveToday = leaves.some((leave) => leave.status === "approved" && leave.from_date <= today && today <= leave.to_date);
  const branchId = me?.branch_id ?? "";
  // Where and how attendance can be marked follows today's rules; a day already marked keeps its own.
  const rulesToday: GodownRules = rulesOn(versions, branchId, today) ?? DEFAULT_RULES;
  const rulesFor = useMemo(() => rulesLookup(versions, branchId), [versions, branchId]);
  const dayRules: GodownRules = (todayRow && rulesFor(today, todayRow)) || rulesToday;
  const holidayDays = useMemo(() => holidayDates(holidays, branchId), [holidays, branchId]);
  const monthRegister = useMemo(() => summariseMonth(month, days, leaves, today, { joined: me?.joined_on ?? "", rulesFor, holidays: holidayDays }),
    [month, days, leaves, today, me?.joined_on, rulesFor, holidayDays]);
  const monthSummary = monthRegister.summary;
  const [dayFilter, setDayFilter] = useState<MonthTile | null>(null);
  const tileDates = dayFilter ? datesOfTile(monthDays(month), monthRegister.marks, dayFilter) : [];
  const schedule = useMemo(() => (todayRow ? dayPresenceSchedule(todayRow, dayRules, photos.map((photo) => Date.parse(photo.taken_at)), now) : null),
    [todayRow, dayRules, photos, now]);
  // The device must be this godown's registered device, unless the godown's rules allow any phone.
  const deviceOk = !rulesToday.require_device || Boolean(device && me && device.branchId === me.branch_id);

  const begin = async (kind: Kind) => {
    setProblem("");
    setFlow({ step: "locating", kind });
    try {
      const fix = await getBestFix();
      if (kind !== "presence" && godown) {
        const place = locationVerdict({ latitude: godown.latitude, longitude: godown.longitude, radiusM: rulesToday.radius_m, accuracyLimitM: rulesToday.gps_accuracy_limit_m }, fix);
        const refusal = geofenceRefusal(place.verdict, place.distanceM, rulesToday.radius_m);
        if (refusal) { setFlow(null); setProblem(refusal); return; }
      }
      setFlow({ step: "camera", kind, fix });
    } catch (cause) {
      setFlow(null);
      setProblem(cause instanceof Error ? cause.message : "Location not found");
    }
  };

  const signOut = async () => { await supabase.auth.signOut({ scope: "local" }); navigate({ to: "/staff/login" }); };

  if (!me) {
    return <div className="grid min-h-screen place-items-center bg-panel text-sm text-slate"><span className="inline-flex items-center gap-2"><RefreshCw className="h-4 w-4 animate-spin" /> Opening attendance…</span></div>;
  }

  return (
    <div className="min-h-screen bg-[oklch(0.972_0.004_258)] pb-10">
      <header className="sticky top-0 z-30 border-b border-border bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-md items-center justify-between gap-2 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <LogoMark className="h-9 w-9 shrink-0 rounded-lg bg-card p-1 object-contain shadow-sm" />
            <div className="min-w-0">
              <p className="truncate text-sm font-extrabold text-navy">{me.name}</p>
              <p className="truncate text-xs text-slate">{godown?.name ?? me.branch_id}{me.designation ? ` · ${me.designation}` : ""}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <LanguageSwitcher compact />
            <button type="button" aria-label="Sign out" onClick={() => void signOut()}
              className="grid h-9 w-9 place-items-center rounded-md border border-border text-navy hover:border-gold hover:text-gold">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-md space-y-4 px-4 py-4">
        {deviceChecked && !deviceOk && <DeviceWarning device={device} godownName={godown?.name ?? me.branch_id} />}
        {problem && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{problem}</p>}

        {flow ? (
          <MarkFlow flow={flow} setFlow={setFlow} me={me} godown={godown} rules={rulesToday} device={device}
            onDone={async () => { setFlow(null); await load(me); }} onSignOut={() => void signOut()} />
        ) : (
          <>
            <TodayCard today={today} row={todayRow} rules={dayRules} holiday={holidays.find((entry) => entry.holiday_date === today)?.name ?? ""} onLeaveToday={onLeaveToday} canMark={deviceOk} onBegin={(kind) => void begin(kind)} />
            {todayRow && !todayRow.check_out_at && schedule && dayRules.presence_interval_min > 0 && (
              <PresenceCard schedule={schedule} photos={photos} intervalMin={dayRules.presence_interval_min} now={now} canMark={deviceOk} onBegin={() => void begin("presence")} />
            )}
          </>
        )}

        <LeaveCard leaves={leaves} today={today} rules={rulesToday} versions={versions} holidays={holidays} onChange={() => load(me)} />

        <StaffStockCount branchId={me.branch_id} />

        <section className="rounded-2xl border border-border bg-card p-4 shadow-sm">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-bold text-navy"><CalendarDays className="h-4 w-4" /> This month</h2>
          <div className="grid grid-cols-4 gap-2 text-center">
            {[["Present", String(monthSummary.present)], ["Late days", String(monthSummary.late)], ["Leave", String(monthSummary.leave)], ["Absent", String(monthSummary.absent)],
              // Only where they happen: a godown without half days or holidays keeps its four totals.
              ...(monthSummary.halfDay ? [["Half day", String(monthSummary.halfDay)]] : []), ...(monthSummary.holiday ? [["Holiday", String(monthSummary.holiday)]] : [])].map(([label, value]) => (
              <button key={label} type="button" aria-pressed={dayFilter === label} onClick={() => setDayFilter(dayFilter === label ? null : label as MonthTile)} className={`flex flex-col items-center justify-start rounded-lg px-1 py-2 ${dayFilter === label ? "bg-navy/10 ring-2 ring-navy" : "bg-ivory"}`}><p className="text-lg font-extrabold text-navy">{value}</p><p className="text-[11px] text-slate">{label}</p></button>
            ))}
          </div>
          {monthSummary.lateMinutes > 0 && <p className="mt-2 text-xs text-amber-800">{`Total late this month: ${formatDuration(monthSummary.lateMinutes)}`}</p>}
          {dayFilter && (
            <ul className="mt-3 divide-y divide-border text-sm">
              {tileDates.length === 0 && <li className="py-2 text-xs text-slate">No days here this month.</li>}
              {tileDates.map((date) => {
                const day = days.find((row) => row.work_date === date);
                return (
                  <li key={date} className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 py-2">
                    <span className="text-charcoal">{new Date(`${date}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}</span>
                    {day ? <span className="text-xs text-slate">{indiaTime(day.check_in_at)}{day.check_out_at ? ` – ${indiaTime(day.check_out_at)}` : ""}</span> : <span className="text-xs text-slate">{dayFilter}</span>}
                    {day && day.late_minutes > 0 && <span className="text-xs font-semibold text-amber-800">{lateText(day.late_minutes)}</span>}
                  </li>
                );
              })}
            </ul>
          )}
          {!dayFilter && <ul className="mt-3 divide-y divide-border text-sm">
            {days.slice(0, 10).map((day) => (
              <li key={day.id} className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 py-2">
                <span className="text-charcoal">{new Date(`${day.work_date}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}</span>
                <span className="text-xs text-slate">{indiaTime(day.check_in_at)}{day.check_out_at ? ` – ${indiaTime(day.check_out_at)}` : ""}</span>
                {day.late_minutes > 0 && <span className="text-xs font-semibold text-amber-800">{lateText(day.late_minutes)}</span>}
                {(day.late_minutes === 0 || dayStatus(day, rulesFor(day.work_date, day), today) !== day.status) && <AttendanceStatusBadge status={dayStatus(day, rulesFor(day.work_date, day), today)} />}
              </li>
            ))}
          </ul>}
        </section>

        <details className="rounded-2xl border border-border bg-card p-4 shadow-sm">
          <summary className="cursor-pointer text-sm font-bold text-navy">{`Rules at ${godown?.name ?? "your godown"}`}</summary>
          <p className="mb-2 mt-2 text-xs text-slate">Set by head office for your godown.</p>
          <RuleList rules={rulesToday} compact />
        </details>
      </main>
    </div>
  );
}

function DeviceWarning({ device, godownName }: { device: GodownDevice | null; godownName: string }) {
  return (
    <section className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
      <p className="flex items-center gap-2 font-bold"><Smartphone className="h-4 w-4" /> Use your godown's attendance device</p>
      <p className="mt-1">{device
        ? `This device is registered for ${device.godown}. Attendance for ${godownName} must be marked on ${godownName}'s device.`
        : "This phone is not registered for attendance. Mark attendance on your godown's registered phone or tablet."}</p>
      <Link to="/staff/device" className="mt-2 inline-block font-semibold underline">Register this device (needs a code from head office)</Link>
    </section>
  );
}

function TodayCard({ today, row, rules, holiday, onLeaveToday, canMark, onBegin }: {
  today: string; row: Day | null; rules: GodownRules; holiday: string; onLeaveToday: boolean; canMark: boolean; onBegin: (kind: Kind) => void;
}) {
  return (
    <section className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wider text-slate">
        {new Date(`${today}T00:00:00`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}
      </p>
      <p className="mt-0.5 text-xs text-slate">{`Shift ${clockTime(rules.shift_start)} – ${clockTime(rules.shift_end)} · grace ${rules.late_grace_min} min`}</p>
      {holiday ? <p className="mt-3 rounded-lg bg-sky-50 px-3 py-2 text-sm font-semibold text-sky-800">{`Holiday today: ${holiday}`}</p>
        : rules.weekly_off === weekday(today) ? <p className="mt-3 rounded-lg bg-sky-50 px-3 py-2 text-sm font-semibold text-sky-800">Today is this godown's weekly off.</p> : null}
      {onLeaveToday && !row && <p className="mt-3 rounded-lg bg-sky-50 px-3 py-2 text-sm font-semibold text-sky-800">You are on approved leave today.</p>}
      {!row ? (
        <button type="button" disabled={!canMark} onClick={() => onBegin("in")}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-navy py-5 text-lg font-extrabold text-white shadow-md active:scale-[0.99] disabled:opacity-50">
          <LogIn className="h-6 w-6" /> Mark attendance
        </button>
      ) : (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-base font-bold text-navy">{`Checked in at ${indiaTime(row.check_in_at)}`}</p>
            <AttendanceStatusBadge status={dayStatus(row, rules, today)} />
          </div>
          {row.late_minutes > 0 && <p className="text-sm font-semibold text-amber-800">{lateText(row.late_minutes)}</p>}
          {row.check_out_at ? (
            <div className="space-y-1">
              <p className="flex items-center gap-2 text-sm font-semibold text-emerald-700"><CheckCircle2 className="h-4 w-4" /> {`Checked out at ${indiaTime(row.check_out_at)}`}</p>
              {row.early_leave_minutes > 0 && <p className="text-sm font-semibold text-amber-800">{earlyText(row.early_leave_minutes)}</p>}
              <p className="text-xs text-slate">{`Worked ${formatDuration(workedMinutes(row.check_in_at, row.check_out_at))}`}</p>
            </div>
          ) : (
            <button type="button" disabled={!canMark} onClick={() => onBegin("out")}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border-2 border-navy py-4 text-base font-bold text-navy active:scale-[0.99] disabled:opacity-50">
              <LogOut className="h-5 w-5" /> Check out
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function PresenceCard({ schedule, photos, intervalMin, now, canMark, onBegin }: {
  schedule: ReturnType<typeof presenceSchedule>; photos: Photo[]; intervalMin: number; now: number; canMark: boolean; onBegin: () => void;
}) {
  const current = schedule.slots.find((slot) => slot.status === "due");
  const next = schedule.slots.find((slot) => slot.status === "upcoming");
  const minutesTo = next ? Math.max(0, Math.round((next.due - now) / 60_000)) : 0;
  return (
    <section className={`rounded-2xl border p-4 shadow-sm ${current ? "border-amber-300 bg-amber-50" : "border-border bg-card"}`}>
      <h2 className="flex items-center gap-2 text-sm font-bold text-navy"><Camera className="h-4 w-4" /> Presence photos</h2>
      <p className="mt-1 text-xs text-slate">{`A live selfie at the godown every ${formatDuration(intervalMin)} while you are checked in.`}</p>
      {current ? (
        <p className="mt-2 flex items-center gap-2 text-sm font-bold text-amber-900"><AlertTriangle className="h-4 w-4" /> {`Presence photo due now (${indiaTime(current.due)})`}</p>
      ) : next ? (
        <p className="mt-2 flex items-center gap-2 text-sm text-navy"><Clock className="h-4 w-4" /> {`Next photo due at ${indiaTime(next.due)} (in ${formatDuration(minutesTo)})`}</p>
      ) : (
        <p className="mt-2 text-sm text-slate">No more presence photos due today.</p>
      )}
      <p className="mt-1 text-xs text-slate">{`Sent ${schedule.done + schedule.late} of ${schedule.required} due so far${schedule.missed ? ` · ${schedule.missed} missed` : ""}`}</p>
      <button type="button" disabled={!canMark} onClick={onBegin}
        className={`mt-3 flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold disabled:opacity-50 ${current ? "bg-amber-600 text-white" : "border border-navy text-navy"}`}>
        <Camera className="h-4 w-4" /> Send presence photo
      </button>
      {photos.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
          {photos.map((photo) => (
            <li key={photo.taken_at} className={`rounded px-1.5 py-0.5 font-semibold ${photo.inside ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-700"}`}>
              {indiaTime(photo.taken_at)}{photo.inside ? "" : " · outside"}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MarkFlow({ flow, setFlow, me, godown, rules, device, onDone, onSignOut }: {
  flow: Flow; setFlow: (flow: Flow | null) => void; me: Employee; godown: Godown | null; rules: GodownRules; device: GodownDevice | null;
  onDone: () => Promise<void>; onSignOut: () => void;
}) {
  const [sending, setSending] = useState(false);
  const radius = rules.radius_m;
  const fix = "fix" in flow ? flow.fix : null;
  const place = fix ? locationVerdict({ latitude: godown?.latitude ?? null, longitude: godown?.longitude ?? null, radiusM: radius, accuracyLimitM: rules.gps_accuracy_limit_m }, fix) : null;
  const late = flow.kind === "in" ? lateMinutes(serverNow(), rules.shift_start, rules.late_grace_min, rules.late_counted_from) : 0;
  const title = flow.kind === "in" ? "Mark attendance" : flow.kind === "out" ? "Check out" : "Presence photo";

  const submit = async () => {
    if (flow.step !== "confirm") return;
    setSending(true);
    try {
      const fns = await import("@/lib/attendance.functions");
      const position = { lat: flow.fix.lat, lng: flow.fix.lng, accuracy: flow.fix.accuracyM, selfie: flow.selfie, deviceToken: device?.token ?? "" };
      if (flow.kind === "presence") {
        const result = await fns.markPresence({ data: position });
        setFlow({ step: "done", kind: "presence", at: result.at, lateMinutes: 0, earlyMinutes: 0, inside: result.inside });
      } else {
        const result = await fns.markAttendance({ data: { kind: flow.kind, note: "", ...position } });
        setFlow({ step: "done", kind: flow.kind, at: result.at, lateMinutes: result.lateMinutes, earlyMinutes: result.earlyMinutes, inside: true });
      }
    } catch (cause) {
      toast.error(flow.kind === "presence" ? "Presence photo not sent" : "Could not mark attendance", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setSending(false);
    }
  };

  if (flow.step === "done") {
    const heading = flow.kind === "in" ? "Attendance marked successfully" : flow.kind === "out" ? "Checked out successfully" : "Presence photo sent";
    return (
      <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-center shadow-sm">
        <CheckCircle2 className="mx-auto h-16 w-16 text-emerald-600" />
        <p className="mt-3 text-xl font-extrabold text-emerald-800">{heading}</p>
        <p className="mt-1 text-sm text-emerald-900">{indiaTime(flow.at)}</p>
        {flow.lateMinutes > 0 && <p className="mt-2 text-sm font-semibold text-amber-800">{lateText(flow.lateMinutes)}</p>}
        {flow.earlyMinutes > 0 && <p className="mt-2 text-sm font-semibold text-amber-800">{earlyText(flow.earlyMinutes)}</p>}
        {flow.kind === "presence" && !flow.inside && <p className="mt-2 text-sm font-semibold text-red-700">Taken outside the godown: head office will see this.</p>}
        <div className="mt-5 grid grid-cols-2 gap-2">
          <button type="button" onClick={() => void onDone()} className="rounded-xl border border-navy py-3 text-base font-bold text-navy">Done</button>
          <button type="button" onClick={onSignOut} className="rounded-xl bg-navy py-3 text-base font-bold text-white">Sign out</button>
        </div>
        <p className="mt-2 text-xs text-slate">Sign out so the next person can use this device.</p>
      </section>
    );
  }

  return (
    <section className="space-y-4 rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-extrabold text-navy">{title}</h2>
        <button type="button" onClick={() => setFlow(null)} className="text-sm font-semibold text-slate hover:text-navy">Cancel</button>
      </div>

      {flow.step === "locating" ? (
        <p className="flex items-center gap-2 rounded-lg bg-ivory px-3 py-4 text-sm text-navy"><RefreshCw className="h-4 w-4 animate-spin" /> Finding your location…</p>
      ) : place && (
        <p className={`flex items-start gap-2 rounded-lg px-3 py-2 text-sm font-semibold ${place.verdict === "inside" ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-900"}`}>
          <MapPin className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{place.verdict === "inside" ? `At the godown (${place.distanceM} m away)` : place.distanceM !== null ? `Outside the godown: ${place.distanceM} m away (limit ${radius} m)` : "Godown location not set"}
            <span className="block text-xs font-normal">{`GPS accuracy ±${fix?.accuracyM} m`}</span></span>
        </p>
      )}

      {flow.step === "camera" && (
        <SelfieCamera
          stamp={() => ({ lines: [`${me.name} · ${godown?.name ?? me.branch_id}`, new Date(serverNow()).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }), `${flow.fix.lat.toFixed(5)}, ${flow.fix.lng.toFixed(5)} ±${flow.fix.accuracyM} m`] })}
          onCapture={(selfie) => setFlow({ step: "confirm", kind: flow.kind, fix: flow.fix, selfie })}
        />
      )}

      {flow.step === "confirm" && (
        <div className="space-y-3">
          <img src={flow.selfie} alt="Your selfie" className="mx-auto w-full max-w-xs rounded-2xl" />
          <button type="button" onClick={() => setFlow({ step: "camera", kind: flow.kind, fix: flow.fix })} className="w-full text-sm font-semibold text-navy underline">Retake selfie</button>
          {late > 0 && <p className="text-center text-sm font-semibold text-amber-800">{lateText(late)}</p>}
          <button type="button" disabled={sending} onClick={() => void submit()}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 py-4 text-base font-extrabold text-white disabled:opacity-60">
            {sending ? <RefreshCw className="h-5 w-5 animate-spin" /> : <CheckCircle2 className="h-5 w-5" />}
            {sending ? "Uploading…" : flow.kind === "in" ? "Upload selfie & mark present" : flow.kind === "out" ? "Upload selfie & check out" : "Upload presence photo"}
          </button>
        </div>
      )}
    </section>
  );
}

function LeaveCard({ leaves, today, rules, versions, holidays, onChange }: {
  leaves: Leave[]; today: string; rules: GodownRules; versions: RuleVersion[]; holidays: GodownHoliday[]; onChange: () => Promise<void>;
}) {
  const leaveTypes = LEAVE_TYPES.filter((option) => rules.leave_types.includes(option.value));
  const upcomingHolidays = holidays.filter((holiday) => holiday.holiday_date >= today).slice(0, 5);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<LeaveType>("casual");
  // A type the godown no longer allows can't stay selected.
  const type = leaveTypes.some((option) => option.value === picked) ? picked : leaveTypes[0]?.value ?? picked;
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [reason, setReason] = useState("");
  const [sending, setSending] = useState(false);

  const send = async () => {
    const problem = leaveProblem(from, to, reason, today, rules);
    if (problem) { toast.error(problem); return; }
    setSending(true);
    const { error } = await supabase.rpc("request_leave", { _from: from, _to: to, _type: type, _reason: reason.trim() });
    setSending(false);
    if (error) { toast.error("Could not send the request", { description: error.message }); return; }
    toast.success("Leave request sent", { description: rules.leave_partner_required ? "Head office and your channel partner will review it." : "Head office will review it." });
    setOpen(false); setReason("");
    await onChange();
  };

  const cancel = async (id: string) => {
    const { error } = await supabase.rpc("cancel_leave", { _id: id });
    if (error) { toast.error("Could not cancel", { description: error.message }); return; }
    toast.success("Leave request cancelled");
    await onChange();
  };

  return (
    <section className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-navy">Leave and holidays</h2>
        {!open && <button type="button" onClick={() => setOpen(true)} className="rounded-md bg-gold px-3 py-1.5 text-sm font-bold text-navy">Request leave</button>}
      </div>
      {open && (
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            {leaveTypes.map((option) => (
              <button key={option.value} type="button" onClick={() => setPicked(option.value)}
                className={`rounded-lg border px-2 py-2 text-sm font-semibold ${type === option.value ? "border-navy bg-navy text-white" : "border-border text-navy"}`}>{option.label}</button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="block"><span className="mb-1 block text-xs font-semibold text-charcoal">From</span>
              <Input type="date" value={from} onChange={(event) => { setFrom(event.target.value); if (event.target.value > to) setTo(event.target.value); }} /></label>
            <label className="block"><span className="mb-1 block text-xs font-semibold text-charcoal">To</span>
              <Input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} /></label>
          </div>
          <p className="text-xs text-slate">{`${leaveDays(from, to)} day(s)`}</p>
          <label className="block"><span className="mb-1 block text-xs font-semibold text-charcoal">Reason</span>
            <Textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={2} /></label>
          <div className="flex gap-2">
            <button type="button" onClick={() => setOpen(false)} className="flex-1 rounded-lg border border-border py-3 text-sm font-semibold text-navy">Cancel</button>
            <button type="button" disabled={sending} onClick={() => void send()} className="flex flex-[2] items-center justify-center gap-2 rounded-lg bg-navy py-3 text-sm font-bold text-white disabled:opacity-60">
              <Send className="h-4 w-4" /> {sending ? "Sending…" : "Send request"}
            </button>
          </div>
        </div>
      )}
      {upcomingHolidays.length > 0 && (
        <div className="mt-3 rounded-lg bg-ivory px-3 py-2">
          <p className="text-xs font-semibold text-slate">Holidays at your godown</p>
          <ul className="mt-1 space-y-0.5 text-sm">
            {upcomingHolidays.map((holiday) => <li key={holiday.id}><span className="font-semibold text-charcoal">{formatDay(holiday.holiday_date)}</span> <span className="text-slate">· {holiday.name}</span></li>)}
          </ul>
        </div>
      )}
      <ul className="mt-3 divide-y divide-border">
        {leaves.length === 0 && <li className="py-2 text-sm text-slate">No leave requests yet.</li>}
        {leaves.map((leave) => (
          <li key={leave.id} className="space-y-1 py-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold text-charcoal">
                {leave.from_date === leave.to_date ? formatDay(leave.from_date) : `${formatDay(leave.from_date)} – ${formatDay(leave.to_date)}`}
              </span>
              <AttendanceStatusBadge status={leave.status} />
            </div>
            <p className="text-xs text-slate">{LEAVE_TYPES.find((option) => option.value === leave.leave_type)?.label ?? leave.leave_type} · {leave.reason}</p>
            {leave.status !== "cancelled" && <DecisionChips head={leave.head_office_decision} partner={leave.partner_decision} partnerRequired={versions.find((version) => version.id === leave.rule_version_id)?.leave_partner_required ?? true} />}
            {(leave.head_office_note || leave.partner_note) && <p className="text-xs italic text-slate">{[leave.head_office_note, leave.partner_note].filter(Boolean).join(" · ")}</p>}
            {(leave.status === "pending" || (leave.status === "approved" && leave.from_date > today)) && (
              <button type="button" onClick={() => void cancel(leave.id)} className="text-xs font-semibold text-red-700 underline">Cancel request</button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function formatDay(date: string) {
  return new Date(`${date}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}
