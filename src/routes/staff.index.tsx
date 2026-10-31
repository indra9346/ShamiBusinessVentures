import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CalendarDays, CheckCircle2, LogIn, LogOut, MapPin, RefreshCw, Send } from "lucide-react";
import { LogoMark } from "@/components/brand/Logo";
import { LanguageSwitcher } from "@/components/site/LanguageSwitcher";
import { AttendanceStatusBadge, DecisionChips, FlagChips } from "@/components/attendance/AttendanceBits";
import { SelfieCamera } from "@/components/attendance/SelfieCamera";
import { getBestFix } from "@/components/attendance/geolocation";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { serverNow, syncServerClock } from "@/lib/server-clock";
import {
  FLAG_LABELS, LEAVE_TYPES, checkInFlags, indiaDate, indiaTime, lateMinutes, leaveDays, leaveProblem, locationVerdict,
  summariseMonth, type AttendanceFlag, type Fix, type LeaveType, type LocationVerdict,
} from "@/lib/attendance";

export const Route = createFileRoute("/staff/")({
  head: () => ({ meta: [{ title: "Staff Attendance | Grain Bazar" }, { name: "robots", content: "noindex" }] }),
  component: StaffHome,
});

type Employee = Database["public"]["Tables"]["staff_employees"]["Row"];
type Day = Database["public"]["Tables"]["attendance_days"]["Row"];
type Leave = Database["public"]["Tables"]["leave_requests"]["Row"];
type Godown = { name: string; latitude: number | null; longitude: number | null; attendance_radius_m: number; shift_start: string; late_grace_min: number; weekly_off: number | null };
type Flow =
  | { step: "locating"; kind: "in" | "out" }
  | { step: "camera"; kind: "in" | "out"; fix: Fix }
  | { step: "confirm"; kind: "in" | "out"; fix: Fix; selfie: string }
  | { step: "done"; kind: "in" | "out"; at: string; status: string; flags: string[] };

/** The godown employee's phone app: mark attendance with location + selfie, request leave. */
function StaffHome() {
  const navigate = useNavigate();
  const [me, setMe] = useState<Employee | null>(null);
  const [godown, setGodown] = useState<Godown | null>(null);
  const [days, setDays] = useState<Day[]>([]);
  const [leaves, setLeaves] = useState<Leave[]>([]);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [problem, setProblem] = useState("");
  const today = indiaDate(serverNow());
  const month = `${today.slice(0, 7)}-01`;

  const load = useCallback(async (employee: Employee) => {
    const [d, l] = await Promise.all([
      supabase.from("attendance_days").select("*").eq("employee_id", employee.id).gte("work_date", month).order("work_date", { ascending: false }),
      supabase.from("leave_requests").select("*").eq("employee_id", employee.id).order("from_date", { ascending: false }).limit(20),
    ]);
    setDays((d.data as Day[] | null) ?? []);
    setLeaves((l.data as Leave[] | null) ?? []);
  }, [month]);

  // Only an active employee may stay here; anyone else goes to the staff login.
  useEffect(() => {
    void syncServerClock();
    void (async () => {
      const { data: session } = await supabase.auth.getSession();
      const userId = session.session?.user.id;
      if (!userId) { navigate({ to: "/staff/login", replace: true }); return; }
      const { data: employee } = await supabase.from("staff_employees").select("*").eq("user_id", userId).maybeSingle();
      if (!employee || employee.status !== "active") { await supabase.auth.signOut(); navigate({ to: "/staff/login", replace: true }); return; }
      const { data: branch } = await supabase.from("branches")
        .select("name,latitude,longitude,attendance_radius_m,shift_start,late_grace_min,weekly_off").eq("id", employee.branch_id).maybeSingle();
      setMe(employee as Employee);
      setGodown((branch as Godown | null) ?? null);
      await load(employee as Employee);
    })();
  }, [navigate, load]);

  const todayRow = days.find((day) => day.work_date === today) ?? null;
  const onLeaveToday = leaves.some((leave) => leave.status === "approved" && leave.from_date <= today && today <= leave.to_date);
  const monthSummary = useMemo(() => summariseMonth(month, days, leaves, today, { joined: me?.joined_on ?? "", weeklyOff: godown?.weekly_off ?? null }).summary,
    [month, days, leaves, today, me?.joined_on, godown?.weekly_off]);

  const begin = async (kind: "in" | "out") => {
    setProblem("");
    setFlow({ step: "locating", kind });
    try {
      const fix = await getBestFix();
      setFlow({ step: "camera", kind, fix });
    } catch (cause) {
      setFlow(null);
      setProblem(cause instanceof Error ? cause.message : "Location not found");
    }
  };

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
            <button type="button" aria-label="Sign out" onClick={async () => { await supabase.auth.signOut(); navigate({ to: "/staff/login" }); }}
              className="grid h-9 w-9 place-items-center rounded-md border border-border text-navy hover:border-gold hover:text-gold">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-md space-y-4 px-4 py-4">
        {problem && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{problem}</p>}

        {flow ? (
          <MarkFlow flow={flow} setFlow={setFlow} me={me} godown={godown}
            onDone={async () => { setFlow(null); await load(me); }} />
        ) : (
          <TodayCard today={today} row={todayRow} godown={godown} onLeaveToday={onLeaveToday} onBegin={(kind) => void begin(kind)} />
        )}

        <LeaveCard leaves={leaves} today={today} onChange={() => load(me)} />

        <section className="rounded-2xl border border-border bg-card p-4 shadow-sm">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-bold text-navy"><CalendarDays className="h-4 w-4" /> This month</h2>
          <div className="grid grid-cols-4 gap-2 text-center">
            {[["Present", monthSummary.present], ["Late", monthSummary.late], ["Leave", monthSummary.leave], ["Absent", monthSummary.absent]].map(([label, value]) => (
              <div key={label} className="rounded-lg bg-ivory px-1 py-2"><p className="text-lg font-extrabold text-navy">{value}</p><p className="text-[11px] text-slate">{label}</p></div>
            ))}
          </div>
          <ul className="mt-3 divide-y divide-border text-sm">
            {days.slice(0, 10).map((day) => (
              <li key={day.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="text-charcoal">{new Date(`${day.work_date}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}</span>
                <span className="text-xs text-slate">{indiaTime(day.check_in_at)}{day.check_out_at ? ` – ${indiaTime(day.check_out_at)}` : ""}</span>
                <AttendanceStatusBadge status={day.status} />
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}

function TodayCard({ today, row, godown, onLeaveToday, onBegin }: {
  today: string; row: Day | null; godown: Godown | null; onLeaveToday: boolean; onBegin: (kind: "in" | "out") => void;
}) {
  return (
    <section className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wider text-slate">
        {new Date(`${today}T00:00:00`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}
      </p>
      {godown && <p className="mt-0.5 text-xs text-slate">{`Shift starts ${indiaTime(`2000-01-01T${godown.shift_start.slice(0, 5)}:00+05:30`)}`}</p>}
      {onLeaveToday && !row && <p className="mt-3 rounded-lg bg-sky-50 px-3 py-2 text-sm font-semibold text-sky-800">You are on approved leave today.</p>}
      {!row ? (
        <button type="button" onClick={() => onBegin("in")}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-navy py-5 text-lg font-extrabold text-white shadow-md active:scale-[0.99]">
          <LogIn className="h-6 w-6" /> Mark attendance
        </button>
      ) : (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-base font-bold text-navy">{`Checked in at ${indiaTime(row.check_in_at)}`}</p>
            <AttendanceStatusBadge status={row.status} />
          </div>
          <FlagChips flags={row.flags} lateMinutes={row.late_minutes} />
          {row.flags.length > 0 && <DecisionChips head={row.head_office_decision} partner={row.partner_decision} />}
          {row.check_out_at ? (
            <p className="flex items-center gap-2 text-sm font-semibold text-emerald-700"><CheckCircle2 className="h-4 w-4" /> {`Checked out at ${indiaTime(row.check_out_at)}`}</p>
          ) : (
            <button type="button" onClick={() => onBegin("out")}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border-2 border-navy py-4 text-base font-bold text-navy active:scale-[0.99]">
              <LogOut className="h-5 w-5" /> Check out
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function verdictText(verdict: LocationVerdict, distanceM: number | null, radius: number) {
  if (verdict === "no_godown_location") return "The office has not set your godown's location yet";
  if (verdict === "imprecise") return "GPS is not precise enough here";
  return verdict === "inside" ? `At the godown (${distanceM} m away)` : `Outside the godown: ${distanceM} m away (limit ${radius} m)`;
}

function MarkFlow({ flow, setFlow, me, godown, onDone }: {
  flow: Flow; setFlow: (flow: Flow | null) => void; me: Employee; godown: Godown | null; onDone: () => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [askReason, setAskReason] = useState(false);
  const radius = godown?.attendance_radius_m ?? 150;
  const fix = "fix" in flow ? flow.fix : null;
  const place = fix ? locationVerdict({ latitude: godown?.latitude ?? null, longitude: godown?.longitude ?? null, radiusM: radius }, fix) : null;
  const late = flow.kind === "in" && godown ? lateMinutes(serverNow(), godown.shift_start, godown.late_grace_min) : 0;
  const flags = place && flow.kind === "in" ? checkInFlags(place.verdict, late) : [];
  const needsReason = flow.kind === "in" && (flags.length > 0 || askReason);

  const submit = async () => {
    if (flow.step !== "confirm") return;
    if (needsReason && note.trim().length < 3) { toast.error("Write the reason"); return; }
    setSending(true);
    try {
      const { markAttendance } = await import("@/lib/attendance.functions");
      const result = await markAttendance({ data: { kind: flow.kind, lat: flow.fix.lat, lng: flow.fix.lng, accuracy: flow.fix.accuracyM, selfie: flow.selfie, note: note.trim() } });
      if (!result.ok) { setAskReason(true); toast.error("Write the reason", { description: result.flags.map((flag) => FLAG_LABELS[flag as AttendanceFlag] ?? flag).join(", ") }); return; }
      setFlow({ step: "done", kind: flow.kind, at: result.at, status: result.status, flags: result.flags });
    } catch (cause) {
      toast.error("Could not mark attendance", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setSending(false);
    }
  };

  if (flow.step === "done") {
    return (
      <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-center shadow-sm">
        <CheckCircle2 className="mx-auto h-16 w-16 text-emerald-600" />
        <p className="mt-3 text-xl font-extrabold text-emerald-800">{flow.kind === "in" ? "Attendance marked successfully" : "Checked out successfully"}</p>
        <p className="mt-1 text-sm text-emerald-900">{indiaTime(flow.at)}</p>
        {flow.kind === "in" && flow.status === "pending" && (
          <p className="mt-3 text-sm text-amber-800">Head office and your channel partner will review it.</p>
        )}
        <button type="button" onClick={() => void onDone()} className="mt-5 w-full rounded-xl bg-navy py-3 text-base font-bold text-white">Done</button>
      </section>
    );
  }

  return (
    <section className="space-y-4 rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-extrabold text-navy">{flow.kind === "in" ? "Mark attendance" : "Check out"}</h2>
        <button type="button" onClick={() => setFlow(null)} className="text-sm font-semibold text-slate hover:text-navy">Cancel</button>
      </div>

      {flow.step === "locating" ? (
        <p className="flex items-center gap-2 rounded-lg bg-ivory px-3 py-4 text-sm text-navy"><RefreshCw className="h-4 w-4 animate-spin" /> Finding your location…</p>
      ) : place && (
        <p className={`flex items-start gap-2 rounded-lg px-3 py-2 text-sm font-semibold ${place.verdict === "inside" ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-900"}`}>
          <MapPin className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{verdictText(place.verdict, place.distanceM, radius)}<span className="block text-xs font-normal">{`GPS accuracy ±${fix?.accuracyM} m`}</span></span>
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
          {flags.length > 0 && <FlagChips flags={flags} lateMinutes={late} />}
          {(needsReason || flow.kind === "out") && (
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-charcoal">{needsReason ? "Reason (needed for approval)" : "Note (optional)"}</span>
              <Textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={300} rows={2}
                placeholder={needsReason ? "Example: GPS weak inside the godown, sent to a customer site" : ""} />
            </label>
          )}
          <button type="button" disabled={sending} onClick={() => void submit()}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 py-4 text-base font-extrabold text-white disabled:opacity-60">
            {sending ? <RefreshCw className="h-5 w-5 animate-spin" /> : <CheckCircle2 className="h-5 w-5" />}
            {sending ? "Uploading…" : flow.kind === "in" ? "Upload selfie & mark present" : "Upload selfie & check out"}
          </button>
        </div>
      )}
    </section>
  );
}

function LeaveCard({ leaves, today, onChange }: { leaves: Leave[]; today: string; onChange: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<LeaveType>("casual");
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [reason, setReason] = useState("");
  const [sending, setSending] = useState(false);

  const send = async () => {
    const problem = leaveProblem(from, to, reason, today);
    if (problem) { toast.error(problem); return; }
    setSending(true);
    const { error } = await supabase.rpc("request_leave", { _from: from, _to: to, _type: type, _reason: reason.trim() });
    setSending(false);
    if (error) { toast.error("Could not send the request", { description: error.message }); return; }
    toast.success("Leave request sent", { description: "Head office and your channel partner will review it." });
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
            {LEAVE_TYPES.map((option) => (
              <button key={option.value} type="button" onClick={() => setType(option.value)}
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
            {leave.status !== "cancelled" && <DecisionChips head={leave.head_office_decision} partner={leave.partner_decision} />}
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
