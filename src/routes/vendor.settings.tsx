import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel } from "@/components/panel/widgets";
import { vendorNav } from "@/lib/panel-nav";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export const Route = createFileRoute("/vendor/settings")({
  head: () => ({
    meta: [
      { title: "Settings | Shami Vendor Panel" },
      { name: "description", content: "Configure store, shipping, payment and notification settings." },
      { property: "og:title", content: "Vendor Settings | Shami" },
      { property: "og:description", content: "Account and store settings for Shami marketplace vendors." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: VendorSettings,
});

function VendorSettings() {
  const [autoAccept, setAutoAccept] = useState(true);
  const [codEnabled, setCodEnabled] = useState(true);
  const [freeShipThreshold, setFreeShipThreshold] = useState("5000");
  const [emailNotif, setEmailNotif] = useState(true);
  const [smsNotif, setSmsNotif] = useState(false);
  const [orderAlerts, setOrderAlerts] = useState(true);
  const [twoFactor, setTwoFactor] = useState(false);

  const save = (section: string) => toast.success(`${section} settings saved`);

  return (
    <PanelLayout items={vendorNav} tone="vendor" title="Settings" subtitle="Configure your vendor account preferences">
      <Tabs defaultValue="store">
        <TabsList className="flex-wrap">
          <TabsTrigger value="store">Store</TabsTrigger>
          <TabsTrigger value="shipping">Shipping</TabsTrigger>
          <TabsTrigger value="payments">Payments</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
        </TabsList>

        <TabsContent value="store" className="mt-4">
          <Panel title="Store Settings">
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="grid gap-1.5">
                <Label>Store Display Name</Label>
                <Input defaultValue="Shami Sugar Mills" />
              </div>
              <div className="grid gap-1.5">
                <Label>Support Email</Label>
                <Input defaultValue="support@shamisugar.in" />
              </div>
              <div className="grid gap-1.5 lg:col-span-2">
                <Label>Store Description</Label>
                <Textarea rows={3} defaultValue="Trusted bulk sugar manufacturer supplying institutional and retail buyers across Karnataka." />
              </div>
              <div className="flex items-center justify-between rounded-lg border border-border px-4 py-3 lg:col-span-2">
                <div>
                  <p className="text-sm font-semibold text-navy">Auto-accept new orders</p>
                  <p className="text-xs text-slate">New orders move directly to "Accepted" status.</p>
                </div>
                <Switch checked={autoAccept} onCheckedChange={setAutoAccept} />
              </div>
            </div>
            <div className="mt-6 flex justify-end">
              <Button className="bg-navy text-white hover:bg-navy/90" onClick={() => save("Store")}>Save Store Settings</Button>
            </div>
          </Panel>
        </TabsContent>

        <TabsContent value="shipping" className="mt-4">
          <Panel title="Shipping Settings">
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="grid gap-1.5">
                <Label>Free Shipping Threshold (₹)</Label>
                <Input type="number" value={freeShipThreshold} onChange={(e) => setFreeShipThreshold(e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label>Standard Delivery Time</Label>
                <Input defaultValue="2 to 4 business days" />
              </div>
              <div className="grid gap-1.5 lg:col-span-2">
                <Label>Pickup Address</Label>
                <Textarea rows={2} defaultValue="Plot 14, Industrial Estate, Belagavi, Karnataka 590010" />
              </div>
            </div>
            <div className="mt-6 flex justify-end">
              <Button className="bg-navy text-white hover:bg-navy/90" onClick={() => save("Shipping")}>Save Shipping Settings</Button>
            </div>
          </Panel>
        </TabsContent>

        <TabsContent value="payments" className="mt-4">
          <Panel title="Payment Settings">
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="grid gap-1.5">
                <Label>Bank Account Number</Label>
                <Input defaultValue="••••••••4217" disabled />
              </div>
              <div className="grid gap-1.5">
                <Label>IFSC Code</Label>
                <Input defaultValue="HDFC0001234" disabled />
              </div>
              <div className="flex items-center justify-between rounded-lg border border-border px-4 py-3 lg:col-span-2">
                <div>
                  <p className="text-sm font-semibold text-navy">Accept Cash on Delivery</p>
                  <p className="text-xs text-slate">Allow customers to pay COD for your products.</p>
                </div>
                <Switch checked={codEnabled} onCheckedChange={setCodEnabled} />
              </div>
            </div>
            <div className="mt-6 flex justify-end">
              <Button className="bg-navy text-white hover:bg-navy/90" onClick={() => save("Payment")}>Save Payment Settings</Button>
            </div>
          </Panel>
        </TabsContent>

        <TabsContent value="notifications" className="mt-4">
          <Panel title="Notification Preferences">
            <div className="space-y-3">
              <div className="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                <div>
                  <p className="text-sm font-semibold text-navy">Email Notifications</p>
                  <p className="text-xs text-slate">Receive order and payout updates by email.</p>
                </div>
                <Switch checked={emailNotif} onCheckedChange={setEmailNotif} />
              </div>
              <div className="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                <div>
                  <p className="text-sm font-semibold text-navy">SMS Notifications</p>
                  <p className="text-xs text-slate">Get an SMS for critical order updates.</p>
                </div>
                <Switch checked={smsNotif} onCheckedChange={setSmsNotif} />
              </div>
              <div className="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                <div>
                  <p className="text-sm font-semibold text-navy">New Order Alerts</p>
                  <p className="text-xs text-slate">Instant alert whenever a new order is placed.</p>
                </div>
                <Switch checked={orderAlerts} onCheckedChange={setOrderAlerts} />
              </div>
            </div>
            <div className="mt-6 flex justify-end">
              <Button className="bg-navy text-white hover:bg-navy/90" onClick={() => save("Notification")}>Save Notification Settings</Button>
            </div>
          </Panel>
        </TabsContent>

        <TabsContent value="security" className="mt-4">
          <Panel title="Security Settings">
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="grid gap-1.5">
                <Label>Current Password</Label>
                <Input type="password" placeholder="••••••••" />
              </div>
              <div className="grid gap-1.5">
                <Label>New Password</Label>
                <Input type="password" placeholder="••••••••" />
              </div>
              <div className="flex items-center justify-between rounded-lg border border-border px-4 py-3 lg:col-span-2">
                <div>
                  <p className="text-sm font-semibold text-navy">Two-Factor Authentication</p>
                  <p className="text-xs text-slate">Require an OTP in addition to your password at login.</p>
                </div>
                <Switch checked={twoFactor} onCheckedChange={setTwoFactor} />
              </div>
            </div>
            <div className="mt-6 flex justify-end">
              <Button className="bg-navy text-white hover:bg-navy/90" onClick={() => save("Security")}>Save Security Settings</Button>
            </div>
          </Panel>
        </TabsContent>
      </Tabs>
    </PanelLayout>
  );
}
