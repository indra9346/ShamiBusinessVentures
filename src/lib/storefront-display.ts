import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * What the storefront product cards show, controlled from Admin → Settings → Storefront.
 * Everything defaults to off: cards show the product, pack size, stock and the selling price.
 */
export type StorefrontDisplay = {
  /** Struck-through MRP, "% off" and "Save ₹N" on product cards. */
  showMrpSavings: boolean;
  /** Star rating and review count on product cards and the shop's rating filter. */
  showRatings: boolean;
  /** Vendor name above the product title on product cards. */
  showVendor: boolean;
};

export const STOREFRONT_DISPLAY_KEY = "storefront_display";

export const defaultStorefrontDisplay: StorefrontDisplay = {
  showMrpSavings: false,
  showRatings: false,
  showVendor: false,
};

export function parseStorefrontDisplay(value: unknown): StorefrontDisplay {
  const v = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    showMrpSavings: v["showMrpSavings"] === true,
    showRatings: v["showRatings"] === true,
    showVendor: v["showVendor"] === true,
  };
}

let cached: StorefrontDisplay = defaultStorefrontDisplay;
let request: Promise<StorefrontDisplay> | null = null;
const listeners = new Set<(value: StorefrontDisplay) => void>();

function load() {
  request ??= Promise.resolve(
    supabase.from("settings").select("value").eq("key", STOREFRONT_DISPLAY_KEY).eq("is_public", true).maybeSingle(),
  )
    .then(({ data, error }) => (error ? defaultStorefrontDisplay : parseStorefrontDisplay(data?.value)))
    .catch(() => defaultStorefrontDisplay)
    .then((value) => {
      setStorefrontDisplay(value);
      return value;
    });
  return request;
}

/** Applies a new value everywhere at once (used after the admin saves the setting). */
export function setStorefrontDisplay(value: StorefrontDisplay) {
  cached = value;
  for (const listener of listeners) listener(value);
}

/** Current storefront display options; one shared fetch per page load. */
export function useStorefrontDisplay(): StorefrontDisplay {
  const [value, setValue] = useState(cached);
  useEffect(() => {
    listeners.add(setValue);
    setValue(cached);
    void load();
    return () => {
      listeners.delete(setValue);
    };
  }, []);
  return value;
}
