import { useEffect, useMemo, useState } from "react";
import { defaultBranchOf, useBranches, type Branch } from "@/lib/branches";
import { supabase } from "@/integrations/supabase/client";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";

/**
 * Godowns where customers collect their orders, set in Admin → Settings → Pickup.
 * Until home delivery starts, every order is collected from the godown serving its PIN code.
 */
export type PickupPoint = {
  id: string;
  name: string;
  /** Full street address shown to the customer. */
  address: string;
  /** Google Maps link for directions. */
  mapUrl: string;
  /** Timings, what to bring, whom to ask for. */
  instructions: string;
  phone: string;
  /** PIN codes this godown serves. */
  pincodes: string[];
  /** Zoho location the sales order is created under (stock comes out of this warehouse). */
  zohoLocationId: string;
  zohoLocationName: string;
  /** Used for PIN codes no godown lists. */
  isDefault: boolean;
  active: boolean;
};

export type PickupSettings = {
  /** Home delivery is not offered yet; orders are collected. */
  homeDelivery: boolean;
  points: PickupPoint[];
};

export const PICKUP_SETTINGS_KEY = "pickup_points";

/** Challakere taluk PIN codes (Challakere, Nayakanahatti, Obalapura, Chowlur, Thallak). Verify and edit in the admin. */
export const CHALLAKERE_TALUK_PINCODES = ["577522", "577536", "577537", "577538", "577543"];

export const defaultPickupSettings: PickupSettings = {
  homeDelivery: false,
  points: [
    {
      id: "challakere-godown",
      name: "Grain Bazar Challakere Godown",
      address: "Challakere, Chitradurga district, Karnataka",
      mapUrl: "",
      instructions: "Bring your order number. Collect during working hours.",
      phone: "",
      pincodes: CHALLAKERE_TALUK_PINCODES,
      zohoLocationId: "",
      zohoLocationName: "CLK Shami Business Ventures",
      isDefault: true,
      active: true,
    },
  ],
};

const text = (value: unknown, max = 500) => (typeof value === "string" ? value.trim().slice(0, max) : "");

export function parsePickupSettings(value: unknown): PickupSettings {
  const v = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (!v) return defaultPickupSettings;
  const points = (Array.isArray(v["points"]) ? v["points"] : []).flatMap((raw, index): PickupPoint[] => {
    if (!raw || typeof raw !== "object") return [];
    const p = raw as Record<string, unknown>;
    const name = text(p["name"], 120);
    if (!name) return [];
    return [{
      id: text(p["id"], 60) || `point-${index + 1}`,
      name,
      address: text(p["address"], 500),
      mapUrl: /^https:\/\//i.test(text(p["mapUrl"], 1000)) ? text(p["mapUrl"], 1000) : "",
      instructions: text(p["instructions"], 500),
      phone: text(p["phone"], 30),
      pincodes: (Array.isArray(p["pincodes"]) ? p["pincodes"] : [])
        .map((pin) => String(pin).replace(/\D/g, ""))
        .filter((pin) => /^\d{6}$/.test(pin)),
      zohoLocationId: text(p["zohoLocationId"], 40),
      zohoLocationName: text(p["zohoLocationName"], 120),
      isDefault: p["isDefault"] === true,
      active: p["active"] !== false,
    }];
  });
  return { homeDelivery: v["homeDelivery"] === true, points };
}

/** The godown that serves a PIN code: the one listing it, else the default godown. */
export function pickupPointForPin(settings: PickupSettings, pin: string | null | undefined): PickupPoint | null {
  const clean = String(pin ?? "").replace(/\D/g, "");
  const active = settings.points.filter((point) => point.active);
  return active.find((point) => clean && point.pincodes.includes(clean))
    ?? active.find((point) => point.isDefault)
    ?? null;
}

/** True when the godown lists this PIN code itself (not only as the default). */
export function pickupServesPin(point: PickupPoint, pin: string | null | undefined) {
  return point.pincodes.includes(String(pin ?? "").replace(/\D/g, ""));
}

let cached: PickupSettings = defaultPickupSettings;
let request: Promise<PickupSettings> | null = null;
const listeners = new Set<(value: PickupSettings) => void>();

function load() {
  if (STATIC_DATA_MODE) return Promise.resolve(cached);
  request ??= Promise.resolve(
    supabase.from("settings").select("value").eq("key", PICKUP_SETTINGS_KEY).eq("is_public", true).maybeSingle(),
  )
    .then(({ data, error }) => (error || !data ? defaultPickupSettings : parsePickupSettings(data.value)))
    .catch(() => defaultPickupSettings)
    .then((value) => {
      setPickupSettings(value);
      return value;
    });
  return request;
}

/** Applies new pickup settings everywhere at once (used after the admin saves them). */
export function setPickupSettings(value: PickupSettings) {
  cached = value;
  for (const listener of listeners) listener(value);
}

/**
 * Pickup godowns as the storefront needs them, from the Branches table (Admin > Branches).
 * Home delivery is on when the default godown offers it (until PIN matching is switched on).
 */
export function pickupSettingsFromBranches(branches: Branch[]): PickupSettings {
  const fallback = defaultBranchOf(branches);
  return {
    homeDelivery: !!fallback?.deliveryEnabled,
    points: branches.map((branch) => ({
      id: branch.id,
      name: branch.name,
      address: branch.address,
      mapUrl: branch.mapUrl,
      instructions: branch.instructions,
      phone: branch.phone,
      pincodes: branch.servesPincodes,
      zohoLocationId: branch.zohoLocationId,
      zohoLocationName: branch.zohoLocationName,
      isDefault: branch.isDefault,
      active: branch.active && branch.pickupEnabled,
    })),
  };
}

/** Current pickup godowns (live from the Branches table). */
export function usePickupSettings(): PickupSettings {
  const { ready, branches } = useBranches();
  const [legacy, setLegacy] = useState(cached);
  useEffect(() => {
    listeners.add(setLegacy);
    setLegacy(cached);
    if (!ready) void load();
    return () => {
      listeners.delete(setLegacy);
    };
  }, [ready]);
  return useMemo(() => (ready && branches.length ? pickupSettingsFromBranches(branches) : legacy), [ready, branches, legacy]);
}
