import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel } from "@/components/panel/widgets";
import { accountNav } from "@/lib/account-nav";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

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
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [prefs, setPrefs] = useState({ order: true, offers: true, sms: false });

  return (
    <PanelLayout items={accountNav} tone="customer" title="Account Settings" subtitle="Security and preferences">
      <div className="grid gap-6 xl:grid-cols-2">
        <Panel title="Change Password">
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label>Current Password</Label>
              <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>New Password</Label>
              <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} />
            </div>
          </div>
          <div className="mt-6 flex justify-end">
            <Button
              className="bg-navy text-white hover:bg-navy/90"
              onClick={() => {
                if (next.length < 6) {
                  toast.error("New password must be at least 6 characters");
                  return;
                }
                setCurrent("");
                setNext("");
                toast.success("Password updated successfully");
              }}
            >
              Update Password
            </Button>
          </div>
        </Panel>

        <Panel title="Notification Preferences">
          <div className="space-y-4">
            {([
              ["order", "Order & delivery updates"],
              ["offers", "Offers and bulk deals"],
              ["sms", "SMS alerts"],
            ] as const).map(([key, label]) => (
              <div key={key} className="flex items-center justify-between">
                <span className="text-sm text-charcoal">{label}</span>
                <Switch
                  checked={prefs[key]}
                  onCheckedChange={(v) => {
                    setPrefs((p) => ({ ...p, [key]: v }));
                    toast.success(`${label} ${v ? "enabled" : "disabled"}`);
                  }}
                />
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </PanelLayout>
  );
}