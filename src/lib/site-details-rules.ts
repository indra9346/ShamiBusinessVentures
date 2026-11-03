/*
 * The company details customers see in the footer and on the Contact and About pages, set in
 * Admin > Settings > Website details. Each detail has its own switch; a hidden or empty one simply
 * doesn't appear. Invoices don't read these: they print Business Profile and the godown's address.
 */
import { GSTIN_REGEX, normaliseGstin } from "./gstin.ts";

export const SITE_DETAILS_KEY = "site_details";

export const SITE_DETAIL_FIELDS = ["address", "phone", "whatsapp", "email", "gstin", "fssai"] as const;
export type SiteDetailField = (typeof SITE_DETAIL_FIELDS)[number];
export type SiteDetails = Record<SiteDetailField, { value: string; show: boolean }>;
/** What a page may show: the text, or "" when it is hidden or empty. */
export type VisibleSiteDetails = Record<SiteDetailField, string>;

export const HEAD_OFFICE_ADDRESS = "179, 5th Main Rd, BCC Layout, Chandra Layout, Bengaluru, Karnataka 560040";

/**
 * Used until an admin saves the panel. The owner confirmed the head office and GSTIN on 3 Nov 2026.
 * There is no email until the owner chooses one. The FSSAI number is still the old sample, kept at
 * the owner's request until they send the real one.
 */
export const DEFAULT_SITE_DETAILS: SiteDetails = {
  address: { value: HEAD_OFFICE_ADDRESS, show: true },
  phone: { value: "+91 95385 00840", show: true },
  whatsapp: { value: "+91 95385 00840", show: true },
  email: { value: "", show: false },
  gstin: { value: "29ABJCS7870F1ZR", show: true },
  fssai: { value: "10023456789012", show: true },
};

export function parseSiteDetails(saved: unknown): SiteDetails {
  const row = saved && typeof saved === "object" && !Array.isArray(saved) ? (saved as Record<string, unknown>) : {};
  const details = { ...DEFAULT_SITE_DETAILS };
  for (const field of SITE_DETAIL_FIELDS) {
    const entry = row[field];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { value, show } = entry as Record<string, unknown>;
    details[field] = { value: typeof value === "string" ? value.trim() : "", show: show === true };
  }
  return details;
}

export function visibleSiteDetails(details: SiteDetails): VisibleSiteDetails {
  const visible = {} as VisibleSiteDetails;
  for (const field of SITE_DETAIL_FIELDS) visible[field] = details[field].show ? details[field].value.trim() : "";
  return visible;
}

/** Digits with the country code and no leading zero: "095385 00840" -> "919538500840". */
function phoneDigits(phone: string) {
  const digits = phone.replace(/\D/g, "").replace(/^0+/, "");
  return digits.length === 10 ? `91${digits}` : digits;
}

export const telHref = (phone: string) => `tel:+${phoneDigits(phone)}`;
export const whatsappHref = (phone: string) => `https://wa.me/${phoneDigits(phone)}`;

const GSTIN_CHARACTERS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** A GSTIN's last character is a check digit, so most typing mistakes can be caught here. */
function gstinCheckDigitIsRight(gstin: string) {
  let sum = 0;
  for (let index = 0; index < 14; index++) {
    const weighted = GSTIN_CHARACTERS.indexOf(gstin[index] ?? "") * (index % 2 === 0 ? 1 : 2);
    sum += Math.floor(weighted / 36) + (weighted % 36);
  }
  return GSTIN_CHARACTERS[(36 - (sum % 36)) % 36] === gstin[14];
}

const validPhone = (text: string) => phoneDigits(text).length === 12;

const FIELD_RULES: Record<SiteDetailField, { valid: (text: string) => boolean; problem: string }> = {
  address: { valid: (text) => text.length >= 8, problem: "Enter the full head office address, or switch it off" },
  phone: { valid: validPhone, problem: "Enter a valid phone number, or switch it off" },
  whatsapp: { valid: validPhone, problem: "Enter a valid WhatsApp number, or switch it off" },
  email: { valid: (text) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text), problem: "Enter a valid email address, or switch it off" },
  gstin: {
    valid: (text) => {
      const gstin = normaliseGstin(text);
      return GSTIN_REGEX.test(gstin) && gstinCheckDigitIsRight(gstin);
    },
    problem: "Enter a valid GSTIN, or switch it off",
  },
  fssai: { valid: (text) => /^\d{14}$/.test(text.replace(/\s/g, "")), problem: "Enter the 14-digit FSSAI number, or switch it off" },
};

/** What stops the panel saving, or null. A detail that is switched off isn't shown, so it isn't checked. */
export function siteDetailsProblem(details: SiteDetails): string | null {
  for (const field of SITE_DETAIL_FIELDS) {
    const { value, show } = details[field];
    if (show && !FIELD_RULES[field].valid(value.trim())) return FIELD_RULES[field].problem;
  }
  return null;
}

/** The form as it is saved: trimmed, with the GSTIN in capitals and without spaces. */
export function cleanSiteDetails(details: SiteDetails): SiteDetails {
  const clean = { ...details };
  for (const field of SITE_DETAIL_FIELDS) clean[field] = { value: details[field].value.trim(), show: details[field].show };
  clean.gstin = { ...clean.gstin, value: normaliseGstin(clean.gstin.value) };
  return clean;
}
