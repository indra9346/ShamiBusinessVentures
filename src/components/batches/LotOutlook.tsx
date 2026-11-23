import { Fragment, useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { CalendarX2, X } from "lucide-react";
import { Panel } from "@/components/panel/widgets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { inrPrecise } from "@/lib/data";
import type { BatchSale } from "@/lib/batches";
import type { BatchData } from "@/lib/batches.functions";
import { averagePerDay, cleanAverageMode, lotDailySales, marketOutlook, plannedPurchaseOutlook, type AverageMode, type Lot } from "@/lib/lots";
import { cn } from "@/lib/utils";

/*
 * Admin › Lots & average price › If the rest sells at today's market price (client, 19 Nov 2026): per lot with stock,
 * the lot's whole profit or loss if what is left sells at the market price, the average sales a day (normal: since the
 * lot arrived; or custom: from a chosen day, leaving out chosen days), the days until the stock runs out and the day it
 * would. The market price starts at the website's price and can be typed; both choices are kept on this device.
 */
const MODE_KEY = "gb-lots-average-mode";
const PRICE_KEY = "gb-lots-market-prices";
const PLAN_KEY = "gb-lots-planned-purchases";
type Plan = { bags: string; price: string };
const money = (n: number) => inrPrecise(n);
const units = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
const day = (iso: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" }) : "—");

function readJson<T>(key: string, fallback: T): T {
  try { return JSON.parse(window.localStorage.getItem(key) ?? "null") ?? fallback; } catch { return fallback; }
}
function writeJson(key: string, value: unknown) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* this visit only */ }
}

export function LotOutlook({ lots, sales, products, today, withGst }: {
  lots: Lot[]; sales: BatchSale[]; products: BatchData["products"]; today: string; withGst: boolean;
}) {
  const [mode, setModeState] = useState<AverageMode>({ kind: "normal" });
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [skipDay, setSkipDay] = useState("");
  const [plans, setPlans] = useState<Record<string, Plan>>({});
  useEffect(() => {
    setModeState(cleanAverageMode(readJson(MODE_KEY, null), today));
    setTyped(readJson<Record<string, string>>(PRICE_KEY, {}));
    setPlans(readJson<Record<string, Plan>>(PLAN_KEY, {}));
  }, [today]);
  const setPlan = (productId: string, patch: Partial<Plan>) => {
    const next = { ...plans, [productId]: { bags: "", price: "", ...plans[productId], ...patch } };
    setPlans(next);
    writeJson(PLAN_KEY, next);
  };
  const setMode = (next: AverageMode) => { const clean = cleanAverageMode(next, today); setModeState(clean); writeJson(MODE_KEY, clean); };
  const setPrice = (productId: string, value: string) => { const next = { ...typed, [productId]: value }; setTyped(next); writeJson(PRICE_KEY, next); };

  const productOf = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const withStock = lots.filter((lot) => lot.available + lot.held > 0);
  const rows = withStock.map((lot) => {
    const product = productOf.get(lot.productId);
    const gstRate = product?.gstRate ?? 0;
    const sitePrice = product?.price ?? 0;
    const typedPrice = Number(typed[lot.productId]);
    const price = typed[lot.productId] !== undefined && typed[lot.productId] !== "" && typedPrice > 0 ? typedPrice : sitePrice;
    const avg = averagePerDay(lotDailySales(lot, sales), mode, lot.purchaseDate, today);
    return { lot, gstRate, sitePrice, price, avg, out: marketOutlook(lot, price, gstRate, avg.perDay, today) };
  });
  const totalProfit = rows.reduce((sum, r) => sum + (withGst ? r.out.profitWithGst : r.out.profit), 0);
  const productIds = [...new Set(withStock.map((lot) => lot.productId))];
  // A new purchase typed for a product: that product's lots plus the new bags, all at the market price (a plan only).
  const planned = new Map(productIds.flatMap((id) => {
    const plan = plans[id];
    const bags = Number(plan?.bags);
    const price = Number(plan?.price);
    if (!(bags > 0) || !(price > 0)) return [];
    const mine = rows.filter((r) => r.lot.productId === id);
    if (!mine.length) return [];
    return [[id, plannedPurchaseOutlook(mine.map((r) => ({ lot: r.lot, out: r.out, perDay: r.avg.perDay })), { bags, priceWithGst: price }, mine[0]!.price, mine[0]!.gstRate, today)] as const];
  }));
  const lastRowOf = new Map(rows.map((r, index) => [r.lot.productId, index]));
  const plannedTotal = rows.reduce((sum, r) => sum + (planned.has(r.lot.productId) ? 0 : withGst ? r.out.profitWithGst : r.out.profit), 0)
    + [...planned.values()].reduce((sum, p) => sum + (withGst ? p.profitWithGst : p.profit), 0);

  return (
    <Panel title="If the rest sells at today's market price">
      <div className="grid gap-4 text-sm">
        <div className="grid gap-3 rounded-md border border-border bg-slate-50 p-3 md:grid-cols-2">
          <div className="grid content-start gap-2">
            <p className="text-xs font-bold uppercase tracking-wide text-slate">Average sales a day</p>
            <label className="flex items-center gap-2">
              <input type="radio" name="avg-mode" checked={mode.kind === "normal"} onChange={() => setMode({ kind: "normal" })} />
              Normal: every day since the lot arrived
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="avg-mode" checked={mode.kind === "custom"} onChange={() => setMode({ kind: "custom", from: today, exclude: [] })} />
              Custom: from a day I choose, leaving out days I choose
            </label>
            {mode.kind === "custom" && (
              <div className="grid gap-2 pl-6">
                <label className="grid gap-1 text-xs font-semibold text-slate">Average from
                  <Input type="date" max={today} value={mode.from} onChange={(e) => setMode({ ...mode, from: e.target.value || today })} className="w-44" />
                </label>
                <div className="flex flex-wrap items-end gap-2">
                  <label className="grid gap-1 text-xs font-semibold text-slate">Leave out a day
                    <Input type="date" min={mode.from} max={today} value={skipDay} onChange={(e) => setSkipDay(e.target.value)} className="w-44" />
                  </label>
                  <Button size="sm" variant="outline" disabled={!skipDay} onClick={() => { setMode({ ...mode, exclude: [...mode.exclude, skipDay] }); setSkipDay(""); }}>
                    <CalendarX2 className="mr-1.5 h-3.5 w-3.5" />Leave out
                  </Button>
                </div>
                {mode.exclude.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {mode.exclude.map((d) => (
                      <span key={d} className="inline-flex items-center gap-1 rounded-full border border-border bg-white px-2 py-0.5 text-xs">
                        {day(d)}
                        <button type="button" aria-label={`Count ${day(d)} again`} onClick={() => setMode({ ...mode, exclude: mode.exclude.filter((x) => x !== d) })}><X className="h-3 w-3" /></button>
                      </span>
                    ))}
                  </div>
                )}
                <p className="text-xs text-slate">From today the average starts at 0 and builds day by day as sales come in; days left out count neither their days nor their sales.</p>
              </div>
            )}
          </div>
          <div className="grid content-start gap-2">
            <p className="text-xs font-bold uppercase tracking-wide text-slate">Market price a bag (with GST)</p>
            {productIds.map((id) => {
              const product = productOf.get(id);
              return (
                <div key={id} className="grid gap-1.5 rounded border border-border bg-white p-2">
                  <span className="min-w-0 truncate font-semibold text-navy">{product?.name ?? id}</span>
                  <div className="grid grid-cols-3 gap-2">
                    <label className="grid gap-0.5 text-[11px] font-semibold text-slate">New purchase (bags)
                      <Input type="number" inputMode="numeric" min={0} step="1" placeholder="0" value={plans[id]?.bags ?? ""} onChange={(e) => setPlan(id, { bags: e.target.value })} />
                    </label>
                    <label className="grid gap-0.5 text-[11px] font-semibold text-slate">Purchase price a bag (with GST)
                      <Input type="number" inputMode="decimal" min={0} step="0.01" placeholder="0.00" value={plans[id]?.price ?? ""} onChange={(e) => setPlan(id, { price: e.target.value })} />
                    </label>
                    <label className="grid gap-0.5 text-[11px] font-semibold text-slate">Market price a bag (with GST)
                      <Input type="number" inputMode="decimal" min={0} step="0.01" placeholder={String(product?.price ?? "")}
                        value={typed[id] ?? ""} onChange={(e) => setPrice(id, e.target.value)} />
                    </label>
                  </div>
                </div>
              );
            })}
            <p className="text-xs text-slate">Market price empty = the website's price now. A new purchase is only a calculation: nothing is bought or saved. It shows under that product's lots in yellow.</p>
          </div>
        </div>

        {rows.length === 0 ? <p className="text-slate">No lot has stock left.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px]">
              <thead className="bg-ivory text-left text-xs uppercase tracking-wide text-slate">
                <tr>
                  <th className="px-3 py-2">Lot No</th><th className="px-3 py-2">Product</th><th className="px-3 py-2 text-right">Left</th>
                  <th className="px-3 py-2 text-right">Market price</th><th className="px-3 py-2 text-right">Stock left at market</th>
                  <th className="px-3 py-2 text-right">Avg sales / day</th><th className="px-3 py-2 text-right">Stock finishes in</th>
                  <th className="px-3 py-2 text-right">Break-even price</th><th className="px-3 py-2 text-right">Lot profit / loss</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ lot, price, gstRate, avg, out }, index) => {
                  const profit = withGst ? out.profitWithGst : out.profit;
                  const plan = lastRowOf.get(lot.productId) === index ? planned.get(lot.productId) : undefined;
                  const planProfit = plan ? (withGst ? plan.profitWithGst : plan.profit) : 0;
                  return (
                    <Fragment key={lot.key}>
                    <tr className="border-t border-border align-top">
                      <td className="px-3 py-2">
                        <Link to="/admin/batches" search={{ batch: lot.rootBatchId }} className="font-mono font-semibold text-navy hover:text-gold hover:underline">
                          {lot.lotNo ? <span data-no-translate>{lot.lotNo}</span> : <span className="text-slate">{lot.rootCode}</span>}
                        </Link>
                      </td>
                      <td className="px-3 py-2">{lot.productName}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{units(out.units)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {money(withGst ? price : out.priceBefore)}
                        {!withGst && gstRate > 0 && <span className="block text-[11px] text-slate">{`${money(price)} with GST`}</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(withGst ? out.stockValueWithGst : out.stockValue)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {units(avg.perDay)}
                        <span className="block text-[11px] text-slate">{`${units(avg.units)} in ${avg.days} day${avg.days === 1 ? "" : "s"}`}</span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {out.daysToFinish === null ? "No sales yet" : out.daysToFinish === 0 ? "Sold out" : `${out.daysToFinish} days`}
                        {out.finishDate && out.daysToFinish !== 0 && <span className="block text-[11px] text-slate">{`by ${day(out.finishDate)}`}</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(out.breakEvenWithGst)}<span className="block text-[11px] text-slate">with GST</span></td>
                      <td className={cn("px-3 py-2 text-right font-bold tabular-nums", profit < 0 ? "text-red-700" : "text-emerald-700")}>
                        {profit < 0 ? `Loss ${money(-profit)}` : `Profit ${money(profit)}`}
                      </td>
                    </tr>
                    {plan && (
                      <tr className="border-t border-amber-300 bg-amber-50 align-top">
                        <td className="px-3 py-2 text-xs font-bold uppercase text-amber-900" colSpan={2}>
                          {`With new purchase: ${units(plan.bags)} bags at ${money(plans[lot.productId]?.price ? Number(plans[lot.productId]!.price) : 0)}`}
                          <span className="block text-[11px] font-normal normal-case">{`${lot.productName}: all lots above + the new bags (${money(plan.purchaseValueWithGst)} with GST)`}</span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{units(plan.units)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{money(withGst ? price : out.priceBefore)}</td>
                        <td className="px-3 py-2" />
                        <td className="px-3 py-2 text-right tabular-nums">{units(plan.perDay)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {plan.daysToFinish === null ? "No sales yet" : `${plan.daysToFinish} days`}
                          {plan.finishDate && <span className="block text-[11px] text-slate">{`by ${day(plan.finishDate)}`}</span>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{money(plan.breakEvenWithGst)}<span className="block text-[11px] text-slate">with GST</span></td>
                        <td className={cn("px-3 py-2 text-right font-bold tabular-nums", planProfit < 0 ? "text-red-700" : "text-emerald-700")}>
                          {planProfit < 0 ? `Loss ${money(-planProfit)}` : `Profit ${money(planProfit)}`}
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            <p className={cn("mt-2 text-sm font-semibold", totalProfit < 0 ? "text-red-700" : "text-emerald-700")}>
              {totalProfit < 0 ? `All lots with stock: loss ${money(-totalProfit)} at these prices` : `All lots with stock: profit ${money(totalProfit)} at these prices`}
            </p>
            {planned.size > 0 && (
              <p className={cn("mt-1 rounded bg-amber-50 px-2 py-1 text-sm font-semibold", plannedTotal < 0 ? "text-red-700" : "text-emerald-700")}>
                {plannedTotal < 0 ? `With the new purchases: loss ${money(-plannedTotal)} at these prices` : `With the new purchases: profit ${money(plannedTotal)} at these prices`}
              </p>
            )}
            <p className="mt-1 text-xs text-slate">
              Lot profit / loss = sales so far + the stock left (and units awaiting payment) at the market price − the lot's purchase and all its expenses. Break-even price: what a bag must fetch for no profit and no loss. Stock finishes in: the bags left ÷ the average sales a day.
            </p>
          </div>
        )}
      </div>
    </Panel>
  );
}
