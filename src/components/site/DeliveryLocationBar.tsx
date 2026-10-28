import { useEffect, useState } from "react";
import { ChevronDown, MapPin } from "lucide-react";
import { toast } from "sonner";
import { useBranches, useShopperPin } from "@/lib/branches";
import { isOutsideServiceArea, OPEN_PIN_DIALOG_EVENT, OUT_OF_AREA_EVENT, servingGodownOf } from "@/lib/godown-rules";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { UseMyLocationButton } from "@/components/site/UseMyLocationButton";
import { NotInYourArea } from "@/components/site/NotInYourArea";
import { cn } from "@/lib/utils";

/**
 * "📍 Delivering to 577522 · Challakere godown prices ⌄" (tap to change). With PIN matching ON each
 * shopper sees the items, prices and stock of the godown serving their PIN, which comes from what
 * they choose here, else their default address. Only the PIN codes an admin added to a godown can
 * buy: anywhere else shows "We're not in your area yet" with ways to ask for the service.
 */
export function DeliveryLocationBar() {
  const { branches, features, ready } = useBranches();
  const { addresses, user, cartItems } = useApp();
  const [chosenPin, setPin] = useShopperPin();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [blockedPin, setBlockedPin] = useState("");
  const [hidden, setHidden] = useState(false);

  const addressPin = (addresses.find((address) => address.default) ?? addresses[0])?.pin ?? "";
  const pin = chosenPin || addressPin;
  const active = ready && features.branchRouting && user?.role !== "admin" && user?.role !== "vendor";

  useEffect(() => {
    const openDialog = () => { setBlockedPin(""); setDraft(""); setOpen(true); };
    const outOfArea = (event: Event) => setBlockedPin((event as CustomEvent<{ pin: string }>).detail?.pin || "-");
    window.addEventListener(OPEN_PIN_DIALOG_EVENT, openDialog);
    window.addEventListener(OUT_OF_AREA_EVENT, outOfArea);
    return () => {
      window.removeEventListener(OPEN_PIN_DIALOG_EVENT, openDialog);
      window.removeEventListener(OUT_OF_AREA_EVENT, outOfArea);
    };
  }, []);
  useEffect(() => { setHidden(false); }, [pin]);

  if (!active) return null;
  const godown = servingGodownOf(branches, pin);
  const outside = isOutsideServiceArea(branches, features.branchRouting, pin);

  const apply = (value: string) => {
    const clean = value.replace(/\D/g, "");
    if (clean.length !== 6) { toast.error("Enter a 6-digit PIN code"); return; }
    setPin(clean);
    setOpen(false);
    const next = servingGodownOf(branches, clean);
    if (next) {
      toast.success(`Showing ${next.city || next.name} godown prices`, { description: cartItems.length ? "Cart prices now follow this godown." : undefined });
    }
  };

  return (
    <>
      <div className="border-b border-stone-200 bg-ivory/70">
        <div className="mx-auto max-w-7xl px-4 py-1.5 sm:px-6">
          <button
            type="button"
            onClick={() => { setDraft(pin); setOpen(true); }}
            aria-label={pin ? `Delivery PIN ${pin}. Change` : "Set your delivery PIN code"}
            className={cn(
              "group inline-flex max-w-full items-center gap-1.5 rounded-full px-2 py-1 text-left text-xs transition-colors hover:bg-gold/15",
              outside && "bg-rose-50 hover:bg-rose-100",
            )}
          >
            <MapPin className={cn("h-3.5 w-3.5 shrink-0", outside ? "text-rose-600" : "text-gold")} aria-hidden />
            <span className="min-w-0 truncate text-charcoal">
              {!pin ? (
                <>Enter your PIN code to see prices and stock near you</>
              ) : outside ? (
                <>Not delivering yet to <span className="font-bold text-rose-700">{pin}</span></>
              ) : (
                <>Delivering to <span className="font-bold text-navy">{pin}</span> · {godown?.city || godown?.name} godown prices</>
              )}
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-navy transition-transform group-hover:translate-y-px" aria-hidden />
          </button>
        </div>
      </div>

      {/* Outside the service area: the full "not in your area" panel on every shop page (can be hidden). */}
      {outside && !hidden && (
        <div className="mx-auto max-w-7xl px-4 pt-4 sm:px-6">
          <NotInYourArea pin={pin} />
          <div className="mt-1 text-right">
            <button type="button" onClick={() => setHidden(true)} className="text-[11px] font-semibold text-slate underline">Just browsing, hide this</button>
          </div>
        </div>
      )}

      {/* Someone outside the area tried to buy. */}
      <Dialog open={!!blockedPin} onOpenChange={(next) => { if (!next) setBlockedPin(""); }}>
        <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto p-0">
          <DialogHeader className="sr-only">
            <DialogTitle>We're not in your area yet</DialogTitle>
            <DialogDescription>Orders can't be placed for this PIN code yet.</DialogDescription>
          </DialogHeader>
          {blockedPin && <NotInYourArea pin={blockedPin === "-" ? pin : blockedPin} className="border-0 shadow-none" />}
        </DialogContent>
      </Dialog>

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
              {addresses.slice(0, 4).map((address) => {
                const served = !isOutsideServiceArea(branches, features.branchRouting, address.pin);
                return (
                  <button
                    key={address.id}
                    type="button"
                    onClick={() => apply(address.pin)}
                    className="flex w-full items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-left text-sm hover:border-gold"
                  >
                    <span className="min-w-0 truncate"><span className="font-semibold text-navy">{address.label || "Address"}</span> · {address.city} {address.pin}</span>
                    {!served && <span className="shrink-0 rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-bold text-rose-700">Not served yet</span>}
                  </button>
                );
              })}
            </div>
          )}
          <p className="text-xs text-slate">
            We serve around: {branches.filter((b) => b.active && !b.vendorId && b.servesPincodes.length).map((b) => b.city || b.name).join(", ") || "our godowns"}.
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}
