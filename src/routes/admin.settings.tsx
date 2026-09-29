import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
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

function AdminSettings() {
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
    commission: "8",
    advance: "30",
    splitThreshold: "280000",
    paymentWindow: "20",
    freeShipAbove: "5000",
    shippingFlat: "149",
    codEnabled: false,
  });
  const [security, setSecurity] = useState({ twoFactor: true, vendorKyc: true, autoLogout: "30", passwordPolicy: "Strong" });

  return (
    <PanelLayout items={adminNav} tone="admin" title="System Settings" subtitle="Platform-wide business configuration">
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Platform Commission" value={`${commerce.commission}%`} icon={Percent} highlight />
        <StatCard label="Advance on Order" value={`${commerce.advance}%`} icon={ShieldCheck} />
        <StatCard label="Free Freight Above" value={`₹${Number(commerce.freeShipAbove).toLocaleString("en-IN")}`} icon={Truck} />
        <StatCard label="GST Invoicing" value={tax.gstEnabled ? "Enabled" : "Disabled"} icon={Building2} />
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
                  toast.success("Business profile saved");
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
              <div className="grid gap-1.5"><Label>GST on sugar (%)</Label><Input type="number" value={tax.sugar} onChange={(e) => setTax((t) => ({ ...t, sugar: e.target.value }))} /></div>
              <div className="grid gap-1.5"><Label>GST on staples (%)</Label><Input type="number" value={tax.staples} onChange={(e) => setTax((t) => ({ ...t, staples: e.target.value }))} /></div>
              <div className="grid gap-1.5"><Label>GST on packaged goods (%)</Label><Input type="number" value={tax.packaged} onChange={(e) => setTax((t) => ({ ...t, packaged: e.target.value }))} /></div>
              <div className="grid gap-1.5"><Label>Invoice number prefix</Label><Input value={tax.invoicePrefix} onChange={(e) => setTax((t) => ({ ...t, invoicePrefix: e.target.value }))} /></div>
              <div className="flex items-center justify-between gap-4 rounded-md border border-border p-4 sm:col-span-2">
                <div>
                  <p className="text-sm font-bold text-navy">GST invoicing at checkout</p>
                  <p className="text-xs text-slate">Buyers can add a GSTIN and receive a tax invoice</p>
                </div>
                <Switch
                  checked={tax.gstEnabled}
                  onCheckedChange={(v) => {
                    setTax((t) => ({ ...t, gstEnabled: v }));
                    toast.success(v ? "GST invoicing enabled" : "GST invoicing disabled");
                  }}
                />
              </div>
              <Button className="bg-navy text-white hover:bg-navy/90 sm:w-fit" onClick={() => toast.success("Tax settings saved")}>
                <Save className="mr-1 h-4 w-4" /> Save Tax Settings
              </Button>
            </div>
          </Panel>
        </TabsContent>

        <TabsContent value="commerce">
          <Panel title="Commerce & Payment Rules">
            <div className="grid gap-4 sm:grid-cols-2 xl:max-w-3xl">
              <div className="grid gap-1.5"><Label>Platform commission (%)</Label><Input type="number" value={commerce.commission} onChange={(e) => setCommerce((c) => ({ ...c, commission: e.target.value }))} /></div>
              <div className="grid gap-1.5"><Label>Advance payment (%)</Label><Input type="number" value={commerce.advance} onChange={(e) => setCommerce((c) => ({ ...c, advance: e.target.value }))} /></div>
              <div className="grid gap-1.5"><Label>Order split threshold (₹)</Label><Input type="number" value={commerce.splitThreshold} onChange={(e) => setCommerce((c) => ({ ...c, splitThreshold: e.target.value }))} /></div>
              <div className="grid gap-1.5"><Label>Payment window (minutes)</Label><Input type="number" value={commerce.paymentWindow} onChange={(e) => setCommerce((c) => ({ ...c, paymentWindow: e.target.value }))} /></div>
              <div className="grid gap-1.5"><Label>Free freight above (₹)</Label><Input type="number" value={commerce.freeShipAbove} onChange={(e) => setCommerce((c) => ({ ...c, freeShipAbove: e.target.value }))} /></div>
              <div className="grid gap-1.5"><Label>Flat freight charge (₹)</Label><Input type="number" value={commerce.shippingFlat} onChange={(e) => setCommerce((c) => ({ ...c, shippingFlat: e.target.value }))} /></div>
              <div className="flex items-center justify-between gap-4 rounded-md border border-border p-4 sm:col-span-2">
                <div>
                  <p className="text-sm font-bold text-navy">Cash on Delivery</p>
                  <p className="text-xs text-slate">Disabled for bulk freight orders as per policy</p>
                </div>
                <Switch
                  checked={commerce.codEnabled}
                  onCheckedChange={(v) => {
                    setCommerce((c) => ({ ...c, codEnabled: v }));
                    toast.success(v ? "Cash on Delivery enabled" : "Cash on Delivery disabled");
                  }}
                />
              </div>
              <Button
                className="bg-navy text-white hover:bg-navy/90 sm:w-fit"
                onClick={() => {
                  if (Number(commerce.commission) < 0 || Number(commerce.commission) > 40) {
                    toast.error("Commission must be between 0% and 40%");
                    return;
                  }
                  toast.success("Commerce rules saved");
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
              <div className="flex items-center justify-between gap-4 rounded-md border border-border p-4">
                <div>
                  <p className="text-sm font-bold text-navy">Two-factor authentication for admins</p>
                  <p className="text-xs text-slate">OTP verification on every admin sign-in</p>
                </div>
                <Switch checked={security.twoFactor} onCheckedChange={(v) => { setSecurity((s) => ({ ...s, twoFactor: v })); toast.success(v ? "Two-factor enabled" : "Two-factor disabled"); }} />
              </div>
              <div className="flex items-center justify-between gap-4 rounded-md border border-border p-4">
                <div>
                  <p className="text-sm font-bold text-navy">Mandatory vendor KYC</p>
                  <p className="text-xs text-slate">Vendors must clear GST and bank verification before listing</p>
                </div>
                <Switch checked={security.vendorKyc} onCheckedChange={(v) => { setSecurity((s) => ({ ...s, vendorKyc: v })); toast.success(v ? "Vendor KYC required" : "Vendor KYC optional"); }} />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label>Auto logout after (minutes)</Label>
                  <Input type="number" value={security.autoLogout} onChange={(e) => setSecurity((s) => ({ ...s, autoLogout: e.target.value }))} />
                </div>
                <div className="grid gap-1.5">
                  <Label>Password policy</Label>
                  <Select value={security.passwordPolicy} onValueChange={(v) => setSecurity((s) => ({ ...s, passwordPolicy: v }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {["Standard", "Strong", "Enterprise"].map((p) => (
                        <SelectItem key={p} value={p}>{p}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <Button className="bg-navy text-white hover:bg-navy/90 sm:w-fit" onClick={() => toast.success("Security settings saved")}>
                <ShieldCheck className="mr-1 h-4 w-4" /> Save Security Settings
              </Button>
            </div>
          </Panel>
        </TabsContent>
      </Tabs>
    </PanelLayout>
  );
}
