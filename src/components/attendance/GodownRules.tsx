import { useState } from "react";
import { toast } from "sonner";
import { CalendarDays, Crosshair, History, MapPin, Save, Trash2, X } from "lucide-react";
import { Panel } from "@/components/panel/widgets";
import { RuleChangeList, RuleList } from "@/components/attendance/AttendanceBits";
import { getBestFix } from "@/components/attendance/geolocation";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import {
  DEFAULT_RULES, FIRST_RULES_DATE, LEAVE_TYPES, WEEKDAYS, earliestRuleDate, formatDuration, mapLink, parseCoordinates, ruleChanges, rulesOn, rulesProblem,
  type GodownHoliday, type GodownRules, type LateCountedFrom, type MissedCheckout, type RuleVersion,
} from "@/lib/attendance";
import { cn } from "@/lib/utils";

/*
 * Admin > Attendance > Godown rules: head office picks a godown and sets its rules, holidays and
 * location. The channel partner panel shows the same page read-only, for their own godown. Saving
 * adds a new version of the rules from a date (migration 20261102120000_godown_attendance_rules).
 */

export type RulesGodown = { id: string; name: string; latitude: number | null; longitude: number | null };

const longDate = (date: string) => new Date(`${date}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const FIELD_LABEL = "mb-1 block text-xs font-semibold text-charcoal";
const SELECT = "h-10 w-full rounded-md border border-input bg-white px-2 text-sm";
const PRESENCE_OPTIONS = [0, 60, 90, 120, 180, 240];

export function GodownRulesDesk({ editable, godowns, versions, holidays, today, onSaved }: {
  editable: boolean; godowns: RulesGodown[]; versions: RuleVersion[]; holidays: GodownHoliday[]; today: string; onSaved: () => Promise<void>;
}) {
  const [godownId, setGodownId] = useState("");
  const godown = godowns.find((entry) => entry.id === godownId) ?? godowns[0];
  if (!godown) return <p className="text-sm text-slate">No godowns.</p>;
  const mine = versions.filter((version) => version.branch_id === godown.id);
  const current = rulesOn(mine, godown.id, today);
  const mineHolidays = holidays.filter((holiday) => holiday.branch_id === godown.id);

  return (
    <div className="space-y-6">
      {godowns.length > 1 && (
        <label className="block max-w-sm"><span className={FIELD_LABEL}>Godown</span>
          <select value={godown.id} onChange={(event) => setGodownId(event.target.value)} className={cn(SELECT, "font-semibold text-navy")}>
            {godowns.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select></label>
      )}
      {editable ? (
        <div key={godown.id} className="space-y-6">
          <RulesForm godown={godown} versions={mine} today={today} onSaved={onSaved} />
          <HolidaysPanel godown={godown} holidays={mineHolidays} today={today} editable onSaved={onSaved} />
          <LocationPanel godown={godown} onSaved={onSaved} />
          <RuleHistory versions={mine} today={today} editable onSaved={onSaved} />
        </div>
      ) : (
        <div key={godown.id} className="space-y-6">
          <Panel title={`${godown.name} · rules in force`}>
            <p className="mb-3 text-xs text-slate">Only head office can change these rules.</p>
            <RuleList rules={current ?? DEFAULT_RULES} />
          </Panel>
          <HolidaysPanel godown={godown} holidays={mineHolidays} today={today} editable={false} onSaved={onSaved} />
          <RuleHistory versions={mine} today={today} editable={false} onSaved={onSaved} />
        </div>
      )}
    </div>
  );
}

/** What the rule form holds: text for the inputs, turned into rules on save. */
function formFrom(rules: GodownRules) {
  return {
    shiftStart: rules.shift_start.slice(0, 5), shiftEnd: rules.shift_end.slice(0, 5), grace: String(rules.late_grace_min), countedFrom: rules.late_counted_from,
    earlyGrace: String(rules.early_grace_min), halfDayHours: rules.half_day_below_min ? String(rules.half_day_below_min / 60) : "", absentHours: rules.absent_below_min ? String(rules.absent_below_min / 60) : "",
    missedCheckout: rules.missed_checkout, weeklyOff: rules.weekly_off === null ? "none" : String(rules.weekly_off),
    radius: String(rules.radius_m), gpsLimit: String(rules.gps_accuracy_limit_m), requireDevice: rules.require_device,
    presence: String(rules.presence_interval_min), presenceEarly: String(rules.presence_early_min), presenceLate: String(rules.presence_late_min),
    leaveTypes: rules.leave_types, leaveMax: String(rules.leave_max_days), leaveBack: String(rules.leave_back_days), leaveAhead: String(rules.leave_ahead_days), partnerRequired: rules.leave_partner_required,
  };
}
type RuleForm = ReturnType<typeof formFrom>;

function rulesFromForm(form: RuleForm): GodownRules {
  const count = (text: string) => (text.trim() === "" ? Number.NaN : Number(text));
  const hours = (text: string) => (text.trim() === "" ? 0 : Math.round(Number(text) * 60));
  return {
    shift_start: form.shiftStart, shift_end: form.shiftEnd, late_grace_min: count(form.grace), late_counted_from: form.countedFrom, early_grace_min: count(form.earlyGrace),
    half_day_below_min: hours(form.halfDayHours), absent_below_min: hours(form.absentHours), missed_checkout: form.missedCheckout, weekly_off: form.weeklyOff === "none" ? null : Number(form.weeklyOff),
    radius_m: count(form.radius), gps_accuracy_limit_m: count(form.gpsLimit), require_device: form.requireDevice,
    presence_interval_min: Number(form.presence), presence_early_min: count(form.presenceEarly), presence_late_min: count(form.presenceLate),
    leave_types: LEAVE_TYPES.map((option) => option.value).filter((type) => form.leaveTypes.includes(type)), leave_max_days: count(form.leaveMax), leave_back_days: count(form.leaveBack), leave_ahead_days: count(form.leaveAhead), leave_partner_required: form.partnerRequired,
  };
}

function RuleSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-3 rounded-lg border border-border p-3">
      <legend className="px-1 text-xs font-bold uppercase tracking-wider text-slate">{title}</legend>
      {children}
    </fieldset>
  );
}

function RulesForm({ godown, versions, today, onSaved }: { godown: RulesGodown; versions: RuleVersion[]; today: string; onSaved: () => Promise<void> }) {
  const earliest = earliestRuleDate(versions, today);
  const [picked, setPicked] = useState("");
  const from = picked >= earliest ? picked : earliest;
  // The form starts from the rules in force on the chosen date; what the admin changes stays changed if the date moves.
  const base = rulesOn(versions, godown.id, from) ?? DEFAULT_RULES;
  const baseForm = formFrom(base);
  const [edits, setEdits] = useState<Partial<RuleForm>>({});
  const form: RuleForm = { ...baseForm, ...edits };
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof RuleForm>(key: K, value: RuleForm[K]) => setEdits((previous) => ({ ...previous, [key]: value }));
  const rules = rulesFromForm(form);
  const problem = rulesProblem(rules);
  const changes = problem ? [] : ruleChanges(base, rules);
  const presenceOptions = PRESENCE_OPTIONS.includes(base.presence_interval_min) ? PRESENCE_OPTIONS : [...PRESENCE_OPTIONS, base.presence_interval_min].sort((a, b) => a - b);

  const save = async () => {
    if (problem) { toast.error(problem); return; }
    // Only what changed: the database keeps every other rule as it is on that date.
    const before = rulesFromForm(baseForm);
    const changed = Object.fromEntries(Object.entries(rules).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(before[key as keyof GodownRules])));
    setBusy(true);
    const { error } = await supabase.rpc("save_godown_rules", { _branch: godown.id, _effective_from: from, _rules: changed as Json });
    setBusy(false);
    if (error) { toast.error("Could not save the rules", { description: error.message }); return; }
    toast.success(`${godown.name}: rules saved`, { description: from === today ? "They apply from today." : `They apply from ${longDate(from)}.` });
    await onSaved();
    setEdits({}); setPicked("");
  };

  return (
    <Panel title={`${godown.name} · rules`}>
      <p className="mb-3 text-xs text-slate">These rules are for this godown only. A godown keeps its rules until you change them here.</p>
      <div className="grid gap-4 lg:grid-cols-2">
        <RuleSection title="Shift and late">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <label className="block"><span className={FIELD_LABEL}>Shift starts</span><Input type="time" value={form.shiftStart} onChange={(event) => set("shiftStart", event.target.value)} /></label>
            <label className="block"><span className={FIELD_LABEL}>Shift ends</span><Input type="time" value={form.shiftEnd} onChange={(event) => set("shiftEnd", event.target.value)} /></label>
            <label className="block"><span className={FIELD_LABEL}>Grace (min)</span><Input type="number" min={0} max={240} value={form.grace} onChange={(event) => set("grace", event.target.value)} /></label>
          </div>
          <label className="block"><span className={FIELD_LABEL}>Once late, count the late time from</span>
            <select value={form.countedFrom} onChange={(event) => set("countedFrom", event.target.value as LateCountedFrom)} className={SELECT}>
              <option value="shift_start">The shift start</option>
              <option value="grace_end">The end of grace</option>
            </select></label>
          <label className="block"><span className={FIELD_LABEL}>Left-early allowance (min): leaving this close to the shift end is not counted</span><Input type="number" min={0} max={240} value={form.earlyGrace} onChange={(event) => set("earlyGrace", event.target.value)} /></label>
          <p className="text-xs text-slate">{`Late = check-in after ${form.shiftStart || "?"} + ${form.grace || "0"} min, counted from ${form.countedFrom === "grace_end" ? "the end of grace" : form.shiftStart || "?"}.`}</p>
          <p className="text-xs text-slate">{Number(form.earlyGrace) > 0 ? `Left early = check-out more than ${form.earlyGrace} min before ${form.shiftEnd || "?"}.` : `Left early = check-out before ${form.shiftEnd || "?"}.`}</p>
        </RuleSection>

        <RuleSection title="Half day, absent and weekly off">
          <div className="grid grid-cols-2 gap-2">
            <label className="block"><span className={FIELD_LABEL}>Half day if worked under (hours)</span><Input type="number" min={0} max={24} step={0.5} value={form.halfDayHours} placeholder="Off" onChange={(event) => set("halfDayHours", event.target.value)} /></label>
            <label className="block"><span className={FIELD_LABEL}>Absent if worked under (hours)</span><Input type="number" min={0} max={24} step={0.5} value={form.absentHours} placeholder="Off" onChange={(event) => set("absentHours", event.target.value)} /></label>
          </div>
          <p className="text-xs text-slate">Left empty: any check-in counts as a full day present.</p>
          <label className="block"><span className={FIELD_LABEL}>If someone does not check out</span>
            <select value={form.missedCheckout} onChange={(event) => set("missedCheckout", event.target.value as MissedCheckout)} className={SELECT}>
              <option value="present">Counts as present</option>
              <option value="half_day">Counts as half day</option>
              <option value="absent">Counts as absent</option>
            </select></label>
          <label className="block"><span className={FIELD_LABEL}>Weekly off (not counted as absent)</span>
            <select value={form.weeklyOff} onChange={(event) => set("weeklyOff", event.target.value)} className={SELECT}>
              {WEEKDAYS.map((day, index) => <option key={day} value={String(index)}>{day}</option>)}
              <option value="none">No weekly off (open every day)</option>
            </select></label>
        </RuleSection>

        <RuleSection title="Where attendance can be marked">
          <div className="grid grid-cols-2 gap-2">
            <label className="block"><span className={FIELD_LABEL}>Radius (m): staff can check in and out only within it</span><Input type="number" min={25} max={2000} value={form.radius} onChange={(event) => set("radius", event.target.value)} /></label>
            <label className="block"><span className={FIELD_LABEL}>GPS accuracy limit (m): rougher positions are refused</span><Input type="number" min={10} max={2000} value={form.gpsLimit} onChange={(event) => set("gpsLimit", event.target.value)} /></label>
          </div>
          <label className="flex items-start gap-2 text-sm text-charcoal">
            <input type="checkbox" checked={form.requireDevice} onChange={(event) => set("requireDevice", event.target.checked)} className="mt-0.5 h-4 w-4" />
            <span>Staff must use this godown's registered device</span>
          </label>
        </RuleSection>

        <RuleSection title="Presence photos">
          <label className="block"><span className={FIELD_LABEL}>Presence photo (live geotagged selfie while checked in)</span>
            <select value={form.presence} onChange={(event) => set("presence", event.target.value)} className={SELECT}>
              {presenceOptions.map((minutes) => <option key={minutes} value={String(minutes)}>{minutes ? `Every ${formatDuration(minutes)}` : "Off"}</option>)}
            </select></label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block"><span className={FIELD_LABEL}>On time from (min before it is due)</span><Input type="number" min={0} max={120} value={form.presenceEarly} onChange={(event) => set("presenceEarly", event.target.value)} /></label>
            <label className="block"><span className={FIELD_LABEL}>On time until (min after it is due)</span><Input type="number" min={0} max={240} value={form.presenceLate} onChange={(event) => set("presenceLate", event.target.value)} /></label>
          </div>
        </RuleSection>

        <RuleSection title="Leave">
          <div className="grid grid-cols-2 gap-2">
            {LEAVE_TYPES.map((option) => (
              <label key={option.value} className="flex items-center gap-2 text-sm text-charcoal">
                <input type="checkbox" checked={form.leaveTypes.includes(option.value)} className="h-4 w-4"
                  onChange={(event) => set("leaveTypes", event.target.checked ? [...form.leaveTypes, option.value] : form.leaveTypes.filter((type) => type !== option.value))} />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <label className="block"><span className={FIELD_LABEL}>Longest request (days)</span><Input type="number" min={1} max={60} value={form.leaveMax} onChange={(event) => set("leaveMax", event.target.value)} /></label>
            <label className="block"><span className={FIELD_LABEL}>For past days, up to (days)</span><Input type="number" min={0} max={365} value={form.leaveBack} onChange={(event) => set("leaveBack", event.target.value)} /></label>
            <label className="block"><span className={FIELD_LABEL}>In advance, up to (days)</span><Input type="number" min={0} max={365} value={form.leaveAhead} onChange={(event) => set("leaveAhead", event.target.value)} /></label>
          </div>
          <label className="flex items-start gap-2 text-sm text-charcoal">
            <input type="checkbox" checked={form.partnerRequired} onChange={(event) => set("partnerRequired", event.target.checked)} className="mt-0.5 h-4 w-4" />
            <span>The channel partner must also approve leave</span>
          </label>
        </RuleSection>

        <div className="space-y-3 rounded-lg border border-gold/40 bg-ivory p-3">
          <label className="block"><span className={FIELD_LABEL}>These rules apply from</span>
            <Input type="date" min={earliest} value={from} onChange={(event) => setPicked(event.target.value)} /></label>
          <p className="text-xs text-slate">Past days keep the rules they had. Anyone already checked in today stays on the rules they checked in under.</p>
          {earliest > today && <p className="text-xs font-semibold text-amber-800">{`A change is scheduled from ${longDate(earliest)}. New rules can start from that date. To change rules sooner, first cancel it in Rule history.`}</p>}
          {problem ? <p role="alert" className="text-sm font-semibold text-red-700">{problem}</p>
            : changes.length ? (
              <div className="text-sm">
                <p className="mb-1 font-semibold text-navy">{`${changes.length} change(s) to save:`}</p>
                <RuleChangeList changes={changes} />
              </div>
            ) : <p className="text-sm text-slate">No changes yet.</p>}
          <button type="button" disabled={busy || Boolean(problem) || !changes.length} onClick={() => void save()}
            className="inline-flex items-center gap-1.5 rounded-md bg-navy px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
            <Save className="h-4 w-4" /> {busy ? "Saving…" : "Save rules"}
          </button>
        </div>
      </div>
    </Panel>
  );
}

function HolidaysPanel({ godown, holidays, today, editable, onSaved }: { godown: RulesGodown; holidays: GodownHoliday[]; today: string; editable: boolean; onSaved: () => Promise<void> }) {
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const earliest = addDays(today, -30);
  const sorted = [...holidays].sort((a, b) => a.holiday_date.localeCompare(b.holiday_date));
  const upcoming = sorted.filter((holiday) => holiday.holiday_date >= today);
  const past = sorted.filter((holiday) => holiday.holiday_date < today).reverse();

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!date) { toast.error("Choose the date"); return; }
    if (date < earliest) { toast.error("A holiday more than 30 days ago can't be changed"); return; }
    if (name.trim().length < 2) { toast.error("Write the holiday's name"); return; }
    setBusy(true);
    const { error } = await supabase.rpc("set_godown_holiday", { _branch: godown.id, _date: date, _name: name.trim() });
    setBusy(false);
    if (error) { toast.error("Could not save the holiday", { description: error.message }); return; }
    toast.success(`${godown.name}: holiday saved`);
    setDate(""); setName("");
    await onSaved();
  };
  const remove = async (holiday: GodownHoliday) => {
    const { error } = await supabase.rpc("remove_godown_holiday", { _id: holiday.id });
    if (error) { toast.error("Could not remove the holiday", { description: error.message }); return; }
    toast.success(`${godown.name}: holiday removed`);
    await onSaved();
  };
  const row = (holiday: GodownHoliday) => (
    <li key={holiday.id} className="flex items-center justify-between gap-3 py-2 text-sm">
      <span className="min-w-0"><span className="font-semibold text-charcoal">{longDate(holiday.holiday_date)}</span> <span className="text-slate">· {holiday.name}</span></span>
      {editable && holiday.holiday_date >= earliest && (
        <button type="button" onClick={() => void remove(holiday)} className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-red-700 hover:underline"><Trash2 className="h-3.5 w-3.5" /> Remove</button>
      )}
    </li>
  );

  return (
    <Panel title={`${godown.name} · holidays`}>
      <div className={cn("grid gap-6", editable && "lg:grid-cols-2")}>
        {editable && (
          <form onSubmit={(event) => void add(event)} className="space-y-3">
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-2">
              <label className="block"><span className={FIELD_LABEL}>Date</span><Input type="date" min={earliest} value={date} onChange={(event) => setDate(event.target.value)} /></label>
              <label className="block"><span className={FIELD_LABEL}>Holiday</span><Input value={name} maxLength={80} placeholder="Deepavali" onChange={(event) => setName(event.target.value)} /></label>
            </div>
            <p className="text-xs text-slate">A holiday isn't counted as absent, for this godown only. Someone who works that day is still marked present. A past date (up to 30 days back) changes that day from Absent to Holiday.</p>
            <button type="submit" disabled={busy} className="inline-flex items-center gap-1.5 rounded-md bg-navy px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
              <CalendarDays className="h-4 w-4" /> {busy ? "Saving…" : "Add holiday"}
            </button>
          </form>
        )}
        <div>
          {sorted.length === 0 ? <p className="text-sm text-slate">No holidays set for this godown.</p> : (
            <>
              {upcoming.length > 0 && <ul className="divide-y divide-border">{upcoming.map(row)}</ul>}
              {past.length > 0 && (
                <>
                  <h3 className="mb-1 mt-3 text-xs font-bold uppercase tracking-wider text-slate">Past holidays</h3>
                  <ul className="divide-y divide-border">{past.slice(0, 10).map(row)}</ul>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </Panel>
  );
}

function LocationPanel({ godown, onSaved }: { godown: RulesGodown; onSaved: () => Promise<void> }) {
  const [lat, setLat] = useState(godown.latitude?.toString() ?? "");
  const [lng, setLng] = useState(godown.longitude?.toString() ?? "");
  const [paste, setPaste] = useState("");
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
    setBusy(true);
    const { error } = await supabase.from("branches").update({ latitude, longitude, updated_at: new Date().toISOString() }).eq("id", godown.id);
    setBusy(false);
    if (error) { toast.error("Could not save", { description: error.message }); return; }
    toast.success(`${godown.name}: location saved`);
    await onSaved();
  };
  return (
    <Panel title={`${godown.name} · location`}>
      <div className="max-w-xl space-y-3">
        <label className="block"><span className={FIELD_LABEL}>Paste a Google Maps link or “latitude, longitude”</span>
          <Input value={paste} onChange={(event) => applyPasted(event.target.value)} placeholder="https://maps.google.com/…@14.31,76.65 or 14.3123, 76.6512" /></label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block"><span className={FIELD_LABEL}>Latitude</span><Input value={lat} onChange={(event) => setLat(event.target.value)} inputMode="decimal" /></label>
          <label className="block"><span className={FIELD_LABEL}>Longitude</span><Input value={lng} onChange={(event) => setLng(event.target.value)} inputMode="decimal" /></label>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <button type="button" disabled={locating} onClick={() => void takeDeviceLocation()} className="inline-flex items-center gap-1.5 font-semibold text-navy hover:underline disabled:opacity-60">
            <Crosshair className="h-4 w-4" /> {locating ? "Finding location…" : "Use this device's location"}
          </button>
          {lat && lng && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) && (
            <a href={mapLink(Number(lat), Number(lng))} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-navy hover:underline"><MapPin className="h-4 w-4" /> Check on Google Maps</a>
          )}
        </div>
        <p className="text-xs text-slate">Use this device's location only while standing inside the godown. A new location applies at once.</p>
        <button type="button" disabled={busy} onClick={() => void save()} className="inline-flex items-center gap-1.5 rounded-md bg-navy px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
          <Save className="h-4 w-4" /> {busy ? "Saving…" : "Save location"}
        </button>
      </div>
    </Panel>
  );
}

/** Every version of a godown's rules: what changed, who changed it, from when, and which one is in force. */
function RuleHistory({ versions, today, editable, onSaved }: { versions: RuleVersion[]; today: string; editable: boolean; onSaved: () => Promise<void> }) {
  const ordered = [...versions].sort((a, b) => a.effective_from.localeCompare(b.effective_from) || a.created_at.localeCompare(b.created_at));
  const inForce = versions[0] ? rulesOn(versions, versions[0].branch_id, today) : undefined;
  const live = ordered.filter((version) => !version.cancelled_at);
  const newestFirst = [...ordered].reverse();
  const cancel = async (version: RuleVersion) => {
    const { error } = await supabase.rpc("cancel_godown_rules", { _id: version.id });
    if (error) { toast.error("Could not cancel the change", { description: error.message }); return; }
    toast.success("Scheduled change cancelled");
    await onSaved();
  };
  return (
    <Panel title="Rule history">
      <p className="mb-2 flex items-center gap-1.5 text-xs text-slate"><History className="h-3.5 w-3.5" /> Rules are never edited in place: each change is kept, and days marked under older rules stay as they were.</p>
      <ul className="divide-y divide-border">
        {newestFirst.map((version) => {
          const before = live[live.indexOf(version) - 1];
          const changes = before && !version.cancelled_at ? ruleChanges(before, version) : [];
          const scheduled = version.effective_from > today;
          const badge = version.cancelled_at ? "Cancelled" : version.id === inForce?.id ? "In force" : scheduled ? "Scheduled" : "Replaced";
          return (
            <li key={version.id} className="space-y-1 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-navy">{version.effective_from === FIRST_RULES_DATE ? "From the start" : `Applies from ${longDate(version.effective_from)}`}</span>
                <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold",
                  badge === "In force" ? "bg-emerald-50 text-emerald-700" : badge === "Scheduled" ? "bg-amber-50 text-amber-800" : "bg-slate-100 text-slate-600")}>{badge}</span>
                {version.effective_from !== FIRST_RULES_DATE && (
                  <span className="text-xs text-slate">{`Saved ${new Date(version.created_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })}${version.created_by_name ? ` · ${version.created_by_name}` : ""}`}</span>
                )}
                {editable && scheduled && version === live.at(-1) && (
                  <button type="button" onClick={() => void cancel(version)} className="inline-flex items-center gap-1 text-xs font-semibold text-red-700 hover:underline"><X className="h-3.5 w-3.5" /> Cancel this change</button>
                )}
              </div>
              {version.effective_from === FIRST_RULES_DATE ? <p className="text-xs text-slate">The rules this godown started with.</p> : changes.length ? <RuleChangeList changes={changes} /> : null}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
