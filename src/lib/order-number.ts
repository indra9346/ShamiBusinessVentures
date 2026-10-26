/*
 * Order numbers. New orders are numbered by the database as
 *   <GODOWN>-<DELIVERY PIN>-<DDMMYY>-<HHMMSS IST>[-n]   e.g. CLK-577522-261026-143215
 * (Challakere godown, PIN 577522, 26 Oct 2026 at 14:32:15; -2, -3 only for a same-second clash).
 * Older orders keep their ORD-… numbers. Kept free of app imports so the node tests can load it.
 */

/** Matches an order number inside text (notifications, messages): new godown numbers and old ORD- ones. */
export const ORDER_NUMBER_IN_TEXT = /\b(?:[A-Z]{2,6}-\d{6}-\d{6}-\d{6}(?:-\d{1,3})?|ORD-\d+)\b/;

/** The first order number mentioned in a text, or undefined. */
export const orderNumberIn = (text: string) => text.match(ORDER_NUMBER_IN_TEXT)?.[0];

export type OrderNumberParts = { godown: string; pin: string; placedAt: Date; sequence: number };

/** Reads a godown order number back (godown code, PIN, IST time). Null for old ORD- numbers. */
export function parseOrderNumber(orderNo: string): OrderNumberParts | null {
  const match = /^([A-Z]{2,6})-(\d{6})-(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-(\d{1,3}))?$/.exec(orderNo.trim());
  if (!match) return null;
  const [, godown, pin, dd, mm, yy, hh, mi, ss, seq] = match;
  // The digits are India time (UTC+05:30).
  const placedAt = new Date(Date.UTC(2000 + Number(yy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss)) - 330 * 60_000);
  if (Number.isNaN(placedAt.getTime())) return null;
  return { godown: godown!, pin: pin!, placedAt, sequence: seq ? Number(seq) : 1 };
}
