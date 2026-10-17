import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { Panel } from "@/components/panel/widgets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useApp } from "@/lib/store";
import { useBranches } from "@/lib/branches";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";

/** GST state codes (first two digits of a GSTIN). */
export const GST_STATES: [string, string][] = [
  ["37", "Andhra Pradesh"], ["12", "Arunachal Pradesh"], ["18", "Assam"], ["10", "Bihar"], ["22", "Chhattisgarh"],
  ["07", "Delhi"], ["30", "Goa"], ["24", "Gujarat"], ["06", "Haryana"], ["02", "Himachal Pradesh"], ["20", "Jharkhand"],
  ["29", "Karnataka"], ["32", "Kerala"], ["23", "Madhya Pradesh"], ["27", "Maharashtra"], ["14", "Manipur"],
  ["17", "Meghalaya"], ["15", "Mizoram"], ["13", "Nagaland"], ["21", "Odisha"], ["34", "Puducherry"], ["03", "Punjab"],
  ["08", "Rajasthan"], ["11", "Sikkim"], ["33", "Tamil Nadu"], ["36", "Telangana"], ["16", "Tripura"],
  ["09", "Uttar Pradesh"], ["05", "Uttarakhand"], ["19", "West Bengal"],
];
const stateName = (code: string) => GST_STATES.find(([value]) => value === code)?.[1] ?? code;

type Rules = { defaultRate: string; states: { code: string; rate: string }[] };

/**
 * Commission by the vendor's state (from their GSTIN): a default rate plus per-state rates.
 * Vendors with a rate set individually keep it until it is reset to the rules.
 */
export function CommissionRules() {
  const { vendors } = useApp();
  const { features } = useBranches();
  const [rules, setRules] = useState<Rules | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void supabase.from("settings").select("value").eq("key", "marketplace_commission").maybeSingle().then(({ data }) => {
      const value = data?.value && typeof data.value === "object" && !Array.isArray(data.value) ? data.value as Record<string, unknown> : {};
      const stateRates = value["state_rates"] && typeof value["state_rates"] === "object" ? value["state_rates"] as Record<string, unknown> : {};
      setRules({
        defaultRate: String(value["default_rate"] ?? 8),
        states: Object.entries(stateRates).map(([code, rate]) => ({ code, rate: String(rate) })),
      });
    });
  }, []);

  const save = async () => {
    if (!rules) return;
    const parse = (value: string) => Number(value);
    const defaultRate = parse(rules.defaultRate);
    if (!Number.isFinite(defaultRate) || defaultRate < 0 || defaultRate > 100) { toast.error("Default rate must be 0 to 100%"); return; }
    const stateRates: Record<string, number> = {};
    for (const { code, rate } of rules.states) {
      const value = parse(rate);
      if (!code) continue;
      if (!Number.isFinite(value) || value < 0 || value > 100) { toast.error(`Rate for ${stateName(code)} must be 0 to 100%`); return; }
      stateRates[code] = value;
    }
    setSaving(true);
    const { error } = await supabase.from("settings").upsert({
      key: "marketplace_commission", value: { default_rate: defaultRate, state_rates: stateRates } as Json, is_public: false,
    });
    const applied = error ? null : await supabase.rpc("admin_apply_commission_rules");
    setSaving(false);
    if (error || applied?.error) { toast.error("Could not save the commission rules", { description: (error ?? applied?.error)?.message }); return; }
    toast.success("Commission rules saved", { description: `${applied?.data ?? 0} vendor rate(s) updated. Refresh to see them.` });
  };

  const resetVendor = async (vendorId: string) => {
    const { error } = await supabase.rpc("admin_set_vendor_commission", { _vendor_id: vendorId, _rate: null });
    if (error) { toast.error("Could not reset the vendor's rate", { description: error.message }); return; }
    toast.success("Vendor now follows the commission rules. Refresh to see the new rate.");
  };

  if (!rules) return null;
  const used = new Set(rules.states.map((state) => state.code));
  return (
    <Panel title="Commission rules by vendor state" className="mb-6">
      {!features.marketplaceVendors && (
        <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">The vendor marketplace is OFF; these rules apply once it is switched on (Admin → Vendors).</p>
      )}
      <p className="mb-3 text-sm text-slate">A vendor's state is read from their GSTIN. Vendors without a GSTIN, or from a state not listed, use the default rate. A rate set for one vendor (Edit Rate below) overrides the rules.</p>
      <div className="grid max-w-2xl gap-2">
        <label className="flex items-center gap-3 text-sm">
          <span className="w-44 font-semibold text-navy">Default rate</span>
          <Input className="w-24" inputMode="decimal" value={rules.defaultRate} onChange={(e) => setRules({ ...rules, defaultRate: e.target.value })} />
          <span className="text-slate">%</span>
        </label>
        {rules.states.map((state, index) => (
          <div key={index} className="flex items-center gap-3 text-sm">
            <select
              className="h-9 w-44 rounded-md border border-input bg-background px-2"
              value={state.code}
              onChange={(e) => setRules({ ...rules, states: rules.states.map((item, i) => (i === index ? { ...item, code: e.target.value } : item)) })}
            >
              <option value="">Choose state</option>
              {GST_STATES.filter(([code]) => code === state.code || !used.has(code)).map(([code, name]) => <option key={code} value={code}>{name} ({code})</option>)}
            </select>
            <Input className="w-24" inputMode="decimal" value={state.rate} onChange={(e) => setRules({ ...rules, states: rules.states.map((item, i) => (i === index ? { ...item, rate: e.target.value } : item)) })} />
            <span className="text-slate">%</span>
            <Button variant="ghost" size="sm" aria-label="Remove state rate" onClick={() => setRules({ ...rules, states: rules.states.filter((_, i) => i !== index) })}><Trash2 className="h-4 w-4" /></Button>
          </div>
        ))}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={() => setRules({ ...rules, states: [...rules.states, { code: "", rate: rules.defaultRate }] })}><Plus className="mr-1 h-4 w-4" /> Add state rate</Button>
          <Button size="sm" className="bg-navy text-white hover:bg-navy/90" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save rules"}</Button>
        </div>
      </div>
      {vendors.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border text-left text-xs uppercase text-slate"><th className="py-2">Vendor</th><th>State (GSTIN)</th><th>Rate now</th><th></th></tr></thead>
            <tbody>
              {vendors.map((vendor) => {
                // Only a valid GSTIN tells the state (an invalid one could start with any digits).
                const code = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test((vendor.gst || "").toUpperCase()) ? vendor.gst.slice(0, 2) : "";
                return (
                  <tr key={vendor.id} className="border-b border-border">
                    <td className="py-2 font-semibold text-navy">{vendor.business}</td>
                    <td>{code ? `${stateName(code)} (${code})` : vendor.gst ? "Invalid GSTIN (default rate)" : "No GSTIN (default rate)"}</td>
                    <td>{vendor.commission}%</td>
                    <td className="text-right"><Button variant="outline" size="sm" onClick={() => void resetVendor(vendor.id)}>Use rules</Button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
