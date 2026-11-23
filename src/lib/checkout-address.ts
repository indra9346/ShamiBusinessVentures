/*
 * The rules behind editing an address at checkout: what the form must contain, whether a save changes
 * anything, what happens to the saved map point, and what a new address did to the order on screen.
 * Kept free of app imports so the node tests can load it.
 */
import { preorderText } from "./preorder.ts";

export type AddressFields = { label: string; name: string; phone: string; line: string; city: string; state: string; pin: string; landmark: string };
export type MapPoint = { latitude: number; longitude: number; locationAccuracy: number; locatedAt: string };
export type SavedAddress = Omit<AddressFields, "landmark"> & {
  landmark?: string | null | undefined;
  latitude?: number | undefined;
  longitude?: number | undefined;
  locationAccuracy?: number | undefined;
  locatedAt?: string | undefined;
};

/** The same check for a new address and an edited one. */
export function addressFormProblem(form: AddressFields): string | null {
  const complete = form.name.trim() && form.phone.replace(/\D/g, "").length >= 10 && form.line.trim() && form.city.trim() && /^\d{6}$/.test(form.pin.trim());
  return complete ? null : "Enter your name, valid phone, full address, city and 6-digit PIN code";
}

export const cleanAddressFields = (form: AddressFields): AddressFields => ({
  label: form.label.trim() || "Delivery",
  name: form.name.trim(),
  phone: form.phone.trim(),
  line: form.line.trim(),
  city: form.city.trim(),
  state: form.state.trim(),
  pin: form.pin.trim(),
  landmark: form.landmark.trim(),
});

export const addressFieldsOf = (saved: SavedAddress): AddressFields => ({
  label: saved.label, name: saved.name, phone: saved.phone, line: saved.line, city: saved.city, state: saved.state, pin: saved.pin, landmark: saved.landmark ?? "",
});

export const mapPointOf = (saved: SavedAddress): MapPoint | null =>
  saved.latitude !== undefined && saved.longitude !== undefined
    ? { latitude: saved.latitude, longitude: saved.longitude, locationAccuracy: saved.locationAccuracy ?? 0, locatedAt: saved.locatedAt ?? "" }
    : null;

// By place, not by time: a time read back from the database is written differently from the one captured here.
const samePoint = (a: MapPoint | null, b: MapPoint | null) =>
  a === b || (a !== null && b !== null && Math.abs(a.latitude - b.latitude) < 1e-6 && Math.abs(a.longitude - b.longitude) < 1e-6);

/** True when the map point on the form is still the one saved with the address, not one just captured. */
export const pointIsTheSavedOne = (saved: SavedAddress, formPoint: MapPoint | null) => samePoint(mapPointOf(saved), formPoint);

/**
 * The map point to keep after an edit. A point just captured stays. The saved point marks the old
 * place, so it goes when the PIN is typed over with a different one.
 */
export function mapPointAfterEdit(saved: SavedAddress, formPoint: MapPoint | null, pin: string): MapPoint | null {
  return pointIsTheSavedOne(saved, formPoint) && saved.pin.trim() !== pin.trim() ? null : formPoint;
}

const NO_POINT = { latitude: undefined, longitude: undefined, locationAccuracy: undefined, locatedAt: undefined };

/** What to write for an edit, or null when it changes nothing (so nothing is saved or sent to Zoho). */
export function addressEditPatch(saved: SavedAddress, form: AddressFields, formPoint: MapPoint | null) {
  const fields = cleanAddressFields(form);
  const point = mapPointAfterEdit(saved, formPoint, fields.pin);
  const before = addressFieldsOf(saved);
  const fieldsSame = (Object.keys(fields) as (keyof AddressFields)[]).every((key) => fields[key] === before[key]);
  const pointSame = samePoint(mapPointOf(saved), point);
  if (fieldsSame && pointSame) return null;
  return { ...fields, ...(pointSame ? {} : point ?? NO_POINT) };
}

/** Said under the form while typing, before anything is saved. */
export function pinHint({ pin, outside, movesTo }: { pin: string; outside: boolean; movesTo: string | null }): string | null {
  const clean = pin.trim();
  if (!/^\d{6}$/.test(clean)) return null;
  if (outside) return `We don't deliver to PIN ${clean} yet. You can save it, but orders can't be placed for it.`;
  return movesTo ? `PIN ${clean} is served by the ${movesTo} godown. Prices and stock will change to that godown's.` : null;
}

/* ------------------------------------------------------------------------- */
/* The cart at the godown serving the address.                                */
/* ------------------------------------------------------------------------- */

export type CheckoutLine = {
  id: string; name: string; qty: number;
  /** How many this godown can sell now (ready + pre-order units on sale); null = it does not sell this item. */
  available: number | null;
  /** The units that arrive later at this godown (pre-order batches, 14 Nov 2026). */
  arriving?: number | undefined;
  /** The ready units there (in the godown now). available may be less than ready + arriving: the per-order maximum. */
  ready?: number | undefined;
};
export type LineProblem = CheckoutLine & { kind: "not_sold" | "short" };

/** The lines the serving godown cannot fill as they stand. The database refuses these too. */
export function lineProblems(lines: CheckoutLine[]): LineProblem[] {
  return lines.flatMap((line): LineProblem[] => {
    if (line.available === null) return [{ ...line, kind: "not_sold" }];
    return line.qty > line.available ? [{ ...line, kind: "short" }] : [];
  });
}

export function lineProblemText(problem: LineProblem, godown: string): string {
  const name = problem.name || "This item";
  if (problem.kind === "not_sold") return `${name}: not sold at the ${godown} godown, so it is not in this total`;
  if (!problem.available) return `${name}: out of stock at the ${godown} godown`;
  const arriving = Math.max(0, problem.arriving ?? 0);
  // Ready and arriving as the godown has them (review fix: worked out from a capped available, 100 ready read as 0).
  const ready = problem.ready ?? Math.max(0, problem.available - arriving);
  if (arriving > 0) return preorderText.limit(name, problem.available, godown, Math.max(0, ready), arriving, problem.qty);
  return `${name}: only ${problem.available} available at the ${godown} godown, you have ${problem.qty}`;
}

/* ------------------------------------------------------------------------- */
/* What a new address did to the order.                                       */
/* ------------------------------------------------------------------------- */

export type SeenOrder = { pin: string; godownId: string | null; godownName: string; total: number };
export type AddressChange = { fromTotal: number; movedTo: string | null };

const sameMoney = (a: number, b: number) => Math.abs(a - b) < 0.005;

/** Null when the new address changed neither the godown nor the total. */
export function addressChangeBetween(before: SeenOrder, now: SeenOrder): AddressChange | null {
  const moved = before.godownId !== now.godownId;
  if (!moved && sameMoney(before.total, now.total)) return null;
  return { fromTotal: before.total, movedTo: moved ? now.godownName : null };
}

/** Reads the total live: the customer can still change delivery or the quantities after the notice appears. */
export function addressChangeText(change: AddressChange, total: number, money: (amount: number) => string): { title: string; detail: string } | null {
  const same = sameMoney(change.fromTotal, total);
  if (same && !change.movedTo) return null;
  return {
    title: same ? `Your total stays ${money(total)}` : `Your total changed from ${money(change.fromTotal)} to ${money(total)}`,
    detail: change.movedTo
      ? `The ${change.movedTo} godown now serves this address, so prices, stock and delivery charges are from there.`
      : "Please check the new total before you pay.",
  };
}

/** Why the address on a held checkout or a placed order cannot be edited. */
export function addressLockReason({ paid, checking, godown }: { paid: boolean; checking: boolean; godown: string }): string {
  if (paid) return "This order is placed, so its address can't be changed here. If it is wrong, call us on +91 98459 66288.";
  if (checking) return "We are checking your payment for this checkout, so its address can't be changed now. If it is wrong, call us on +91 98459 66288.";
  return `This address can't be changed now: your prices and stock are held at the ${godown} godown for it, and the payment is for this exact amount. If you have not paid yet and need another address, cancel this payment, press Reorder and start again. If you have already paid, do not cancel: call us on +91 98459 66288.`;
}
