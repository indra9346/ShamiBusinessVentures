/*
 * Zoho's customer and vendor numbers (owner, 12 Nov 2026: "Fetch Customer ID (customer number) & Vendor IDs (vendor
 * number) from Zoho & show the same everywhere in customer details & order details & in invoices & delivery slips").
 *
 * Zoho Books keeps them on the contact as `contact_number` ("Customer Number" / "Vendor Number", shown when Settings >
 * Preferences > Customers and Vendors has Customer and Vendor Numbers switched on). The website reads the contact from
 * Zoho when it creates, updates or checks it, keeps the number on its link to that contact
 * (zoho_contact_links.zoho_contact_number, migration 20261112160000) and shows it as "Customer No." / "Vendor No.".
 * Nothing is ever sent to Zoho: Zoho numbers its contacts itself.
 *
 * No app imports: the node tests load this file.
 */

export type ContactKind = "customer" | "vendor";

/** The words on every page, invoice and paper. */
export const CONTACT_NUMBER_LABELS = { customer: "Customer No.", vendor: "Vendor No." } as const satisfies Record<ContactKind, string>;

export const contactNumberLabel = (kind: ContactKind) => CONTACT_NUMBER_LABELS[kind];

/** Zoho Books allows at most 50 characters. */
export const CONTACT_NUMBER_MAX = 50;

/** A stored or received number as shown: trimmed text, or null when there is none. */
export function cleanContactNumber(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, CONTACT_NUMBER_MAX) : null;
}

/**
 * The number on a contact Zoho sent back. undefined when the reply has no `contact_number` at all (Zoho said nothing,
 * so whatever the website kept stays); null when it is there but empty (numbers switched off, or this contact has none).
 */
export function zohoContactNumberOf(contact: unknown): string | null | undefined {
  if (!contact || typeof contact !== "object" || Array.isArray(contact)) return undefined;
  if (!("contact_number" in contact)) return undefined;
  return cleanContactNumber((contact as Record<string, unknown>)["contact_number"]);
}

/** "Customer No. CUS-00012" for an invoice or a paper; "" when there is no number, so the line is left out. */
export function contactNumberLine(kind: ContactKind, number: string | null | undefined) {
  const clean = cleanContactNumber(number);
  return clean ? `${CONTACT_NUMBER_LABELS[kind]} ${clean}` : "";
}

/**
 * What the website saves on the link after asking Zoho: the time it asked, and the number when Zoho said one (an empty
 * one clears it). A reply without the field changes only the time.
 */
export function contactNumberUpdate(number: string | null | undefined, checkedAt: string): Record<string, string | null> {
  return number === undefined
    ? { zoho_contact_number_checked_at: checkedAt }
    : { zoho_contact_number: number, zoho_contact_number_checked_at: checkedAt };
}

/** Everyone's numbers the signed-in account may see (public.zoho_contact_numbers): an admin all, anyone else their own. */
export type ContactNumbers = {
  customers: ReadonlyMap<string, string>;
  vendorsByUser: ReadonlyMap<string, string>;
  vendorsByVendorId: ReadonlyMap<string, string>;
};

export const NO_CONTACT_NUMBERS: ContactNumbers = { customers: new Map(), vendorsByUser: new Map(), vendorsByVendorId: new Map() };

/** The rows of public.zoho_contact_numbers() as look-ups. Anything else (an error, no rows) is no numbers. */
export function contactNumbersFrom(rows: unknown): ContactNumbers {
  if (!Array.isArray(rows)) return NO_CONTACT_NUMBERS;
  const customers = new Map<string, string>();
  const vendorsByUser = new Map<string, string>();
  const vendorsByVendorId = new Map<string, string>();
  for (const value of rows) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    const number = cleanContactNumber(row["contact_number"]);
    const userId = typeof row["user_id"] === "string" ? row["user_id"] : "";
    if (!number || !userId) continue;
    if (row["contact_type"] === "customer") customers.set(userId, number);
    else if (row["contact_type"] === "vendor") {
      vendorsByUser.set(userId, number);
      const vendorId = typeof row["vendor_id"] === "string" ? row["vendor_id"].trim() : "";
      if (vendorId) vendorsByVendorId.set(vendorId, number);
    }
  }
  return { customers, vendorsByUser, vendorsByVendorId };
}

/** A vendor's number. The site's vendor id is the profile's vendor id, or the account id when it has none. */
export function vendorNumberOf(numbers: ContactNumbers, vendorId: string | null | undefined) {
  if (!vendorId) return null;
  return numbers.vendorsByVendorId.get(vendorId) ?? numbers.vendorsByUser.get(vendorId) ?? null;
}

/** Contacts asked of Zoho per press of "Fetch customer and vendor numbers from Zoho": one GET each. */
export const CONTACT_NUMBER_BATCH = 20;

/** What one press did. */
export type ContactNumberFetch = {
  /** Contacts asked of Zoho now. */
  read: number;
  /** Of those, how many have a number in Zoho. */
  found: number;
  /** Zoho has no number on them (numbers switched off, or none given). */
  empty: number;
  /** Zoho's reply had no number field at all. */
  notSaid: number;
  /** Zoho could not be read for these (their Zoho contact ids). */
  failed: string[];
  /** Linked contacts never asked yet. */
  remaining: number;
  /** Linked contacts in all, and how many have a number now. */
  linked: number;
  numbered: number;
  /** Zoho's daily API limit: nothing was asked. */
  pausedUntil: string | null;
  /** The database does not have the update yet: nothing was asked. */
  needsMigration: boolean;
};

export const EMPTY_CONTACT_NUMBER_FETCH: ContactNumberFetch = {
  read: 0, found: 0, empty: 0, notSaid: 0, failed: [], remaining: 0, linked: 0, numbered: 0, pausedUntil: null, needsMigration: false,
};

/**
 * Zoho Books' help ("associate unique number with customer"): Settings > Preferences > Customers and Vendors, one box
 * for customers and one for vendors; existing contacts get numbers copied from a custom field or from a series; once
 * on, Zoho cannot switch it off. So the owner decides; the website only reads what Zoho has.
 */
export const CONTACT_NUMBERS_OFF_HINT = "Zoho sent no numbers. Customer and Vendor Numbers may be off in Zoho Books (Settings > Preferences > Customers and Vendors: Enable Customer Number, Enable Vendor Number). Zoho cannot switch them off again once on, so the owner decides. After Zoho has numbered the existing contacts, press the button again.";

/**
 * The answer to the admin, one line each (each translates on its own). When Zoho sends no numbers at all, the last line
 * points to the preference in Zoho Books.
 */
export function contactNumberFetchLines(result: ContactNumberFetch): string[] {
  if (result.needsMigration) return ["The database does not have the customer and vendor number update yet. Nothing was asked of Zoho. Ask your developer to apply it."];
  if (result.pausedUntil && !result.read && !result.failed.length) return ["Zoho's daily API limit was reached, so nothing was asked. Try again after the pause ends."];
  const lines = [
    ...(result.pausedUntil ? ["Zoho's daily API limit was reached, so the rest were not asked. Try again after the pause ends."] : []),
    `Contacts read from Zoho now: ${result.read}`,
    `With a number in Zoho: ${result.found}`,
    `Without a number in Zoho: ${result.empty + result.notSaid}`,
  ];
  if (result.failed.length) lines.push(`Zoho could not be read for: ${result.failed.length}`);
  lines.push(`Linked contacts with a number: ${result.numbered} of ${result.linked}`);
  lines.push(result.remaining > 0 ? `Not asked yet: ${result.remaining}. Press the button again.` : "Every linked contact has been asked. Pressing again reads the oldest ones again.");
  if (result.read > 0 && result.found === 0) lines.push(CONTACT_NUMBERS_OFF_HINT);
  return lines;
}
