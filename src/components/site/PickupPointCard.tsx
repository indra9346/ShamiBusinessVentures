import { MapPin, Navigation, Phone, Warehouse } from "lucide-react";
import { pickupPointForPin, pickupServesPin, usePickupSettings } from "@/lib/pickup-points";
import { cn } from "@/lib/utils";

/**
 * Where the customer collects this order: the godown serving the delivery PIN code, with its
 * address, instructions and a Google Maps "Get directions" link. Hidden once home delivery is on.
 */
export function PickupPointCard({ pin, className, heading = "Pick up your order from" }: {
  /** Delivery PIN code; null shows the default godown (no PIN known yet). */
  pin: string | null | undefined;
  className?: string;
  heading?: string;
}) {
  const settings = usePickupSettings();
  if (settings.homeDelivery) return null;
  const point = pickupPointForPin(settings, pin);
  if (!point) return null;
  const servesPin = pickupServesPin(point, pin);
  return (
    <section className={cn("rounded-lg border border-gold/40 bg-ivory/60 p-3.5 sm:p-4", className)} aria-label="Pickup location">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate">{heading}</p>
      <div className="mt-1.5 flex items-start gap-2.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-navy text-gold">
          <Warehouse className="h-4 w-4" />
        </span>
        <div className="min-w-0 space-y-1">
          <p className="font-bold text-navy">{point.name}</p>
          {point.address && (
            <p className="flex items-start gap-1 text-sm text-charcoal">
              <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate" />
              <span>{point.address}</span>
            </p>
          )}
          {point.instructions && <p className="text-xs text-slate">{point.instructions}</p>}
          {point.phone && (
            <a href={`tel:${point.phone.replace(/[^\d+]/g, "")}`} className="inline-flex items-center gap-1 text-xs font-semibold text-navy hover:text-gold">
              <Phone className="h-3.5 w-3.5" /> {point.phone}
            </a>
          )}
          {pin && !servesPin && (
            <p className="text-xs font-medium text-amber-800">
              Home delivery is not available yet. This is our nearest godown; we will call you to arrange pickup.
            </p>
          )}
        </div>
      </div>
      {point.mapUrl && (
        <a
          href={point.mapUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex h-9 items-center gap-1.5 rounded-md bg-navy px-3 text-sm font-semibold text-white hover:bg-midnight"
        >
          <Navigation className="h-4 w-4" /> Get directions
        </a>
      )}
    </section>
  );
}
