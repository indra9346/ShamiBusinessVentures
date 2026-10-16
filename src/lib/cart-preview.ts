import { useSyncExternalStore } from "react";
import type { Product } from "@/lib/data";

/** Quantity being chosen on the add-to-cart keypad, not yet added to the cart. */
export type CartPreview = { product: Product; qty: number } | null;

let current: CartPreview = null;
const listeners = new Set<() => void>();

export function setCartPreview(preview: CartPreview) {
  if (current?.product.id === preview?.product.id && current?.qty === preview?.qty) return;
  current = preview;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The keypad's pending quantity, so the cart bar can show the cart as it will be after Add. */
export function useCartPreview(): CartPreview {
  return useSyncExternalStore(subscribe, () => current, () => null);
}
