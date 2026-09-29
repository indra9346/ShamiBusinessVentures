import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Building2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel, StatusBadge } from "@/components/panel/widgets";
import { vendorNav } from "@/lib/panel-nav";
import { useApp, useVendorScope } from "@/lib/store";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/vendor/profile")({
  head: () => ({
    meta: [
      { title: "Store Profile | Shami Vendor Panel" },
      { name: "description", content: "Manage your vendor business profile and KYC documents." },
      { property: "og:title", content: "Vendor Profile | Shami" },
      { property: "og:description", content: "Business profile management for Shami marketplace vendors." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: VendorProfile,
});

const kycDocs = [
  { name: "GST Certificate", status: "Verified" },
  { name: "PAN Card", status: "Verified" },
  { name: "Bank Passbook / Cancelled Cheque", status: "Verified" },
  { name: "FSSAI Licence", status: "Pending" },
];

function VendorProfile() {
  const { vendors } = useApp();
  const { vendorId } = useVendorScope();
  const vendor = vendors.find((v) => v.id === vendorId)!;

  const [business, setBusiness] = useState(vendor.business);
  const [owner, setOwner] = useState(vendor.owner);
  const [email, setEmail] = useState(vendor.email);
  const [phone, setPhone] = useState(vendor.phone);
  const [city, setCity] = useState(vendor.city);

  return (
    <PanelLayout items={vendorNav} tone="vendor" title="Store Profile" subtitle="Manage your business details">
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Panel title="Business Details">
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Business Name</Label>
              <Input value={business} onChange={(e) => setBusiness(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Owner Name</Label>
              <Input value={owner} onChange={(e) => setOwner(e.target.value)} />
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
              <Label>City</Label>
              <Input value={city} onChange={(e) => setCity(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>GST Number</Label>
              <Input value={vendor.gst} disabled />
            </div>
            <div className="grid gap-1.5">
              <Label>Bank Account</Label>
              <Input value={vendor.bank} disabled />
            </div>
            <div className="grid gap-1.5">
              <Label>Commission Rate</Label>
              <Input value={`${vendor.commission}%`} disabled />
            </div>
            <div className="grid gap-1.5">
              <Label>Rating</Label>
              <Input value={`${vendor.rating} / 5`} disabled />
            </div>
            <div className="grid gap-1.5">
              <Label>Joined</Label>
              <Input value={vendor.joined} disabled />
            </div>
          </div>
          <div className="mt-6 flex justify-end">
            <Button
              className="bg-navy text-white hover:bg-navy/90"
              onClick={() => toast.success("Store profile updated successfully")}
            >
              Save Changes
            </Button>
          </div>
        </Panel>

        <div className="space-y-6">
          <Panel title="Store Logo">
            <div className="grid place-items-center gap-3 rounded-lg border border-dashed border-border py-8">
              <span className="grid h-16 w-16 place-items-center rounded-full bg-navy/6 text-navy">
                <Building2 className="h-8 w-8" />
              </span>
              <p className="text-xs text-slate">{business}</p>
              <Button variant="outline" size="sm" onClick={() => toast.success("Logo upload not required in demo mode")}>
                Upload Logo
              </Button>
            </div>
          </Panel>
          <Panel title="KYC Documents">
            <div className="space-y-3">
              {kycDocs.map((d) => (
                <div key={d.name} className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-slate" />
                    <span className="text-sm text-charcoal">{d.name}</span>
                  </div>
                  <StatusBadge status={d.status} />
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </div>
    </PanelLayout>
  );
}
