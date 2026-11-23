import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { CalendarClock, CheckCircle2, ListTodo } from "lucide-react";
import { dueState, dueText, kindLabel, sortFollowUps, todayInIndia, type FollowUpTask } from "@/lib/follow-ups";
import { completeFollowUp, loadFollowUps } from "@/lib/follow-ups-store";
import { cn } from "@/lib/utils";

const longDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" });

/**
 * The employee's own follow-ups on their staff page: the open tasks an admin assigned to them (the row rules show only
 * theirs), the most urgent first, each with Mark done and a note. The admins are told when one is done.
 */
export function StaffFollowUps() {
  const [tasks, setTasks] = useState<FollowUpTask[] | null>(null);
  const [busy, setBusy] = useState("");
  const today = todayInIndia();
  const load = useCallback(async () => {
    try {
      setTasks(sortFollowUps((await loadFollowUps()).filter((task) => task.status === "open"), today));
    } catch {
      setTasks([]);
    }
  }, [today]);
  useEffect(() => { void load(); }, [load]);
  if (!tasks || tasks.length === 0) return null;
  const done = async (task: FollowUpTask) => {
    const note = window.prompt(`Mark "${task.title}" done? Add a note for the office if you like.`, "");
    if (note === null) return;
    setBusy(task.id);
    try {
      await completeFollowUp(task.id, note.trim());
      toast.success("Marked done", { description: "The office is told." });
      await load();
    } catch (cause) {
      toast.error("Could not mark it done", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy("");
    }
  };
  return (
    <section className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <h2 className="flex items-center gap-2 text-base font-bold text-navy"><ListTodo className="h-5 w-5 text-gold" /> My tasks</h2>
      <ul className="mt-3 space-y-2">
        {tasks.map((task) => {
          const state = dueState(task, today);
          const late = state === "overdue" || state === "today";
          return (
            <li key={task.id} className={cn("rounded-lg border p-3", late ? "border-red-200 bg-red-50" : state === "soon" ? "border-amber-200 bg-amber-50" : "border-border bg-white")}>
              <p className="font-semibold text-navy">{task.title}</p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate">
                <span className="rounded bg-muted px-1.5 py-0.5 font-semibold">{kindLabel(task.kind)}</span>
                <span className={cn("inline-flex items-center gap-1 font-semibold", late ? "text-red-700" : state === "soon" ? "text-amber-800" : "text-slate")}>
                  <CalendarClock className="h-3.5 w-3.5" />
                  <span>{longDate(task.dueOn)}</span>
                  <span>{`· ${dueText(task.dueOn, today)}`}</span>
                </span>
              </p>
              {task.details && <p className="mt-1 whitespace-pre-line text-xs text-charcoal">{task.details}</p>}
              <button type="button" disabled={busy === task.id} onClick={() => void done(task)}
                className="mt-2 inline-flex items-center gap-1 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60">
                <CheckCircle2 className="h-3.5 w-3.5" /> Mark done
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
