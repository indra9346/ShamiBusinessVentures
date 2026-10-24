import { useState } from "react";
import { toast } from "sonner";
import { Panel } from "@/components/panel/widgets";
import { branchStockOf, reloadBranches, useBranches } from "@/lib/branches";
import { inr } from "@/lib/data";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

/**
 * Admin: an item's price and stock in each godown. Godowns linked to a Zoho price list can be
 * edited here; the change is saved at once, waits for Zoho, and is sent to the price list by the
 * next sync (or "Sync with Zoho now" on the Godowns page). Edits made in Zoho come back the same way.
 */
export function GodownPricesPanel({ productId, basePrice }: { productId: string; basePrice: number }) {
  const state = useBranches();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const godowns = state.branches.filter((branch) => !branch.vendorId);
  if (!state.ready || godowns.length === 0) return null;

  const save = async (branchId: string, price: number | null, listed: boolean) => {
    if (listed && (price === null || !Number.isFinite(price) || price <= 0)) { toast.error("Enter a valid price"); return; }
    setBusy(branchId);
    const { error } = await supabase.rpc("admin_set_branch_price", { _branch_id: branchId, _product_id: productId, _price: price, _listed: listed });
    setBusy(null);
    if (error) { toast.error("Could not save the godown price", { description: error.message }); return; }
    setDrafts((current) => { const next = { ...current }; delete next[branchId]; return next; });
    await reloadBranches();
    toast.success(listed ? "Godown price saved" : "No longer sold at this godown", { description: "It will be sent to Zoho with the next sync." });
  };

  return (
    <Panel title="Godown prices and stock">
      <div className="space-y-2 text-sm">
        {godowns.map((branch) => {
          const entry = state.prices.get(productId)?.get(branch.id);
          const stock = branchStockOf(state, productId, branch.id);
          const linked = !!branch.zohoPricebookId;
          const listed = linked ? !!entry?.listed : true;
          const draft = drafts[branch.id] ?? (entry?.price ? String(entry.price) : String(basePrice || ""));
          return (
            <div key={branch.id} className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2">
              <div className="min-w-[10rem] flex-1">
                <p className="font-semibold text-navy">{branch.name}{branch.active ? "" : " (off)"}</p>
                <p className="text-xs text-slate">
                  {linked ? `Zoho price list: ${branch.zohoPricebookName || branch.zohoPricebookId}` : "No price list: normal price"}
                  {" · "}Stock {stock.toLocaleString("en-IN")}
                  {entry?.pending ? " · waiting for Zoho" : ""}
                </p>
              </div>
              {linked ? (
                <>
                  <label className="flex items-center gap-2 text-xs text-slate">
                    <Switch
                      checked={listed}
                      disabled={busy === branch.id}
                      onCheckedChange={(on) => void save(branch.id, on ? Number(draft) : entry?.price ?? null, on)}
                      aria-label={`Sold at ${branch.name}`}
                    />
                    Sold here
                  </label>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-slate">₹</span>
                    <Input
                      className="h-8 w-28"
                      inputMode="decimal"
                      value={draft}
                      disabled={!listed || busy === branch.id}
                      onChange={(event) => setDrafts((current) => ({ ...current, [branch.id]: event.target.value }))}
                      aria-label={`Price at ${branch.name}`}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!listed || busy === branch.id || drafts[branch.id] === undefined}
                      onClick={() => void save(branch.id, Number(draft), true)}
                    >
                      Save
                    </Button>
                  </div>
                </>
              ) : (
                <span className="font-semibold text-navy">{inr(basePrice)}</span>
              )}
            </div>
          );
        })}
        <p className="text-xs text-slate">Godowns linked to a Zoho price list sell only the items in it. Link price lists on the Godowns page.</p>
      </div>
    </Panel>
  );
}
