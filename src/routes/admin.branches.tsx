import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { MapPin, Phone, Plus, Star, Truck, Warehouse } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel, StatCard } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { inr } from "@/lib/data";
import { useApp } from "@/lib/store";
import { PLATFORM_FEATURES_KEY, reloadBranches, useBranches, type Branch } from "@/lib/branches";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export const Route = createFileRoute("/admin/branches")({
  head: () => ({ meta: [{ title: "Branches | Grain Bazar Admin" }, { name: "robots", content: "noindex" }] }),
  component: AdminBranches,
});

/** GST state codes for the branch's state. */
const STATES: [string, string][] = [
  ["Andhra Pradesh", "37"], ["Arunachal Pradesh", "12"], ["Assam", "18"], ["Bihar", "10"], ["Chhattisgarh", "22"],
  ["Delhi", "07"], ["Goa", "30"], ["Gujarat", "24"], ["Haryana", "06"], ["Himachal Pradesh", "02"], ["Jharkhand", "20"],
  ["Karnataka", "29"], ["Kerala", "32"], ["Madhya Pradesh", "23"], ["Maharashtra", "27"], ["Manipur", "14"],
  ["Meghalaya", "17"], ["Mizoram", "15"], ["Nagaland", "13"], ["Odisha", "21"], ["Puducherry", "34"], ["Punjab", "03"],
  ["Rajasthan", "08"], ["Sikkim", "11"], ["Tamil Nadu", "33"], ["Telangana", "36"], ["Tripura", "16"],
  ["Uttar Pradesh", "09"], ["Uttarakhand", "05"], ["West Bengal", "19"],
];

type Form = {
  id: string; code: string; name: string; address: string; city: string; state: string; pincode: string; phone: string;
  email: string; mapUrl: string; instructions: string; gstin: string; zohoLocationId: string; zohoLocationName: string;
  pincodes: string; pickupEnabled: boolean; deliveryEnabled: boolean; deliveryFee: string; freeDeliveryAbove: string; active: boolean;
};

const emptyForm: Form = {
  id: "", code: "", name: "", address: "", city: "", state: "Karnataka", pincode: "", phone: "", email: "", mapUrl: "",
  instructions: "Bring your order number. Collect during working hours.", gstin: "", zohoLocationId: "", zohoLocationName: "",
  pincodes: "", pickupEnabled: true, deliveryEnabled: false, deliveryFee: "0", freeDeliveryAbove: "", active: true,
};

const formFrom = (branch: Branch): Form => ({
  id: branch.id, code: branch.code, name: branch.name, address: branch.address, city: branch.city, state: branch.state,
  pincode: branch.pincode, phone: branch.phone, email: branch.email, mapUrl: branch.mapUrl, instructions: branch.instructions,
  gstin: branch.gstin, zohoLocationId: branch.zohoLocationId, zohoLocationName: branch.zohoLocationName,
  pincodes: branch.servesPincodes.join(", "), pickupEnabled: branch.pickupEnabled, deliveryEnabled: branch.deliveryEnabled,
  deliveryFee: String(branch.deliveryFee), freeDeliveryAbove: branch.freeDeliveryAbove === null ? "" : String(branch.freeDeliveryAbove),
  active: branch.active,
});

function AdminBranches() {
  const { branches, stock, features, ready } = useBranches();
  const { orders } = useApp();
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [locations, setLocations] = useState<{ id: string; name: string }[] | null>(null);

  const stats = useMemo(() => new Map(branches.map((branch) => {
    const branchOrders = orders.filter((order) => order.branchId === branch.id);
    let units = 0;
    for (const byBranch of stock.values()) units += byBranch.get(branch.id) ?? 0;
    return [branch.id, {
      orders: branchOrders.length,
      open: branchOrders.filter((order) => order.status !== "Delivered" && order.status !== "Cancelled").length,
      paid: branchOrders.filter((order) => order.payment === "Paid" && order.status !== "Cancelled").reduce((sum, order) => sum + order.amount, 0),
      units,
    }] as const;
  })), [branches, orders, stock]);

  const setFeature = async (key: "branch_routing" | "marketplace_vendors", on: boolean) => {
    const value = { branch_routing: features.branchRouting, marketplace_vendors: features.marketplaceVendors, [key]: on };
    const { error } = await supabase.from("settings").upsert({ key: PLATFORM_FEATURES_KEY, value, is_public: true });
    if (error) { toast.error("Could not change the setting", { description: error.message }); return; }
    await reloadBranches();
    toast.success(on ? "Turned on" : "Turned off");
  };

  const loadLocations = async () => {
    try {
      const { listZohoLocations } = await import("@/lib/zoho-commerce.functions");
      setLocations(await listZohoLocations());
    } catch (cause) {
      toast.error("Could not load Zoho locations", { description: cause instanceof Error ? cause.message : undefined });
    }
  };

  const save = async () => {
    if (!form) return;
    const name = form.name.trim();
    const code = form.code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    if (name.length < 3) { toast.error("Enter the branch name"); return; }
    if (!code) { toast.error("Enter a short branch code, e.g. CLK"); return; }
    if (form.address.trim().length < 8) { toast.error("Enter the full godown address"); return; }
    if (!/^\d{6}$/.test(form.pincode.trim())) { toast.error("Enter the godown's 6-digit PIN code"); return; }
    const pincodes = [...new Set(form.pincodes.split(/[\s,]+/).map((pin) => pin.trim()).filter(Boolean))];
    if (pincodes.some((pin) => !/^\d{6}$/.test(pin))) { toast.error("PIN codes served must be 6 digits each"); return; }
    if (form.gstin.trim() && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(form.gstin.trim().toUpperCase())) {
      toast.error("Enter a valid 15-character GSTIN, or leave it blank"); return;
    }
    if (!form.pickupEnabled && !form.deliveryEnabled) { toast.error("Offer pickup, home delivery, or both"); return; }
    const fee = Number(form.deliveryFee || 0);
    const free = form.freeDeliveryAbove.trim() ? Number(form.freeDeliveryAbove) : null;
    if (!Number.isFinite(fee) || fee < 0 || (free !== null && (!Number.isFinite(free) || free < 0))) {
      toast.error("Enter valid delivery charges"); return;
    }
    const stateCode = STATES.find(([state]) => state === form.state)?.[1] ?? "";
    const row = {
      id: form.id || `BR-${code}`, code, name, address: form.address.trim(), city: form.city.trim(), state: form.state,
      state_code: stateCode, pincode: form.pincode.trim(), phone: form.phone.trim(), email: form.email.trim(),
      map_url: form.mapUrl.trim(), instructions: form.instructions.trim(), gstin: form.gstin.trim().toUpperCase(),
      zoho_location_id: form.zohoLocationId, zoho_location_name: form.zohoLocationName,
      serves_pincodes: pincodes.length ? pincodes : [form.pincode.trim()],
      pickup_enabled: form.pickupEnabled, delivery_enabled: form.deliveryEnabled, delivery_fee: fee, free_delivery_above: free,
      active: form.active, updated_at: new Date().toISOString(),
    };
    const editing = branches.find((branch) => branch.id === form.id);
    if (editing?.isDefault && !form.active) { toast.error("The default branch cannot be switched off. Make another branch the default first."); return; }
    setSaving(true);
    const { error } = editing
      ? await supabase.from("branches").update(row).eq("id", editing.id)
      : await supabase.from("branches").insert({ ...row, is_default: branches.length === 0, sort_order: branches.length });
    setSaving(false);
    if (error) {
      toast.error("Could not save the branch", { description: error.code === "23505" ? "That branch code is already used." : error.message });
      return;
    }
    await reloadBranches();
    toast.success(editing ? `${name} updated` : `${name} added`);
    setForm(null);
  };

  const makeDefault = async (branch: Branch) => {
    if (!branch.active) { toast.error("Switch the branch on first"); return; }
    const current = branches.find((item) => item.isDefault);
    if (current) {
      const { error } = await supabase.from("branches").update({ is_default: false }).eq("id", current.id);
      if (error) { toast.error("Could not change the default branch", { description: error.message }); return; }
    }
    const { error } = await supabase.from("branches").update({ is_default: true }).eq("id", branch.id);
    if (error) {
      if (current) await supabase.from("branches").update({ is_default: true }).eq("id", current.id);
      toast.error("Could not change the default branch", { description: error.message });
      return;
    }
    await reloadBranches();
    toast.success(`${branch.name} is now the default branch`);
  };

  const godowns = branches.filter((branch) => !branch.vendorId);
  const partnerPoints = branches.filter((branch) => branch.vendorId);
  const active = godowns.filter((branch) => branch.active);
  return (
    <PanelLayout items={adminNav} tone="admin" title="Branches" subtitle="Godowns, the PIN codes they serve, pickup and delivery">
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Active branches" value={String(active.length)} icon={Warehouse} />
        <StatCard label="PIN codes served" value={String(new Set(active.flatMap((branch) => branch.servesPincodes)).size)} icon={MapPin} />
        <StatCard label="Offering home delivery" value={String(active.filter((branch) => branch.deliveryEnabled).length)} icon={Truck} />
        <StatCard label="Default branch" value={branches.find((branch) => branch.isDefault)?.code ?? "—"} icon={Star} />
      </div>

      <Panel title="Match customers to godowns by PIN" className="mb-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl text-sm text-slate">
            <p>When ON, each customer is served by the godown that lists their PIN code: they see that godown's stock, collect from it (or get its home delivery), and the order and its stock belong to that branch. PIN codes no godown lists go to the default branch.</p>
            <p className="mt-1">When OFF (now), every order is handled by the default branch.</p>
          </div>
          <label className="flex items-center gap-2 text-sm font-semibold text-navy">
            <Switch checked={features.branchRouting} disabled={!ready} onCheckedChange={(on) => void setFeature("branch_routing", on)} aria-label="Match customers to godowns by PIN" />
            {features.branchRouting ? "ON" : "OFF"}
          </label>
        </div>
      </Panel>

      <div className="mb-4 flex justify-end">
        <Button className="bg-navy text-white hover:bg-navy/90" onClick={() => setForm({ ...emptyForm })}>
          <Plus className="mr-1 h-4 w-4" /> Add branch
        </Button>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {godowns.map((branch) => {
          const stat = stats.get(branch.id);
          return (
            <Panel key={branch.id} title={`${branch.name}${branch.isDefault ? "  ·  Default" : ""}`}>
              <div className="space-y-2 text-sm">
                <p className="flex items-start gap-1.5 text-charcoal"><MapPin className="mt-0.5 h-4 w-4 shrink-0 text-slate" />{branch.address}</p>
                {branch.phone && <p className="flex items-center gap-1.5 text-charcoal"><Phone className="h-4 w-4 text-slate" />{branch.phone}</p>}
                <p className="text-xs text-slate">Code {branch.code} · {branch.state} ({branch.stateCode}) · Zoho location: {branch.zohoLocationName || "not set"}</p>
                <p className="text-xs text-slate">Serves PIN {branch.servesPincodes.join(", ") || "—"}</p>
                <p className="text-xs text-slate">
                  {branch.pickupEnabled ? "Pickup" : ""}{branch.pickupEnabled && branch.deliveryEnabled ? " + " : ""}
                  {branch.deliveryEnabled ? `Home delivery (${branch.deliveryFee ? inr(branch.deliveryFee) : "free"}${branch.freeDeliveryAbove !== null ? `, free above ${inr(branch.freeDeliveryAbove)}` : ""})` : ""}
                  {branch.active ? "" : " · Switched off"}
                </p>
                <div className="grid grid-cols-4 gap-2 rounded-md bg-ivory/60 p-2 text-center text-xs">
                  <div><p className="font-bold text-navy">{stat?.orders ?? 0}</p><p className="text-slate">orders</p></div>
                  <div><p className="font-bold text-navy">{stat?.open ?? 0}</p><p className="text-slate">open</p></div>
                  <div><p className="font-bold text-navy">{inr(stat?.paid ?? 0)}</p><p className="text-slate">paid sales</p></div>
                  <div><p className="font-bold text-navy">{(stat?.units ?? 0).toLocaleString("en-IN")}</p><p className="text-slate">units in stock</p></div>
                </div>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button size="sm" variant="outline" onClick={() => setForm(formFrom(branch))}>Edit</Button>
                  {!branch.isDefault && <Button size="sm" variant="outline" onClick={() => void makeDefault(branch)}>Make default</Button>}
                </div>
              </div>
            </Panel>
          );
        })}
      </div>

      {partnerPoints.length > 0 && (
        <Panel title="Vendor pickup / delivery points (marketplace)" className="mt-6">
          <p className="mb-3 text-xs text-slate">Set by vendors who fulfil from their own place. Customers see them as "Partner pickup point", never the vendor's name.</p>
          <div className="space-y-2 text-sm">
            {partnerPoints.map((point) => (
              <div key={point.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
                <span><span className="font-semibold text-navy">{point.vendorId}</span> · {point.address} · PIN {point.servesPincodes.join(", ")}</span>
                <span className="text-xs text-slate">{point.pickupEnabled ? "Pickup" : ""}{point.pickupEnabled && point.deliveryEnabled ? " + " : ""}{point.deliveryEnabled ? `Delivery ${point.deliveryFee ? inr(point.deliveryFee) : "free"}` : ""}{point.active ? "" : " · off"}</span>
              </div>
            ))}
          </div>
        </Panel>
      )}

      <Dialog open={!!form} onOpenChange={(open) => { if (!open) setForm(null); }}>
        <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
          <DialogHeader><DialogTitle>{form?.id ? "Edit branch" : "Add branch"}</DialogTitle></DialogHeader>
          {form && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5 sm:col-span-2"><Label>Branch name</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Grain Bazar Chitradurga Godown" /></div>
              <div className="grid gap-1.5"><Label>Code</Label><Input value={form.code} disabled={!!form.id} maxLength={8} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="CTA" /></div>
              <div className="grid gap-1.5"><Label>State</Label>
                <select className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })}>
                  {STATES.map(([state, code]) => <option key={code} value={state}>{state} ({code})</option>)}
                </select>
              </div>
              <div className="grid gap-1.5 sm:col-span-2"><Label>Godown address</Label><Textarea rows={2} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>City / town</Label><Input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>Godown PIN code</Label><Input inputMode="numeric" maxLength={6} value={form.pincode} onChange={(e) => setForm({ ...form, pincode: e.target.value.replace(/\D/g, "") })} /></div>
              <div className="grid gap-1.5"><Label>Phone</Label><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>Email</Label><Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
              <div className="grid gap-1.5 sm:col-span-2"><Label>Google Maps link</Label><Input value={form.mapUrl} onChange={(e) => setForm({ ...form, mapUrl: e.target.value })} placeholder="https://maps.app.goo.gl/…" /></div>
              <div className="grid gap-1.5 sm:col-span-2"><Label>Pickup instructions</Label><Input value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} /></div>
              <div className="grid gap-1.5 sm:col-span-2"><Label>PIN codes this godown serves</Label><Textarea rows={2} value={form.pincodes} onChange={(e) => setForm({ ...form, pincodes: e.target.value })} placeholder="577522, 577536, …" /></div>
              <div className="grid gap-1.5"><Label>Branch GSTIN (if separate)</Label><Input maxLength={15} value={form.gstin} onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })} /></div>
              <div className="grid gap-1.5"><Label>Zoho location</Label>
                {locations ? (
                  <select className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={form.zohoLocationId}
                    onChange={(e) => setForm({ ...form, zohoLocationId: e.target.value, zohoLocationName: locations.find((l) => l.id === e.target.value)?.name ?? "" })}>
                    <option value="">Not set</option>
                    {locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
                  </select>
                ) : (
                  <Button type="button" variant="outline" onClick={() => void loadLocations()}>{form.zohoLocationName || "Load from Zoho"}</Button>
                )}
              </div>
              <label className="flex items-center gap-2 text-sm"><Switch checked={form.pickupEnabled} onCheckedChange={(on) => setForm({ ...form, pickupEnabled: on })} />Customers can collect from this godown</label>
              <label className="flex items-center gap-2 text-sm"><Switch checked={form.deliveryEnabled} onCheckedChange={(on) => setForm({ ...form, deliveryEnabled: on })} />Home delivery from this godown</label>
              {form.deliveryEnabled && (
                <>
                  <div className="grid gap-1.5"><Label>Delivery charge (₹)</Label><Input inputMode="decimal" value={form.deliveryFee} onChange={(e) => setForm({ ...form, deliveryFee: e.target.value })} /></div>
                  <div className="grid gap-1.5"><Label>Free delivery above (₹, optional)</Label><Input inputMode="decimal" value={form.freeDeliveryAbove} onChange={(e) => setForm({ ...form, freeDeliveryAbove: e.target.value })} /></div>
                </>
              )}
              <label className="flex items-center gap-2 text-sm sm:col-span-2"><Switch checked={form.active} onCheckedChange={(on) => setForm({ ...form, active: on })} />Branch is active</label>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setForm(null)}>Cancel</Button>
            <Button className="bg-navy text-white hover:bg-navy/90" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save branch"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PanelLayout>
  );
}
