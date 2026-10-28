/*
 * Business (B2B) purchases: the buyer's GSTIN and legal name. Same rules as the database
 * (start_paid_checkout) so the checkout explains a problem before the order is refused.
 */

export const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

/** GST state codes by state / union territory name (lower case). */
export const GST_STATE_CODES: Record<string, string> = {
  "jammu and kashmir": "01", "himachal pradesh": "02", punjab: "03", chandigarh: "04", uttarakhand: "05",
  haryana: "06", delhi: "07", rajasthan: "08", "uttar pradesh": "09", bihar: "10", sikkim: "11",
  "arunachal pradesh": "12", nagaland: "13", manipur: "14", mizoram: "15", tripura: "16", meghalaya: "17",
  assam: "18", "west bengal": "19", jharkhand: "20", odisha: "21", chhattisgarh: "22", "madhya pradesh": "23",
  gujarat: "24", "dadra and nagar haveli and daman and diu": "26", maharashtra: "27", karnataka: "29", goa: "30",
  lakshadweep: "31", kerala: "32", "tamil nadu": "33", puducherry: "34", "andaman and nicobar islands": "35",
  telangana: "36", "andhra pradesh": "37", ladakh: "38",
};

/** "29ABCDE1234F1Z5" from what a person typed (spaces dropped, upper case). */
export const normaliseGstin = (raw: string | null | undefined) => (raw ?? "").replace(/\s+/g, "").toUpperCase();

/** The two-digit GST code of a state name ("Karnataka" → "29"); null when unknown. */
export function gstStateCodeOf(stateName: string | null | undefined): string | null {
  const key = (stateName ?? "").trim().toLowerCase().replace(/&/g, "and").replace(/\s+/g, " ");
  return GST_STATE_CODES[key] ?? null;
}

/**
 * What is wrong with a business purchase's details, or null when fine. A GSTIN needs the legal
 * name registered with it, and must belong to the state of the billing address (its first two digits).
 */
export function businessDetailsProblem(rawGstin: string, legalName: string, addressState?: string | null): string | null {
  const gstin = normaliseGstin(rawGstin);
  if (!gstin) return "Enter your GSTIN, or switch off \"Buying for a business\"";
  if (gstin.length !== 15) return "A GSTIN has 15 characters";
  if (!GSTIN_REGEX.test(gstin)) return "This is not a valid GSTIN (for example 29ABCDE1234F1Z5)";
  if (legalName.trim().length < 2) return "Enter the legal business name registered with this GSTIN";
  const code = gstStateCodeOf(addressState);
  if (code && gstin.slice(0, 2) !== code) {
    return `This GSTIN is registered in state code ${gstin.slice(0, 2)}, but the address is in ${addressState} (${code}). Use an address in the GSTIN's state.`;
  }
  return null;
}
