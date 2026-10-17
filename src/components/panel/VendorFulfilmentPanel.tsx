import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Panel } from "@/components/panel/widgets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { reloadBranches, useBranches } from "@/lib/branches";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";

type Mode = "godown" | "self";

/**
 * How a vendor's products reach customers: kept at a Grain Bazar godown (Grain Bazar handles
 * pickup/delivery there), or fulfilled from the vendor's own place with the vendor's own pickup
 * and/or home delivery. Customers never see the vendor's name; a "Partner pickup point" is shown.
 */
export function VendorFulfilmentPanel({ vendorId }: { vendorId: string }) {
  const { branches, features } = useBranches();
  const godowns = branches.filter((branch) => branch.active && !branch.vendorId);
  const own = branches.find((branch) => branch.vendorId === vendorId);
  const [mode, setMode] = useState<Mode>("godown");
  const [branchId, setBranchId] = useState("");
  const [details, setDetails] = useState({ address: "", city: "", pincode: "", phone: "", mapUrl: "", instructions: "", pincodes: "", pickup: true, delivery: false, fee: "0", freeAbove: "" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!vendorId) return;
    void supabase.from("vendor_settings").select("value").eq("vendor_id", vendorId).eq("key", "fulfilment").maybeSingle().then(({ data }) => {
      const value = data?.value && typeof data.value === "object" && !Array.isArray(data.value) ? data.value as Record<string, unknown> : {};
      if (value["mode"] === "self") setMode("self");
      if (typeof value["branch_id"] === "string") setBranchId(value["branch_id"]);
    });
  }, [vendorId]);
  useEffect(() => {
    if (!own) return;
    setDetails({
      address: own.address, city: own.city, pincode: own.pincode, phone: own.phone, mapUrl: own.mapUrl, instructions: own.instructions,
      pincodes: own.servesPincodes.join(", "), pickup: own.pickupEnabled, delivery: own.deliveryEnabled,
      fee: String(own.deliveryFee), freeAbove: own.freeDeliveryAbove === null ? "" : String(own.freeDeliveryAbove),
    });
  }, [own]);

  const save = async () => {
    if (mode === "godown" && !branchId) { toast.error("Choose the Grain Bazar godown that keeps your stock"); return; }
    setSaving(true);
    const { error } = await supabase.rpc("vendor_set_fulfilment", {
      _mode: mode,
      _branch_id: mode === "godown" ? branchId : null,
      _details: {
        address: details.address, city: details.city, pincode: details.pincode, phone: details.phone, map_url: details.mapUrl,
        instructions: details.instructions, pincodes: details.pincodes.split(/[\s,]+/).filter(Boolean),
        pickup: details.pickup, delivery: details.delivery, delivery_fee: details.fee, free_delivery_above: details.freeAbove,
      } as Json,
    });
    setSaving(false);
    if (error) { toast.error("Could not save how you fulfil orders", { description: error.message }); return; }
    await reloadBranches();
    toast.success("Fulfilment saved");
  };

  return (
    <Panel title="How your orders reach customers">
      {!features.marketplaceVendors && <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">The vendor marketplace is not open yet; this can be saved once it opens.</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        {([["godown", "I will keep products at your godown", "Grain Bazar stores your stock and handles pickup and delivery from its godown."], ["self", "I will maintain from my place only", "You keep the stock; customers collect from you and/or you deliver, with your own charge."]] as const).map(([value, title, hint]) => (
          <button key={value} type="button" onClick={() => setMode(value)}
            className={`rounded-lg border p-4 text-left ${mode === value ? "border-gold bg-ivory" : "border-border hover:border-gold"}`}>
            <span className="block font-semibold text-navy">{title}</span>
            <span className="text-sm text-slate">{hint}</span>
          </button>
        ))}
      </div>
      {mode === "godown" ? (
        <div className="mt-4 grid gap-1.5 sm:max-w-md">
          <Label>Grain Bazar godown</Label>
          <select className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            <option value="">Choose a godown</option>
            {godowns.map((branch) => <option key={branch.id} value={branch.id}>{branch.name} ({branch.city || branch.state})</option>)}
          </select>
        </div>
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5 sm:col-span-2"><Label>Pickup / dispatch address</Label><Textarea rows={2} value={details.address} onChange={(e) => setDetails({ ...details, address: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>City</Label><Input value={details.city} onChange={(e) => setDetails({ ...details, city: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>PIN code</Label><Input inputMode="numeric" maxLength={6} value={details.pincode} onChange={(e) => setDetails({ ...details, pincode: e.target.value.replace(/\D/g, "") })} /></div>
          <div className="grid gap-1.5"><Label>Phone</Label><Input value={details.phone} onChange={(e) => setDetails({ ...details, phone: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>Google Maps link</Label><Input value={details.mapUrl} onChange={(e) => setDetails({ ...details, mapUrl: e.target.value })} /></div>
          <div className="grid gap-1.5 sm:col-span-2"><Label>PIN codes you serve</Label><Input value={details.pincodes} onChange={(e) => setDetails({ ...details, pincodes: e.target.value })} placeholder="577522, 577536" /></div>
          <div className="grid gap-1.5 sm:col-span-2"><Label>Pickup instructions</Label><Input value={details.instructions} onChange={(e) => setDetails({ ...details, instructions: e.target.value })} /></div>
          <label className="flex items-center gap-2 text-sm"><Switch checked={details.pickup} onCheckedChange={(on) => setDetails({ ...details, pickup: on })} />Customers can collect from me</label>
          <label className="flex items-center gap-2 text-sm"><Switch checked={details.delivery} onCheckedChange={(on) => setDetails({ ...details, delivery: on })} />I offer home delivery</label>
          {details.delivery && (
            <>
              <div className="grid gap-1.5"><Label>Delivery charge (₹)</Label><Input inputMode="decimal" value={details.fee} onChange={(e) => setDetails({ ...details, fee: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>Free delivery above (₹, optional)</Label><Input inputMode="decimal" value={details.freeAbove} onChange={(e) => setDetails({ ...details, freeAbove: e.target.value })} /></div>
            </>
          )}
        </div>
      )}
      <div className="mt-6 flex justify-end">
        <Button className="bg-navy text-white" disabled={saving || !features.marketplaceVendors} onClick={() => void save()}>{saving ? "Saving…" : "Save fulfilment"}</Button>
      </div>
    </Panel>
  );
}
