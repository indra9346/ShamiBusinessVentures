/*
 * Coming back from the UPI app (owner, 7 Nov 2026): the customer lands on the QR / UTR area of the order they were
 * paying, not at the top of the page or on an empty checkout. Two cases:
 *   - the browser kept the page: when it is shown again, it scrolls back to that order's pay panel;
 *   - the browser reloaded the page: checkout's address carries ?pay=<order numbers>, so it reopens the pay step.
 * No framework imports, so the node tests run this file as it is.
 */

import type { PayMethod } from "./payment-rules.ts";

export const PAY_RETURN_KEY = "gb-upi-return";
/** A return older than this is not a return from paying: the page just opens normally. */
export const PAY_RETURN_MAX_AGE_MS = 30 * 60_000;

/** Told to the pay panel (its id in detail) when the customer is back from the UPI app, so it asks for the UTR. */
export const PAY_RETURNED_EVENT = "gb-upi-returned";

/** The element id of an order's pay panel. */
export const payPanelId = (orderNo: string) => `pay-${orderNo}`;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const sessionStore = (): StorageLike | null => {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
};

/** Noted when a UPI app button is tapped: where to come back to. */
export function rememberPayReturn(
  targetId: string,
  now = Date.now(),
  store: StorageLike | null = sessionStore(),
) {
  try {
    store?.setItem(PAY_RETURN_KEY, JSON.stringify({ id: targetId, at: now }));
  } catch {
    // Storage blocked: the customer scrolls back by hand.
  }
}

/** The pay panel to scroll to, once: read and cleared. Null when nothing is waiting or it is too old. */
export function takePayReturn(
  now = Date.now(),
  store: StorageLike | null = sessionStore(),
): string | null {
  try {
    const raw = store?.getItem(PAY_RETURN_KEY);
    if (!raw) return null;
    store?.removeItem(PAY_RETURN_KEY);
    const saved = JSON.parse(raw) as { id?: unknown; at?: unknown };
    if (typeof saved.id !== "string" || typeof saved.at !== "number") return null;
    if (now - saved.at > PAY_RETURN_MAX_AGE_MS || now < saved.at) return null;
    return saved.id;
  } catch {
    return null;
  }
}

/** Order numbers as checkout's ?pay= value. */
export const payParam = (orderNos: string[]) => orderNos.join(",");

/** ?pay= read back: real-looking order numbers only, each once, at most five. */
export function parsePayParam(text: string | undefined | null): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  for (const part of text.split(",")) {
    const orderNo = part.trim();
    if (/^[A-Za-z0-9-]{3,40}$/.test(orderNo)) seen.add(orderNo);
  }
  return [...seen].slice(0, 5);
}

type HoldLike = {
  orderNo: string;
  amount: number;
  holdUntil: string | null;
  status: string;
  method?: string | undefined;
};
export type PlacedPayment = {
  id: string;
  amount: number;
  holdUntil: string | null;
  method: PayMethod;
};

const PAYABLE = ["Awaiting Payment", "Payment Confirmed"];

/**
 * The orders to show on the pay step again, from the customer's own held checkouts, in the ?pay= order. One that
 * expired or was ended is left out: there is nothing to pay any more, and checkout says so elsewhere.
 */
export function restorablePlaced(holds: HoldLike[], orderNos: string[]): PlacedPayment[] {
  return orderNos.flatMap((orderNo) => {
    const hold = holds.find(
      (candidate) => candidate.orderNo === orderNo && PAYABLE.includes(candidate.status),
    );
    if (!hold) return [];
    const method: PayMethod =
      hold.method === "NEFT" || hold.method === "RTGS" ? hold.method : "UPI";
    return [{ id: hold.orderNo, amount: Number(hold.amount), holdUntil: hold.holdUntil, method }];
  });
}
