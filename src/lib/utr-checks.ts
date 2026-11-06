/*
 * What the admin's "UTR checks" panel shows (data from admin_utr_conflicts): every transfer that appears on two or more
 * orders or accounts, accounts whose UTRs keep being refused, and the latest refused tries. Pure helpers, no "@/"
 * imports, so the tests can load this file directly.
 */

export type UtrRecordSource = "utr_sent" | "utr_replaced" | "tried" | "payment" | "bank_sms";

export type UtrRecord = {
  source: UtrRecordSource;
  order_no: string | null;
  user_id: string | null;
  who: string | null;
  phone: string | null;
  amount: number | null;
  state: string | null;
  at: string;
  ref: string;
  detail: string | null;
};

export type UtrConflictGroup = {
  key: string;
  records: number;
  orders: number;
  accounts: number;
  last_at: string;
  severity: "high" | "medium";
  reviewed: boolean;
  review_note: string | null;
  reviewed_at: string | null;
  items: UtrRecord[];
};

export type UtrAccountFlag = { user_id: string; who: string | null; phone: string | null; refused: number; paused_now: boolean; last_at: string };
export type UtrTry = { at: string; order_no: string; user_id: string | null; who: string | null; ref: string; amount: number | null; outcome: "refused" | "blocked"; reason: string | null };
export type UtrChecks = { groups: UtrConflictGroup[]; accounts: UtrAccountFlag[]; tries: UtrTry[]; since: string };

export const EMPTY_UTR_CHECKS: UtrChecks = { groups: [], accounts: [], tries: [], since: "" };

/** Plain words for where a record comes from. */
export const UTR_SOURCE_LABEL: Record<UtrRecordSource, string> = {
  utr_sent: "UTR sent by the customer",
  utr_replaced: "Earlier UTR, replaced",
  tried: "Tried, refused",
  payment: "Payment recorded",
  bank_sms: "Bank SMS",
};

/** Groups that need someone: not yet looked at, or something new came after the last look. */
export function openUtrGroups(checks: UtrChecks) {
  return checks.groups.filter((group) => !group.reviewed);
}

/** The other orders sharing a transfer with this order, for the badge in "Payments to check". */
export function otherOrdersSharingUtr(orderNo: string, checks: UtrChecks): string[] {
  const others = new Set<string>();
  for (const group of checks.groups) {
    if (!group.items.some((item) => item.order_no === orderNo)) continue;
    for (const item of group.items) if (item.order_no && item.order_no !== orderNo) others.add(item.order_no);
  }
  return [...others].sort();
}

/** A phone shown to an admin at a glance: the last 4 digits only. */
export function maskPhone(phone: string | null | undefined) {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? `••••${digits.slice(-4)}` : "";
}

/** The accounts in a group, each with its name and how many records it has there, most first. */
export function accountsInGroup(group: UtrConflictGroup) {
  const byAccount = new Map<string, { userId: string; who: string; phone: string; records: number }>();
  for (const item of group.items) {
    if (!item.user_id) continue;
    const entry = byAccount.get(item.user_id) ?? { userId: item.user_id, who: item.who || "Unknown", phone: maskPhone(item.phone), records: 0 };
    entry.records += 1;
    byAccount.set(item.user_id, entry);
  }
  return [...byAccount.values()].sort((a, b) => b.records - a.records || a.who.localeCompare(b.who, "en"));
}
