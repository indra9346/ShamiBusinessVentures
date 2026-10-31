import { useEffect, useState, useSyncExternalStore } from "react";
import { supabase } from "@/integrations/supabase/client";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { defaultBranchOf } from "@/lib/godown-rules";
import { products as seedProducts } from "@/lib/data";
import { afterPageLoad, snapshotIsFresh, useStorefrontSnapshot, type StorefrontSnapshot } from "@/lib/storefront-snapshot";

export { branchForPin, branchStockOf, defaultBranchOf, godownOfferOf, godownPriceOf, orderGodownFor, zohoLocationLabel } from "@/lib/godown-rules";

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
  /** Zoho price list this godown sells from: only its items, at its prices. "" = every item at the base price. */
  zohoPricebookId: string;
  zohoPricebookName: string;
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
  gstin: "", zohoLocationId: "", zohoLocationName: "CLK Shami Business Ventures", zohoPricebookId: "", zohoPricebookName: "",
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
    zohoPricebookId: str(row["zoho_pricebook_id"]), zohoPricebookName: str(row["zoho_pricebook_name"]),
    servesPincodes: Array.isArray(row["serves_pincodes"]) ? (row["serves_pincodes"] as unknown[]).map(String) : [],
    pickupEnabled: row["pickup_enabled"] !== false, deliveryEnabled: row["delivery_enabled"] === true,
    deliveryFee: Number(row["delivery_fee"]) || 0, freeDeliveryAbove: Number.isFinite(free) ? free : null,
    isDefault: row["is_default"] === true, active: row["active"] !== false, sortOrder: Number(row["sort_order"]) || 0,
    vendorId: typeof row["vendor_id"] === "string" && row["vendor_id"] ? row["vendor_id"] : null,
  };
}

export type GodownPrice = { price: number; listed: boolean; pending: boolean };

export type BranchState = {
  ready: boolean;
  branches: Branch[];
  /** product id -> branch id -> stock */
  stock: Map<string, Map<string, number>>;
  /** product id -> branch id -> godown price (godowns linked to a Zoho price list). */
  prices: Map<string, Map<string, GodownPrice>>;
  features: PlatformFeatures;
  /** Marketplace ON: vendor id -> the branch their items are fulfilled from. */
  vendorPoints: Map<string, string>;
};

/**
 * Static demo with localStorage "gb-demo-pin-matching" = "on": PIN matching as on the live site
 * (Challakere's PINs only, its stock = the demo stock), to try the service-area screens.
 */
function demoPinMatching(): boolean {
  try {
    return STATIC_DATA_MODE && typeof window !== "undefined" && window.localStorage.getItem("gb-demo-pin-matching") === "on";
  } catch {
    return false;
  }
}
const demoRouting = demoPinMatching();
let cache: BranchState = STATIC_DATA_MODE
  ? {
      ready: true, branches: [DEMO_BRANCH], prices: new Map(), vendorPoints: new Map(),
      stock: demoRouting ? new Map(seedProducts.map((product) => [product.id, new Map([[DEMO_BRANCH.id, product.stock]])])) : new Map(),
      features: { ...defaultFeatures, branchRouting: demoRouting },
    }
  : { ready: false, branches: [], stock: new Map(), prices: new Map(), features: defaultFeatures, vendorPoints: new Map() };
const listeners = new Set<(state: BranchState) => void>();
let loading: Promise<void> | null = null;
let subscribed = false;

function publish(next: BranchState) {
  cache = next;
  for (const listener of listeners) listener(cache);
}

type PriceRow = { branch_id: string; product_id: string; price: number | string; listed: boolean | null; pending: boolean | null };
type StockRow = { branch_id: string; product_id: string; stock: number | string };

const featuresFrom = (setting: unknown): PlatformFeatures => {
  const value = setting && typeof setting === "object" && !Array.isArray(setting) ? setting as Row : {};
  return { branchRouting: value["branch_routing"] === true, marketplaceVendors: value["marketplace_vendors"] === true };
};

function branchStateFrom(branchRows: Row[], stockRows: StockRow[], priceRows: PriceRow[], features: PlatformFeatures, points: { vendor_id: string; branch_id: string }[]): BranchState {
  const prices = new Map<string, Map<string, GodownPrice>>();
  for (const row of priceRows) {
    const byBranch = prices.get(row.product_id) ?? new Map<string, GodownPrice>();
    byBranch.set(row.branch_id, { price: Number(row.price) || 0, listed: row.listed !== false, pending: row.pending === true });
    prices.set(row.product_id, byBranch);
  }
  const stock = new Map<string, Map<string, number>>();
  for (const row of stockRows) {
    const byBranch = stock.get(row.product_id) ?? new Map<string, number>();
    byBranch.set(row.branch_id, Number(row.stock) || 0);
    stock.set(row.product_id, byBranch);
  }
  const vendorPoints = new Map<string, string>();
  if (features.marketplaceVendors) for (const point of points) vendorPoints.set(point.vendor_id, point.branch_id);
  return { ready: true, branches: branchRows.map((row) => branchFromRow(row)), stock, prices, features, vendorPoints };
}

export async function reloadBranches() {
  if (STATIC_DATA_MODE) return;
  const [branchResult, stockResult, featureResult, priceResult] = await Promise.all([
    supabase.from("branches").select("*").order("sort_order").order("name"),
    supabase.from("branch_stock").select("branch_id,product_id,stock"),
    supabase.from("settings").select("value").eq("key", PLATFORM_FEATURES_KEY).eq("is_public", true).maybeSingle(),
    supabase.from("branch_prices").select("branch_id,product_id,price,listed,pending"),
  ]);
  const features = featuresFrom(featureResult.data?.value);
  const points = features.marketplaceVendors ? (await supabase.rpc("vendor_fulfilment_points")).data ?? [] : [];
  publish(branchStateFrom(
    (branchResult.data ?? []) as Row[],
    stockResult.data ?? [],
    // Before the godown migration is applied the table does not exist yet: no godown prices.
    priceResult.error ? [] : priceResult.data ?? [],
    features,
    points,
  ));
}

// The godowns sent with the page, converted once per page (the server and the browser start from the same).
const snapshotStates = new WeakMap<StorefrontSnapshot, BranchState>();
function snapshotBranchState(snapshot: StorefrontSnapshot): BranchState {
  let state = snapshotStates.get(snapshot);
  if (!state) {
    state = branchStateFrom(snapshot.branches, snapshot.branchStock, snapshot.branchPrices,
      featuresFrom(snapshot.settings[PLATFORM_FEATURES_KEY]), snapshot.vendorPoints);
    snapshotStates.set(snapshot, state);
  }
  return state;
}

/** Starts from the page's copy: no database call now, and one after the page loads if it was not fresh. */
function seedFromSnapshot(snapshot: StorefrontSnapshot) {
  if (STATIC_DATA_MODE || cache.ready || loading) return;
  publish(snapshotBranchState(snapshot));
  loading = snapshotIsFresh(snapshot)
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        afterPageLoad(() => void reloadBranches().catch((error: unknown) => console.warn("Could not load branches", error)).finally(resolve));
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
      .on("postgres_changes", { event: "*", schema: "public", table: "branch_prices" }, schedule)
      .on("postgres_changes", { event: "*", schema: "public", table: "settings" }, schedule)
      .subscribe();
  }
}

/** Branches, stock per branch and platform switches, kept live. */
export function useBranches(): BranchState {
  const snapshot = useStorefrontSnapshot();
  const [state, setState] = useState(() => (!cache.ready && snapshot ? snapshotBranchState(snapshot) : cache));
  useEffect(() => {
    listeners.add(setState);
    if (snapshot) seedFromSnapshot(snapshot);
    setState(cache);
    ensureLoaded();
    return () => { listeners.delete(setState); };
  }, []);
  return state;
}

/** Home-delivery charge from a godown (same rule as the database): its fee, free at or above its threshold. */
export const branchDeliveryFee = (branch: Branch | null, subtotal: number) =>
  !branch || (branch.freeDeliveryAbove !== null && subtotal >= branch.freeDeliveryAbove) ? 0 : branch.deliveryFee;

/* ------------------------------------------------------------------------- */
/* The shopper's delivery PIN ("Delivering to …"), kept on this device.       */
/* ------------------------------------------------------------------------- */
const SHOPPER_PIN_KEY = "gb-shopper-pin";
const pinListeners = new Set<() => void>();
let shopperPin = "";
try {
  if (typeof window !== "undefined") shopperPin = localStorage.getItem(SHOPPER_PIN_KEY) || "";
} catch {
  /* storage blocked */
}

/** Sets the shopper's PIN (6 digits) or clears it (""), for every open component. */
export function setShopperPin(pin: string) {
  const clean = pin.replace(/\D/g, "").slice(0, 6);
  shopperPin = clean.length === 6 ? clean : "";
  try {
    if (shopperPin) localStorage.setItem(SHOPPER_PIN_KEY, shopperPin);
    else localStorage.removeItem(SHOPPER_PIN_KEY);
  } catch { /* storage blocked */ }
  for (const listener of pinListeners) listener();
}

const subscribeShopperPin = (listener: () => void) => {
  pinListeners.add(listener);
  return () => { pinListeners.delete(listener); };
};

/**
 * The PIN the shopper chose ("" when none yet). The server-rendered page has none, so the browser's
 * first render matches it and the saved PIN applies right after.
 */
export function useShopperPin(): [string, (pin: string) => void] {
  const value = useSyncExternalStore(subscribeShopperPin, () => shopperPin, () => "");
  return [value, setShopperPin];
}

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
