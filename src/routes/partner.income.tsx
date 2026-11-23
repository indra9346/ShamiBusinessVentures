import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState, useEffect } from "react";
import { Panel } from "@/components/panel/widgets";
import { MonthlyIncome } from "@/components/partners/MonthlyIncome";
import { usePartner } from "@/components/partners/PartnerLayout";
import { PartnerPayouts } from "@/components/partners/PartnerPayouts";
import { commissionTotals, TargetBar, usePartnerData } from "@/components/partners/PartnerWidgets";
import { supabase } from "@/integrations/supabase/client";
import { inrPrecise } from "@/lib/data";
import { monthLabel, targetProgress } from "@/lib/partners";

export const Route = createFileRoute("/partner/income")({
  head: () => ({ meta: [{ title: "Monthly income | Grain Bazar Partner" }, { name: "robots", content: "noindex" }] }),
  component: Page,
});

/** The month's income (profit share), the target and the payouts the office has made. */
function Page() {
  const { me, month, statement } = usePartner();
  const { lines } = usePartnerData(month);
  const [target, setTarget] = useState(0);
  useEffect(() => {
    void supabase.from("partner_targets").select("target_sales").eq("partner_id", me.id).eq("month", month).maybeSingle()
      .then(({ data }) => setTarget(Number(data?.target_sales ?? 0)));
  }, [me.id, month]);
  const totals = useMemo(() => commissionTotals(lines), [lines]);
  const progress = targetProgress(totals.sales, target);
  return (
    <>
      <MonthlyIncome month={month} audience="partner" />
      {!statement && (
        <Panel title={`Monthly income · ${monthLabel(month)}`}>
          <p className="text-sm text-slate">This month your godown is on commission per order. See it under Commissions.</p>
        </Panel>
      )}
      <Panel title={`Target for ${monthLabel(month)}`}>
        {target > 0 ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span className="font-semibold text-navy">{inrPrecise(totals.sales)} of {inrPrecise(target)}</span>
              <span className="font-bold text-navy">{progress}%</span>
            </div>
            <TargetBar percent={progress} />
            <p className="text-xs text-slate">{progress !== null && progress >= 100 ? "Target reached. Well done!" : `${inrPrecise(Math.max(0, target - totals.sales))} more in sales to reach the target.`}</p>
          </div>
        ) : <p className="text-sm text-slate">No target set for this month yet.</p>}
      </Panel>
      <PartnerPayouts partnerId={me.id} partnerName={me.name} />
    </>
  );
}
