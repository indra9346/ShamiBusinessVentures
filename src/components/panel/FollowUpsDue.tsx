import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ListTodo } from "lucide-react";
import { followUpCounts, todayInIndia } from "@/lib/follow-ups";
import { loadFollowUps } from "@/lib/follow-ups-store";

/** Admin dashboard: one line when follow-ups are late, due today or due soon, linking to the list. */
export function FollowUpsDue() {
  const [counts, setCounts] = useState<{ overdue: number; soon: number } | null>(null);
  useEffect(() => {
    let active = true;
    void loadFollowUps().then((tasks) => { if (active) setCounts(followUpCounts(tasks, todayInIndia())); }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  if (!counts || (counts.overdue === 0 && counts.soon === 0)) return null;
  return (
    <p className="mb-4 flex flex-wrap items-center gap-x-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
      <ListTodo className="h-4 w-4 shrink-0" />
      <Link to="/admin/follow-ups" className="font-semibold text-navy hover:text-gold">Follow-ups</Link>
      {counts.overdue > 0 && <span className="font-semibold text-red-800">{`Late or due today: ${counts.overdue}`}</span>}
      {counts.soon > 0 && <span>{`Due soon: ${counts.soon}`}</span>}
    </p>
  );
}
