import { useState } from "react";
import { Panel } from "@/components/panel/widgets";
import { inrPrecise } from "@/lib/data";
import { purchaseBatchOf } from "@/lib/lots";
import { profitLines, type StockBatch } from "@/lib/stock-numbers";
import type { BatchRecord } from "@/lib/batches";
import { cn } from "@/lib/utils";

const money = (n: number) => inrPrecise(n);
const units = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/*
 * Batch detail, top (client's note, 19 Nov 2026: "Batch No means whatever we receive in 1 bill … make S1, S2 & these as
 * separate lot Nos. Profit & loss should show batch wise & according to lots also. Batch No is Stock No."): the bill's
 * stock number, its lots, and the profit and loss of each lot and of the whole batch, before GST and with GST.
 */
export function StockBatchPanel({ stock, batches, currentId, onOpen }: {
  stock: StockBatch; batches: BatchRecord[]; currentId: string; onOpen: (batchId: string) => void;
}) {
  const [withGst, setWithGst] = useState(false);
  const total = profitLines(stock.totals);
  // Stock lost or found sits between cost of goods sold and gross profit: shown when any lot has some.
  const lossOf = (t: { lossValue: number; lossWithGstValue: number }) => (withGst ? t.lossWithGstValue : t.lossValue);
  const showLoss = stock.lots.some((r) => r.lossValue !== 0 || r.lossWithGstValue !== 0);
  const lossCell = (t: { lossValue: number; lossWithGstValue: number }, cls = "") => showLoss && <td className={cn("px-3 py-2 text-right tabular-nums", cls)}>{money(-lossOf(t))}</td>;
  const tone = (n: number) => (n < 0 ? "text-red-700" : "text-emerald-700");
  const cells = (p: ReturnType<typeof profitLines>) => withGst
    ? [p.salesWithGst, p.costOfGoodsSoldWithGst, p.grossProfitWithGst, p.netProfitWithGst]
    : [p.sales, p.costOfGoodsSold, p.grossProfit, p.netProfit];
  return (
    <Panel title={`Batch (stock no.) ${stock.stockNo}`}>
      <div className="grid gap-3 p-4 text-sm">
        <p className="text-slate">
          {[stock.billNumber && `Bill ${stock.billNumber}`, !stock.billNumber && stock.poNumber && `PO ${stock.poNumber}`, stock.supplier, `${stock.lots.length} lot${stock.lots.length === 1 ? "" : "s"}`]
            .filter(Boolean).join(" · ")}
        </p>
        <div className="flex rounded-md border border-input bg-white p-0.5 text-xs self-start justify-self-start">
          {([[false, "Before GST"], [true, "With GST"]] as const).map(([value, label]) => (
            <button key={label} type="button" onClick={() => setWithGst(value)} className={cn("rounded px-2.5 py-1 font-semibold", withGst === value ? "bg-navy text-white" : "text-slate")}>{label}</button>
          ))}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-ivory text-left text-xs uppercase tracking-wide text-slate">
              <tr>
                <th className="px-3 py-2">Lot no.</th><th className="px-3 py-2">Item</th><th className="px-3 py-2">Godown</th>
                <th className="px-3 py-2 text-right">Bought</th><th className="px-3 py-2 text-right">Sold</th><th className="px-3 py-2 text-right">Left</th>
                <th className="px-3 py-2 text-right">Sales</th><th className="px-3 py-2 text-right">Cost of goods sold</th>{showLoss && <th className="px-3 py-2 text-right">Stock lost / found</th>}
                <th className="px-3 py-2 text-right">Gross profit</th><th className="px-3 py-2 text-right">Net profit</th>
              </tr>
            </thead>
            <tbody>
              {stock.lots.map((row) => {
                const lotNo = purchaseBatchOf(row.batch, batches).lot_no;
                const [sales, cogs, gross, net] = cells(profitLines(row));
                return (
                  <tr key={row.batch.id} onClick={() => onOpen(row.batch.id)}
                    className={cn("cursor-pointer border-t border-border hover:bg-ivory/60", row.batch.id === currentId && "bg-gold/10")}>
                    <td className="whitespace-nowrap px-3 py-2 font-mono font-semibold text-navy" data-no-translate>
                      {lotNo || <span className="font-sans font-normal text-amber-800">No lot no. yet</span>}
                      <span className="block text-[11px] font-normal text-slate">{row.batch.batch_code}</span>
                    </td>
                    <td className="max-w-[220px] truncate px-3 py-2" title={row.batch.product_name}>{row.batch.product_name}</td>
                    <td className="max-w-[140px] truncate px-3 py-2 text-slate" title={row.godown}>{row.godown}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{units(row.purchased)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{units(row.sold)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{units(row.available)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(sales!)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(cogs!)}</td>
                    {lossCell(row)}
                    <td className={cn("px-3 py-2 text-right font-semibold tabular-nums", tone(gross!))}>{money(gross!)}</td>
                    <td className={cn("px-3 py-2 text-right font-semibold tabular-nums", tone(net!))}>{money(net!)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              {(() => {
                const [sales, cogs, gross, net] = cells(total);
                return (
                  <tr className="border-t-2 border-navy/30 bg-ivory font-semibold">
                    <td className="px-3 py-2" colSpan={3}>{`Batch ${stock.stockNo} total`}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{units(stock.totals.purchased)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{units(stock.totals.sold)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{units(stock.totals.available)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(sales!)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(cogs!)}</td>
                    {lossCell(stock.totals)}
                    <td className={cn("px-3 py-2 text-right tabular-nums", tone(gross!))}>{money(gross!)}</td>
                    <td className={cn("px-3 py-2 text-right tabular-nums", tone(net!))}>{money(net!)}</td>
                  </tr>
                );
              })()}
            </tfoot>
          </table>
        </div>
        <p className="text-xs text-slate">Click a lot to see its own profit and loss, expenses and customers below. Net profit is after the operating expenses (commissions, other).</p>
      </div>
    </Panel>
  );
}
