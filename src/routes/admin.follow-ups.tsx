import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CalendarClock, CheckCircle2, ListTodo, Pencil, Repeat, RotateCcw, Trash2, XCircle } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel } from "@/components/panel/widgets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { adminNav } from "@/lib/panel-nav";
import { useBranches } from "@/lib/branches";
import {
  dueState, dueText, followUpCounts, followUpProblem, FOLLOW_UP_KINDS, FOLLOW_UP_REPEATS, kindLabel, nextDueOn, repeatLabel,
  sortFollowUps, todayInIndia, type DueState, type FollowUpTask,
} from "@/lib/follow-ups";
import {
  addFollowUp, cancelFollowUp, completeFollowUp, deleteFollowUp, loadEmployeesForTasks, loadFollowUps, reopenFollowUp, updateFollowUp,
  type FollowUpForm,
} from "@/lib/follow-ups-store";
import { cn } from "@/lib/utils";
import { BulkBar, BulkDeleteDialog, TickBox, useBulkSelection } from "@/components/panel/BulkSelect";

export const Route = createFileRoute("/admin/follow-ups")({
  head: () => ({ meta: [{ title: "Follow-ups | Shami Admin" }, { name: "robots", content: "noindex" }] }),
  component: AdminFollowUps,
});

const longDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" });

const STATE_STYLE: Record<DueState, { bar: string; text: string; label: string }> = {
  overdue: { bar: "bg-red-500", text: "text-red-700", label: "Late" },
  today: { bar: "bg-red-500", text: "text-red-700", label: "Due today" },
  soon: { bar: "bg-amber-500", text: "text-amber-800", label: "Due soon" },
  later: { bar: "bg-emerald-500", text: "text-emerald-800", label: "Upcoming" },
  done: { bar: "bg-slate-300", text: "text-slate", label: "Done" },
  cancelled: { bar: "bg-slate-200", text: "text-slate", label: "Cancelled" },
};

const emptyForm = (): FollowUpForm => ({
  title: "", details: "", kind: "licence_renewal", employeeId: null, branchId: null, dueOn: "", repeatEvery: "year", remindDays: 30,
});

const fieldClass = "h-10 w-full rounded-md border border-border bg-white px-3 text-sm";

function AdminFollowUps() {
  const { branches } = useBranches();
  const [tasks, setTasks] = useState<FollowUpTask[]>([]);
  const [employees, setEmployees] = useState<{ id: string; name: string; branchId: string; designation: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState("");
  const [form, setForm] = useState<FollowUpForm>(emptyForm);
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState("");
  const [show, setShow] = useState<"open" | "closed" | "all">("open");
  const [who, setWho] = useState("all");
  const today = todayInIndia();

  const reload = useCallback(async () => {
    try {
      const [rows, people] = await Promise.all([loadFollowUps(), loadEmployeesForTasks()]);
      setTasks(rows);
      setEmployees(people);
      setFailed("");
    } catch (cause) {
      setFailed(cause instanceof Error ? cause.message : "Could not load the follow-ups");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const nameOf = (employeeId: string | null) => (employeeId ? employees.find((e) => e.id === employeeId)?.name ?? "Former employee" : "Office");
  const godownOf = (branchId: string | null) => (branchId ? branches.find((b) => b.id === branchId)?.name ?? branchId : "");
  const counts = followUpCounts(tasks, today);
  const shown = useMemo(() => sortFollowUps(tasks, today).filter((task) => {
    const open = task.status === "open";
    if (show === "open" && !open) return false;
    if (show === "closed" && open) return false;
    if (who === "office") return task.employeeId === null;
    if (who !== "all") return task.employeeId === who;
    return true;
  }), [tasks, today, show, who]);

  // 13 Nov 2026 (owner): tick several follow-ups and delete them together (each removed for good, like its own Delete).
  const bulk = useBulkSelection(shown.map((task) => task.id));
  const [bulkOpen, setBulkOpen] = useState(false);

  const set = <K extends keyof FollowUpForm>(key: K, value: FollowUpForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const problem = followUpProblem(form);
  const save = async () => {
    if (problem) { toast.error(problem); return; }
    setSaving(true);
    try {
      if (editing) await updateFollowUp(editing, form);
      else await addFollowUp(form);
      toast.success(editing ? "Follow-up changed" : "Follow-up added", { description: `${form.title.trim()} · due ${longDate(form.dueOn)}` });
      setForm(emptyForm());
      setEditing(null);
      await reload();
    } catch (cause) {
      toast.error("Could not save", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setSaving(false);
    }
  };
  const edit = (task: FollowUpTask) => {
    setEditing(task.id);
    setForm({ title: task.title, details: task.details, kind: task.kind, employeeId: task.employeeId, branchId: task.branchId, dueOn: task.dueOn, repeatEvery: task.repeatEvery, remindDays: task.remindDays });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const act = async (task: FollowUpTask, what: "done" | "cancel" | "reopen" | "delete") => {
    let note = "";
    if (what === "done") {
      const typed = window.prompt(`Mark "${task.title}" done? Add a note if you like (for example the new licence number).`, "");
      if (typed === null) return;
      note = typed.trim();
    }
    if (what === "delete" && !window.confirm(`Delete "${task.title}"? It is removed for good. To keep it on record, use Cancel instead.`)) return;
    setBusy(task.id);
    try {
      if (what === "done") {
        const { nextDue } = await completeFollowUp(task.id, note);
        toast.success("Marked done", { description: nextDue ? `The next one is due ${longDate(nextDue)}.` : undefined });
      } else if (what === "cancel") {
        await cancelFollowUp(task.id);
        toast.message("Cancelled");
      } else if (what === "reopen") {
        await reopenFollowUp(task.id);
        toast.message("Opened again");
      } else {
        await deleteFollowUp(task.id);
        toast.message("Deleted");
      }
      await reload();
    } catch (cause) {
      toast.error("Could not do that", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy("");
    }
  };

  return (
    <PanelLayout items={adminNav} tone="admin" title="Follow-ups" subtitle="Tasks for your team, such as licence renewals">
      <div className="mb-4 flex flex-wrap gap-2 text-sm">
        <span className={cn("rounded-full px-3 py-1 font-semibold", counts.overdue ? "bg-red-50 text-red-800" : "bg-muted text-slate")}>{`Late or due today: ${counts.overdue}`}</span>
        <span className={cn("rounded-full px-3 py-1 font-semibold", counts.soon ? "bg-amber-50 text-amber-900" : "bg-muted text-slate")}>{`Due soon: ${counts.soon}`}</span>
        <span className="rounded-full bg-muted px-3 py-1 font-semibold text-slate">{`Open: ${counts.open}`}</span>
      </div>

      <Panel title={editing ? "Change follow-up" : "Add a follow-up"} className="mb-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="sm:col-span-2 lg:col-span-3">
            <label className="mb-1 block text-xs font-semibold text-charcoal" htmlFor="fu-title">What has to be done *</label>
            <Input id="fu-title" value={form.title} maxLength={150} placeholder="For example: Renew the FSSAI licence for the Challakere godown" onChange={(e) => set("title", e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-charcoal" htmlFor="fu-kind">Type</label>
            <select id="fu-kind" className={fieldClass} value={form.kind} onChange={(e) => set("kind", e.target.value as FollowUpForm["kind"])}>
              {FOLLOW_UP_KINDS.map((kind) => <option key={kind.value} value={kind.value}>{kind.label}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-charcoal" htmlFor="fu-who">Assigned to</label>
            <select id="fu-who" className={fieldClass} value={form.employeeId ?? ""} onChange={(e) => set("employeeId", e.target.value || null)}>
              <option value="">Office (admins)</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.designation ? `${e.name} · ${e.designation}` : e.name}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-charcoal" htmlFor="fu-godown">Godown (optional)</label>
            <select id="fu-godown" className={fieldClass} value={form.branchId ?? ""} onChange={(e) => set("branchId", e.target.value || null)}>
              <option value="">All / not for one godown</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-charcoal" htmlFor="fu-due">Due date *</label>
            <Input id="fu-due" type="date" value={form.dueOn} onChange={(e) => set("dueOn", e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-charcoal" htmlFor="fu-repeat">Repeats</label>
            <select id="fu-repeat" className={fieldClass} value={form.repeatEvery} onChange={(e) => set("repeatEvery", e.target.value as FollowUpForm["repeatEvery"])}>
              {FOLLOW_UP_REPEATS.map((repeat) => <option key={repeat.value} value={repeat.value}>{repeat.label}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-charcoal" htmlFor="fu-remind">Show as due soon (days before)</label>
            <Input id="fu-remind" type="number" min={0} max={90} value={String(form.remindDays)} onChange={(e) => set("remindDays", Math.round(Number(e.target.value) || 0))} />
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <label className="mb-1 block text-xs font-semibold text-charcoal" htmlFor="fu-details">Details (optional)</label>
            <Textarea id="fu-details" value={form.details} maxLength={1000} rows={2} placeholder="Licence number, office to visit, documents to carry…" onChange={(e) => set("details", e.target.value)} />
          </div>
        </div>
        {form.repeatEvery !== "none" && form.dueOn && !problem && (
          <p className="mt-2 text-xs text-slate"><Repeat className="mr-1 inline h-3.5 w-3.5" />{`When it is marked done, the next one is made for ${longDate(nextDueOn(form.dueOn, form.repeatEvery) ?? form.dueOn)}.`}</p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button disabled={saving} onClick={() => void save()} className="bg-navy text-white">{saving ? "Saving…" : editing ? "Save changes" : "Add follow-up"}</Button>
          {editing && <Button variant="outline" disabled={saving} onClick={() => { setEditing(null); setForm(emptyForm()); }}>Cancel change</Button>}
        </div>
      </Panel>

      <Panel
        title="Follow-ups"
        action={(
          <div className="flex flex-wrap gap-2">
            <select aria-label="Show" className="h-9 rounded-md border border-border bg-white px-2 text-sm" value={show} onChange={(e) => setShow(e.target.value as typeof show)}>
              <option value="open">Open</option>
              <option value="closed">Done or cancelled</option>
              <option value="all">All</option>
            </select>
            <select aria-label="Assigned to" className="h-9 rounded-md border border-border bg-white px-2 text-sm" value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="all">Everyone</option>
              <option value="office">Office (admins)</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </div>
        )}
      >
        {loading ? <p className="text-sm text-slate">Loading…</p>
          : failed ? <p className="text-sm font-semibold text-danger">{failed}</p>
          : shown.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-slate"><ListTodo className="h-4 w-4" />{show === "open" ? "No open follow-ups. Add one above." : "Nothing here."}</p>
          ) : (
            <>
            <BulkBar state={bulk.state} count={bulk.count} selectable={shown.length} onToggleAll={bulk.toggleAll} onClear={bulk.clear} onDelete={() => setBulkOpen(true)} hint="Tick follow-ups to delete several together" />
            <ul className="space-y-2">
              {shown.map((task) => {
                const state = dueState(task, today);
                const style = STATE_STYLE[state];
                const open = task.status === "open";
                return (
                  <li key={task.id} className="flex overflow-hidden rounded-lg border border-border bg-white">
                    <span className={cn("w-1.5 shrink-0", style.bar)} aria-hidden />
                    <TickBox checked={bulk.isSelected(task.id)} onChange={(on) => bulk.toggle(task.id, on)} label={`Select ${task.title}`} className="ml-1 mt-2" />
                    <div className="min-w-0 flex-1 py-3 pl-1 pr-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className={cn("font-semibold text-navy", !open && "line-through decoration-slate/50")}>{task.title}</p>
                          <p className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-slate">
                            <span className="rounded bg-muted px-1.5 py-0.5 font-semibold">{kindLabel(task.kind)}</span>
                            <span>{nameOf(task.employeeId)}</span>
                            {task.branchId && <span>{godownOf(task.branchId)}</span>}
                            {task.repeatEvery !== "none" && <span className="inline-flex items-center gap-0.5"><Repeat className="h-3 w-3" />{repeatLabel(task.repeatEvery)}</span>}
                          </p>
                        </div>
                        <p className={cn("flex items-center gap-1 text-sm font-semibold", style.text)}>
                          <CalendarClock className="h-4 w-4" />
                          <span>{longDate(task.dueOn)}</span>
                          {open ? <span>{`· ${dueText(task.dueOn, today)}`}</span> : <span>{`· ${style.label}`}</span>}
                        </p>
                      </div>
                      {task.details && <p className="mt-1 whitespace-pre-line text-xs text-charcoal">{task.details}</p>}
                      {task.status === "done" && (
                        <p className="mt-1 text-xs text-emerald-800">{`Done ${task.doneAt ? new Date(task.doneAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : ""}${task.doneNote ? `: ${task.doneNote}` : ""}`}</p>
                      )}
                      <div className="mt-2 flex flex-wrap gap-2">
                        {open && <Button size="sm" className="h-7 bg-emerald-600 text-white hover:bg-emerald-700" disabled={busy === task.id} onClick={() => void act(task, "done")}><CheckCircle2 className="mr-1 h-3.5 w-3.5" />Mark done</Button>}
                        {open && <Button size="sm" variant="outline" className="h-7" disabled={busy === task.id} onClick={() => edit(task)}><Pencil className="mr-1 h-3.5 w-3.5" />Edit</Button>}
                        {open && <Button size="sm" variant="ghost" className="h-7 text-slate" disabled={busy === task.id} onClick={() => void act(task, "cancel")}><XCircle className="mr-1 h-3.5 w-3.5" />Cancel task</Button>}
                        {task.status === "cancelled" && <Button size="sm" variant="outline" className="h-7" disabled={busy === task.id} onClick={() => void act(task, "reopen")}><RotateCcw className="mr-1 h-3.5 w-3.5" />Open again</Button>}
                        <Button size="sm" variant="ghost" className="h-7 text-danger" disabled={busy === task.id} onClick={() => void act(task, "delete")}><Trash2 className="mr-1 h-3.5 w-3.5" />Delete</Button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            </>
          )}
      </Panel>
      {bulkOpen && (
        <BulkDeleteDialog
          title={(n) => (n === 1 ? "Delete 1 follow-up?" : `Delete ${n} follow-ups?`)}
          description="They are removed for good. To keep one on record, use Cancel task on it instead."
          items={shown.filter((task) => bulk.isSelected(task.id)).map((task) => ({ id: task.id, label: `${task.title} · ${longDate(task.dueOn)}` }))}
          run={(id) => deleteFollowUp(id)}
          onClose={() => setBulkOpen(false)}
          onFinished={(done) => { if (done.length) { bulk.clear(); void reload(); } }}
        />
      )}
    </PanelLayout>
  );
}
