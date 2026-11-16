import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ClipboardCheck, CreditCard, FileCheck2, IndianRupee, Target, Timer, Trophy } from "lucide-react";
import { StatCard } from "@/components/panel/widgets";
import { usePartner } from "@/components/partners/PartnerLayout";
import { commissionTotals, usePartnerData } from "@/components/partners/PartnerWidgets";
import { ScanQrCard } from "@/components/partners/ScanQrCard";
import { supabase } from "@/integrations/supabase/client";
import { inrPrecise } from "@/lib/data";
import { monthLabel } from "@/lib/partners";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/partner/")({
  head: () => ({ meta: [{ title: "Channel Partner Commission Platform | Grain Bazar" }, { name: "robots", content: "noindex" }] }),
  component: PartnerDashboard,
});

/**
 * The channel partner's dashboard (owner, 16 Nov 2026: a side menu like the admin's instead of one long page): what is
 * waiting for the partner, the month's figures and the QR scanner. Each card opens its page.
 */
function PartnerDashboard() {
  const navigate = useNavigate();
  const { me, month, statement } = usePartner();
  const { leaders, lines, error } = usePartnerData(month);
  const totals = useMemo(() => commissionTotals(lines), [lines]);
  const myRank = leaders?.find((row) => row.partner_id === me.id)?.rank;
  const waiting = useWaiting();
  const openLines = (view: "earned" | "pending" | "sales") => navigate({ to: "/partner/commissions", search: { view } });

  return (
    <>
      {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="grid gap-4 sm:grid-cols-3">
        <WaitingCard to="/partner/payments" icon={CreditCard} label="Customer payments" count={waiting.payments} hint="checkouts waiting for payment" />
        <WaitingCard to="/partner/orders" icon={ClipboardCheck} label="Orders to confirm" count={waiting.orders} hint="paid orders to confirm" />
        <WaitingCard to="/partner/delivery-notes" icon={FileCheck2} label="Delivery notes" count={waiting.handover} hint="with goods still to hand over" />
      </div>
      <p className="text-xs text-slate">{monthLabel(month)} · updates live every 30 seconds</p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {statement ? (
          <>
            <StatCard onClick={() => navigate({ to: "/partner/income" })} label="Total income" value={inrPrecise(statement.income)} icon={IndianRupee} description="Profit on delivered and fully paid orders" />
            <StatCard onClick={() => navigate({ to: "/partner/income" })} label="Your share" value={inrPrecise(statement.share_amount)} icon={Timer} description="After deductions and income tax" />
          </>
        ) : (
          <>
            <StatCard onClick={() => openLines("earned")} label="Commission earned" value={inrPrecise(totals.earned)} icon={IndianRupee} description="Delivered and fully paid orders" />
            <StatCard onClick={() => openLines("pending")} label="Commission pending" value={inrPrecise(totals.pending)} icon={Timer} description="Becomes earned on delivery + full payment" />
          </>
        )}
        <StatCard onClick={() => openLines("sales")} label="Sales (excl. GST)" value={inrPrecise(totals.sales)} icon={Target} description={`${totals.orders} orders`} />
        <StatCard onClick={() => navigate({ to: "/partner/leaderboard" })} label="Leaderboard rank" value={myRank ? `#${myRank} of ${leaders?.length ?? 0}` : "—"} icon={Trophy} />
      </div>
      <ScanQrCard godown={me.godown} />
    </>
  );
}

function WaitingCard({ to, icon: Icon, label, count, hint }: {
  to: "/partner/payments" | "/partner/orders" | "/partner/delivery-notes";
  icon: React.ComponentType<{ className?: string }>; label: string; count: number | null; hint: string;
}) {
  return (
    <Link to={to} className={cn("flex items-center gap-3 rounded-xl border bg-card p-4 shadow-sm hover:border-gold", count ? "border-amber-300" : "border-border")}>
      <Icon className="h-6 w-6 shrink-0 text-navy" />
      <span className="min-w-0">
        <span className="block text-sm font-bold text-navy">{label}</span>
        <span className={cn("block text-xs", count ? "font-semibold text-amber-800" : "text-slate")}>{count === null ? "Loading…" : `${count} ${hint}`}</span>
      </span>
    </Link>
  );
}

/** How many things wait for the partner: checkouts to be paid, paid orders to confirm, notes with goods to hand over. */
function useWaiting() {
  const [state, setState] = useState<{ payments: number | null; orders: number | null; handover: number | null }>({ payments: null, orders: null, handover: null });
  useEffect(() => {
    let stop = false;
    const load = async () => {
      const [payments, orders, notes] = await Promise.all([
        supabase.rpc("partner_payment_checkouts"),
        supabase.rpc("partner_orders_to_confirm"),
        supabase.rpc("godown_released_notes"),
      ]);
      if (stop) return;
      const rows = (result: { data: unknown; error: unknown }) => (!result.error && Array.isArray(result.data) ? (result.data as Record<string, unknown>[]) : []);
      setState({
        payments: rows(payments).length,
        orders: rows(orders).filter((row) => !row["confirmed_at"] && row["zoho_void"] !== true).length,
        handover: rows(notes).filter((row) => !row["delivered"] && Number(row["to_go"] ?? 0) > 0).length,
      });
    };
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => { stop = true; window.clearInterval(timer); };
  }, []);
  return state;
}
