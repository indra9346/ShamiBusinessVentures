import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel } from "@/components/panel/widgets";
import { accountNav } from "@/lib/account-nav";
import { useApp } from "@/lib/store";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/account/profile")({
  head: () => ({
    meta: [
      { title: "My Profile | Shami Business Ventures" },
      { name: "description", content: "Update your name, email and phone number on your Shami account." },
      { property: "og:title", content: "My Profile | Shami" },
      { property: "og:description", content: "Manage your personal account details." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AccountProfile,
});

function AccountProfile() {
  const { user, updateProfile } = useApp();
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [phone, setPhone] = useState(user?.phone ?? "");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!user) return;
    setName(user.name || "");
    setEmail(user.email || "");
    setPhone(user.phone || "");
  }, [user?.id, user?.name, user?.email, user?.phone]);

  return (
    <PanelLayout items={accountNav} tone="customer" title="My Profile" subtitle="Your personal account details">
      <Panel title="Personal Information">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="grid gap-1.5">
            <Label>Full Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label>Email</Label>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label>Phone</Label>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label>Account Type</Label>
            <Input value="Retail & Bulk Buyer" disabled />
          </div>
        </div>
        <div className="mt-6 flex justify-end">
          <Button
            className="bg-navy text-white hover:bg-navy/90"
            disabled={saving}
            onClick={async () => {
              if (!name.trim() || !email.trim()) {
                toast.error("Name and email are required");
                return;
              }
              setSaving(true);
              const saved = await updateProfile({ name: name.trim(), email: email.trim(), phone: phone.trim() });
              setSaving(false);
              if (saved) {
                toast.success("Profile updated successfully");
              }
            }}
          >
            Save Changes
          </Button>
        </div>
      </Panel>
    </PanelLayout>
  );
}
