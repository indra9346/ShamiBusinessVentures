import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Boxes, CheckCircle2, RefreshCw, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { indiaTime } from "@/lib/attendance";
import { STOCK_COUNT_REASONS, stockCountProblem, stockCountReasonLabel, type StockCountReason } from "@/lib/stock-counts";
import { cn } from "@/lib/utils";

/*
 * The staff app's "Godown stock": every active employee counts the packs on their godown's floor
 * and enters the number. The server corrects Zoho first and only then the website (submitStockCount),
 * so the stock admin and customers see is the stock Zoho has.
 */

type StockCount = Database["public"]["Tables"]["stock_counts"]["Row"];
type Item = { id: string; name: string; category: string; sku: string; size: string; stock: number };

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export function StaffStockCount({ branchId }: { branchId: string }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [counts, setCounts] = useState<StockCount[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [products, stock, recent] = await Promise.all([
      supabase.from("catalog_products").select("id,vendor_id,payload"),
      supabase.from("branch_stock").select("product_id,stock").eq("branch_id", branchId),
      supabase.from("stock_counts").select("*").eq("branch_id", branchId).order("created_at", { ascending: false }).limit(10),
    ]);
    const stockOf = new Map((stock.data ?? []).map((row) => [row.product_id, Number(row.stock) || 0]));
    setItems((products.data ?? [])
      .filter((row) => !String(row.vendor_id ?? "").startsWith("zoho:"))
      .map((row) => {
        const payload = (row.payload ?? {}) as Record<string, unknown>;
        return {
          id: row.id, name: text(payload["name"]) || row.id, category: text(payload["category"]) || "Other",
          sku: text(payload["sku"]), size: text(payload["weight"]) || text(payload["unit"]), stock: stockOf.get(row.id) ?? 0,
        };
      })
      .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name)));
    setCounts((recent.data as StockCount[] | null) ?? []);
  }, [branchId]);
  useEffect(() => { void load(); }, [load]);

  const categories = useMemo(() => ["All", ...new Set((items ?? []).map((item) => item.category))], [items]);
  const shown = (items ?? []).filter((item) => (category === "All" || item.category === category)
    && (!query.trim() || `${item.name} ${item.sku}`.toLowerCase().includes(query.trim().toLowerCase())));

  return (
    <section className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <h2 className="flex items-center gap-2 text-sm font-bold text-navy"><Boxes className="h-4 w-4" /> Godown stock</h2>
      <p className="mt-1 text-xs text-slate">Count the packs on the godown floor and enter the number. Zoho and the website are updated at once.</p>
      <div className="mt-3 flex items-center gap-2 rounded-lg border border-input bg-white px-2">
        <Search className="h-4 w-4 shrink-0 text-slate" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search products" aria-label="Search products"
          className="h-10 w-full bg-transparent text-sm outline-none" />
      </div>
      <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">
        {categories.map((name) => (
          <button key={name} type="button" onClick={() => setCategory(name)}
            className={cn("shrink-0 rounded-full border px-3 py-1 text-xs font-semibold", category === name ? "border-navy bg-navy text-white" : "border-border text-navy")}>
            {name}
          </button>
        ))}
      </div>
      {items === null ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-slate"><RefreshCw className="h-4 w-4 animate-spin" /> Loading…</p>
      ) : (
        <ul className="mt-2 divide-y divide-border">
          {shown.length === 0 && <li className="py-3 text-sm text-slate">No products found.</li>}
          {shown.map((item) => (
            <li key={item.id} className="py-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-charcoal">{item.name}</p>
                  <p className="text-xs text-slate">{[item.size, item.sku].filter(Boolean).join(" · ")}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-right text-xs text-slate"><span className="block text-base font-extrabold text-navy">{item.stock}</span>in stock</span>
                  {open !== item.id && (
                    <button type="button" onClick={() => setOpen(item.id)} className="rounded-md border border-navy px-2.5 py-1.5 text-xs font-bold text-navy">Update stock</button>
                  )}
                </div>
              </div>
              {open === item.id && <CountForm item={item} onClose={() => setOpen(null)} onSaved={async () => { setOpen(null); await load(); }} />}
            </li>
          ))}
        </ul>
      )}
      {counts.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate">Recent stock updates at this godown</h3>
          <ul className="space-y-2 text-sm">
            {counts.map((count) => (
              <li key={count.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <span className="font-semibold text-charcoal">{count.product_name}</span>
                <span className="text-xs text-slate">{`${Number(count.zoho_physical_before)} → ${Number(count.counted)} · ${count.counted_by_name} · ${new Date(count.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })} ${indiaTime(count.created_at)}`}</span>
                {count.flagged && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-900">Big change</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function CountForm({ item, onClose, onSaved }: { item: Item; onClose: () => void; onSaved: () => Promise<void> }) {
  const [value, setValue] = useState("");
  const [reason, setReason] = useState<StockCountReason>("daily_count");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ counted: number; zohoBefore: number; siteAfter: number; flagged: boolean } | null>(null);

  const save = async () => {
    const counted = value.trim() === "" ? NaN : Number(value);
    const problem = stockCountProblem(counted);
    if (problem) { toast.error(problem); return; }
    setBusy(true);
    try {
      const { submitStockCount } = await import("@/lib/zoho-commerce.functions");
      const saved = await submitStockCount({ data: { productId: item.id, counted, reason, note: note.trim() } });
      setResult(saved);
      toast.success("Stock updated", { description: `${saved.productName}: ${saved.counted}` });
    } catch (cause) {
      toast.error("Stock was not updated", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div className="mt-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm">
        <p className="flex items-center gap-2 font-bold text-emerald-800"><CheckCircle2 className="h-4 w-4" /> Stock updated in Zoho and on the website</p>
        <p className="mt-1 text-emerald-900">{`Counted ${result.counted} (Zoho had ${result.zohoBefore}). Website stock now ${result.siteAfter}.`}</p>
        {result.flagged && <p className="mt-1 flex items-center gap-1.5 text-amber-800"><AlertTriangle className="h-4 w-4" /> Big change: head office will check it.</p>}
        <button type="button" onClick={() => void onSaved()} className="mt-2 w-full rounded-lg bg-navy py-2 text-sm font-bold text-white">Done</button>
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-2 rounded-xl border border-border bg-ivory p-3">
      <label className="block">
        <span className="mb-1 block text-xs font-semibold text-charcoal">Counted quantity (packs on the floor)</span>
        <Input autoFocus inputMode="numeric" value={value} onChange={(event) => setValue(event.target.value.replace(/[^\d]/g, ""))} className="h-12 text-lg font-bold" placeholder={String(item.stock)} />
      </label>
      <div className="grid grid-cols-2 gap-1.5">
        {STOCK_COUNT_REASONS.map((option) => (
          <button key={option.value} type="button" onClick={() => setReason(option.value)}
            className={cn("rounded-lg border px-2 py-1.5 text-xs font-semibold", reason === option.value ? "border-navy bg-navy text-white" : "border-border bg-white text-navy")}>
            {stockCountReasonLabel(option.value)}
          </button>
        ))}
      </div>
      <Input value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} placeholder="Note (optional)" />
      <div className="flex gap-2">
        <button type="button" onClick={onClose} className="flex-1 rounded-lg border border-border bg-white py-2.5 text-sm font-semibold text-navy">Cancel</button>
        <button type="button" disabled={busy} onClick={() => void save()} className="flex flex-[2] items-center justify-center gap-2 rounded-lg bg-navy py-2.5 text-sm font-bold text-white disabled:opacity-60">
          {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} {busy ? "Updating Zoho…" : "Save count"}
        </button>
      </div>
    </div>
  );
}
