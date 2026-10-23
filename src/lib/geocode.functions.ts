import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Turns the customer's current map position into a postal address (house/street, area, city,
 * state, PIN code). Signed-in customers only. Uses OpenStreetMap Nominatim (identified, one
 * request per user action, as its usage policy asks) and BigDataCloud as a fallback.
 */
export type ReverseGeocodeResult = {
  line: string;
  landmark: string;
  city: string;
  state: string;
  pin: string;
  displayName: string;
  source: "openstreetmap" | "bigdatacloud";
};

const clean = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const join = (...parts: string[]) => [...new Set(parts.map((part) => part.trim()).filter(Boolean))].join(", ");

async function fromNominatim(lat: number, lng: number): Promise<ReverseGeocodeResult | null> {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&zoom=18&accept-language=en&lat=${lat}&lon=${lng}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "GrainBazar/1.0 (+https://grainbazar.com)", Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) return null;
  const data = (await response.json()) as { address?: Record<string, unknown>; display_name?: string; name?: string };
  const a = data.address ?? {};
  const pin = clean(a["postcode"]).replace(/\s/g, "");
  const city = clean(a["city"]) || clean(a["town"]) || clean(a["village"]) || clean(a["municipality"]) || clean(a["county"]) || clean(a["state_district"]);
  const state = clean(a["state"]);
  if (!city && !state) return null;
  const line = join(
    join(clean(a["house_number"]), clean(a["house_name"])),
    clean(a["road"]),
    clean(a["neighbourhood"]) || clean(a["quarter"]),
    clean(a["suburb"]) || clean(a["hamlet"]),
    clean(a["village"]) && clean(a["village"]) !== city ? clean(a["village"]) : "",
  );
  const landmark = clean(a["amenity"]) || clean(a["building"]) || clean(a["shop"]) || clean(a["office"]) || clean(data.name);
  return {
    line: line || clean(data.display_name).split(",").slice(0, 3).join(",").trim(),
    landmark: landmark && !line.includes(landmark) ? landmark : "",
    city,
    state,
    pin: /^\d{6}$/.test(pin) ? pin : "",
    displayName: clean(data.display_name),
    source: "openstreetmap",
  };
}

async function fromBigDataCloud(lat: number, lng: number): Promise<ReverseGeocodeResult | null> {
  const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`;
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) return null;
  const data = (await response.json()) as Record<string, unknown>;
  const pin = clean(data["postcode"]).replace(/\s/g, "");
  const city = clean(data["city"]) || clean(data["locality"]);
  const state = clean(data["principalSubdivision"]);
  if (!city && !state) return null;
  return {
    line: clean(data["locality"]) !== city ? clean(data["locality"]) : "",
    landmark: "",
    city,
    state,
    pin: /^\d{6}$/.test(pin) ? pin : "",
    displayName: join(clean(data["locality"]), city, state, pin),
    source: "bigdatacloud",
  };
}

export const reverseGeocode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }))
  .handler(async ({ data }) => {
    const lat = Math.round(data.lat * 1e6) / 1e6;
    const lng = Math.round(data.lng * 1e6) / 1e6;
    try {
      const primary = await fromNominatim(lat, lng);
      if (primary && primary.pin) return primary;
      const fallback = await fromBigDataCloud(lat, lng).catch(() => null);
      // Prefer the detailed street address; borrow the PIN code from the fallback if missing.
      if (primary) return { ...primary, pin: primary.pin || fallback?.pin || "" };
      if (fallback) return fallback;
    } catch {
      const fallback = await fromBigDataCloud(lat, lng).catch(() => null);
      if (fallback) return fallback;
    }
    throw new Error("Could not find an address for this location. Please type it in.");
  });
