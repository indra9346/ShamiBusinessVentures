import { useState } from "react";
import { MapPin } from "lucide-react";
import { toast } from "sonner";
import { branchForPin, useBranches, useShopperPin } from "@/lib/branches";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { UseMyLocationButton } from "@/components/site/UseMyLocationButton";

/**
 * "Delivering to 515201 · Hindupur godown – Change". With PIN matching ON each shopper sees the
 * items, prices and stock of the godown serving their PIN. The PIN comes from what they choose
 * here, else their default address; nobody has to fill in a profile to shop.
 */
export function DeliveryLocationBar() {
  const { branches, features, ready } = useBranches();
  const { addresses, user, cartItems } = useApp();
  const [chosenPin, setPin] = useShopperPin();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");

  if (!ready || !features.branchRouting || user?.role === "admin" || user?.role === "vendor") return null;
  const godowns = branches.filter((branch) => branch.active && !branch.vendorId);
  const addressPin = (addresses.find((address) => address.default) ?? addresses[0])?.pin ?? "";
  const pin = chosenPin || addressPin;
  const godown = branchForPin(branches, pin);
  const served = !!pin && godowns.some((branch) => branch.servesPincodes.includes(pin));

  const apply = (value: string) => {
    const clean = value.replace(/\D/g, "");
    if (clean.length !== 6) { toast.error("Enter a 6-digit PIN code"); return; }
    const next = branchForPin(branches, clean);
    setPin(clean);
    setOpen(false);
    const known = godowns.some((branch) => branch.servesPincodes.includes(clean));
    toast.success(known ? `Showing ${next?.city || next?.name || "your"} godown prices` : "We don't serve this PIN yet", {
      description: known
        ? cartItems.length ? "Cart prices now follow this godown." : undefined
        : `You can still order for pickup from ${next?.name ?? "our default godown"}.`,
    });
  };

  return (
    <>
      <div className="border-b border-stone-200 bg-ivory/70">
        <div className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-1.5 text-xs sm:px-6">
          <MapPin className="h-3.5 w-3.5 shrink-0 text-gold" aria-hidden />
          <p className="min-w-0 flex-1 truncate text-charcoal">
            {pin ? (
              <>
                Delivering to <span className="font-bold text-navy">{pin}</span>
                {" · "}
                {served
                  ? <span>{godown?.city || godown?.name} godown prices</span>
                  : <span className="text-amber-800">not served yet, showing {godown?.city || godown?.name} (pickup)</span>}
              </>
            ) : (
              <>Enter your PIN code to see prices and stock near you</>
            )}
          </p>
          <button
            type="button"
            onClick={() => { setDraft(pin); setOpen(true); }}
            className="shrink-0 rounded-full border border-gold/60 px-2.5 py-0.5 font-semibold text-navy transition-colors hover:bg-gold/15"
          >
            {pin ? "Change" : "Set PIN"}
          </button>
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Your delivery location</DialogTitle>
            <DialogDescription>Prices, items and stock come from the godown that serves your PIN code.</DialogDescription>
          </DialogHeader>
          <form
            className="flex gap-2"
            onSubmit={(event) => { event.preventDefault(); apply(draft); }}
          >
            <Input
              autoFocus
              inputMode="numeric"
              maxLength={6}
              placeholder="6-digit PIN code"
              value={draft}
              onChange={(event) => setDraft(event.target.value.replace(/\D/g, ""))}
              aria-label="PIN code"
            />
            <Button type="submit" className="bg-navy text-white hover:bg-navy/90">Apply</Button>
          </form>
          <UseMyLocationButton
            onLocated={(location) => {
              if (/^\d{6}$/.test(location.pin)) apply(location.pin);
              else toast.error("Could not find a PIN code for your location", { description: "Please type your PIN code." });
            }}
          />
          {addresses.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-semibold text-slate">Your saved addresses</p>
              {addresses.slice(0, 4).map((address) => (
                <button
                  key={address.id}
                  type="button"
                  onClick={() => apply(address.pin)}
                  className="block w-full truncate rounded-md border border-border px-3 py-2 text-left text-sm hover:border-gold"
                >
                  <span className="font-semibold text-navy">{address.label || "Address"}</span> · {address.city} {address.pin}
                </button>
              ))}
            </div>
          )}
          {godowns.length > 1 && (
            <p className="text-xs text-slate">
              We serve from: {godowns.map((branch) => branch.city || branch.name).join(", ")}.
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
