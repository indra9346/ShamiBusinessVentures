import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Building2, Percent, Save, ShieldCheck, Truck } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel, StatCard } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { useApp } from "@/lib/store";

export const Route = createFileRoute("/admin/settings")({
  head: () => ({
    meta: [
      { title: "System Settings | Shami Business Ventures Admin" },
      { name: "description", content: "Business profile, GST, commission, shipping and security settings for the platform." },
      { property: "og:title", content: "System Settings | Shami Admin" },
      { property: "og:description", content: "Configure platform-wide business rules." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminSettings,
});

const settingKeys = ["business_profile", "tax_config", "commerce_rules", "security_config", "company", "tax", "order", "shipping", "security"] as const;

function AdminSettings() {
  const { vendors } = useApp();
  const [business, setBusiness] = useState({
    name: "Shami Business Ventures Pvt Ltd",
    email: "support@shamiventures.in",
    phone: "+91 98765 12340",
    gstin: "29ABHCS4321K1ZP",
    pan: "ABHCS4321K",
    address: "Plot 27, APMC Industrial Yard, Belagavi, Karnataka 590010",
  });
  const [tax, setTax] = useState({ sugar: "5", staples: "5", packaged: "12", gstEnabled: true, invoicePrefix: "SBV/26-27/" });
  const [commerce, setCommerce] = useState({
    advance: "30",
    splitThreshold: "280000",
    paymentWindow: "20",
    freeShipAbove: "10000",
    shippingFlat: "250",
    codEnabled: false,
  });
  const [security, setSecurity] = useState({ twoFactor: true, vendorKyc: true, autoLogout: "30", passwordPolicy: "Strong" });
  useEffect(() => {
    let active = true;
    void supabase.from("settings").select("key,value").in("key", [...settingKeys]).then(({ data, error }) => {
      if (!active || error) return;
      const values = new Map((data ?? []).map((r) => [r.key, r.value]));
      const obj = (key: string): Record<string, unknown> => { const v = values.get(key); return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {}; };
      const savedBusiness = { ...obj("company"), ...obj("business_profile") };
      if (Object.keys(savedBusiness).length) setBusiness((old) => ({ ...old, name: String(savedBusiness["name"] ?? old.name), email: String(savedBusiness["email"] ?? old.email), phone: String(savedBusiness["phone"] ?? old.phone), gstin: String(savedBusiness["gstin"] ?? old.gstin), pan: String(savedBusiness["pan"] ?? old.pan), address: String(savedBusiness["address"] ?? old.address) }));
      const savedTax = { ...obj("tax"), ...obj("tax_config") };
      if (Object.keys(savedTax).length) setTax((old) => ({ ...old, sugar: String(savedTax["sugar"] ?? savedTax["gst_default"] ?? old.sugar), staples: String(savedTax["staples"] ?? savedTax["gst_default"] ?? old.staples), packaged: String(savedTax["packaged"] ?? old.packaged), gstEnabled: Boolean(savedTax["gstEnabled"] ?? savedTax["gst_enabled"] ?? old.gstEnabled), invoicePrefix: String(savedTax["invoicePrefix"] ?? savedTax["invoice_prefix"] ?? old.invoicePrefix) }));
      const savedCommerce = { ...obj("commerce_rules"), ...obj("order") }, savedShipping = obj("shipping");
      if (Object.keys(savedCommerce).length || Object.keys(savedShipping).length) setCommerce((old) => ({ ...old, advance: String(savedCommerce["advance"] ?? savedCommerce["advance_percent"] ?? old.advance), splitThreshold: String(savedCommerce["splitThreshold"] ?? savedCommerce["split_threshold"] ?? old.splitThreshold), paymentWindow: String(savedCommerce["paymentWindow"] ?? savedCommerce["payment_timer_minutes"] ?? old.paymentWindow), freeShipAbove: String(savedShipping["free_above"] ?? old.freeShipAbove), shippingFlat: String(savedShipping["standard"] ?? old.shippingFlat), codEnabled: false }));
      const savedSecurity = { ...obj("security"), ...obj("security_config") };
      if (Object.keys(savedSecurity).length) {
        const rawSec = savedSecurity["autoLogout"];
        const rawHours = savedSecurity["session_hours"];
        setSecurity((old) => ({
          ...old,
          twoFactor: Boolean(savedSecurity["twoFactor"] ?? old.twoFactor),
          vendorKyc: Boolean(savedSecurity["vendorKyc"] ?? old.vendorKyc),
          autoLogout: rawSec !== null && rawSec !== undefined && rawSec !== ""
            ? String(rawSec)
            : Number(rawHours)
            ? String(Number(rawHours) * 60)
            : old.autoLogout,
          passwordPolicy: String(savedSecurity["passwordPolicy"] ?? old.passwordPolicy),
        }));
      }
    });
    return () => { active = false; };
  }, []);
  const saveSetting = async (key: typeof settingKeys[number], value: object, label: string) => {
    const idleTimeout = Math.min(1440, Math.max(5, Math.round(Number(security.autoLogout) || 30)));
    if (key === "security_config" && !Number.isFinite(Number(security.autoLogout))) {
      toast.error("Enter an inactivity timeout from 5 to 1,440 minutes");
      return;
    }
    const valueJson = JSON.parse(JSON.stringify(value)) as Json;
    const rows: { key: string; value: Json; is_public: boolean }[] = [{ key, value: valueJson, is_public: false }];
    if (key === "business_profile") rows.push({ key: "company", value: { name: business.name, email: business.email, phone: business.phone, address: business.address, gstin: business.gstin, pan: business.pan }, is_public: true });
    if (key === "tax_config") rows.push({ key: "tax", value: { gst_default: Number(tax.staples), gst_enabled: tax.gstEnabled, cess: 0, sugar: Number(tax.sugar), staples: Number(tax.staples), packaged: Number(tax.packaged), invoice_prefix: tax.invoicePrefix }, is_public: true });
    if (key === "commerce_rules") {
      const { data: currentShipping } = await supabase.from("settings").select("value").eq("key", "shipping").maybeSingle();
      const oldShipping = currentShipping?.value && typeof currentShipping.value === "object" && !Array.isArray(currentShipping.value) ? currentShipping.value : {};
      rows.push({ key: "order", value: { split_threshold: Number(commerce.splitThreshold), advance_percent: Number(commerce.advance), payment_timer_minutes: Number(commerce.paymentWindow), cod_enabled: false }, is_public: true });
      rows.push({ key: "shipping", value: { ...oldShipping, free_above: Number(commerce.freeShipAbove), standard: Number(commerce.shippingFlat) } as Json, is_public: true });
    }
    if (key === "security_config") rows.push({ key: "security", value: { ...JSON.parse(JSON.stringify(value)), autoLogout: idleTimeout, session_hours: Math.max(1, Math.ceil(idleTimeout / 60)), password_min: 8 }, is_public: false });
    const { error } = await supabase.from("settings").upsert(rows, { onConflict: "key" });
    if (error) { toast.error(`Could not save ${label.toLowerCase()}`, { description: error.message }); return; }
    if (key === "security_config") {
      setSecurity((current) => ({ ...current, autoLogout: String(idleTimeout) }));
      window.dispatchEvent(new CustomEvent("admin-idle-timeout-updated", { detail: idleTimeout }));
    }
    toast.success(`${label} saved`);
  };

  return (
    <PanelLayout items={adminNav} tone="admin" title="System Settings" subtitle="Platform-wide business configuration">
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Average Vendor Commission" value={`${vendors.length ? (vendors.reduce((sum, vendor) => sum + vendor.commission, 0) / vendors.length).toFixed(1) : "0"}%`} icon={Percent} highlight />
        <StatCard label="Advance on Order" value={`${commerce.advance}%`} icon={ShieldCheck} />
        <StatCard label="Free Freight Above" value={`₹${Number(commerce.freeShipAbove).toLocaleString("en-IN")}`} icon={Truck} />
        <StatCard label="GST on New Products" value={tax.gstEnabled ? "Enabled" : "Disabled"} icon={Building2} />
      </div>

      <Tabs defaultValue="business">
        <TabsList className="mb-4 flex-wrap">
          <TabsTrigger value="business">Business</TabsTrigger>
          <TabsTrigger value="tax">Tax & Invoicing</TabsTrigger>
          <TabsTrigger value="commerce">Commerce Rules</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
        </TabsList>

        <TabsContent value="business">
          <Panel title="Business Profile">
            <div className="grid gap-4 sm:grid-cols-2 xl:max-w-3xl">
              {(
                [
                  ["Legal name", "name"],
                  ["Support email", "email"],
                  ["Support phone", "phone"],
                  ["GSTIN", "gstin"],
                  ["PAN", "pan"],
                ] as const
              ).map(([label, key]) => (
                <div key={key} className="grid gap-1.5">
                  <Label>{label}</Label>
                  <Input value={business[key]} onChange={(e) => setBusiness((b) => ({ ...b, [key]: e.target.value }))} />
                </div>
              ))}
              <div className="grid gap-1.5 sm:col-span-2">
                <Label>Registered address</Label>
                <Textarea rows={3} value={business.address} onChange={(e) => setBusiness((b) => ({ ...b, address: e.target.value }))} />
              </div>
              <Button
                className="bg-navy text-white hover:bg-navy/90 sm:w-fit"
                onClick={() => {
                  if (!business.name.trim() || !business.email.includes("@")) {
                    toast.error("Enter a valid business name and support email");
                    return;
                  }
                  void saveSetting("business_profile", business, "Business profile");
                }}
              >
                <Save className="mr-1 h-4 w-4" /> Save Profile
              </Button>
            </div>
          </Panel>
        </TabsContent>

        <TabsContent value="tax">
          <Panel title="Tax & Invoicing">
            <div className="grid gap-4 sm:grid-cols-2 xl:max-w-3xl">
              <div className="grid gap-1.5"><Label>New sugar product GST default (%)</Label><Input type="number" min="0" max="100" value={tax.sugar} onChange={(e) => setTax((t) => ({ ...t, sugar: e.target.value }))} /></div>
              <div className="grid gap-1.5"><Label>New staple product GST default (%)</Label><Input type="number" min="0" max="100" value={tax.staples} onChange={(e) => setTax((t) => ({ ...t, staples: e.target.value }))} /></div>
              <div className="grid gap-1.5"><Label>New packaged product GST default (%)</Label><Input type="number" min="0" max="100" value={tax.packaged} onChange={(e) => setTax((t) => ({ ...t, packaged: e.target.value }))} /></div>
              <div className="grid gap-1.5"><Label>Invoice number prefix</Label><Input value={tax.invoicePrefix} onChange={(e) => setTax((t) => ({ ...t, invoicePrefix: e.target.value }))} /><p className="text-xs text-slate">Applied to invoice downloads in customer accounts.</p></div>
              <div className="flex items-center justify-between gap-4 rounded-md border border-border p-4 sm:col-span-2">
                <div>
                  <p className="text-sm font-bold text-navy">Apply GST defaults to new products</p>
                  <p className="text-xs text-slate">Rates are copied into new listings and used at checkout. Existing products keep their saved GST rate.</p>
                </div>
                <Switch
                  checked={tax.gstEnabled}
                  onCheckedChange={(v) => {
                    setTax((t) => ({ ...t, gstEnabled: v }));
                  }}
                />
              </div>
              <Button className="bg-navy text-white hover:bg-navy/90 sm:w-fit" onClick={() => void saveSetting("tax_config", tax, "Tax settings")}>
                <Save className="mr-1 h-4 w-4" /> Save Tax Settings
              </Button>
            </div>
          </Panel>
        </TabsContent>

        <TabsContent value="commerce">
          <Panel title="Commerce & Payment Rules">
            <div className="grid gap-4 sm:grid-cols-2 xl:max-w-3xl">
              <div className="rounded-md border border-border p-4 sm:col-span-2"><p className="text-sm font-bold text-navy">Vendor commission rates</p><p className="mt-1 text-xs text-slate">The average above is calculated from saved vendor rates. Set an individual vendor’s commission on the <Link to="/admin/commissions" className="font-semibold text-navy underline">Commissions page</Link>.</p></div>
              <div className="grid gap-1.5"><Label>Advance payment (%)</Label><Input type="number" value={commerce.advance} onChange={(e) => setCommerce((c) => ({ ...c, advance: e.target.value }))} /></div>
              <div className="grid gap-1.5"><Label>Order split threshold (₹)</Label><Input type="number" value={commerce.splitThreshold} onChange={(e) => setCommerce((c) => ({ ...c, splitThreshold: e.target.value }))} /></div>
              <div className="grid gap-1.5"><Label>Payment window (minutes)</Label><Input type="number" value={commerce.paymentWindow} onChange={(e) => setCommerce((c) => ({ ...c, paymentWindow: e.target.value }))} /></div>
              <div className="grid gap-1.5"><Label>Free freight above (₹)</Label><Input type="number" value={commerce.freeShipAbove} onChange={(e) => setCommerce((c) => ({ ...c, freeShipAbove: e.target.value }))} /></div>
              <div className="grid gap-1.5"><Label>Flat freight charge (₹)</Label><Input type="number" value={commerce.shippingFlat} onChange={(e) => setCommerce((c) => ({ ...c, shippingFlat: e.target.value }))} /></div>
              <div className="flex items-center justify-between gap-4 rounded-md border border-border p-4 sm:col-span-2">
                <div>
                  <p className="text-sm font-bold text-navy">Cash on Delivery</p>
                  <p className="text-xs text-slate">Cash on delivery is currently blocked by checkout until a verified collection and reconciliation workflow is configured.</p>
                </div>
                <Switch checked={false} disabled aria-label="Cash on delivery is unavailable" />
              </div>
              <Button
                className="bg-navy text-white hover:bg-navy/90 sm:w-fit"
                onClick={() => {
                  void saveSetting("commerce_rules", commerce, "Commerce rules");
                }}
              >
                <Save className="mr-1 h-4 w-4" /> Save Rules
              </Button>
            </div>
          </Panel>
        </TabsContent>

        <TabsContent value="security">
          <Panel title="Security & Access">
            <div className="grid gap-4 xl:max-w-3xl">
              <p className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">The inactivity timeout is enforced in admin browser sessions. Admin MFA and selectable password-strength rules are not enforced by this app yet.</p>
              <div className="flex items-center justify-between gap-4 rounded-md border border-border p-4">
                <div>
                  <p className="text-sm font-bold text-navy">Two-factor authentication for admins</p>
                  <p className="text-xs text-slate">Policy target only; an MFA enrollment and challenge flow is not connected.</p>
                </div>
                <Switch checked={security.twoFactor} disabled aria-label="Admin MFA enforcement is not implemented" />
              </div>
              <div className="flex items-center justify-between gap-4 rounded-md border border-border p-4">
                <div>
                  <p className="text-sm font-bold text-navy">Mandatory vendor KYC</p>
                  <p className="text-xs text-slate">When enabled, PAN, bank proof and business registration documents must be approved before a vendor can submit or edit listings. Vendors with GSTIN also need an approved GST certificate.</p>
                </div>
                <Switch checked={security.vendorKyc} onCheckedChange={(value) => setSecurity((current) => ({ ...current, vendorKyc: value }))} aria-label="Require vendor KYC approval before catalog changes" />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label>Auto logout after (minutes)</Label>
                  <Input type="number" min={5} max={1440} value={security.autoLogout} onChange={(event) => setSecurity((current) => ({ ...current, autoLogout: event.target.value }))} />
                </div>
                <div className="grid gap-1.5">
                  <Label>Password policy</Label>
                  <Select value={security.passwordPolicy} disabled>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {["Standard", "Strong", "Enterprise"].map((p) => (
                        <SelectItem key={p} value={p}>{p}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <Button className="bg-navy text-white hover:bg-navy/90 sm:w-fit" onClick={() => void saveSetting("security_config", security, "Security settings")}><Save className="mr-1 h-4 w-4" /> Save Security Settings</Button>
            </div>
          </Panel>
        </TabsContent>
      </Tabs>
    </PanelLayout>
  );
}
