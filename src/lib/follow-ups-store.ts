import { supabase } from "@/integrations/supabase/client";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { followUpFromRow, type FollowUpKind, type FollowUpRepeat, type FollowUpTask } from "@/lib/follow-ups";

/*
 * Follow-up tasks in the database (public.follow_up_tasks). Admins read and write every task; an employee reads the
 * ones assigned to them (row rules) and marks them done through complete_follow_up_task(). The demo keeps them in this
 * browser only.
 */

const DEMO_KEY = "gb-demo-follow-ups";
const readDemo = (): FollowUpTask[] => {
  try { return JSON.parse(localStorage.getItem(DEMO_KEY) ?? "[]") as FollowUpTask[]; } catch { return []; }
};
const writeDemo = (rows: FollowUpTask[]) => {
  try { localStorage.setItem(DEMO_KEY, JSON.stringify(rows)); } catch { /* private window: the demo just forgets */ }
};

const COLUMNS = "id,title,details,kind,employee_id,branch_id,due_on,repeat_every,remind_days,status,done_at,done_note,created_at";

export type FollowUpForm = {
  title: string; details: string; kind: FollowUpKind; employeeId: string | null; branchId: string | null;
  dueOn: string; repeatEvery: FollowUpRepeat; remindDays: number;
};

const toRow = (form: FollowUpForm) => ({
  title: form.title.trim(), details: form.details.trim(), kind: form.kind, employee_id: form.employeeId, branch_id: form.branchId,
  due_on: form.dueOn, repeat_every: form.repeatEvery, remind_days: form.remindDays,
});

/** Every task the signed-in person may see: all of them for an admin, their own for an employee. */
export async function loadFollowUps(): Promise<FollowUpTask[]> {
  if (STATIC_DATA_MODE) return readDemo();
  const { data, error } = await supabase.from("follow_up_tasks").select(COLUMNS).order("due_on").limit(1000);
  if (error) throw new Error(error.message);
  return (data ?? []).map(followUpFromRow);
}

export async function addFollowUp(form: FollowUpForm) {
  if (STATIC_DATA_MODE) {
    writeDemo([...readDemo(), { ...form, id: crypto.randomUUID(), status: "open", doneAt: null, doneNote: "", createdAt: new Date().toISOString() }]);
    return;
  }
  const { error } = await supabase.from("follow_up_tasks").insert(toRow(form));
  if (error) throw new Error(error.message);
}

export async function updateFollowUp(id: string, form: FollowUpForm) {
  if (STATIC_DATA_MODE) {
    writeDemo(readDemo().map((task) => (task.id === id ? { ...task, ...form } : task)));
    return;
  }
  const { error } = await supabase.from("follow_up_tasks").update(toRow(form)).eq("id", id);
  if (error) throw new Error(error.message);
}

/** Done, with a note; a repeating task's next one is made by the database. */
export async function completeFollowUp(id: string, note: string): Promise<{ nextDue: string | null }> {
  if (STATIC_DATA_MODE) {
    writeDemo(readDemo().map((task) => (task.id === id ? { ...task, status: "done", doneAt: new Date().toISOString(), doneNote: note } : task)));
    return { nextDue: null };
  }
  const { data, error } = await supabase.rpc("complete_follow_up_task", { _id: id, _note: note });
  if (error) throw new Error(error.message);
  return { nextDue: ((data as { next_due?: string | null } | null)?.next_due ?? null) };
}

export async function cancelFollowUp(id: string) {
  if (STATIC_DATA_MODE) {
    writeDemo(readDemo().map((task) => (task.id === id ? { ...task, status: "cancelled" } : task)));
    return;
  }
  const { error } = await supabase.from("follow_up_tasks").update({ status: "cancelled" }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function reopenFollowUp(id: string) {
  if (STATIC_DATA_MODE) {
    writeDemo(readDemo().map((task) => (task.id === id ? { ...task, status: "open" } : task)));
    return;
  }
  const { error } = await supabase.from("follow_up_tasks").update({ status: "open" }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteFollowUp(id: string) {
  if (STATIC_DATA_MODE) {
    writeDemo(readDemo().filter((task) => task.id !== id));
    return;
  }
  const { error } = await supabase.from("follow_up_tasks").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

/** Active employees to assign tasks to (admin only). */
export async function loadEmployeesForTasks(): Promise<{ id: string; name: string; branchId: string; designation: string }[]> {
  if (STATIC_DATA_MODE) return [];
  const { data, error } = await supabase.from("staff_employees").select("id,name,branch_id,designation,status").eq("status", "active").order("name");
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({ id: row.id, name: row.name, branchId: row.branch_id, designation: row.designation ?? "" }));
}
