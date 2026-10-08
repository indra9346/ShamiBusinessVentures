import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel } from "@/components/panel/widgets";
import { accountNav } from "@/lib/account-nav";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useApp } from "@/lib/store";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/account/settings")({
  head: () => ({
    meta: [
      { title: "Account Settings | Shami Business Ventures" },
      { name: "description", content: "Change your password and manage notification preferences." },
      { property: "og:title", content: "Account Settings | Shami" },
      { property: "og:description", content: "Security and notification preferences." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AccountSettings,
});

function AccountSettings() {
  const { user } = useApp();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [prefs, setPrefs] = useState({ order: true, offers: true, sms: false });
  const [loadingPrefs, setLoadingPrefs] = useState(true);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);

  useEffect(() => {
    if (!user?.id) return;
    let active = true;
    void supabase.from("customer_settings").select("value").eq("user_id", user.id).eq("key", "notifications").maybeSingle().then(({ data, error }) => {
      if (!active) return;
      if (error) toast.error("Could not load notification preferences", { description: error.message });
      else if (data?.value && typeof data.value === "object" && !Array.isArray(data.value)) {
        const value = data.value as Record<string, unknown>;
        setPrefs((old) => ({
          order: typeof value["order"] === "boolean" ? value["order"] : old.order,
          offers: typeof value["offers"] === "boolean" ? value["offers"] : old.offers,
          sms: typeof value["sms"] === "boolean" ? value["sms"] : old.sms,
        }));
      }
      setLoadingPrefs(false);
    });
    return () => { active = false; };
  }, [user?.id]);

  const updatePassword = async () => {
    if (next.length < 8) { toast.error("New password must be at least 8 characters"); return; }
    setSavingPassword(true);
    if (current.trim()) {
      const { data: { user: authUser }, error: authError } = await supabase.auth.getUser();
      const email = authUser?.email ?? user?.email;
      if (authError || !email) {
        setSavingPassword(false);
        toast.error("Could not verify your current account session");
        return;
      }
      const { error: reauthError } = await supabase.auth.signInWithPassword({ email, password: current });
      if (reauthError) {
        setSavingPassword(false);
        toast.error("Current password could not be verified", { description: reauthError.message });
        return;
      }
    }
    const { error } = await supabase.auth.updateUser({ password: next });
    setSavingPassword(false);
    if (error) { toast.error("Could not update password", { description: error.message }); return; }
    setCurrent(""); setNext(""); toast.success("Password updated successfully");
  };

  const savePreferences = async () => {
    if (!user?.id) { toast.error("Sign in to save notification preferences"); return; }
    setSavingPrefs(true);
    const { error } = await supabase.from("customer_settings").upsert(
      { user_id: user.id, key: "notifications", value: prefs },
      { onConflict: "user_id,key" },
    );
    setSavingPrefs(false);
    if (error) { toast.error("Could not save notification preferences", { description: error.message }); return; }
    toast.success("Notification preferences saved");
  };

  return (
    <PanelLayout items={accountNav} tone="customer" title="Account Settings" subtitle="Security and preferences">
      <div className="grid gap-6 xl:grid-cols-2">
        <Panel title="Change Password">
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label>Current Password (optional for one-time-code accounts)</Label>
              <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>New Password</Label>
              <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
            </div>
          </div>
          <div className="mt-6 flex justify-end">
            <Button
              className="bg-navy text-white hover:bg-navy/90"
              disabled={savingPassword}
              onClick={() => void updatePassword()}
            >
              {savingPassword ? "Updating…" : "Update Password"}
            </Button>
          </div>
        </Panel>

        <Panel title="Notification Preferences">
          <p className="mb-4 text-sm text-slate">Preferences are saved to your account. Email and SMS delivery require provider setup. In-app order notices remain available independently of these delivery preferences.</p>
          <div className="space-y-4">
            {([
              ["order", "Order & delivery updates"],
              ["offers", "Offers and bulk deals"],
              ["sms", "SMS alerts"],
            ] as const).map(([key, label]) => (
              <div key={key} className="flex items-center justify-between">
                <span className="text-sm text-charcoal">{label}</span>
                <Switch disabled={loadingPrefs || savingPrefs}
                  checked={prefs[key]}
                  onCheckedChange={(v) => setPrefs((p) => ({ ...p, [key]: v }))}
                />
              </div>
            ))}
          </div>
          <div className="mt-6 flex justify-end"><Button disabled={loadingPrefs || savingPrefs} className="bg-navy text-white" onClick={() => void savePreferences()}>{savingPrefs ? "Saving…" : "Save Preferences"}</Button></div>
        </Panel>
      </div>
    </PanelLayout>
  );
}
