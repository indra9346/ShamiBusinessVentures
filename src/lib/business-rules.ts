import { supabase } from "@/integrations/supabase/client";

export type TaxSettings = {
  gstEnabled: boolean;
  sugar: number;
  staples: number;
  packaged: number;
  invoicePrefix: string;
};

export const defaultTaxSettings: TaxSettings = {
  gstEnabled: true,
  sugar: 5,
  staples: 5,
  packaged: 12,
  invoicePrefix: "INV-",
};

export async function loadTaxSettings(): Promise<TaxSettings> {
  const { data, error } = await supabase.from("settings").select("value")
    .eq("key", "tax").eq("is_public", true).maybeSingle();
  if (error) throw error;
  const value = data?.value && typeof data.value === "object" && !Array.isArray(data.value)
    ? data.value as Record<string, unknown>
    : {};
  const rate = (key: string, fallback: number) => {
    const n = Number(value[key] ?? value["gst_default"] ?? fallback);
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : fallback;
  };
  return {
    gstEnabled: value["gst_enabled"] !== false,
    sugar: rate("sugar", defaultTaxSettings.sugar),
    staples: rate("staples", defaultTaxSettings.staples),
    packaged: rate("packaged", defaultTaxSettings.packaged),
    invoicePrefix: typeof value["invoice_prefix"] === "string" && value["invoice_prefix"].trim()
      ? value["invoice_prefix"].trim()
      : defaultTaxSettings.invoicePrefix,
  };
}

export function defaultGstForCategory(settings: TaxSettings, category: string): number {
  if (!settings.gstEnabled) return 0;
  const normalized = category.toLowerCase();
  if (normalized.includes("sugar")) return settings.sugar;
  if (normalized.includes("packaged")) return settings.packaged;
  return settings.staples;
}
