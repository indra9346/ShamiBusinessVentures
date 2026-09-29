import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { MapPin } from "lucide-react";
import { toast } from "sonner";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel } from "@/components/panel/widgets";
import { accountNav } from "@/lib/account-nav";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export const Route = createFileRoute("/account/addresses")({
  head: () => ({
    meta: [
      { title: "Saved Addresses | Shami Business Ventures" },
      { name: "description", content: "Manage your delivery and warehouse addresses for faster checkout." },
      { property: "og:title", content: "Saved Addresses | Shami" },
      { property: "og:description", content: "Add, edit and set default delivery addresses." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AccountAddresses,
});

const blank = { label: "", name: "", phone: "", line: "", city: "", state: "Karnataka", pin: "", landmark: "" };

function AccountAddresses() {
  const { addresses, addAddress, updateAddress, deleteAddress, setDefaultAddress } = useApp();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState(blank);

  const set = (k: keyof typeof blank, v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <PanelLayout items={accountNav} tone="customer" title="Saved Addresses" subtitle="Delivery locations on your account">
      <Panel
        title={`${addresses.length} Saved Addresses`}
        action={
          <Button
            size="sm"
            className="bg-navy text-white hover:bg-navy/90"
            onClick={() => {
              setEditing(null);
              setForm(blank);
              setOpen(true);
            }}
          >
            Add New Address
          </Button>
        }
      >
        <div className="grid gap-4 lg:grid-cols-2">
          {addresses.map((a) => (
            <div key={a.id} className="rounded-lg border border-border p-4">
              <div className="flex items-center justify-between">
                <p className="flex items-center gap-2 font-semibold text-navy">
                  <MapPin className="h-4 w-4 text-gold" /> {a.label}
                </p>
                {a.default && (
                  <span className="rounded-full bg-gold/15 px-2 py-0.5 text-[11px] font-bold text-gold">Default</span>
                )}
              </div>
              <p className="mt-2 text-sm font-medium text-charcoal">{a.name} · {a.phone}</p>
              <p className="mt-1 text-sm text-slate">{a.line}, {a.city}, {a.state} — {a.pin}</p>
              {a.landmark && <p className="text-xs text-slate">Landmark: {a.landmark}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setEditing(a.id);
                    setForm({
                      label: a.label, name: a.name, phone: a.phone, line: a.line,
                      city: a.city, state: a.state, pin: a.pin, landmark: a.landmark ?? "",
                    });
                    setOpen(true);
                  }}
                >
                  Edit
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={a.default}
                  onClick={() => {
                    setDefaultAddress(a.id);
                    toast.success(`${a.label} set as default address`);
                  }}
                >
                  Set Default
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    deleteAddress(a.id);
                    toast.success(`${a.label} address removed`);
                  }}
                >
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Address" : "Add New Address"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            {([
              ["label", "Label"], ["name", "Full Name"], ["phone", "Phone"], ["line", "Address Line"],
              ["city", "City"], ["state", "State"], ["pin", "PIN Code"], ["landmark", "Landmark"],
            ] as const).map(([k, label]) => (
              <div key={k} className="grid gap-1.5">
                <Label>{label}</Label>
                <Input value={form[k]} onChange={(e) => set(k, e.target.value)} />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              className="bg-navy text-white hover:bg-navy/90"
              onClick={() => {
                if (!form.label.trim() || !form.line.trim() || !form.city.trim() || form.pin.length !== 6) {
                  toast.error("Fill label, address, city and a valid 6-digit PIN");
                  return;
                }
                if (editing) {
                  updateAddress(editing, form);
                  toast.success("Address updated");
                } else {
                  addAddress({ id: `A${Date.now()}`, ...form, default: addresses.length === 0 });
                  toast.success("New address added");
                }
                setOpen(false);
              }}
            >
              {editing ? "Save Changes" : "Add Address"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PanelLayout>
  );
}