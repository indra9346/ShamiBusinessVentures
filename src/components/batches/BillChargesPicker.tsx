import { useEffect, useState } from "react";
import { FileText, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { inrPrecise } from "@/lib/data";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import type { BatchData } from "@/lib/batches.functions";
import { CostError, SplitEditor, docOf, type SplitDoc } from "@/components/batches/ExpensePicker";
import { cn } from "@/lib/utils";

/*
 * Admin › Batches › Expenses › Bill charges (spec 8.1, 10): any recent Zoho bill, then its charge lines — freight, hamali
 * and transport billed by a vendor, the discount on the whole bill (a negative cost) and the round-off — split over
 * batches like an expense. Bills are read with the Inventory permission, so this works before the Books Reauthorize.
 */

const money = (n: number) => inrPrecise(n);
const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const day = (iso: string) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" }) : "—");

type Bills = { billId: string; billNumber: string; vendorName: string; date: string; total: number }[];
type Charges = Awaited<ReturnType<typeof import("@/lib/batch-costs.functions")["getBillCharges"]>>;

export function BillChargesDialog({ open, onOpenChange, data, presetBatchIds, defaultGodown, initialBillId, onSaved }: {
  open: boolean; onOpenChange: (open: boolean) => void; data: BatchData; presetBatchIds: string[]; defaultGodown?: string | undefined;
  initialBillId?: string | undefined; onSaved: () => Promise<void>;
}) {
  const godowns = data.godowns.filter((g) => g.active && g.zohoLinked);
  const [branchId, setBranchId] = useState(defaultGodown && godowns.some((g) => g.id === defaultGodown) ? defaultGodown : godowns[0]?.id ?? "");
  const [bills, setBills] = useState<Bills | null>(null);
  const [charges, setCharges] = useState<Charges | null>(null);
  const [doc, setDoc] = useState<SplitDoc | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState("");

  const loadBills = async (godown: string) => {
    if (!godown) return;
    setLoading(true); setProblem(""); setBills(null);
    try {
      if (STATIC_DATA_MODE) { setBills([]); return; }
      const { listBatchBills } = await import("@/lib/zoho-commerce.functions");
      setBills((await listBatchBills({ data: { branchId: godown } })).bills);
    } catch (cause) {
      setProblem(errorText(cause));
    } finally {
      setLoading(false);
    }
  };
  const openBill = async (billId: string) => {
    setLoading(true); setProblem(""); setCharges(null); setDoc(null);
    try {
      if (STATIC_DATA_MODE) return;
      const { getBillCharges } = await import("@/lib/batch-costs.functions");
      const answer = await getBillCharges({ data: { billId } });
      setCharges(answer);
      if (answer.bill.status === "void") setProblem("This bill is void in Zoho");
    } catch (cause) {
      setProblem(errorText(cause));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (!open) return;
    setDoc(null); setCharges(null);
    if (initialBillId) void openBill(initialBillId);
    else void loadBills(branchId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialBillId]);
  const close = () => onOpenChange(false);
  const presets = [...new Set([...presetBatchIds, ...(charges?.batches.map((b) => b.id) ?? [])])];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-1rem)] max-w-3xl overflow-y-auto overflow-x-hidden p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>Charges on a supplier's bill</DialogTitle>
          <DialogDescription>Freight, hamali and other lines that are not goods, the discount on the whole bill and the round-off, split over batches.</DialogDescription>
        </DialogHeader>
        <CostError text={problem} />
        {doc ? (
          <SplitEditor data={data} doc={doc} presetBatchIds={presets} onCancel={() => setDoc(null)} onSaved={async () => { close(); await onSaved(); }} />
        ) : charges ? (
          <div className="grid gap-2">
            <p className="text-sm font-semibold text-navy">{`Bill ${charges.bill.billNumber} · ${charges.bill.vendorName} · ${day(charges.bill.date)}`}</p>
            {charges.batches.length > 0 && <p className="text-xs text-slate">{`Its batches: ${charges.batches.map((b) => b.code).join(", ")}`}</p>}
            {charges.docs.length === 0 && <p className="text-sm text-slate">This bill has no freight or other charge lines, no discount and no round-off.</p>}
            {charges.docs.map((d) => (
              <button key={d.zoho_line_id} type="button" onClick={() => setDoc(docOf(d))}
                className="grid min-w-0 grid-cols-[1fr_auto] gap-x-3 rounded-lg border border-border bg-white p-3 text-left text-sm hover:border-gold">
                <span className="truncate font-semibold text-navy">{d.description}{d.account_name && d.account_name !== d.description ? ` (${d.account_name})` : ""}</span>
                <span className={cn("text-right font-semibold", d.cost < 0 && "text-emerald-700")}>{money(d.cost)}</span>
                <span className="text-xs text-slate">{d.gst_amount ? `Before GST ${money(d.amount_before_gst)} · GST ${money(d.gst_amount)}` : "No GST"}</span>
                <span className="text-right text-xs text-slate">{d.tagged ? `${money(d.tagged)} tagged` : "Not tagged"}</span>
              </button>
            ))}
            <Button variant="outline" size="sm" className="justify-self-start" onClick={() => { setCharges(null); if (!bills) void loadBills(branchId); }}>Other bill</Button>
          </div>
        ) : (
          <div className="grid gap-2">
            <div className="flex flex-wrap items-end gap-2">
              <label className="grid min-w-0 flex-1 gap-1 text-xs font-semibold text-slate">Bills of godown
                <select value={branchId} onChange={(e) => { setBranchId(e.target.value); void loadBills(e.target.value); }} className="h-10 w-full rounded-md border border-input bg-white px-2 text-sm">
                  {godowns.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </label>
              <Button size="sm" variant="outline" disabled={loading} onClick={() => void loadBills(branchId)}><RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")} />Refresh bills</Button>
            </div>
            {!bills && loading && <p className="text-sm text-slate">Reading bills from Zoho…</p>}
            {bills && bills.length === 0 && <p className="text-sm text-slate">No recent bills in Zoho.</p>}
            {bills?.map((b) => (
              <button key={b.billId} type="button" disabled={loading} onClick={() => void openBill(b.billId)}
                className="grid min-w-0 grid-cols-[1fr_auto] gap-x-3 rounded-lg border border-border bg-white p-3 text-left text-sm hover:border-gold">
                <span className="truncate font-semibold text-navy"><FileText className="mr-1 inline h-3.5 w-3.5" />{b.billNumber}</span>
                <span className="text-right font-semibold">{money(b.total)}</span>
                <span className="truncate text-xs text-slate">{b.vendorName}</span>
                <span className="text-right text-xs text-slate">{day(b.date)}</span>
              </button>
            ))}
          </div>
        )}
        {!doc && <DialogFooter><Button variant="outline" onClick={close}>Close</Button></DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}
