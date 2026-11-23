import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Boxes, Hash, IndianRupee, RefreshCw, Scale } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel, StatCard } from "@/components/panel/widgets";
import { Button } from "@/components/ui/button";
import { adminNav } from "@/lib/panel-nav";
import { inrPrecise } from "@/lib/data";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { buildBatchReport } from "@/lib/batches";
import type { BatchData } from "@/lib/batches.functions";
import { buildLots, stockAverages, type Lot } from "@/lib/lots";
import { LotOutlook } from "@/components/batches/LotOutlook";
import { cn } from "@/lib/utils";

/*
 * Admin › Lots & average price (client's note, 17 Nov 2026):
 *   "Similarly we need P&L lot wise."
 *   "One more menu option where average price calculation for available stock. It will show arrival price, average
 *    sales/day, amount received, amount yet to recover in that lot."
 * A lot is one purchase (its lot number, e.g. SS/S1/340/003, set on the batch) with the batches sent on from it to other
 * godowns. Figures before GST or with GST, as chosen (kept on this device). Read-only: the numbers come from Admin › Batches.
 */
export const Route = createFileRoute("/admin/lots")({
  head: () => ({ meta: [{ title: "Lots & Average Price | Shami Admin" }, { name: "robots", content: "noindex" }] }),
  component: AdminLots,
});

const money = (n: number) => inrPrecise(n);
const units = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
const istDate = (iso: string) => new Date(Date.parse(iso) + 5.5 * 3600_000).toISOString().slice(0, 10);
const day = (iso: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" }) : "—");
const GST_KEY = "gb-lots-with-gst";

function AdminLots() {
  const [data, setData] = useState<BatchData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [withGst, setWithGst] = useState<boolean>(() => {
    try { return typeof window !== "undefined" && window.localStorage.getItem(GST_KEY) === "1"; } catch { return false; }
  });
  const chooseGst = (on: boolean) => {
    setWithGst(on);
    try { window.localStorage.setItem(GST_KEY, on ? "1" : "0"); } catch { /* just this visit */ }
  };
  const load = useCallback(async () => {
    if (STATIC_DATA_MODE) { setError("Lots are read from the live batches; open this page on the live site."); return; }
    setLoading(true);
    try {
      const { getBatchData } = await import("@/lib/batches.functions");
      setData(await getBatchData());
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load the lots");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const today = istDate(new Date().toISOString());
  const report = useMemo(() => (data ? buildBatchReport({ ...data, today }) : null), [data, today]);
  const lots = useMemo(() => (report ? buildLots(report.rows, today) : []), [report, today]);
  const averages = useMemo(() => stockAverages(lots), [lots]);
  const withStock = lots.filter((lot) => lot.available > 0);
  const pick = (before: number, gst: number) => (withGst ? gst : before);
  const received = withStock.reduce((sum, lot) => sum + pick(lot.receivedValue, lot.receivedWithGstValue), 0);
  const toRecover = withStock.reduce((sum, lot) => sum + pick(lot.yetToRecover, lot.yetToRecoverWithGst), 0);
  const stockValue = averages.reduce((sum, a) => sum + pick(a.stockValue, a.stockValueWithGst), 0);
  const gstWord = withGst ? "with GST" : "before GST";

  return (
    <PanelLayout items={adminNav} tone="admin" title="Lots & average price" subtitle="Each purchase lot: arrival price, sales per day, money received and still to recover; P&L lot wise">
      <div className="grid min-w-0 gap-4 [&>*]:min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="inline-flex rounded-md border border-border bg-white p-0.5 text-sm" role="group" aria-label="GST">
            <button type="button" onClick={() => chooseGst(false)} className={cn("rounded px-3 py-1.5 font-semibold", !withGst ? "bg-navy text-white" : "text-slate hover:text-navy")}>Before GST</button>
            <button type="button" onClick={() => chooseGst(true)} className={cn("rounded px-3 py-1.5 font-semibold", withGst ? "bg-navy text-white" : "text-slate hover:text-navy")}>With GST</button>
          </div>
          <Button size="sm" variant="outline" disabled={loading} onClick={() => void load()}><RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")} />Refresh</Button>
        </div>
        {error && <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{error}</p>}
        {!data && !error && <p className="text-sm text-slate">Reading the lots…</p>}
        {data && (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatCard compact label="Lots with stock" value={`${withStock.length} / ${lots.length}`} icon={Hash} description="with bags left / all lots" />
              <StatCard compact label="Stock at arrival price" value={money(stockValue)} icon={Boxes} description={`${units(averages.reduce((s, a) => s + a.available, 0))} left, ${gstWord}`} />
              <StatCard compact label="Amount received" value={money(received)} icon={IndianRupee} description={`paid orders of the lots with stock, ${gstWord}`} />
              <StatCard compact label="Yet to recover" value={money(toRecover)} icon={Scale} highlight description={`purchase + expenses not yet back, ${gstWord}`} />
            </div>

            <Panel title={`Average price of available stock (${gstWord})`}>
              {averages.length === 0 ? <p className="text-sm text-slate">No stock left in any lot.</p> : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-sm">
                    <thead className="bg-ivory text-left text-xs uppercase tracking-wide text-slate">
                      <tr><th className="px-3 py-2">Product</th><th className="px-3 py-2 text-right">Bags left</th><th className="px-3 py-2 text-right">Lots</th><th className="px-3 py-2 text-right">Average arrival price</th><th className="px-3 py-2 text-right">Stock value</th></tr>
                    </thead>
                    <tbody>
                      {averages.map((a) => (
                        <tr key={a.productName} className="border-t border-border">
                          <td className="px-3 py-2 font-semibold text-navy">{a.productName}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{units(a.available)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{a.lots}</td>
                          <td className="px-3 py-2 text-right font-semibold tabular-nums">{money(pick(a.avgArrivalPrice, a.avgArrivalPriceWithGst))}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{money(pick(a.stockValue, a.stockValueWithGst))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="mt-2 text-xs text-slate">Average arrival price: each lot's arrival price (bill cost + its expenses, per bag bought) weighted by the bags it has left.</p>
                </div>
              )}
            </Panel>

            <Panel title={`Lots with stock (${withStock.length})`}>
              {withStock.length === 0 ? <p className="text-sm text-slate">No lot has stock left.</p> : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1080px] text-sm">
                    <thead className="bg-ivory text-left text-xs uppercase tracking-wide text-slate">
                      <tr>
                        <th className="px-3 py-2">Lot No</th><th className="px-3 py-2">Product</th><th className="px-3 py-2">Arrived</th>
                        <th className="px-3 py-2 text-right">Bought</th><th className="px-3 py-2 text-right">Sold</th><th className="px-3 py-2 text-right">Left</th>
                        <th className="px-3 py-2 text-right">Arrival price</th><th className="px-3 py-2 text-right">Avg sales / day</th><th className="px-3 py-2 text-right">Avg selling price</th>
                        <th className="px-3 py-2 text-right">Amount received</th><th className="px-3 py-2 text-right">Yet to recover</th><th className="px-3 py-2 text-right">Days to recover</th>
                      </tr>
                    </thead>
                    <tbody>{withStock.map((lot) => <LotStockRow key={lot.key} lot={lot} withGst={withGst} />)}</tbody>
                  </table>
                  <p className="mt-2 text-xs text-slate">
                    Arrival price: the bill's cost plus the lot's expenses, per bag bought. Average sales per day: bags sold since the lot arrived.
                    Amount received: paid orders. Yet to recover: the lot's purchase and expenses not yet received. Days to recover: at the money received per day so far.
                  </p>
                </div>
              )}
            </Panel>

            {/* Client, 19 Nov 2026: the lot at today's market price, with normal or custom averaging. */}
            <LotOutlook lots={lots} sales={report?.sales ?? []} products={data.products} today={today} withGst={withGst} />

            <Panel title={`Profit and loss lot wise (${gstWord})`}>
              {lots.length === 0 ? <p className="text-sm text-slate">No lots yet.</p> : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1160px] text-sm">
                    <thead className="bg-ivory text-left text-xs uppercase tracking-wide text-slate">
                      <tr>
                        <th className="px-3 py-2">Lot No</th><th className="px-3 py-2">Product</th><th className="px-3 py-2">Godowns</th>
                        <th className="px-3 py-2 text-right">Bought</th><th className="px-3 py-2 text-right">Sold</th>
                        <th className="px-3 py-2 text-right">Sales</th><th className="px-3 py-2 text-right">Cost of sold</th><th className="px-3 py-2 text-right">Cost of goods expenses</th>
                        <th className="px-3 py-2 text-right">Gross profit</th><th className="px-3 py-2 text-right">Operating expenses</th>
                        <th className="px-3 py-2 text-right">Net profit</th><th className="px-3 py-2 text-right">Net per bag</th>
                      </tr>
                    </thead>
                    <tbody>{lots.map((lot) => <LotProfitRow key={lot.key} lot={lot} withGst={withGst} />)}</tbody>
                  </table>
                  <p className="mt-2 text-xs text-slate">Gross profit: sales − cost of goods sold (bill cost + transport, hamali and other expenses marked cost of goods). Net profit: after operating expenses (commissions, other) and stock lost. Open a lot to see its batches, orders and expenses.</p>
                </div>
              )}
            </Panel>
          </>
        )}
      </div>
    </PanelLayout>
  );
}

function LotName({ lot }: { lot: Lot }) {
  return (
    <Link to="/admin/batches" search={{ batch: lot.rootBatchId }} className="font-mono font-semibold text-navy hover:text-gold hover:underline">
      {lot.lotNo ? <span data-no-translate>{lot.lotNo}</span> : <span className="text-slate">{`No lot no (${lot.rootCode})`}</span>}
    </Link>
  );
}

function LotStockRow({ lot, withGst }: { lot: Lot; withGst: boolean }) {
  const pick = (before: number, gst: number) => (withGst ? gst : before);
  const yet = pick(lot.yetToRecover, lot.yetToRecoverWithGst);
  return (
    <tr className="border-t border-border">
      <td className="px-3 py-2"><LotName lot={lot} /></td>
      <td className="px-3 py-2">{lot.productName}</td>
      <td className="whitespace-nowrap px-3 py-2 text-slate">{`${day(lot.purchaseDate)} · ${lot.days} d`}</td>
      <td className="px-3 py-2 text-right tabular-nums">{units(lot.purchased)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{units(lot.sold)}</td>
      <td className="px-3 py-2 text-right font-semibold tabular-nums">{units(lot.available)}</td>
      <td className="px-3 py-2 text-right font-semibold tabular-nums">{money(pick(lot.arrivalPrice, lot.arrivalPriceWithGst))}</td>
      <td className="px-3 py-2 text-right tabular-nums">{units(lot.salesPerDay)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{lot.sold > 0 ? money(pick(lot.avgSellingPrice, lot.avgSellingPriceWithGst)) : "—"}</td>
      <td className="px-3 py-2 text-right tabular-nums text-emerald-700">{money(pick(lot.receivedValue, lot.receivedWithGstValue))}</td>
      <td className={cn("px-3 py-2 text-right font-semibold tabular-nums", yet > 0 ? "text-amber-800" : "text-emerald-700")}>{yet > 0 ? money(yet) : "Recovered"}</td>
      <td className="px-3 py-2 text-right tabular-nums">{lot.daysToRecover === null ? "—" : `${lot.daysToRecover} d`}</td>
    </tr>
  );
}

function LotProfitRow({ lot, withGst }: { lot: Lot; withGst: boolean }) {
  const pick = (before: number, gst: number) => (withGst ? gst : before);
  const expensesOnSold = pick(lot.expenseOnSoldValue + lot.expenseOnLostValue, lot.expenseOnSoldWithGstValue);
  const cogsExpenses = pick(lot.expenseOnSoldCogsValue, lot.expenseOnSoldCogsWithGstValue);
  const operating = expensesOnSold - cogsExpenses;
  const profit = pick(lot.profit, lot.profitWithGstValue);
  const gross = profit + operating;
  return (
    <tr className="border-t border-border">
      <td className="px-3 py-2"><LotName lot={lot} /></td>
      <td className="px-3 py-2">{lot.productName}</td>
      <td className="px-3 py-2 text-slate">{lot.godowns.join(", ")}</td>
      <td className="px-3 py-2 text-right tabular-nums">{units(lot.purchased)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{units(lot.sold)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{money(pick(lot.sales, lot.salesWithGstValue))}</td>
      <td className="px-3 py-2 text-right tabular-nums">{money(pick(lot.costOfSold, lot.costOfSoldWithGstValue))}</td>
      <td className="px-3 py-2 text-right tabular-nums">{money(cogsExpenses)}</td>
      <td className={cn("px-3 py-2 text-right font-semibold tabular-nums", gross < 0 ? "text-red-700" : "text-emerald-700")}>{money(gross)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{money(operating)}</td>
      <td className={cn("px-3 py-2 text-right font-semibold tabular-nums", profit < 0 ? "text-red-700" : "text-emerald-700")}>{money(profit)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{lot.sold > 0 ? money(profit / lot.sold) : "—"}</td>
    </tr>
  );
}

