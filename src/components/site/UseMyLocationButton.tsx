import { useEffect, useRef, useState } from "react";
import { Crosshair, Loader2, MapPin } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import type { ReverseGeocodeResult } from "@/lib/geocode.functions";
import { showAuthNotice } from "@/components/site/AuthNotice";

export type CapturedLocation = ReverseGeocodeResult & {
  latitude: number;
  longitude: number;
  accuracy: number;
  capturedAt: string;
};

/** Best fix within this time, or sooner once it is this accurate (metres). */
const MAX_WAIT_MS = 10_000;
const GOOD_ENOUGH_M = 25;

/**
 * "Use my current location": reads the device's live GPS position (high accuracy, refined for a
 * few seconds), finds the postal address for it and hands both to the form to fill in.
 */
export function UseMyLocationButton({ onLocated, className }: { onLocated: (location: CapturedLocation) => void; className?: string }) {
  const [state, setState] = useState<"idle" | "locating" | "looking-up">("idle");
  const [last, setLast] = useState<CapturedLocation | null>(null);
  const watchRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (watchRef.current !== null) navigator.geolocation.clearWatch(watchRef.current);
  }, []);

  const lookUp = async (position: GeolocationPosition) => {
    setState("looking-up");
    const { latitude, longitude, accuracy } = position.coords;
    try {
      const address: ReverseGeocodeResult = STATIC_DATA_MODE
        ? { line: "Pavagada Road, Mahadevi Road", landmark: "", city: "Challakere", state: "Karnataka", pin: "577522", displayName: "Demo location", source: "openstreetmap" }
        : await import("@/lib/geocode.functions").then(({ reverseGeocode }) => reverseGeocode({ data: { lat: latitude, lng: longitude } }));
      const located: CapturedLocation = { ...address, latitude, longitude, accuracy, capturedAt: new Date(position.timestamp).toISOString() };
      setLast(located);
      onLocated(located);
      toast.success("Address filled from your location", {
        description: `${[address.city, address.state, address.pin].filter(Boolean).join(", ")} · accurate to about ${Math.round(accuracy)} m. Check the house/flat number.`,
      });
    } catch (cause) {
      showAuthNotice("Could not find your address", cause instanceof Error ? cause.message : "Please type it in.");
    } finally {
      setState("idle");
    }
  };

  const locate = () => {
    if (typeof window === "undefined" || !("geolocation" in navigator)) {
      showAuthNotice("This browser cannot share your location", "Please type your address.");
      return;
    }
    if (!window.isSecureContext) {
      showAuthNotice("Location needs a secure (https) page");
      return;
    }
    setState("locating");
    let best: GeolocationPosition | null = null;
    const finish = () => {
      if (watchRef.current !== null) navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null;
      window.clearTimeout(timer);
      if (best) void lookUp(best);
      else setState("idle");
    };
    const timer = window.setTimeout(finish, MAX_WAIT_MS);
    watchRef.current = navigator.geolocation.watchPosition(
      (position) => {
        if (!best || position.coords.accuracy < best.coords.accuracy) best = position;
        if (position.coords.accuracy <= GOOD_ENOUGH_M) finish();
      },
      (error) => {
        if (best) { finish(); return; }
        window.clearTimeout(timer);
        if (watchRef.current !== null) navigator.geolocation.clearWatch(watchRef.current);
        watchRef.current = null;
        setState("idle");
        const message = error.code === error.PERMISSION_DENIED
          ? "Location permission is blocked. Allow location for this site in your browser settings (the lock icon in the address bar), then try again."
          : error.code === error.TIMEOUT
            ? "Your location took too long to find. Move near a window or turn on GPS, then try again."
            : "Your location is not available right now. Turn on location/GPS and try again.";
        // A calm notice that stays readable (the permission steps are long).
        showAuthNotice("Could not get your location", message);
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: MAX_WAIT_MS },
    );
  };

  return (
    <div className={className}>
      <Button type="button" variant="outline" className="w-full border-gold/60 text-navy hover:bg-ivory sm:w-auto" disabled={state !== "idle"} onClick={locate}>
        {state === "idle" ? <Crosshair className="mr-1.5 h-4 w-4 text-gold" /> : <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
        {state === "locating" ? "Finding your location…" : state === "looking-up" ? "Finding your address…" : "Use my current location"}
      </Button>
      {last && (
        <p className="mt-1.5 flex items-center gap-1 text-xs text-slate">
          <MapPin className="h-3.5 w-3.5 text-gold" />
          Pinned at {last.latitude.toFixed(5)}, {last.longitude.toFixed(5)} (±{Math.round(last.accuracy)} m) ·{" "}
          <a className="font-semibold text-navy underline" href={`https://www.google.com/maps?q=${last.latitude},${last.longitude}`} target="_blank" rel="noreferrer">View on map</a>
        </p>
      )}
    </div>
  );
}
