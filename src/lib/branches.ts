import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";

/**
 * Grain Bazar godown branches. One catalogue; each product has a stock count per branch
 * (the product's total stock is the sum). Orders belong to one branch. Loaded once, kept live
 * with realtime updates, and shared by every component through a small module cache.
 */
export type Branch = {
  id: string;
  code: string;
  name: string;
  address: string;
  city: string;
  state: string;
  stateCode: string;
  pincode: string;
  phone: string;
  email: string;
  mapUrl: string;
  instructions: string;
  gstin: string;
  zohoLocationId: string;
  zohoLocationName: string;
  servesPincodes: string[];
  pickupEnabled: boolean;
  deliveryEnabled: boolean;
  deliveryFee: number;
  freeDeliveryAbove: number | null;
  isDefault: boolean;
  active: boolean;
  sortOrder: number;
  /** Set when this is a marketplace vendor's own pickup/delivery point (not a Grain Bazar godown). */
  vendorId: string | null;
};

/** Platform switches, stored in the public "platform_features" setting. Both start OFF. */
export type PlatformFeatures = {
  /** Match each customer to the godown serving their PIN code (stock, pickup, delivery). */
  branchRouting: boolean;
  /** Outside vendors can apply, list (after approval) and sell; Grain Bazar bills and pays them out. */
  marketplaceVendors: boolean;
};

export const PLATFORM_FEATURES_KEY = "platform_features";
export const defaultFeatures: PlatformFeatures = { branchRouting: false, marketplaceVendors: false };

export const DEMO_BRANCH: Branch = {
  id: "BR-CLK", code: "CLK", name: "Grain Bazar Challakere Godown",
  address: "Pavagada Road, Behind Mahalakshmi Kalyana Mantapa, Mahadevi Road, Challakere, Karnataka 577522",
  city: "Challakere", state: "Karnataka", stateCode: "29", pincode: "577522", phone: "8310084308",
  email: "shamibusinessventurespvtltd@gmail.com", mapUrl: "", instructions: "Bring your order number. Collect during working hours.",
  gstin: "", zohoLocationId: "", zohoLocationName: "CLK Shami Business Ventures",
  servesPincodes: ["577522", "577536", "577537", "577538", "577543"], pickupEnabled: true, deliveryEnabled: false,
  deliveryFee: 0, freeDeliveryAbove: null, isDefault: true, active: true, sortOrder: 0, vendorId: null,
};

type Row = Record<string, unknown>;
const str = (value: unknown) => (typeof value === "string" ? value : "");
const num = (value: unknown) => (value === null || value === undefined || value === "" ? NaN : Number(value));

export function branchFromRow(row: Row): Branch {
  const free = num(row["free_delivery_above"]);
  return {
    id: str(row["id"]), code: str(row["code"]), name: str(row["name"]), address: str(row["address"]),
    city: str(row["city"]), state: str(row["state"]), stateCode: str(row["state_code"]), pincode: str(row["pincode"]),
    phone: str(row["phone"]), email: str(row["email"]), mapUrl: str(row["map_url"]), instructions: str(row["instructions"]),
    gstin: str(row["gstin"]), zohoLocationId: str(row["zoho_location_id"]), zohoLocationName: str(row["zoho_location_name"]),
    servesPincodes: Array.isArray(row["serves_pincodes"]) ? (row["serves_pincodes"] as unknown[]).map(String) : [],
    pickupEnabled: row["pickup_enabled"] !== false, deliveryEnabled: row["delivery_enabled"] === true,
    deliveryFee: Number(row["delivery_fee"]) || 0, freeDeliveryAbove: Number.isFinite(free) ? free : null,
    isDefault: row["is_default"] === true, active: row["active"] !== false, sortOrder: Number(row["sort_order"]) || 0,
    vendorId: typeof row["vendor_id"] === "string" && row["vendor_id"] ? row["vendor_id"] : null,
  };
}

export type BranchState = {
  ready: boolean;
  branches: Branch[];
  /** product id -> branch id -> stock */
  stock: Map<string, Map<string, number>>;
  features: PlatformFeatures;
  /** Marketplace ON: vendor id -> the branch their items are fulfilled from. */
  vendorPoints: Map<string, string>;
};

let cache: BranchState = STATIC_DATA_MODE
  ? { ready: true, branches: [DEMO_BRANCH], stock: new Map(), features: defaultFeatures, vendorPoints: new Map() }
  : { ready: false, branches: [], stock: new Map(), features: defaultFeatures, vendorPoints: new Map() };
const listeners = new Set<(state: BranchState) => void>();
let loading: Promise<void> | null = null;
let subscribed = false;

function publish(next: BranchState) {
  cache = next;
  for (const listener of listeners) listener(cache);
}

export async function reloadBranches() {
  if (STATIC_DATA_MODE) return;
  const [branchResult, stockResult, featureResult] = await Promise.all([
    supabase.from("branches").select("*").order("sort_order").order("name"),
    supabase.from("branch_stock").select("branch_id,product_id,stock"),
    supabase.from("settings").select("value").eq("key", PLATFORM_FEATURES_KEY).eq("is_public", true).maybeSingle(),
  ]);
  const stock = new Map<string, Map<string, number>>();
  for (const row of stockResult.data ?? []) {
    const byBranch = stock.get(row.product_id) ?? new Map<string, number>();
    byBranch.set(row.branch_id, Number(row.stock) || 0);
    stock.set(row.product_id, byBranch);
  }
  const value = featureResult.data?.value && typeof featureResult.data.value === "object" && !Array.isArray(featureResult.data.value)
    ? featureResult.data.value as Row : {};
  const features = { branchRouting: value["branch_routing"] === true, marketplaceVendors: value["marketplace_vendors"] === true };
  const vendorPoints = new Map<string, string>();
  if (features.marketplaceVendors) {
    const { data: points } = await supabase.rpc("vendor_fulfilment_points");
    for (const point of points ?? []) vendorPoints.set(point.vendor_id, point.branch_id);
  }
  publish({
    ready: true,
    branches: (branchResult.data ?? []).map((row) => branchFromRow(row as Row)),
    stock,
    features,
    vendorPoints,
  });
}

function ensureLoaded() {
  if (STATIC_DATA_MODE) return;
  if (!loading) loading = reloadBranches().catch((error: unknown) => console.warn("Could not load branches", error)).then(() => undefined);
  if (!subscribed) {
    subscribed = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => void reloadBranches(), 400); };
    supabase.channel("branches-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "branches" }, schedule)
      .on("postgres_changes", { event: "*", schema: "public", table: "branch_stock" }, schedule)
      .on("postgres_changes", { event: "*", schema: "public", table: "settings" }, schedule)
      .subscribe();
  }
}

/** Branches, stock per branch and platform switches, kept live. */
export function useBranches(): BranchState {
  const [state, setState] = useState(cache);
  useEffect(() => {
    listeners.add(setState);
    setState(cache);
    ensureLoaded();
    return () => { listeners.delete(setState); };
  }, []);
  return state;
}

export const defaultBranchOf = (branches: Branch[]) => branches.find((branch) => branch.isDefault && branch.active) ?? branches.find((branch) => branch.active && !branch.vendorId) ?? null;

/** The godown serving a PIN code: one that lists it, else the default godown. */
export function branchForPin(branches: Branch[], pin: string | null | undefined) {
  const active = branches.filter((branch) => branch.active && !branch.vendorId);
  const clean = (pin ?? "").replace(/\D/g, "");
  return (clean ? active.find((branch) => branch.servesPincodes.includes(clean)) : undefined) ?? defaultBranchOf(branches);
}

/** Home-delivery charge from a godown (same rule as the database): its fee, free at or above its threshold. */
export const branchDeliveryFee = (branch: Branch | null, subtotal: number) =>
  !branch || (branch.freeDeliveryAbove !== null && subtotal >= branch.freeDeliveryAbove) ? 0 : branch.deliveryFee;

export const branchStockOf = (state: BranchState, productId: string, branchId: string) => state.stock.get(productId)?.get(branchId) ?? 0;

/* ------------------------------------------------------------------------- */
/* The branch an administrator is working in ("all" = every branch).          */
/* ------------------------------------------------------------------------- */
const ADMIN_BRANCH_KEY = "gb-admin-branch";
const branchListeners = new Set<(id: string) => void>();
let adminBranch = "all";
try {
  if (typeof window !== "undefined") adminBranch = localStorage.getItem(ADMIN_BRANCH_KEY) || "all";
} catch {
  /* storage blocked */
}

export function setAdminBranch(id: string) {
  adminBranch = id || "all";
  try { localStorage.setItem(ADMIN_BRANCH_KEY, adminBranch); } catch { /* storage blocked */ }
  for (const listener of branchListeners) listener(adminBranch);
}

export function useAdminBranch(): [string, (id: string) => void] {
  const [value, setValue] = useState(adminBranch);
  useEffect(() => {
    branchListeners.add(setValue);
    setValue(adminBranch);
    return () => { branchListeners.delete(setValue); };
  }, []);
  return [value, setAdminBranch];
}
