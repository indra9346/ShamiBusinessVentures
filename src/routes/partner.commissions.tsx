import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { FilterNote, Panel } from "@/components/panel/widgets";
import { usePartner } from "@/components/partners/PartnerLayout";
import { CommissionOrders, usePartnerData } from "@/components/partners/PartnerWidgets";
import { supabase } from "@/integrations/supabase/client";
import { matchesCommissionStatus } from "@/lib/panel-filters";
import { describeRate, monthLabel, type CommissionKind } from "@/lib/partners";
import { percentText } from "@/lib/partner-month";

type Search = { view?: "earned" | "pending" | "sales" };

export const Route = createFileRoute("/partner/commissions")({
  head: () => ({ meta: [{ title: "Commissions | Grain Bazar Partner" }, { name: "robots", content: "noindex" }] }),
  validateSearch: (search: Record<string, unknown>): Search =>
    search["view"] === "earned" || search["view"] === "pending" || search["view"] === "sales" ? { view: search["view"] } : {},
  component: Page,
});

type Rate = { productName: string; kind: CommissionKind; value: number; enabled: boolean };

/** The month's commission on each order (the dashboard's money cards open it filtered) and the partner's rates. */
function Page() {
  const { me, month, statement } = usePartner();
  const { view = "all" } = Route.useSearch() as { view?: string };
  const navigate = useNavigate();
  const { lines, error } = usePartnerData(month);
  const [rates, setRates] = useState<Rate[]>([]);
  useEffect(() => {
    void (async () => {
      const { data: rules } = await supabase.from("partner_commission_rules").select("*").eq("branch_id", me.branchId);
      const ids = (rules ?? []).map((rule) => rule.product_id).filter((id): id is string => Boolean(id));
      const { data: products } = ids.length ? await supabase.from("catalog_products").select("id,payload").in("id", ids) : { data: [] };
      const names = new Map((products ?? []).map((row) => [row.id, String((row.payload as Record<string, unknown>)?.["name"] ?? row.id)]));
      setRates((rules ?? []).map((rule) => ({
        productName: rule.product_id ? names.get(rule.product_id) ?? rule.product_id : "All other products",
        kind: rule.kind as CommissionKind, value: Number(rule.value), enabled: rule.enabled !== false,
      })).sort((a, b) => (a.productName === "All other products" ? 1 : b.productName === "All other products" ? -1 : a.productName.localeCompare(b.productName))));
    })();
  }, [me.branchId]);

  return (
    <>
      {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <Panel title={`Your commissions · ${monthLabel(month)}`}>
        {view !== "all" && (
          <FilterNote label={view === "earned" ? "Commission earned" : view === "pending" ? "Commission pending" : "Sales (excl. GST)"}
            onClear={() => navigate({ to: "/partner/commissions", search: {} })} />
        )}
        <CommissionOrders lines={lines?.filter((line) => line.partner_id === me.id && matchesCommissionStatus(line.status, view)) ?? null} />
      </Panel>
      <Panel title="Your commission rates">
        {statement ? (
          <p className="text-sm text-charcoal">{`You earn ${percentText(statement.share_percent)}% of what remains each month, after deductions and income tax.`}</p>
        ) : rates.length ? (
          <ul className="space-y-2 text-sm">
            {rates.map((rate) => (
              <li key={rate.productName} className="flex justify-between gap-3 border-b border-border/60 pb-2 last:border-0">
                <span className="text-charcoal">{rate.productName}</span>
                <span className="shrink-0 font-semibold text-navy">{rate.enabled ? describeRate(rate.kind, rate.value) : "No commission (₹0)"}</span>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-slate">Rates have not been set yet.</p>}
      </Panel>
    </>
  );
}
