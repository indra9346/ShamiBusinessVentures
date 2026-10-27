import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { IndianRupee, LogOut, RefreshCw, Target, Timer, Trophy } from "lucide-react";
import { LogoMark } from "@/components/brand/Logo";
import { Panel, StatCard } from "@/components/panel/widgets";
import { CommissionLinesTable, PartnerLeaderboard, TargetBar, commissionTotals, usePartnerData } from "@/components/partners/PartnerWidgets";
import { MyPartnerReport } from "@/components/partners/MyPartnerReport";
import { supabase } from "@/integrations/supabase/client";
import { inrPrecise } from "@/lib/data";
import { describeRate, monthLabel, monthStart, targetProgress, type CommissionKind } from "@/lib/partners";

export const Route = createFileRoute("/partner/")({
  head: () => ({ meta: [{ title: "Channel Partner Commission Platform | Grain Bazar" }, { name: "robots", content: "noindex" }] }),
  component: PartnerDashboard,
});

type Me = { id: string; name: string; branchId: string; godown: string };
type Rate = { productName: string; kind: CommissionKind; value: number };

/** The godown channel partner's live dashboard: commissions, target, rates and the leaderboard. */
function PartnerDashboard() {
  const navigate = useNavigate();
  const [me, setMe] = useState<Me | null>(null);
  const [month, setMonth] = useState(monthStart());
  const [rates, setRates] = useState<Rate[]>([]);
  const [target, setTarget] = useState<number>(0);
  const { leaders, lines, error } = usePartnerData(month);

  // Only an active partner may stay here; anyone else goes to the partner login.
  useEffect(() => {
    void (async () => {
      const { data: session } = await supabase.auth.getSession();
      const userId = session.session?.user.id;
      if (!userId) { navigate({ to: "/partner/login", replace: true }); return; }
      const { data: partner } = await supabase.from("channel_partners").select("id,name,branch_id,status").eq("user_id", userId).maybeSingle();
      if (!partner || partner.status !== "active") { await supabase.auth.signOut(); navigate({ to: "/partner/login", replace: true }); return; }
      const { data: branch } = await supabase.from("branches").select("name").eq("id", partner.branch_id).maybeSingle();
      setMe({ id: partner.id, name: partner.name, branchId: partner.branch_id, godown: branch?.name ?? partner.branch_id });
      const { data: rules } = await supabase.from("partner_commission_rules").select("product_id,kind,value").eq("branch_id", partner.branch_id);
      const ids = (rules ?? []).map((rule) => rule.product_id).filter((id): id is string => Boolean(id));
      const { data: products } = ids.length ? await supabase.from("catalog_products").select("id,payload").in("id", ids) : { data: [] };
      const names = new Map((products ?? []).map((row) => [row.id, String((row.payload as Record<string, unknown>)?.["name"] ?? row.id)]));
      setRates((rules ?? []).map((rule) => ({
        productName: rule.product_id ? names.get(rule.product_id) ?? rule.product_id : "All other products",
        kind: rule.kind as CommissionKind, value: Number(rule.value),
      })).sort((a, b) => (a.productName === "All other products" ? 1 : b.productName === "All other products" ? -1 : a.productName.localeCompare(b.productName))));
    })();
  }, [navigate]);

  useEffect(() => {
    if (!me) return;
    void supabase.from("partner_targets").select("target_sales").eq("partner_id", me.id).eq("month", month).maybeSingle()
      .then(({ data }) => setTarget(Number(data?.target_sales ?? 0)));
  }, [me, month]);

  const totals = useMemo(() => commissionTotals(lines), [lines]);
  const progress = targetProgress(totals.sales, target);
  const myRank = leaders?.find((row) => row.partner_id === me?.id)?.rank;

  if (!me) {
    return <div className="grid min-h-screen place-items-center bg-panel text-sm text-slate"><span className="inline-flex items-center gap-2"><RefreshCw className="h-4 w-4 animate-spin" /> Opening your dashboard…</span></div>;
  }

  return (
    <div className="min-h-screen bg-[oklch(0.972_0.004_258)]">
      <header className="sticky top-0 z-30 border-b border-border bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <LogoMark className="h-9 w-9 rounded-lg bg-card p-1 object-contain shadow-sm" />
            <div>
              <p className="text-sm font-extrabold tracking-wide text-navy">Channel Partner Commission Platform</p>
              <p className="text-xs text-slate">{me.name} · {me.godown}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input type="month" value={month.slice(0, 7)} max={monthStart().slice(0, 7)}
              onChange={(event) => event.target.value && setMonth(`${event.target.value}-01`)}
              className="h-9 rounded-md border border-input bg-white px-2 text-sm" aria-label="Month" />
            <button type="button" onClick={async () => { await supabase.auth.signOut(); navigate({ to: "/partner/login" }); }}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-sm text-navy hover:border-gold hover:text-gold">
              <LogOut className="h-4 w-4" /> Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6">
        {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <p className="text-xs text-slate">{monthLabel(month)} · updates live every 30 seconds</p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Commission earned" value={inrPrecise(totals.earned)} icon={IndianRupee} description="Delivered and fully paid orders" />
          <StatCard label="Commission pending" value={inrPrecise(totals.pending)} icon={Timer} description="Becomes earned on delivery + full payment" />
          <StatCard label="Sales (excl. GST)" value={inrPrecise(totals.sales)} icon={Target} description={`${totals.orders} orders`} />
          <StatCard label="Leaderboard rank" value={myRank ? `#${myRank} of ${leaders?.length ?? 0}` : "—"} icon={Trophy} />
        </div>

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

        <MyPartnerReport partnerName={me.name} />

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <Panel title="Leaderboard">
            <PartnerLeaderboard leaders={leaders} highlightPartnerId={me.id} />
          </Panel>
          <Panel title="Your commission rates">
            {rates.length ? (
              <ul className="space-y-2 text-sm">
                {rates.map((rate) => (
                  <li key={rate.productName} className="flex justify-between gap-3 border-b border-border/60 pb-2 last:border-0">
                    <span className="text-charcoal">{rate.productName}</span>
                    <span className="shrink-0 font-semibold text-navy">{describeRate(rate.kind, rate.value)}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-slate">Rates have not been set yet.</p>}
          </Panel>
        </div>

        <Panel title={`Your commissions · ${monthLabel(month)}`}>
          <CommissionLinesTable lines={lines?.filter((line) => line.partner_id === me.id) ?? null} />
        </Panel>
      </main>
    </div>
  );
}
