import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { AlertTriangle, CloudDownload, RefreshCw } from "lucide-react";
import { inrPrecise } from "@/lib/data";
import type { ZohoItemNotOnWebsite } from "@/lib/zoho-item-import";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const madeOn = (value: string) => {
  const when = Date.parse(value);
  return Number.isFinite(when)
    ? new Date(when).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })
    : "";
};

/**
 * Admin → Products: Zoho items that have no website product (for one, items made in Zoho before
 * 4 Nov 2026, which don't come in by themselves). One click brings an item in the same way a new item
 * comes in: a hidden product waiting for approval. Nothing changes in Zoho, and it goes on the shop
 * only when an admin switches it on. Zoho is read only when this list is opened.
 */
export function ZohoItemsNotOnWebsite() {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ZohoItemNotOnWebsite[] | null>(null);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [brought, setBrought] = useState<Record<string, string>>({});

  const load = async () => {
    setRows(null);
    setError("");
    try {
      const { listZohoItemsNotOnWebsite } = await import("@/lib/zoho-commerce.functions");
      setRows(await listZohoItemsNotOnWebsite());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Zoho could not be read");
    }
  };

  const bring = async (row: ZohoItemNotOnWebsite) => {
    setBusy(row.itemId);
    try {
      const { bringZohoItemOntoWebsite } = await import("@/lib/zoho-commerce.functions");
      const result = await bringZohoItemOntoWebsite({ data: { itemId: row.itemId } });
      setBrought((current) => ({ ...current, [row.itemId]: result.productId }));
      toast.success("Brought onto the website, hidden", { description: "Set its price, category and picture, then switch it on." });
    } catch (cause) {
      toast.error("Could not bring it onto the website", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  };

  return (
    <>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-4 py-3 text-sm">
        <p className="min-w-0 flex-1 text-slate">Zoho items that aren't on the website yet can be brought in hidden, for you to check and switch on.</p>
        <Button size="sm" variant="outline" onClick={() => { setOpen(true); void load(); }}>
          <CloudDownload className="mr-1.5 h-4 w-4" /> Zoho items not on the website
        </Button>
      </div>
      <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) setConfirming(null); }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Zoho items not on the website</DialogTitle>
            <DialogDescription>
              Bringing one in makes a hidden product waiting for approval. Nothing changes in Zoho, and it goes on the shop only when you switch it on.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <div className="space-y-2">
              <p className="flex items-start gap-1.5 text-sm text-danger"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{error}</p>
              <Button size="sm" variant="outline" onClick={() => void load()}>Try again</Button>
            </div>
          ) : rows === null ? (
            <p className="flex items-center gap-2 text-sm text-slate"><RefreshCw className="h-4 w-4 animate-spin" /> Checking Zoho…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-slate">Every Zoho item is already on the website.</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {rows.map((row) => (
                <li key={row.itemId} className="py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-navy">{row.name}</p>
                      <p className="flex flex-wrap gap-x-1.5 text-xs text-slate">
                        {/* One label per part, so each one reads in Kannada too. */}
                        {[row.sku ? `SKU ${row.sku}` : "No SKU", `${inrPrecise(row.rate)}${row.unit ? ` / ${row.unit}` : ""}`,
                          row.active ? "Active in Zoho" : "Inactive in Zoho", row.createdAt ? `Made in Zoho on ${madeOn(row.createdAt)}` : ""]
                          .filter(Boolean)
                          .map((part, index) => <span key={index}>{index > 0 && <span aria-hidden>· </span>}<span>{part}</span></span>)}
                      </p>
                      {row.problem && <p className="mt-1 flex items-start gap-1 text-xs text-amber-700"><AlertTriangle className="mt-px h-3 w-3 shrink-0" />{row.problem}</p>}
                    </div>
                    {brought[row.itemId] ? (
                      <Link to="/admin/products/$id" params={{ id: brought[row.itemId]! }} className="text-xs font-semibold text-gold hover:underline">
                        On the website, hidden: open it
                      </Link>
                    ) : confirming === row.itemId ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Button size="sm" className="bg-navy text-white hover:bg-navy/90" disabled={busy === row.itemId} onClick={() => void bring(row)}>
                          {busy === row.itemId ? "Bringing in…" : "Yes, bring it in hidden"}
                        </Button>
                        <Button size="sm" variant="ghost" disabled={busy === row.itemId} onClick={() => setConfirming(null)}>Cancel</Button>
                      </div>
                    ) : (
                      <Button size="sm" variant="outline" disabled={!!row.problem || !!busy} onClick={() => setConfirming(row.itemId)}>
                        Bring onto the website
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
