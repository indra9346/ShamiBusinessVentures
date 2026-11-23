import { useCallback, useEffect, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { Panel } from "@/components/panel/widgets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import type { DashProduct } from "@/lib/stock-dashboard";
import { downloadXlsx } from "@/lib/xlsx";
import { cn } from "@/lib/utils";

/*
 * Daily stock dashboard (client's sheet, 23 Nov 2026): per item and batch / lot for a chosen day, Opening, Receipts and
 * returns, Sent to other godowns, Adjustments, Sales, Handed over, Undelivered (sold, not handed over) and the expected
 * Physical stock, with Zoho's on-hand (today only) and the difference. Admins choose the godown; a channel partner sees
 * their own godown only (the server decides from the login).
 */
type Answer = { admin: boolean; branchId: string; branchName: string; day: string; today: string; zohoNote: string; branches: { id: string; name: string }[]; products: DashProduct[] };

const todayIst = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const n = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(2));
const COLUMNS = ["Batch No", "Lot No", "Opening", "Receipts / returns", "Sent to godowns", "Adjustments", "Sales", "Handed over", "Undelivered", "Physical stock (expected)"];

export function StockDashboard({ partner = false }: { partner?: boolean }) {
  const [day, setDay] = useState(todayIst());
  const [branchId, setBranchId] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    if (STATIC_DATA_MODE) { setError("The stock dashboard reads the live batches; open it on the live site."); return; }
    setLoading(true);
    try {
      const { stockDashboard } = await import("@/lib/zoho-commerce.functions");
      const next = (await stockDashboard({ data: { branchId: partner ? "" : branchId, day } })) as Answer;
      setAnswer(next);
      if (!partner && !branchId) setBranchId(next.branchId);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load the stock dashboard");
    } finally {
      setLoading(false);
    }
  }, [branchId, day, partner]);
  useEffect(() => { void load(); }, [load]);

  const download = () => {
    if (!answer) return;
    const rows: (string | number | null)[][] = [[`Stock on ${answer.day} · ${answer.branchName}`], [], ["Product", ...COLUMNS, "Zoho on hand", "Difference"]];
    const bold = [0, 2];
    for (const p of answer.products) {
      for (const r of p.rows) rows.push([p.productName, r.code, r.lotNo, r.opening, r.receipts, r.sent, r.adjustments, r.sales, r.handedOver, r.undelivered, r.expected, null, null]);
      bold.push(rows.length);
      rows.push([`${p.productName} total`, "", "", p.totals.opening, p.totals.receipts, p.totals.sent, p.totals.adjustments, p.totals.sales, p.totals.handedOver, p.totals.undelivered, p.totals.expected, p.zohoOnHand, p.variance]);
    }
    downloadXlsx(`stock-${answer.branchName.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}-${answer.day}.xlsx`, [{ name: "Stock", rows, boldRows: bold, widths: [24, 18, 18, 10, 12, 12, 12, 10, 12, 12, 14, 12, 12] }]);
  };

  return (
    <Panel title="Daily stock" action={
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={!answer?.products.length} onClick={download}><Download className="mr-1.5 h-3.5 w-3.5" />Excel</Button>
        <Button size="sm" variant="outline" disabled={loading} onClick={() => void load()} aria-label="Refresh"><RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} /></Button>
      </div>
    }>
      <div className="grid gap-3 text-sm">
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-xs font-semibold text-slate">Day
            <Input type="date" max={todayIst()} value={day} onChange={(e) => setDay(e.target.value || todayIst())} className="w-44" />
          </label>
          {!partner && answer?.admin && (
            <label className="grid gap-1 text-xs font-semibold text-slate">Godown
              <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className="h-10 rounded-md border border-input bg-white px-3 text-sm">
                {answer.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
          )}
          {partner && answer && <p className="text-sm font-semibold text-navy">{answer.branchName}</p>}
        </div>
        {error && <p className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">{error}</p>}
        {answer?.zohoNote && <p className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">{answer.zohoNote}</p>}
        {answer && !answer.products.length && !loading && <p className="text-slate">No stock or movements at this godown on this day.</p>}
        {answer && answer.products.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px]">
              <thead className="bg-ivory text-left text-xs uppercase tracking-wide text-slate">
                <tr>{COLUMNS.map((c, i) => <th key={c} className={cn("px-3 py-2", i > 1 && "text-right")}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {answer.products.map((p) => (
                  <ProductRows key={p.productId} product={p} today={answer.day === answer.today} />
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-slate">
              Physical stock (expected) = opening + receipts and returns − sent to other godowns ± adjustments − handed over. Sold but not handed over yet is still at the godown (Undelivered). Zoho's on-hand is the master figure; the difference shows where they don't agree.
            </p>
          </div>
        )}
      </div>
    </Panel>
  );
}

function ProductRows({ product, today }: { product: DashProduct; today: boolean }) {
  const t = product.totals;
  const cell = "px-3 py-1.5 text-right tabular-nums";
  return (
    <>
      <tr className="border-t-2 border-border bg-slate-50">
        <td className="px-3 py-1.5 font-semibold text-navy" colSpan={10}>{product.productName}</td>
      </tr>
      {product.rows.map((r) => (
        <tr key={r.id} className="border-t border-border/60">
          <td className="px-3 py-1.5 font-mono text-xs">{r.code}</td>
          <td className="px-3 py-1.5 font-mono text-xs" data-no-translate>{r.lotNo || "—"}</td>
          <td className={cell}>{n(r.opening)}</td><td className={cell}>{n(r.receipts)}</td><td className={cell}>{n(r.sent)}</td>
          <td className={cell}>{n(r.adjustments)}</td><td className={cell}>{n(r.sales)}</td><td className={cell}>{n(r.handedOver)}</td>
          <td className={cell}>{n(r.undelivered)}</td><td className={cn(cell, "font-semibold")}>{n(r.expected)}</td>
        </tr>
      ))}
      <tr className="border-t border-border font-semibold">
        <td className="px-3 py-1.5" colSpan={2}>Total</td>
        <td className={cell}>{n(t.opening)}</td><td className={cell}>{n(t.receipts)}</td><td className={cell}>{n(t.sent)}</td>
        <td className={cell}>{n(t.adjustments)}</td><td className={cell}>{n(t.sales)}</td><td className={cell}>{n(t.handedOver)}</td>
        <td className={cell}>{n(t.undelivered)}</td><td className={cell}>{n(t.expected)}</td>
      </tr>
      <tr className="text-xs">
        <td className="px-3 pb-2 text-slate" colSpan={8} />
        <td className="px-3 pb-2 text-right text-slate">Zoho on hand</td>
        <td className="px-3 pb-2 text-right tabular-nums">
          {product.zohoOnHand === null ? <span className="text-slate">{today ? "—" : "today only"}</span> : (
            <>
              <span className="font-semibold">{n(product.zohoOnHand)}</span>
              <span className={cn("block", product.variance === 0 ? "text-emerald-700" : "font-semibold text-red-700")}>{product.variance === 0 ? "matches" : `difference ${product.variance! > 0 ? "+" : ""}${n(product.variance!)}`}</span>
            </>
          )}
        </td>
      </tr>
    </>
  );
}
