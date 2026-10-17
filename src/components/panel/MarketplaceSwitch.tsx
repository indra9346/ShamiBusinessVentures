import { toast } from "sonner";
import { Panel } from "@/components/panel/widgets";
import { Switch } from "@/components/ui/switch";
import { PLATFORM_FEATURES_KEY, reloadBranches, useBranches } from "@/lib/branches";
import { supabase } from "@/integrations/supabase/client";

/**
 * Admin switch for the outside-vendor marketplace. OFF (now): Grain Bazar alone lists and sells
 * from the admin panel; vendor sign-up and the vendor panel are closed, and the database refuses
 * vendor catalogue, stock and order actions. ON: approved vendors list products (after review),
 * Grain Bazar bills every customer, keeps its commission and pays vendors out.
 */
export function MarketplaceSwitch() {
  const { features, ready } = useBranches();
  const set = async (on: boolean) => {
    const value = { branch_routing: features.branchRouting, marketplace_vendors: on };
    const { error } = await supabase.from("settings").upsert({ key: PLATFORM_FEATURES_KEY, value, is_public: true });
    if (error) { toast.error("Could not change the marketplace setting", { description: error.message }); return; }
    await reloadBranches();
    toast.success(on ? "Vendor marketplace is ON" : "Vendor marketplace is OFF");
  };
  return (
    <Panel title="Outside vendors (marketplace)" className="mb-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-3xl space-y-1 text-sm text-slate">
          <p><span className="font-semibold text-navy">OFF (now):</span> Grain Bazar is the only seller. Vendor sign-up and the vendor panel are closed.</p>
          <p><span className="font-semibold text-navy">ON:</span> approved vendors list products after admin review. Customers always buy from Grain Bazar (vendor names stay hidden); Grain Bazar bills the customer, keeps its commission (by the vendor's state, see Commissions) and pays the rest to the vendor. Each vendor chooses to keep stock at a Grain Bazar godown or fulfil from their own place, with their own pickup and/or home delivery.</p>
        </div>
        <label className="flex items-center gap-2 text-sm font-semibold text-navy">
          <Switch checked={features.marketplaceVendors} disabled={!ready} onCheckedChange={(on) => void set(on)} aria-label="Outside vendor marketplace" />
          {features.marketplaceVendors ? "ON" : "OFF"}
        </label>
      </div>
    </Panel>
  );
}
