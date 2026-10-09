import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel } from "@/components/panel/widgets";
import { vendorNav } from "@/lib/panel-nav";
import { useVendorScope } from "@/lib/store";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export const Route = createFileRoute("/vendor/settings")({ component: VendorSettings });
type Settings = { store: { displayName: string; supportEmail: string; description: string; autoAccept: boolean }; shipping: { freeShipThreshold: string; deliveryTime: string; pickupAddress: string }; payments: { codEnabled: boolean }; notifications: { email: boolean; sms: boolean; orderAlerts: boolean }; security: { twoFactorPreference: boolean } };
const initial: Settings = {
  store: { displayName: "", supportEmail: "", description: "", autoAccept: false },
  shipping: { freeShipThreshold: "5000", deliveryTime: "2 to 4 business days", pickupAddress: "" },
  payments: { codEnabled: false },
  notifications: { email: false, sms: false, orderAlerts: true },
  security: { twoFactorPreference: false },
};

function VendorSettings() {
  const { vendorId } = useVendorScope();
  const [settings, setSettings] = useState<Settings>(initial);
  const [newPassword, setNewPassword] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    void supabase.from("vendor_settings").select("key,value").eq("vendor_id", vendorId).then(({ data, error }) => {
      if (!active || error) { if (error) console.error("Could not load vendor settings", error.message); return; }
      const next = { ...initial };
      for (const row of data ?? []) if (row.key in next && row.value && typeof row.value === "object" && !Array.isArray(row.value)) {
        const key = row.key as keyof Settings;
        next[key] = { ...next[key], ...row.value } as never;
      }
      setSettings(next);
    });
    return () => { active = false; };
  }, [vendorId]);
  const setSection = <K extends keyof Settings>(key: K, patch: Partial<Settings[K]>) => setSettings((s) => ({ ...s, [key]: { ...s[key], ...patch } }));
  const save = async <K extends keyof Settings>(key: K, label: string) => {
    setSaving(true);
    const { error } = await supabase.from("vendor_settings").upsert({ vendor_id: vendorId, key, value: JSON.parse(JSON.stringify(settings[key])) as Json, updated_at: new Date().toISOString() }, { onConflict: "vendor_id,key" });
    setSaving(false);
    if (error) { toast.error(`Could not save ${label.toLowerCase()}`, { description: error.message }); return; }
    toast.success(`${label} saved`);
  };
  const updatePassword = async () => {
    if (newPassword.length < 8) { toast.error("Use a password with at least 8 characters"); return; }
    setSaving(true); const { error } = await supabase.auth.updateUser({ password: newPassword }); setSaving(false);
    if (error) { toast.error("Could not update password", { description: error.message }); return; }
    setNewPassword(""); toast.success("Password updated");
  };
  return <PanelLayout items={vendorNav} tone="vendor" title="Settings" subtitle="Configure store and account preferences">
    <Tabs defaultValue="store"><TabsList className="flex-wrap"><TabsTrigger value="store">Store</TabsTrigger><TabsTrigger value="shipping">Shipping</TabsTrigger><TabsTrigger value="payments">Payments</TabsTrigger><TabsTrigger value="notifications">Notifications</TabsTrigger><TabsTrigger value="security">Security</TabsTrigger></TabsList>
      <TabsContent value="store" className="mt-4"><Panel title="Store Settings"><div className="grid gap-4 lg:grid-cols-2"><div className="grid gap-1.5"><Label>Store Display Name</Label><Input value={settings.store.displayName} onChange={e=>setSection("store",{displayName:e.target.value})}/></div><div className="grid gap-1.5"><Label>Support Email</Label><Input type="email" value={settings.store.supportEmail} onChange={e=>setSection("store",{supportEmail:e.target.value})}/></div><div className="grid gap-1.5 lg:col-span-2"><Label>Store Description</Label><Textarea rows={3} value={settings.store.description} onChange={e=>setSection("store",{description:e.target.value})}/></div><div className="flex items-center justify-between rounded-lg border px-4 py-3 lg:col-span-2"><div><p className="text-sm font-semibold">Auto-accept new orders</p><p className="text-xs text-slate">Preference saved for your account. Order processing still follows platform rules.</p></div><Switch checked={settings.store.autoAccept} onCheckedChange={v=>setSection("store",{autoAccept:v})}/></div></div><div className="mt-6 flex justify-end"><Button disabled={saving} className="bg-navy text-white" onClick={()=>void save("store","Store settings")}>Save Store Settings</Button></div></Panel></TabsContent>
      <TabsContent value="shipping" className="mt-4"><Panel title="Shipping Settings"><div className="grid gap-4 lg:grid-cols-2"><div className="grid gap-1.5"><Label>Free Shipping Threshold (₹)</Label><Input type="number" min="0" value={settings.shipping.freeShipThreshold} onChange={e=>setSection("shipping",{freeShipThreshold:e.target.value})}/></div><div className="grid gap-1.5"><Label>Standard Delivery Time</Label><Input value={settings.shipping.deliveryTime} onChange={e=>setSection("shipping",{deliveryTime:e.target.value})}/></div><div className="grid gap-1.5 lg:col-span-2"><Label>Pickup Address</Label><Textarea rows={2} value={settings.shipping.pickupAddress} onChange={e=>setSection("shipping",{pickupAddress:e.target.value})}/></div></div><div className="mt-6 flex justify-end"><Button disabled={saving} className="bg-navy text-white" onClick={()=>void save("shipping","Shipping settings")}>Save Shipping Settings</Button></div></Panel></TabsContent>
      <TabsContent value="payments" className="mt-4"><Panel title="Payment Settings"><p className="mb-4 text-sm text-slate">Bank details must be verified through vendor onboarding. They are not editable from this screen.</p><div className="flex items-center justify-between rounded-lg border border-border bg-ivory/40 px-4 py-3"><div><p className="text-sm font-semibold text-navy">Cash on Delivery (Disabled)</p><p className="text-xs text-slate">Cash on delivery is not accepted on Shami Business Ventures. All orders are processed via online prepaid methods (UPI, Cards, Net Banking).</p></div><Switch checked={false} disabled aria-label="Cash on delivery is disabled" /></div><div className="mt-6 flex justify-end"><Button disabled={saving} className="bg-navy text-white" onClick={()=>void save("payments","Payment preferences")}>Save Payment Settings</Button></div></Panel></TabsContent>
      <TabsContent value="notifications" className="mt-4"><Panel title="Notification Preferences"><p className="mb-4 text-sm text-slate">These are saved delivery preferences. Automatic email and SMS sending requires configured delivery providers; order alerts are available only when written to your in-app inbox.</p><div className="space-y-3">{([["email","Email Notifications","Preference saved; outbound email delivery is not configured."],["sms","SMS Notifications","Preference saved; an SMS provider is not configured."],["orderAlerts","New Order Alerts","Preference saved; alerts appear in the in-app inbox when created."]] as const).map(([key,title,desc])=><div key={key} className="flex items-center justify-between rounded-lg border px-4 py-3"><div><p className="text-sm font-semibold">{title}</p><p className="text-xs text-slate">{desc}</p></div><Switch checked={settings.notifications[key]} onCheckedChange={v=>setSection("notifications",{[key]:v})}/></div>)}</div><div className="mt-6 flex justify-end"><Button disabled={saving} className="bg-navy text-white" onClick={()=>void save("notifications","Notification preferences")}>Save Notification Settings</Button></div></Panel></TabsContent>
      <TabsContent value="security" className="mt-4"><Panel title="Security Settings"><p className="mb-4 text-sm text-slate">Password changes update your authenticated account. Two-factor enrollment is not enabled here because an MFA challenge flow has not been configured.</p><div className="grid gap-1.5 sm:max-w-md"><Label>New Password</Label><Input type="password" autoComplete="new-password" value={newPassword} onChange={e=>setNewPassword(e.target.value)}/></div><Button className="mt-3 bg-navy text-white" disabled={saving} onClick={()=>void updatePassword()}>Update Password</Button><div className="mt-6 flex items-center justify-between rounded-lg border px-4 py-3"><div><p className="text-sm font-semibold">Two-factor setup preference</p><p className="text-xs text-slate">This preference does not enforce MFA; enrollment requires provider setup.</p></div><Switch checked={settings.security.twoFactorPreference} onCheckedChange={v=>setSection("security",{twoFactorPreference:v})}/></div><div className="mt-4 flex justify-end"><Button disabled={saving} className="bg-navy text-white" onClick={()=>void save("security","Security preferences")}>Save Security Settings</Button></div></Panel></TabsContent>
    </Tabs>
  </PanelLayout>;
}
