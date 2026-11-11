import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { HandCoins } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { MonthlyIncome } from "@/components/partners/MonthlyIncome";
import { useBranches } from "@/lib/branches";
import { adminNav } from "@/lib/panel-nav";
import { monthStart } from "@/lib/partners";

export const Route = createFileRoute("/admin/partner-income")({
  validateSearch: (search: Record<string, unknown>) => ({ godown: typeof search["godown"] === "string" ? search["godown"] : undefined }),
  head: () => ({ meta: [{ title: "Partner Monthly Income | Grain Bazar Admin" }, { name: "robots", content: "noindex" }] }),
  component: AdminPartnerIncome,
});

/** One godown's month on monthly profit share: income, deductions and what remains, then closing it for payment. */
function AdminPartnerIncome() {
  const { godown: wanted } = Route.useSearch();
  const { branches } = useBranches();
  const godowns = branches.filter((branch) => !branch.vendorId);
  const [picked, setPicked] = useState("");
  const [month, setMonth] = useState(monthStart());
  const godownId = picked || wanted || godowns[0]?.id || "";
  return (
    <PanelLayout items={adminNav} tone="admin" title="Partner Monthly Income" subtitle="Income, deductions and what remains for each godown on monthly profit share">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select aria-label="Godown" value={godownId} onChange={(event) => setPicked(event.target.value)} className="h-9 min-w-0 max-w-full rounded-md border border-input bg-white px-2 text-sm">
          {godowns.map((godown) => <option key={godown.id} value={godown.id}>{godown.name}</option>)}
        </select>
        <input type="month" value={month.slice(0, 7)} max={monthStart().slice(0, 7)} aria-label="Month"
          onChange={(event) => event.target.value && setMonth(`${event.target.value}-01`)}
          className="h-9 rounded-md border border-input bg-white px-2 text-sm" />
        <Link to="/admin/partner-payouts" className="inline-flex h-9 items-center gap-1.5 rounded-md bg-navy px-3 text-sm font-semibold text-white hover:bg-midnight"><HandCoins className="h-4 w-4" />Partner Payouts</Link>
      </div>
      {godownId && <MonthlyIncome key={`${godownId}-${month}`} month={month} branchId={godownId} audience="admin" />}
    </PanelLayout>
  );
}
