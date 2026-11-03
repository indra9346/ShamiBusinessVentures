/*
 * Rice sample and purchase desk (Admin > Rice Samples). Samples arrive with a price per quintal, get cooked and
 * tested, and one is chosen. Raising its Zoho purchase order happens here. No framework imports, so the node
 * tests run the same code the server runs: the store (database functions) and the Zoho calls are passed in.
 *
 * What stops a second purchase order:
 *   1. rice_sample_po_claim (database): one row per sample, the sample's row locked while deciding. Only the
 *      caller told "claimed" may send anything to Zoho.
 *   2. A send that gets no clear answer becomes "uncertain". Nothing is sent again until Zoho has been searched
 *      for the sample's reference and at least two minutes have passed.
 *   3. If a second one exists all the same, it is found by the same reference and shown to the admin.
 */

import { GST_STATE_CODES, GSTIN_REGEX } from "./gstin.ts";
import { ZOHO_PLACE_CODES } from "./zoho-sync-core.ts";

/** settings row: { issueOnCreate: boolean }. No row means Draft. */
export const RICE_PO_SETTINGS_KEY = "rice_po_settings";

// ---------------------------------------------------------------- Samples

export type SampleStatus = "arrived" | "tested" | "selected" | "discarded" | "unavailable";
export type PartyRole = "broker" | "seller";
export type GrainResult = "separate" | "slightly_sticky" | "sticky";
export type SwellingResult = "good" | "ok" | "poor";
export type TasteResult = "good" | "ok" | "off";
export type BrokenResult = "few" | "some" | "many";

export type RiceSample = {
  id: string; sample_no: number; arrival_date: string; variety: string; method: string; price_per_qntl: number; quantity_qntl: number;
  party_role: PartyRole; party_name: string; party_phone: string; seller_name: string; notes: string;
  status: SampleStatus; status_reason: string; status_changed_at: string; created_by_name: string; created_at: string; updated_at: string;
  deleted_at: string | null; deleted_by_name: string; deleted_reason: string;
};
export type RiceTest = {
  id: string; sample_id: string; tested_at: string; tested_by_name: string; score: number;
  grain: GrainResult; swelling: SwellingResult; taste: TasteResult; broken: BrokenResult; notes: string; recorded_at: string;
};
export type RiceEvent = {
  id: number; sample_id: string; action: string; from_status: string | null; to_status: string | null;
  detail: string; actor_name: string; at: string;
};
export type PoState = "sending" | "uncertain" | "rejected" | "raised" | "dead";
export type PoDeathReason = "cancelled" | "rejected" | "deleted";
/** A purchase order this sample once had, now dead in Zoho, or a duplicate that went with it. Kept for good. */
export type RetiredPo = {
  generation: number; reference: string; id: string; number: string; status: string; reason: PoDeathReason | "duplicate"; total: number | null; vendor_name: string | null;
  quantity_qntl: number | null; rate_per_qntl: number | null; raised_at: string | null; raised_by_name: string; retired_at: string; retired_by: string; note: string;
};
export type RicePo = {
  sample_id: string; reference: string; state: PoState; generation: number; retired_pos: RetiredPo[]; attempt_id: string; attempts: number; snapshot: PoPlan;
  claimed_by_name: string; claimed_at: string; last_error: string; zoho_po_id: string; zoho_po_number: string; zoho_po_status: string;
  zoho_sub_total: number | null; zoho_tax_total: number | null; zoho_total: number | null; differences: string[];
  duplicates: PoFound[]; zoho_gone: boolean; zoho_checked_at: string | null; raised_at: string | null; raised_by_name: string;
};

export const STATUS_LABELS: Record<SampleStatus, string> = {
  arrived: "Arrived", tested: "Tested", selected: "PO raised", discarded: "Discarded", unavailable: "Unavailable",
};
export const GRAIN_LABELS: Record<GrainResult, string> = { separate: "Separate", slightly_sticky: "Slightly sticky", sticky: "Sticky" };
export const SWELLING_LABELS: Record<SwellingResult, string> = { good: "Good", ok: "OK", poor: "Poor" };
export const TASTE_LABELS: Record<TasteResult, string> = { good: "Good", ok: "OK", off: "Off" };
export const BROKEN_LABELS: Record<BrokenResult, string> = { few: "Few", some: "Some", many: "Many" };

/** The short number written on the sample's bag. */
export const sampleLabel = (sampleNo: number) => `S-${sampleNo}`;

/** Still in the running to be bought. */
export const inPlay = (status: SampleStatus) => status === "arrived" || status === "tested";

/**
 * The variety and method choices for the sample form: for now, what has been typed on earlier samples. The client's
 * master list is being built separately; when it is ready, this one function changes to read it.
 */
export function riceTextOptions(samples: Pick<RiceSample, "variety" | "method">[]) {
  const unique = (values: string[]) => [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return { varieties: unique(samples.map((sample) => sample.variety)), methods: unique(samples.map((sample) => sample.method)) };
}

/** The newest test decides a sample's score: a later retest replaces the earlier opinion, and the earlier one stays on record. */
export function latestTest(tests: RiceTest[]): RiceTest | null {
  let newest: RiceTest | null = null;
  for (const test of tests) {
    if (!newest || test.tested_at > newest.tested_at || (test.tested_at === newest.tested_at && test.recorded_at > newest.recorded_at)) newest = test;
  }
  return newest;
}

export function testsBySample(tests: RiceTest[]) {
  const map = new Map<string, RiceTest[]>();
  for (const test of tests) map.set(test.sample_id, [...(map.get(test.sample_id) ?? []), test]);
  for (const list of map.values()) list.sort((a, b) => b.tested_at.localeCompare(a.tested_at) || b.recorded_at.localeCompare(a.recorded_at));
  return map;
}

export type SampleSort = "score" | "price" | "arrival_new" | "arrival_old";
export const SORT_LABELS: Record<SampleSort, string> = {
  score: "Best score first", price: "Lowest price first", arrival_new: "Newest arrival first", arrival_old: "Oldest arrival first",
};

/** Samples still in play come first, whatever the sort. Untested ones come after tested ones when sorting by score; ties fall to the lower price, then the earlier arrival. */
export function sortSamples<T extends Pick<RiceSample, "id" | "arrival_date" | "price_per_qntl" | "status">>(samples: T[], sort: SampleSort, tests: Map<string, RiceTest[]>): T[] {
  const score = (sample: T) => latestTest(tests.get(sample.id) ?? [])?.score ?? -1;
  const byPrice = (a: T, b: T) => Number(a.price_per_qntl) - Number(b.price_per_qntl);
  const byArrival = (a: T, b: T) => a.arrival_date.localeCompare(b.arrival_date);
  const byId = (a: T, b: T) => a.id.localeCompare(b.id);
  const compare: Record<SampleSort, (a: T, b: T) => number> = {
    score: (a, b) => score(b) - score(a) || byPrice(a, b) || byArrival(a, b) || byId(a, b),
    price: (a, b) => byPrice(a, b) || score(b) - score(a) || byArrival(a, b) || byId(a, b),
    arrival_new: (a, b) => byArrival(b, a) || score(b) - score(a) || byPrice(a, b) || byId(a, b),
    arrival_old: (a, b) => byArrival(a, b) || score(b) - score(a) || byPrice(a, b) || byId(a, b),
  };
  const playOrder = (sample: T) => (inPlay(sample.status) ? 0 : 1);
  return [...samples].sort((a, b) => playOrder(a) - playOrder(b) || compare[sort](a, b));
}

/**
 * Which samples in a side-by-side comparison have the best price and the best score. All of them when tied, none when only one
 * has a figure. Only samples still in play count, and an off taste or smell is never the best score.
 */
export function bestInComparison(samples: Pick<RiceSample, "id" | "price_per_qntl" | "status">[], tests: Map<string, RiceTest[]>) {
  const open = samples.filter((sample) => inPlay(sample.status));
  const known = open.flatMap((sample) => {
    const test = latestTest(tests.get(sample.id) ?? []);
    return test && test.taste !== "off" ? [{ id: sample.id, score: test.score }] : [];
  });
  const topScore = Math.max(...known.map((entry) => entry.score));
  const lowest = Math.min(...open.map((sample) => Number(sample.price_per_qntl)));
  return {
    bestScore: known.length > 1 ? new Set(known.filter((entry) => entry.score === topScore).map((entry) => entry.id)) : new Set<string>(),
    bestPrice: open.length > 1 ? new Set(open.filter((sample) => Number(sample.price_per_qntl) === lowest).map((sample) => sample.id)) : new Set<string>(),
  };
}

/** Digits only, without a leading 91 on a 12-digit number. */
export const phoneDigits = (raw: string) => {
  const digits = raw.replace(/\D/g, "");
  return digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
};
export const isSamplePhone = (raw: string) => /^\d{10,13}$/.test(raw.replace(/\D/g, ""));
/** A tap-to-call address, and a WhatsApp one where the number can have one (India by default). */
export function phoneLinks(raw: string) {
  const digits = raw.replace(/\D/g, "").replace(/^0+/, "");
  const international = digits.length === 10 ? `91${digits}` : digits;
  return { tel: `tel:+${international}`, whatsapp: digits.length >= 10 ? `https://wa.me/${international}` : "" };
}

/**
 * A price that looks like it was typed in the wrong unit, or null. Rice costs thousands of rupees per quintal: ₹42 is almost
 * certainly per kg, ₹1,100 is a price per bag, and ₹4,20,000 has extra digits. A warning only, because a person may know better.
 */
export function priceUnitWarning(pricePerQntl: number): string | null {
  if (!(pricePerQntl > 0)) return null;
  const perKg = (pricePerQntl / 100).toFixed(2);
  if (pricePerQntl < 500) return `That is only ₹${perKg} per kg. This price is per quintal (100 kg). If ₹${pricePerQntl} is per kg, enter ₹${pricePerQntl * 100}.`;
  if (pricePerQntl < 1500) return `That is only ₹${perKg} per kg. This price is per quintal (100 kg), not per bag.`;
  if (pricePerQntl > 20000) return `That is ₹${perKg} per kg. Please check the figure: this price is per quintal (100 kg).`;
  return null;
}

// ---------------------------------------------------------------- Purchase order figures

/** Half-up, on the decimal figure and not its binary neighbour: 0.35 x 3716.5 is 1300.775, which rounds to 1300.78. */
const round = (value: number, places: number) => {
  const clean = Number(value.toPrecision(15));
  return Number(`${Math.round(Number(`${clean}e${places}`))}e-${places}`);
};
export const round2 = (value: number) => round(value, 2);
export const round3 = (value: number) => round(value, 3);

/**
 * What goes into Zoho's Reference# field: "GBS-<sample id>", then "GBS-<sample id>-2" and so on for each new purchase order after
 * one died. A cancelled purchase order stays in Zoho with its reference, so reusing it would make the search find that one.
 */
export const poReference = (sampleId: string, generation = 1) => (generation > 1 ? `GBS-${sampleId}-${generation}` : `GBS-${sampleId}`);

const BULK_UNITS: Record<string, number> = {
  kg: 1, kgs: 1, kilogram: 1, kilograms: 1,
  qtl: 100, qtls: 100, qntl: 100, qntls: 100, quintal: 100, quintals: 100, qt: 100,
  t: 1000, ton: 1000, tons: 1000, tonne: 1000, tonnes: 1000, mt: 1000,
};
export const isBulkUnit = (unit: string) => unit.trim().toLowerCase() in BULK_UNITS;

/**
 * How many kg one unit of a Zoho item is, or null when it cannot be told and a person must say. The unit decides when it
 * is a weight ("qtl"); otherwise the size in the item's name ("Grade A Raw Rice 25kg"). The admin sees and can correct this
 * before anything is sent, because a wrong answer raises a purchase order for the wrong amount of rice.
 */
export function kgPerZohoUnit(unit: string, itemName: string): number | null {
  const weight = BULK_UNITS[unit.trim().toLowerCase()];
  if (weight) return weight;
  const fromName = /(\d+(?:\.\d+)?)\s*(?:kg|kgs|kilo)\b/i.exec(itemName);
  const size = fromName ? Number(fromName[1]) : 0;
  return size > 0 ? size : null;
}

/** What the purchase order line will say, in the Zoho item's own unit. */
export type PoLine = { poQuantity: number; poRate: number; subTotal: number; exactTotal: number };

export function planPoLine(input: { quantityQntl: number; ratePerQntl: number; kgPerUnit: number }): PoLine {
  const poQuantity = round3((input.quantityQntl * 100) / input.kgPerUnit);
  const poRate = round2((input.ratePerQntl * input.kgPerUnit) / 100);
  return { poQuantity, poRate, subTotal: round2(poQuantity * poRate), exactTotal: round2(input.quantityQntl * input.ratePerQntl) };
}

/** What stops this line being raised, in plain words, or null when it is fine. */
export function poLineProblem(input: { quantityQntl: number; ratePerQntl: number; kgPerUnit: number; availableQntl: number; unit: string; itemName: string }): string | null {
  const { quantityQntl, ratePerQntl, kgPerUnit, availableQntl, unit, itemName } = input;
  if (!(quantityQntl > 0)) return "Enter the quantity to buy, in quintals.";
  if (!(ratePerQntl > 0)) return "Enter the agreed price per quintal.";
  if (!(kgPerUnit > 0)) return `Say how many kg one unit of this Zoho item is.`;
  if (isBulkUnit(unit) && kgPerZohoUnit(unit, "") !== kgPerUnit) return `One ${unit} is ${kgPerZohoUnit(unit, "")} kg, not ${kgPerUnit} kg.`;
  if (quantityQntl > availableQntl) return `The seller has ${availableQntl} quintal available. If there is more now, edit the sample first.`;
  const line = planPoLine({ quantityQntl, ratePerQntl, kgPerUnit });
  if (line.poQuantity <= 0 || line.poRate <= 0) return "These figures come to nothing in this Zoho item's unit. Check the item's size.";
  if (!isBulkUnit(unit)) {
    const named = kgPerZohoUnit("", itemName);
    if (named && named !== kgPerUnit) return `"${itemName}" says ${named} kg, not ${kgPerUnit} kg. A wrong size puts the wrong stock in Zoho. Choose the item of the right size, or one sold by weight.`;
    if (Math.abs(line.poQuantity - Math.round(line.poQuantity)) > 0.0005) {
      const whole = Math.floor(line.poQuantity);
      return whole > 0
        ? `${quantityQntl} quintal is not a whole number of ${kgPerUnit} kg units. The nearest below is ${whole} units, which is ${round3((whole * kgPerUnit) / 100)} quintal: enter that, or use an item sold by weight.`
        : `${quantityQntl} quintal is less than one ${kgPerUnit} kg unit.`;
    }
  }
  if (Math.abs(line.subTotal - line.exactTotal) > 1) {
    return `Rounding the rate to paise in this unit moves the total by more than ₹1 (₹${line.subTotal} against ₹${line.exactTotal}). Use an item sold per quintal, or change the price or quantity.`;
  }
  return null;
}

/** Everything the admin confirmed. Saved with the purchase order, and what Zoho's copy is compared with. */
export type PoPlan = {
  reference: string; date: string; vendorRole: PartyRole; vendorId: string; vendorName: string; itemId: string; itemName: string; itemUnit: string;
  kgPerUnit: number; quantityQntl: number; ratePerQntl: number; poQuantity: number; poRate: number; subTotal: number; gstPercent: number | null;
  branchId: string; branchName: string; locationId: string; issueOnCreate: boolean; description: string;
  /** The Zoho company it was raised in. A purchase order from before this was recorded has none. */
  organizationId?: string;
  /** The tax poTaxFrom worked out. A purchase order raised before this was added has none, and a new one is never sent without it. */
  taxId?: string; taxName?: string; taxKind?: PoTax["kind"]; sourceOfSupply?: string; destinationOfSupply?: string;
};

/** The purchase order line's text. The vendor sees it, so it holds nothing internal. */
export const poDescription = (variety: string, method: string, quantityQntl: number, ratePerQntl: number) =>
  `${[variety, method].filter(Boolean).join(", ")}. ${quantityQntl} quintal at Rs ${ratePerQntl} per quintal.`.slice(0, 480);

/** Today in India as YYYY-MM-DD: the purchase order's date. */
export const indiaToday = (nowMs: number) => new Date(nowMs + 330 * 60_000).toISOString().slice(0, 10);

/**
 * The request body. Quotes from Zoho's Inventory purchase order API are in docs/rice-samples.md. Both rate and purchase_rate
 * are sent because the published example uses purchase_rate while Zoho's live purchase orders report rate; recordCreated then
 * compares what Zoho saved with what was confirmed. No purchase order number is sent: Zoho numbers it from the client's own
 * series. Nothing internal (scores, tasting notes) goes in here, because the vendor receives this document. The tax goes on the line, with
 * the two states it depends on. A vendor Zoho marks as not registered gets neither, which is what came back with GST 0 on the first live test.
 * It doesn't fill in the item's name either (a live test showed a line with only the description), so the name goes on the line too.
 */
export function purchaseOrderBody(plan: PoPlan): Record<string, unknown> {
  return {
    vendor_id: plan.vendorId,
    date: plan.date,
    reference_number: plan.reference,
    location_id: plan.locationId,
    is_inclusive_tax: false,
    ...(plan.sourceOfSupply ? { source_of_supply: plan.sourceOfSupply } : {}),
    ...(plan.destinationOfSupply ? { destination_of_supply: plan.destinationOfSupply } : {}),
    line_items: [{
      item_id: plan.itemId,
      name: plan.itemName,
      description: plan.description,
      quantity: plan.poQuantity,
      rate: plan.poRate,
      purchase_rate: plan.poRate,
      location_id: plan.locationId,
      ...(plan.taxId ? { tax_id: plan.taxId } : {}),
    }],
  };
}

const text = (value: unknown) => (value === null || value === undefined ? "" : String(value));
const numberOr = (value: unknown, fallback: number | null = null) => {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
const asRecords = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.map(asRecord) : []);

/** Where Zoho's copy differs from what the admin confirmed, in plain words. Empty when it agrees. */
export function poDifferences(plan: PoPlan, zohoPo: Record<string, unknown>): string[] {
  const out: string[] = [];
  const lines = asRecords(zohoPo["line_items"]);
  const line = lines[0];
  if (text(zohoPo["vendor_id"]) && text(zohoPo["vendor_id"]) !== plan.vendorId) out.push(`Zoho has this for vendor ${text(zohoPo["vendor_name"]) || text(zohoPo["vendor_id"])}, not ${plan.vendorName}.`);
  if (text(zohoPo["location_id"]) && text(zohoPo["location_id"]) !== plan.locationId) out.push(`Zoho placed this at ${text(zohoPo["location_name"]) || "another location"}, not ${plan.branchName}.`);
  if (lines.length > 1) out.push(`Zoho shows ${lines.length} lines, not 1.`);
  if (line) {
    if (text(line["item_id"]) && text(line["item_id"]) !== plan.itemId) out.push(`Zoho's line is for ${text(line["name"]) || "another item"}, not ${plan.itemName}.`);
    if (!text(line["name"])) out.push(`Zoho's line doesn't show the item's name, ${plan.itemName}, so the vendor wouldn't see it.`);
    const quantity = numberOr(line["quantity"]);
    if (quantity !== null && Math.abs(quantity - plan.poQuantity) > 0.0005) out.push(`Zoho's quantity is ${quantity}, not ${plan.poQuantity}.`);
    const rate = numberOr(line["rate"] ?? line["purchase_rate"]);
    if (rate !== null && Math.abs(rate - plan.poRate) > 0.005) out.push(`Zoho's rate is ₹${rate}, not ₹${plan.poRate}.`);
  }
  const subTotal = numberOr(zohoPo["sub_total"]);
  if (subTotal !== null && Math.abs(subTotal - plan.subTotal) > 0.01) out.push(`Zoho's amount before GST is ₹${subTotal}, not ₹${plan.subTotal}.`);
  return [...out, ...poTaxDifferences(plan, zohoPo)];
}

/** The tax part of the comparison. A purchase order from before the tax was recorded has no tax to compare beyond any percentage it showed. */
export function poTaxDifferences(plan: PoPlan, zohoPo: Record<string, unknown>): string[] {
  const out: string[] = [];
  const tax = numberOr(zohoPo["tax_total"]);
  if (plan.taxKind === "none") {
    // The vendor isn't registered, so any tax at all is wrong, however small.
    const noTax = "but Zoho marks the vendor as not registered for GST, so it should carry none.";
    if (tax === null) out.push("Zoho's copy doesn't show the GST on this purchase order.");
    else if (tax > 0) out.push(`Zoho shows GST of ₹${tax} on this purchase order, ${noTax}`);
    const taxedLine = asRecords(zohoPo["line_items"]).find((row) => text(row["tax_id"]));
    if (taxedLine) out.push(`Zoho put ${text(taxedLine["tax_name"]) || "a tax"} on this line, ${noTax}`);
    return out;
  }
  if (tax !== null && plan.gstPercent !== null && plan.gstPercent !== undefined) {
    const expected = round2((plan.subTotal * plan.gstPercent) / 100);
    if (Math.abs(tax - expected) > 1) out.push(`Zoho's GST is ₹${tax}, not the ₹${expected} (${plan.gstPercent}%) you were shown.`);
  }
  if (!plan.taxId) return out;
  const shown = plan.taxName || "the tax you were shown";
  if (tax === null) out.push("Zoho's copy doesn't show the GST on this purchase order.");
  const line = asRecords(zohoPo["line_items"])[0];
  const lineTax = text(line?.["tax_id"]);
  if (line && lineTax !== plan.taxId) out.push(lineTax ? `Zoho put ${text(line["tax_name"]) || "another tax"} on this line, not ${shown}.` : `Zoho's line shows no tax, not ${shown}.`);
  const source = text(zohoPo["source_of_supply"]), destination = text(zohoPo["destination_of_supply"]);
  if (plan.sourceOfSupply && source !== plan.sourceOfSupply) out.push(`Zoho has the vendor's state as ${source ? placeName(source) : "blank"}, not ${placeName(plan.sourceOfSupply)}.`);
  if (plan.destinationOfSupply && destination !== plan.destinationOfSupply) out.push(`Zoho has the delivery state as ${destination ? placeName(destination) : "blank"}, not ${placeName(plan.destinationOfSupply)}.`);
  return out;
}

// ---------------------------------------------------------------- The tax on a purchase order

type PoTaxRoute = "intra" | "inter";
export type PoTax = {
  taxId: string; taxName: string; percent: number;
  /** intra: the vendor and the godown are in the same state, so CGST + SGST. inter: different states, so IGST. none: Zoho marks the vendor as not registered, so no tax. */
  kind: PoTaxRoute | "none";
  /** The parts as Zoho names them, CGST2.5 and SGST2.5, when Zoho lists them. */
  parts: string[];
  /** Zoho's two-letter state codes. */
  sourceOfSupply: string; destinationOfSupply: string;
};
export type PoTaxAnswer = { ok: true; tax: PoTax } | { ok: false; message: string };
/** Said plainly wherever such a purchase order shows. */
export const NO_GST_WORDS = "No GST: vendor not registered";
const NO_GST: PoTax = { taxId: "", taxName: "No GST", percent: 0, kind: "none", parts: [], sourceOfSupply: "", destinationOfSupply: "" };

const PLACE_NAMES: Record<string, string> = Object.fromEntries(Object.entries(GST_STATE_CODES).map(([name, digits]) => [ZOHO_PLACE_CODES[digits] ?? digits, name.replace(/\b(?!and\b)[a-z]/g, (c) => c.toUpperCase())]));
/** Other codes for a state than this site's table holds. Zoho's own code for the vendor is what gets sent; these only stop a false alarm against their GSTIN. */
const OTHER_PLACE_CODES: Record<string, string> = { CG: "CT", OD: "OR", UK: "UT", AP: "AD", DD: "DN" };
const placeName = (code: string) => PLACE_NAMES[OTHER_PLACE_CODES[code] ?? code] ?? code;

/**
 * Works out a purchase order's tax from what Zoho holds: the item's own tax for this route, the route from the vendor's state and
 * the godown's. Each item in Zoho holds two taxes, intra (GST5, a group of CGST and SGST) and inter (IGST5). The rate is the
 * accountant's, so it is never assumed here. When something needed isn't there, or two things disagree, the answer says what to fix,
 * so nothing goes out with GST 0 by accident. A 0% tax set on the item itself is an answer, and the confirm screen says so.
 *
 * A vendor Zoho marks as not registered (business_none) gets no tax, the owner's decision of 3 Nov 2026. That comes only from Zoho's own
 * marking: anything else that isn't plainly registered, or a marking its own GSTIN contradicts, stops, because it isn't clear which is right.
 */
export function poTaxFrom(item: Record<string, unknown>, vendor: Record<string, unknown>, godown: { name: string; stateCode: string }): PoTaxAnswer {
  const stop = (message: string): PoTaxAnswer => ({ ok: false, message });
  const vendorName = text(vendor["contact_name"]) || "This vendor", itemName = text(item["name"]) || "This item";
  const gstin = text(vendor["gst_no"]).trim().toUpperCase();
  const treatment = text(vendor["gst_treatment"]).trim().toLowerCase();
  if (item["is_taxable"] === false) return stop(`${itemName} is marked as not taxable in Zoho, so the website can't tell what tax this purchase order should carry. Ask your accountant.`);
  if (treatment === "business_none") {
    if (gstin) return stop(`Zoho marks ${vendorName} as not registered for GST, but also holds a GSTIN for them, so it isn't clear which is right. Correct it in Zoho.`);
    return { ok: true, tax: NO_GST };
  }
  if (treatment !== "business_gst") return stop(`Zoho doesn't say plainly whether ${vendorName} is registered for GST${treatment ? ` (it says ${treatment.replace(/_/g, " ")})` : ""}, so the website can't tell what tax this purchase order should carry. Correct it in Zoho, or ask your accountant.`);
  if (!gstin) return stop(`Zoho marks ${vendorName} as GST-registered but holds no GSTIN for them, so it isn't clear which is right. Correct it in Zoho.`);
  const source = text(vendor["place_of_contact"]).trim().toUpperCase();
  if (!source) return stop(`Zoho has no state for ${vendorName}. Add it in Zoho: it decides between CGST + SGST and IGST.`);
  if (!GSTIN_REGEX.test(gstin)) return stop(`${vendorName}'s GSTIN in Zoho, ${gstin}, doesn't look right. Correct it in Zoho.`);
  const gstinPlace = ZOHO_PLACE_CODES[gstin.slice(0, 2)];
  if (!gstinPlace || gstinPlace !== (OTHER_PLACE_CODES[source] ?? source)) return stop(`${vendorName}'s GSTIN is from ${gstinPlace ? placeName(gstinPlace) : "an unknown state"}, but Zoho has them in ${placeName(source)}. Correct it in Zoho: it decides between CGST + SGST and IGST.`);
  const destination = ZOHO_PLACE_CODES[godown.stateCode.trim()];
  if (!destination) return stop(`${godown.name} has no state on record. Add it in Admin > Branches: it decides between CGST + SGST and IGST.`);

  const kind: PoTaxRoute = (OTHER_PLACE_CODES[source] ?? source) === destination ? "intra" : "inter";
  const routeOf = (route: PoTaxRoute) => (route === "intra" ? "within the state" : "from another state");
  const taxFor = (route: PoTaxRoute) => asRecords(item["item_tax_preferences"]).find((row) => text(row["tax_specification"]).toLowerCase() === route);
  const chosen = taxFor(kind);
  const taxId = text(chosen?.["tax_id"]), taxName = text(chosen?.["tax_name"]), percent = numberOr(chosen?.["tax_percentage"]);
  if (!chosen || !taxId || !taxName || percent === null || percent < 0) return stop(`${itemName} has no tax for purchases ${routeOf(kind)} in Zoho. Set it on the item in Zoho. The rate is for your accountant.`);
  if (/igst/i.test(taxName) !== (kind === "inter")) return stop(`${itemName}'s tax for purchases ${routeOf(kind)} is ${taxName} in Zoho, which doesn't look right for that. Check it on the item in Zoho.`);
  const otherRoute = kind === "intra" ? "inter" : "intra";
  const otherPercent = numberOr(taxFor(otherRoute)?.["tax_percentage"]);
  if (otherPercent !== null && otherPercent !== percent) return stop(`${itemName} is at ${percent}% ${routeOf(kind)} but ${otherPercent}% ${routeOf(otherRoute)} in Zoho, and they should match. Check it on the item in Zoho.`);
  const groups = asRecords(chosen["tax_groups_details"]);
  if (groups.length && Math.abs(groups.reduce((sum, part) => sum + (numberOr(part["percentage"]) ?? 0), 0) - percent) > 0.001) return stop(`${itemName}'s tax ${taxName} doesn't add up to ${percent}% in Zoho. Check it on the item in Zoho.`);
  return { ok: true, tax: { taxId, taxName, percent, kind, parts: groups.map((part) => text(part["text"])).filter(Boolean), sourceOfSupply: source, destinationOfSupply: destination } };
}

export const poTaxAmount = (subTotal: number, percent: number) => round2((subTotal * percent) / 100);
/** "GST5 (CGST2.5 + SGST2.5)" for the confirm screen. */
export const poTaxLabel = (tax: Pick<PoTax, "taxName" | "parts">) => (tax.parts.length ? `${tax.taxName} (${tax.parts.join(" + ")})` : tax.taxName);
export const poTaxReason = (tax: Pick<PoTax, "kind" | "sourceOfSupply" | "destinationOfSupply">) => (tax.kind === "none" ? "Zoho marks this vendor as not registered for GST, so this purchase order carries no tax." : tax.kind === "intra"
  ? `CGST + SGST, because the vendor and the godown are both in ${placeName(tax.destinationOfSupply)}.`
  : `IGST, because the vendor is in ${placeName(tax.sourceOfSupply)} and the godown in ${placeName(tax.destinationOfSupply)}.`);

const ZOHO_STATUS_LABELS: Record<string, string> = {
  draft: "Draft", open: "Issued", issued: "Issued", billed: "Billed", partially_billed: "Partly billed", cancelled: "Cancelled", closed: "Closed",
  received: "Received", partially_received: "Partly received", pending_approval: "Waiting for approval", approved: "Approved", rejected: "Rejected in Zoho",
};
export const zohoStatusLabel = (status: string) => ZOHO_STATUS_LABELS[status.toLowerCase()] ?? status.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

const ZOHO_APP_HOST: Record<string, string> = {
  in: "inventory.zoho.in", com: "inventory.zoho.com", eu: "inventory.zoho.eu", com_au: "inventory.zoho.com.au", jp: "inventory.zoho.jp", ca: "inventory.zohocloud.ca",
};
export const zohoPoUrl = (region: string, organizationId: string, poId: string) =>
  `https://${ZOHO_APP_HOST[region] ?? ZOHO_APP_HOST["in"]}/app/${organizationId}#/purchaseorders/${poId}`;

// ---------------------------------------------------------------- Zoho's answers

export type ZohoRaw = { status: number; body: Record<string, unknown> | null };
/** One request to Zoho Inventory, never resent. Throws when no answer came back (network failure or timeout). */
export type ZohoSend = (resource: string, method: "GET" | "POST", body?: Record<string, unknown>, query?: Record<string, string>) => Promise<ZohoRaw>;

/**
 * ok: Zoho accepted. rejected: Zoho refused, so nothing was created (the 4xx family, including 429, which Zoho sends without
 * processing the request). uncertain: Zoho may have acted, so nothing may be sent again until it has been searched (a
 * gateway error or an answer that cannot be read).
 */
export function zohoVerdict(raw: ZohoRaw): "ok" | "rejected" | "uncertain" {
  if (raw.status >= 500 || raw.status === 408) return "uncertain";
  if (raw.status >= 400) return "rejected";
  if (raw.status < 200 || raw.status >= 300 || !raw.body) return "uncertain";
  const code = raw.body["code"];
  if (code === 0) return "ok";
  return typeof code === "number" ? "rejected" : "uncertain";
}

export const zohoMessage = (raw: ZohoRaw) => text(raw.body?.["message"]).slice(0, 300) || `Zoho answered ${raw.status}`;

/** Zoho's refusal in plain words, with the step that fixes it where there is one. */
export function plainZohoRefusal(raw: ZohoRaw): string {
  const message = zohoMessage(raw);
  if (raw.status >= 500 && !raw.body) return `Zoho is having trouble just now (error ${raw.status}).`;
  if (raw.status === 401 || /not authori[sz]ed|invalid[_ ]?scope|oauth|permission|access token/i.test(message)) {
    return 'Zoho has not given this website permission for this yet. Open Admin > Zoho Commerce, press "Reauthorize Zoho", accept every permission Zoho lists, then try again.';
  }
  if (raw.status === 429 || /limit|too many/i.test(message)) return "Zoho's limit on requests has been reached for now. Wait a few minutes and try again.";
  if (/purchase ?order ?number|purchaseorder_number/i.test(message)) return `Zoho asks for a purchase order number, which means its automatic numbering is off. Turn it on in Zoho (Settings > Purchase Orders). Zoho said: "${message}"`;
  if (/hsn|sac/i.test(message)) return `The Zoho item needs its HSN code first. Add it to the item in Zoho and try again. Zoho said: "${message}"`;
  return `Zoho said: "${message}"`;
}

// ---------------------------------------------------------------- Finding a purchase order again

export type PoFound = { id: string; number: string; status: string };
const poFoundFrom = (row: Record<string, unknown>): PoFound => ({ id: text(row["purchaseorder_id"]), number: text(row["purchaseorder_number"]), status: poDeathReason(row["status"], row["order_status"]) && !poDeathReason(row["status"]) ? text(row["order_status"]) : text(row["status"]) });
/** Zoho's list may go on past this page. Its published example has no page_context, so a full page without one counts as maybe. */
const pageMayContinue = (listed: Record<string, unknown>, rows: unknown[]) => {
  const more = asRecord(listed["page_context"])["has_more_page"];
  return more === true || (more !== false && rows.length >= Number(PO_PAGE_SIZE));
};

/** 5,000 purchase orders. Zoho holds about 150 today. */
export const PO_SEARCH_MAX_PAGES = 25;
const PO_PAGE_SIZE = "200";

/**
 * Every purchase order in Zoho carrying this exact reference. `complete` says the answer can be trusted to mean "no":
 * Inventory's docs list only page and per_page for this list, so the reference filter is only a quick way to a yes. Its empty
 * answer, or a refusal of the filter, proves nothing and is followed by walking every page. The match is always made here, on
 * the exact reference.
 */
export async function findPurchaseOrdersByReference(zoho: ZohoSend, reference: string): Promise<{ matches: PoFound[]; complete: boolean; problem: string }> {
  const seen = new Map<string, PoFound>();
  const take = (rows: Record<string, unknown>[]) => {
    for (const row of rows) {
      if (text(row["reference_number"]).trim() === reference && text(row["purchaseorder_id"])) seen.set(text(row["purchaseorder_id"]), poFoundFrom(row));
    }
  };
  const read = async (query: Record<string, string>) => {
    const raw = await zoho("purchaseorders", "GET", undefined, query);
    if (zohoVerdict(raw) !== "ok") throw new Error(plainZohoRefusal(raw));
    return asRecord(raw.body);
  };
  try {
    const filtered = await read({ reference_number: reference, per_page: PO_PAGE_SIZE });
    const rows = asRecords(filtered["purchaseorders"]);
    take(rows);
    if (seen.size && !pageMayContinue(filtered, rows)) return { matches: [...seen.values()], complete: true, problem: "" };
  } catch {
    // The walk below decides.
  }
  try {
    for (let page = 1; page <= PO_SEARCH_MAX_PAGES; page += 1) {
      const listed = await read({ page: String(page), per_page: PO_PAGE_SIZE });
      const rows = asRecords(listed["purchaseorders"]);
      take(rows);
      if (!pageMayContinue(listed, rows)) return { matches: [...seen.values()], complete: true, problem: "" };
    }
    return { matches: [...seen.values()], complete: false, problem: `Zoho holds more purchase orders than this search reads (${PO_SEARCH_MAX_PAGES} pages).` };
  } catch (cause) {
    return { matches: [...seen.values()], complete: false, problem: cause instanceof Error ? cause.message : "Zoho could not be searched." };
  }
}

// ---------------------------------------------------------------- Raising the purchase order

export type PoActor = { userId: string; name: string };
export type ClaimAnswer =
  | { outcome: "claimed"; attempts: number }
  | { outcome: "already_raised"; po: RicePo }
  | { outcome: "in_progress"; by: string; since: string }
  | { outcome: "verify_first"; attempt_id: string; claimed_at: string; snapshot: PoPlan; attempts: number };
export type TakeoverAnswer = { outcome: "claimed"; attempts: number } | { outcome: "too_soon"; wait_seconds: number } | { outcome: "changed" };
export type RecordAnswer = { outcome: "recorded" | "same" | "duplicate"; po: RicePo };
export type ReleaseAnswer = { outcome: "released" } | { outcome: "too_soon"; wait_seconds: number } | { outcome: "changed" };

/** The database functions. The server passes rice_sample_po_* calls; the tests pass an in-memory copy of the same rules. */
export type PoStore = {
  claim(args: { sampleId: string; attemptId: string; reference: string; snapshot: PoPlan; actor: PoActor }): Promise<ClaimAnswer>;
  takeover(args: { sampleId: string; expectedAttempt: string; attemptId: string; snapshot: PoPlan; actor: PoActor }): Promise<TakeoverAnswer>;
  release(args: { sampleId: string; expectedAttempt: string; actor: PoActor }): Promise<ReleaseAnswer>;
  markFailed(args: { sampleId: string; attemptId: string; state: "rejected" | "uncertain"; message: string; detail: string; actor: PoActor }): Promise<void>;
  record(args: { sampleId: string; po: PoFound; subTotal: number | null; taxTotal: number | null; total: number | null; differences: string[]; foundBySearch: boolean; actor: PoActor }): Promise<RecordAnswer>;
};

export type RaiseResult =
  /** It exists in Zoho. `warnings` say anything a person must look at. */
  | { kind: "raised"; poId: string; poNumber: string; poStatus: string; total: number | null; warnings: string[]; already: boolean }
  /** Zoho refused. Nothing was created; fix it and try again. */
  | { kind: "rejected"; message: string }
  /** Nobody can tell yet. The sample stays locked until Zoho has been searched. */
  | { kind: "uncertain"; message: string; retryAfterSeconds: number; searchIncomplete?: boolean }
  /** Searched in full, and Zoho has none: the admin may raise it again. */
  | { kind: "absent"; message: string }
  /** Another request is sending it right now. */
  | { kind: "in_progress"; message: string };

export const PO_RETRY_SECONDS = 120;
const UNCERTAIN_NOTE = "Do not create it by hand in Zoho.";
/**
 * Seconds until a search can count as proof that nothing landed. The search itself must start after the two minutes: a page read
 * just before the mark can miss a purchase order landing just after it. Five seconds spare covers the server and database clocks.
 */
const elapsedWait = (claimedAt: string, nowMs: number) => Math.max(0, PO_RETRY_SECONDS + 5 - Math.floor((nowMs - Date.parse(claimedAt)) / 1000));
const tooSoon = (wait: number): RaiseResult => ({ kind: "uncertain", retryAfterSeconds: wait, message: `Zoho has no purchase order for this sample yet, but it may still be working on the last request. Check again in ${wait} seconds. ${UNCERTAIN_NOTE}` });

/** What differs between the purchase order already raised and what this admin just confirmed. Empty when they agree. */
export function differsFromRaised(saved: PoPlan, wanted: Pick<PoPlan, "vendorId" | "itemId" | "quantityQntl" | "ratePerQntl" | "branchId" | "taxId" | "taxKind">): string[] {
  const out: string[] = [];
  if (saved.vendorId !== wanted.vendorId) out.push(`vendor ${saved.vendorName}`);
  if (saved.itemId !== wanted.itemId) out.push(`item ${saved.itemName}`);
  if (Number(saved.quantityQntl) !== wanted.quantityQntl) out.push(`${saved.quantityQntl} quintal`);
  if (Number(saved.ratePerQntl) !== wanted.ratePerQntl) out.push(`Rs ${saved.ratePerQntl} per quintal`);
  if (saved.branchId !== wanted.branchId) out.push(`godown ${saved.branchName}`);
  const taxOf = (plan: Pick<PoPlan, "taxId" | "taxKind">) => (plan.taxKind === "none" ? "none" : plan.taxId);
  if (taxOf(saved) && taxOf(wanted) && taxOf(saved) !== taxOf(wanted)) out.push(`tax ${saved.taxName || saved.taxId}`);
  return out.length ? [`The purchase order already raised for this sample is not what you just confirmed. It has: ${out.join(", ")}. Check it in Zoho.`] : [];
}

type RaiseDeps = { store: PoStore; zoho: ZohoSend; newId: () => string; now: () => number; log?: (event: string, detail: Record<string, unknown>) => void };

/** Reads Zoho's full copy for its totals and for comparing with the plan. A failed read is not a failure of the purchase order. */
async function fullPo(zoho: ZohoSend, poId: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await zoho(`purchaseorders/${encodeURIComponent(poId)}`, "GET");
    if (zohoVerdict(raw) !== "ok") return null;
    const po = asRecord(raw.body?.["purchaseorder"] ?? raw.body?.["purchase_order"]);
    return text(po["purchaseorder_id"]) ? po : null;
  } catch {
    return null;
  }
}

const duplicateWarning = (reference: string, others: PoFound[]) =>
  `Zoho holds more than one purchase order with reference ${reference}: ${others.map((po) => po.number || po.id).join(", ")}. Open Zoho and delete the extra one.`;

/** Saves what Zoho holds. If saving fails the purchase order still exists, so the answer says so and Check Zoho will find it. */
async function saveFound(
  deps: RaiseDeps, plan: PoPlan, sampleId: string, found: PoFound, zohoCopy: Record<string, unknown> | null, foundBySearch: boolean, actor: PoActor, extra: string[], wanted: PoPlan = plan,
): Promise<RaiseResult> {
  // wanted is what the admin has just confirmed, when Zoho turned out to hold one from an earlier attempt.
  const differences = zohoCopy ? [...new Set([...poDifferences(plan, zohoCopy), ...poTaxDifferences(wanted, zohoCopy)])]
    : plan.taxId || plan.taxKind || wanted.taxId || wanted.taxKind ? ["Zoho's copy could not be read, so its figures and GST were not compared with what was confirmed."] : [];
  const status = text(zohoCopy?.["status"]) || found.status || "draft";
  const totals = { subTotal: numberOr(zohoCopy?.["sub_total"]), taxTotal: numberOr(zohoCopy?.["tax_total"]), total: numberOr(zohoCopy?.["total"]) };
  let answer: RecordAnswer | null = null;
  for (let attempt = 0; attempt < 2 && !answer; attempt += 1) {
    try {
      answer = await deps.store.record({ sampleId, po: { ...found, status }, ...totals, differences, foundBySearch, actor });
    } catch (cause) {
      deps.log?.("rice_po_record_failed", { sampleId, poId: found.id, message: cause instanceof Error ? cause.message : String(cause) });
    }
  }
  if (!answer) {
    return {
      kind: "uncertain", retryAfterSeconds: 0,
      message: `Zoho has purchase order ${found.number || found.id}, but the website could not save it. ${UNCERTAIN_NOTE} Press Check Zoho to link it.`,
    };
  }
  const saved = answer.po;
  return {
    kind: "raised", poId: saved.zoho_po_id, poNumber: saved.zoho_po_number, poStatus: saved.zoho_po_status,
    total: numberOr(saved.zoho_total), already: answer.outcome !== "recorded",
    warnings: [
      ...differences, ...extra,
      ...(foundBySearch && plan.issueOnCreate && status.toLowerCase() === "draft" ? ["This purchase order is a Draft in Zoho. Issue it there."] : []),
      ...(answer.outcome === "duplicate" ? [duplicateWarning(plan.reference, [{ id: saved.zoho_po_id, number: saved.zoho_po_number, status: saved.zoho_po_status }, found])] : []),
    ],
  };
}

/** Searches Zoho for this sample's reference and records what it finds. Null when Zoho has nothing. */
async function adoptFromSearch(deps: RaiseDeps, sampleId: string, plan: PoPlan, actor: PoActor, wanted: PoPlan = plan) {
  const search = await findPurchaseOrdersByReference(deps.zoho, plan.reference);
  if (!search.matches.length) return { adopted: null, search };
  const [first, ...others] = search.matches as [PoFound, ...PoFound[]];
  const copy = await fullPo(deps.zoho, first.id);
  const adopted = await saveFound(deps, plan, sampleId, first, copy, true, actor, [...differsFromRaised(plan, wanted), ...(others.length ? [duplicateWarning(plan.reference, search.matches)] : [])], wanted);
  for (const other of others) {
    await deps.store.record({ sampleId, po: other, subTotal: null, taxTotal: null, total: null, differences: [], foundBySearch: true, actor }).catch(() => undefined);
  }
  return { adopted, search };
}

/**
 * Raises the purchase order for one sample, at most once. The plan is what the admin confirmed on screen. The server has
 * already checked the figures and read the vendor and item from Zoho.
 */
export async function raiseRicePo(deps: RaiseDeps, sampleId: string, plan: PoPlan, actor: PoActor): Promise<RaiseResult> {
  // Without a tax on the line Zoho saves GST 0, so this is the last stop before anything goes out. Only poTaxFrom's plain "no GST" gets past with none.
  if (!plan.taxId && plan.taxKind !== "none") return { kind: "rejected", message: "The tax for this purchase order hasn't been worked out, so nothing was sent to Zoho. Review it and confirm again." };
  const attemptId = deps.newId();
  const claim = await deps.store.claim({ sampleId, attemptId, reference: plan.reference, snapshot: plan, actor });
  if (claim.outcome === "already_raised") {
    const po = claim.po;
    return { kind: "raised", poId: po.zoho_po_id, poNumber: po.zoho_po_number, poStatus: po.zoho_po_status, total: numberOr(po.zoho_total), warnings: differsFromRaised(po.snapshot, plan), already: true };
  }
  if (claim.outcome === "in_progress") {
    return { kind: "in_progress", message: `${claim.by || "Another admin"} is raising this purchase order right now. It will show here in a moment.` };
  }
  let attempts = claim.outcome === "claimed" ? claim.attempts : 0;
  if (claim.outcome === "verify_first") {
    // An earlier send may have reached Zoho. Zoho is asked first, and what it holds wins.
    const wait = elapsedWait(claim.claimed_at, deps.now());
    const { adopted, search } = await adoptFromSearch(deps, sampleId, claim.snapshot, actor, plan);
    if (adopted) return adopted;
    if (!search.complete) return { kind: "uncertain", retryAfterSeconds: 0, searchIncomplete: true, message: `Zoho could not be searched in full, so it is not safe to send again. ${search.problem} ${UNCERTAIN_NOTE}` };
    if (wait > 0) return tooSoon(wait);
    const taken = await deps.store.takeover({ sampleId, expectedAttempt: claim.attempt_id, attemptId, snapshot: plan, actor });
    if (taken.outcome === "too_soon") {
      return { kind: "uncertain", retryAfterSeconds: Math.max(1, Number(taken.wait_seconds)), message: `Zoho may still be working on the last request. Wait ${Math.max(1, Number(taken.wait_seconds))} seconds, then press Check Zoho. ${UNCERTAIN_NOTE}` };
    }
    if (taken.outcome === "changed") return { kind: "in_progress", message: "Someone else has just acted on this purchase order. It will show here in a moment." };
    attempts = taken.attempts;
  } else if (attempts > 1) {
    // Refused or freed earlier, so the lock let this through. An earlier send could still have landed since: never send blind.
    const { adopted, search } = await adoptFromSearch(deps, sampleId, plan, actor);
    if (adopted) return adopted;
    if (!search.complete) {
      const message = `Zoho could not be searched in full, so it is not safe to send again. ${search.problem} ${UNCERTAIN_NOTE}`;
      await markFailedQuietly(deps, { sampleId, attemptId, state: "uncertain", message, detail: search.problem, actor });
      return { kind: "uncertain", retryAfterSeconds: 0, searchIncomplete: true, message };
    }
  }

  let raw: ZohoRaw;
  try {
    raw = await deps.zoho("purchaseorders", "POST", purchaseOrderBody(plan));
  } catch (cause) {
    return afterUnclearAnswer(deps, sampleId, attemptId, plan, actor, cause instanceof Error ? cause.message : "no answer");
  }
  const verdict = zohoVerdict(raw);
  if (verdict === "rejected") {
    const message = `${plainZohoRefusal(raw)} Nothing was created in Zoho.`;
    await markFailedQuietly(deps, { sampleId, attemptId, state: "rejected", message, detail: zohoMessage(raw), actor });
    return { kind: "rejected", message };
  }
  const created = asRecord(raw.body?.["purchase_order"] ?? raw.body?.["purchaseorder"]);
  const poId = text(created["purchaseorder_id"]);
  if (verdict === "uncertain" || !poId) return afterUnclearAnswer(deps, sampleId, attemptId, plan, actor, `Zoho answered ${raw.status}`);

  const warnings: string[] = [];
  let copy: Record<string, unknown> | null = created;
  let status = text(created["status"]) || "draft";
  if (plan.issueOnCreate) {
    // The purchase order exists whatever happens here, so a failure is a warning for a person and never a reason to send it again.
    try {
      const issued = await deps.zoho(`purchaseorders/${encodeURIComponent(poId)}/status/issued`, "POST");
      if (zohoVerdict(issued) === "ok") status = "open";
      else warnings.push(`The purchase order is in Zoho as a Draft: Zoho would not mark it Issued. Issue it in Zoho. ${plainZohoRefusal(issued)}`);
    } catch {
      warnings.push("The purchase order is in Zoho, but marking it Issued got no answer. Check it in Zoho and issue it there if it still says Draft.");
    }
  }
  // What Zoho saved is what gets compared, not its reply to the request. If it can't be read, the reply is the next best.
  copy = (await fullPo(deps.zoho, poId)) ?? created;
  status = text(copy["status"]) || status;
  if (attempts > 1) {
    // A resend: if the first request was processed after all, both now exist. Say so at once.
    const search = await findPurchaseOrdersByReference(deps.zoho, plan.reference);
    const others = search.matches.filter((po) => po.id !== poId);
    if (others.length) {
      warnings.push(duplicateWarning(plan.reference, [{ id: poId, number: text(created["purchaseorder_number"]), status }, ...others]));
      const result = await saveFound(deps, plan, sampleId, { id: poId, number: text(created["purchaseorder_number"]), status }, copy, false, actor, warnings);
      for (const other of others) await deps.store.record({ sampleId, po: other, subTotal: null, taxTotal: null, total: null, differences: [], foundBySearch: true, actor }).catch(() => undefined);
      return result;
    }
  }
  return saveFound(deps, plan, sampleId, { id: poId, number: text(created["purchaseorder_number"]), status }, copy, false, actor, warnings);
}

/** A record that could not be saved leaves the row as "sending", which the lock treats as unknown after two minutes. That is safe, and it must not stop the rest. */
async function markFailedQuietly(deps: RaiseDeps, args: Parameters<PoStore["markFailed"]>[0]) {
  try {
    await deps.store.markFailed(args);
  } catch (cause) {
    deps.log?.("rice_po_mark_failed_failed", { sampleId: args.sampleId, message: cause instanceof Error ? cause.message : String(cause) });
  }
}

/** Zoho may or may not have created it. Search at once, because usually it did and only the answer was lost. */
async function afterUnclearAnswer(deps: RaiseDeps, sampleId: string, attemptId: string, plan: PoPlan, actor: PoActor, detail: string): Promise<RaiseResult> {
  const pending = `Zoho did not give a clear answer, so the purchase order may or may not exist. The sample stays locked until Zoho has been checked. Wait ${PO_RETRY_SECONDS / 60} minutes, then press Check Zoho. ${UNCERTAIN_NOTE}`;
  await markFailedQuietly(deps, { sampleId, attemptId, state: "uncertain", message: pending, detail, actor });
  const { adopted } = await adoptFromSearch(deps, sampleId, plan, actor);
  return adopted ?? { kind: "uncertain", retryAfterSeconds: PO_RETRY_SECONDS, message: pending };
}

/**
 * The Check Zoho button: read-only towards Zoho. Links the purchase order if Zoho has it. If a complete search at least two
 * minutes after the last send finds nothing, nothing exists, so the sample is freed: it can be raised again, discarded or
 * marked unavailable.
 */
export async function checkRicePo(deps: RaiseDeps, sampleId: string, po: Pick<RicePo, "snapshot" | "claimed_at" | "attempt_id">, actor: PoActor): Promise<RaiseResult> {
  const wait = elapsedWait(po.claimed_at, deps.now());
  const { adopted, search } = await adoptFromSearch(deps, sampleId, po.snapshot, actor);
  if (adopted) return adopted;
  if (!search.complete) return { kind: "uncertain", retryAfterSeconds: 0, searchIncomplete: true, message: `Zoho could not be searched in full. ${search.problem} ${UNCERTAIN_NOTE}` };
  if (wait > 0) return tooSoon(wait);
  const released = await deps.store.release({ sampleId, expectedAttempt: po.attempt_id, actor });
  if (released.outcome === "too_soon") return { kind: "uncertain", retryAfterSeconds: Math.max(1, Number(released.wait_seconds)), message: `Zoho may still be working on the last request. Check again in ${Math.max(1, Number(released.wait_seconds))} seconds. ${UNCERTAIN_NOTE}` };
  if (released.outcome === "changed") return { kind: "in_progress", message: "Someone else has just acted on this purchase order. It will show here in a moment." };
  return { kind: "absent", message: "Zoho has no purchase order for this sample, after a full search. You can raise it again, or discard the sample or mark it unavailable." };
}

// ---------------------------------------------------------------- After raising: Zoho in control

/** Zoho's statuses that mean this purchase order will not go ahead. Anything not listed counts as alive, so an unknown status never frees a sample. */
const DEATH_BY_STATUS: Record<string, PoDeathReason> = {
  cancelled: "cancelled", canceled: "cancelled", cancelled_by_user: "cancelled", cancelled_by_vendor: "cancelled", void: "cancelled", voided: "cancelled", rejected: "rejected",
};
const NOT_CANCELLABLE = new Set(["billed", "partially_billed", "closed", "received", "partially_received", "manually_received", "billed_not_received", "received_not_billed", "drop_shipped"]);
/** status decides. order_status counts only while status still looks open, never once rice has been received or billed. */
export function poDeathReason(status: unknown, orderStatus?: unknown): PoDeathReason | null {
  const main = text(status).trim().toLowerCase();
  return DEATH_BY_STATUS[main] ?? (NOT_CANCELLABLE.has(main) ? null : DEATH_BY_STATUS[text(orderStatus).trim().toLowerCase()] ?? null);
}
/** Whether to offer Cancel: not once rice has been received or billed against it, which belongs in Zoho. */
export const canCancelPo = (status: string) => !NOT_CANCELLABLE.has(status.trim().toLowerCase()) && !poDeathReason(status);
export const PO_DEATH_WORDS: Record<RetiredPo["reason"], string> = { cancelled: "cancelled", rejected: "rejected", deleted: "deleted", duplicate: "a duplicate" };

/**
 * Zoho's own answer that this purchase order does not exist, as read from the live API: code 1002, "Purchase Order does not exist."
 * A bare 404 is not enough: Zoho answers an address it doesn't know with 404 too, and that must never free a sample.
 */
export const zohoSaysNoSuchPo = (raw: ZohoRaw) => zohoVerdict(raw) === "rejected" && (raw.body?.["code"] === 1002 || /purchase ?order does not exist/i.test(zohoMessage(raw)));

export type PoNow = { gone: boolean; status: string; deathReason: PoDeathReason | null; subTotal: number | null; taxTotal: number | null; total: number | null };
/** Zoho's current view of a purchase order. Null: Zoho could not be asked. */
export async function readPoStatus(zoho: ZohoSend, poId: string): Promise<PoNow | null> {
  let raw: ZohoRaw;
  try {
    raw = await zoho(`purchaseorders/${encodeURIComponent(poId)}`, "GET");
  } catch {
    return null;
  }
  if (zohoSaysNoSuchPo(raw)) return { gone: true, status: "", deathReason: null, subTotal: null, taxTotal: null, total: null };
  if (zohoVerdict(raw) !== "ok") return null;
  const po = asRecord(raw.body?.["purchaseorder"] ?? raw.body?.["purchase_order"]);
  if (!text(po["status"])) return null;
  return { gone: false, status: text(po["status"]), deathReason: poDeathReason(po["status"], po["order_status"]), subTotal: numberOr(po["sub_total"]), taxTotal: numberOr(po["tax_total"]), total: numberOr(po["total"]) };
}

export type RaisedPo = Pick<RicePo, "sample_id" | "reference" | "zoho_po_id" | "zoho_po_number" | "zoho_po_status" | "duplicates" | "retired_pos"> & Partial<Pick<RicePo, "zoho_checked_at" | "snapshot">>;
/** The database functions rice_sample_po_refresh, rice_sample_po_mark_dead and rice_sample_po_cancel_asked. */
export type PoLifeStore = {
  refresh(args: { sampleId: string; poId: string; status: string | null; subTotal: number | null; taxTotal: number | null; total: number | null; gone: boolean; duplicates: PoFound[] | null }): Promise<void>;
  markDead(args: { sampleId: string; poId: string; reason: PoDeathReason; status: string; note: string; actor: PoActor | null }): Promise<{ outcome: "freed" | "changed" }>;
  cancelAsked(args: { sampleId: string; number: string; reason: string; actor: PoActor }): Promise<void>;
};
/** organizationId: the Zoho company the website is connected to now. */
export type PoLifeDeps = { store: PoLifeStore; zoho: ZohoSend; organizationId?: string };
export type SettleResult =
  | { kind: "alive"; status: string }
  /** Dead in Zoho, confirmed twice: the sample is back in play. */
  | { kind: "freed"; reason: PoDeathReason; number: string }
  /** Dead, but Zoho holds another purchase order with this reference, so freeing the sample could make a third. */
  | { kind: "blocked"; message: string }
  /** listBehind: Zoho's read says this, and only its list hasn't caught up yet. Not a failure, and the next check sorts it out. */
  | { kind: "unknown"; message: string; listBehind?: PoDeathReason }
  /** Someone else settled it first. */
  | { kind: "changed" };

/**
 * Asks Zoho about one raised purchase order and acts on the answer. Freeing a sample needs two separate answers, so one odd reply
 * cannot lead to a second purchase order: the purchase order itself says it is dead, and a complete search by reference agrees.
 */
export async function settleRaisedPo(deps: PoLifeDeps, po: RaisedPo, actor: PoActor | null, note = ""): Promise<SettleResult> {
  // Another company's books have none of this company's purchase orders, which would read exactly like every one being deleted.
  if (deps.organizationId && po.snapshot?.organizationId && po.snapshot.organizationId !== deps.organizationId) {
    return { kind: "unknown", message: `${po.zoho_po_number} was raised in another Zoho company than the one connected now, so the sample stays locked. Check Admin > Zoho Commerce.` };
  }
  const now = await readPoStatus(deps.zoho, po.zoho_po_id);
  if (!now) return { kind: "unknown", message: "Zoho could not be asked just now. The status shown is from the last check." };
  const reason: PoDeathReason | null = now.gone ? "deleted" : now.deathReason;
  if (!reason) {
    await deps.store.refresh({ sampleId: po.sample_id, poId: po.zoho_po_id, status: now.status, subTotal: now.subTotal, taxTotal: now.taxTotal, total: now.total, gone: false, duplicates: null });
    return { kind: "alive", status: now.status };
  }
  const search = await findPurchaseOrdersByReference(deps.zoho, po.reference);
  if (!search.complete) return { kind: "unknown", message: `Zoho shows ${po.zoho_po_number} as ${PO_DEATH_WORDS[reason]}, but its list could not be read in full, so the sample stays locked for now. ${search.problem}` };
  // Its own row in the search must agree: not listed at all if deleted, listed as dead if cancelled or rejected. Seen live: for under a
  // minute after a cancel, the read says cancelled while the list still says draft. So the sample waits, and the card shows the status it read.
  const own = search.matches.find((match) => match.id === po.zoho_po_id);
  if (own && (now.gone || !poDeathReason(own.status))) {
    await deps.store.refresh({ sampleId: po.sample_id, poId: po.zoho_po_id, status: now.gone ? null : now.status, subTotal: null, taxTotal: null, total: null, gone: now.gone, duplicates: null });
    return { kind: "unknown", listBehind: reason, message: `Zoho shows ${po.zoho_po_number} as ${PO_DEATH_WORDS[reason]}, but its list hasn't caught up yet, so the sample stays locked until it does. That usually takes under a minute, and this page updates by itself. If it doesn't, check it in Zoho.` };
  }
  const others = search.matches.filter((match) => match.id !== po.zoho_po_id && !poDeathReason(match.status));
  if (others.length) {
    await deps.store.refresh({ sampleId: po.sample_id, poId: po.zoho_po_id, status: now.gone ? null : now.status, subTotal: null, taxTotal: null, total: null, gone: now.gone, duplicates: others });
    return { kind: "blocked", message: `${po.zoho_po_number} is ${PO_DEATH_WORDS[reason]} in Zoho, but Zoho also holds ${others.map((other) => other.number || other.id).join(", ")} with this reference. Delete or cancel that one in Zoho and this sample frees itself.` };
  }
  const answer = await deps.store.markDead({ sampleId: po.sample_id, poId: po.zoho_po_id, reason, status: now.status, note, actor });
  return answer.outcome === "freed" ? { kind: "freed", reason, number: po.zoho_po_number } : { kind: "changed" };
}

export type PoSyncResult = { checked: number; freed: { sampleId: string; number: string; reason: PoDeathReason }[]; unknown: number; listRead: boolean };
/** A purchase order that may just be further down Zoho's list gets a call of its own this often, and only one such call each time. */
export const OFF_LIST_CHECK_MS = 10 * 60_000;
/**
 * Keeps raised purchase orders in step with Zoho for few API calls: one list call covers every purchase order on its first page, and
 * only one that changed or isn't there gets a call of its own, at most maxReads each time. A failed list call changes nothing.
 * unknown counts every purchase order left unsettled, which is the caller's sign to wait longer before asking again.
 */
export async function syncRaisedPos(deps: PoLifeDeps, rows: RaisedPo[], options: { maxReads?: number; now?: number } = {}): Promise<PoSyncResult> {
  const result: PoSyncResult = { checked: 0, freed: [], unknown: 0, listRead: false };
  if (!rows.length) return result;
  let raw: ZohoRaw;
  try {
    raw = await deps.zoho("purchaseorders", "GET", undefined, { per_page: PO_PAGE_SIZE });
  } catch {
    return result;
  }
  if (zohoVerdict(raw) !== "ok") return result;
  result.listRead = true;
  const listRows = asRecords(raw.body?.["purchaseorders"]);
  const listed = new Map(listRows.map((row) => [text(row["purchaseorder_id"]), row]));
  const partOfList = pageMayContinue(asRecord(raw.body), listRows);
  const now = options.now ?? Date.now();
  let reads = 0, offListReads = 0;
  for (const row of rows) {
    const hit = listed.get(row.zoho_po_id);
    if (hit && !poDeathReason(hit["status"], hit["order_status"]) && text(hit["status"]) === row.zoho_po_status) {
      // An earlier purchase order of this sample that someone brought back to life in Zoho is a second live one: say so.
      const liveAgain = row.retired_pos.flatMap((old) => {
        const seen = listed.get(old.id);
        return seen && !poDeathReason(seen["status"], seen["order_status"]) && !row.duplicates.some((dup) => dup.id === old.id) ? [poFoundFrom(seen)] : [];
      });
      await deps.store.refresh({ sampleId: row.sample_id, poId: row.zoho_po_id, status: text(hit["status"]), subTotal: null, taxTotal: null, total: numberOr(hit["total"]), gone: false, duplicates: liveAgain.length ? [...row.duplicates, ...liveAgain] : null });
      result.checked += 1;
      continue;
    }
    if (!hit && partOfList) {
      // Not on this page proves nothing when Zoho's list goes on, and asking about each one every minute would use up the budget.
      if (offListReads >= 1 || now - (Date.parse(row.zoho_checked_at ?? "") || 0) < OFF_LIST_CHECK_MS) continue;
      offListReads += 1;
    } else {
      if (reads >= (options.maxReads ?? 5)) continue;
      reads += 1;
    }
    const settled = await settleRaisedPo(deps, row, null);
    // A list catching up isn't a failure, so it doesn't make every page wait five minutes.
    if ((settled.kind === "unknown" && !settled.listBehind) || settled.kind === "blocked") result.unknown += 1;
    else result.checked += 1;
    if (settled.kind === "freed") result.freed.push({ sampleId: row.sample_id, number: settled.number, reason: settled.reason });
  }
  return result;
}

export type CancelResult =
  /** settling: Zoho has taken it, and the sample comes back at the next check, once Zoho's list has caught up. */
  | { kind: "cancelled"; number: string; settling?: boolean }
  /** Zoho refused, and still shows it alive. Nothing changed. */
  | { kind: "refused"; message: string }
  /** No clear answer, or Zoho doesn't show it as cancelled yet. The next status check sorts it out. */
  | { kind: "unclear"; message: string };

/**
 * Cancels a purchase order in Zoho from the website, using Zoho's own "Mark as Cancelled". It never deletes anything in Zoho. Asking
 * twice is harmless, so there is no lock here: the sample is only freed once Zoho itself shows the purchase order as dead.
 */
export async function cancelRicePo(deps: PoLifeDeps, po: RaisedPo, actor: PoActor, reason: string): Promise<CancelResult> {
  await deps.store.cancelAsked({ sampleId: po.sample_id, number: po.zoho_po_number, reason, actor });
  let raw: ZohoRaw | null = null;
  try {
    raw = await deps.zoho(`purchaseorders/${encodeURIComponent(po.zoho_po_id)}/status/cancelled`, "POST");
  } catch {
    // No answer: it may have worked, and the read below tells.
  }
  // A refusal may only mean an earlier press already worked, so Zoho's status decides what to say, not the refusal.
  const refused = raw !== null && zohoVerdict(raw) === "rejected" && !zohoSaysNoSuchPo(raw);
  const settled = await settleRaisedPo(deps, po, actor, `${refused ? "Already cancelled when asked from the website" : "Cancelled from the website"}: ${reason}`);
  if (settled.kind === "freed") return { kind: "cancelled", number: settled.number };
  if (settled.kind === "changed") return { kind: "cancelled", number: po.zoho_po_number };
  if (settled.kind === "unknown" && settled.listBehind === "cancelled") return { kind: "cancelled", number: po.zoho_po_number, settling: true };
  if (refused && raw && settled.kind === "alive") return { kind: "refused", message: `Zoho would not cancel ${po.zoho_po_number}. ${plainZohoRefusal(raw)} Nothing changed. You can deal with it in Zoho.` };
  if (settled.kind === "alive") return { kind: "unclear", message: `Zoho still shows ${po.zoho_po_number} as ${zohoStatusLabel(settled.status)}. Check it in Zoho. This page updates by itself once Zoho changes.` };
  return { kind: "unclear", message: settled.message };
}

/**
 * Before a new purchase order: every earlier one must still be dead, and nothing alive may carry an earlier reference (a copy made in
 * Zoho, say), or the new one would be a second live order. Null when clear.
 */
export async function retiredPoProblem(zoho: ZohoSend, retired: (Pick<RetiredPo, "id" | "number"> & Partial<Pick<RetiredPo, "reference">>)[]): Promise<string | null> {
  for (const old of retired) {
    const now = await readPoStatus(zoho, old.id);
    if (!now) return `Zoho could not be asked about the earlier purchase order ${old.number}. Nothing was sent. Try again in a moment.`;
    if (!now.gone && !now.deathReason) return `The earlier purchase order ${old.number} is alive in Zoho again (${zohoStatusLabel(now.status)}). A new one would make two. Cancel it in Zoho, or carry on with that one. Nothing was sent.`;
  }
  for (const reference of new Set(retired.map((old) => old.reference ?? "").filter(Boolean))) {
    const search = await findPurchaseOrdersByReference(zoho, reference);
    if (!search.complete) return `Zoho's list could not be read in full, so nothing was sent. Try again in a moment. ${search.problem}`;
    const alive = search.matches.find((match) => !poDeathReason(match.status));
    if (alive) return `Zoho holds ${alive.number || alive.id} (${zohoStatusLabel(alive.status)}) with this sample's earlier reference ${reference}. A new one would make two. Cancel it in Zoho, or carry on with that one. Nothing was sent.`;
  }
  return null;
}

// ---------------------------------------------------------------- Vendors and items in Zoho

export type ZohoVendorMatch = {
  id: string; name: string; company: string; phone: string; gstNo: string; gstTreatment: string; contactType: string; active: boolean; byPhone: boolean; byName: boolean;
};
export type ZohoItemMatch = {
  id: string; name: string; sku: string; unit: string; hsn: string; purchaseRate: number; active: boolean; canBePurchased: boolean;
  kgPerUnit: number | null; gstLabel: string; gstPercent: number | null;
};

/** The same name, ignoring case and extra spaces. Used to refuse a duplicate. */
export const nameKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");
const lastTen = (raw: string) => raw.replace(/\D/g, "").slice(-10);

export function vendorMatchesFrom(rows: Record<string, unknown>[], name: string, phone: string): ZohoVendorMatch[] {
  const wantedPhone = lastTen(phone), wantedName = nameKey(name);
  const seen = new Map<string, ZohoVendorMatch>();
  for (const row of rows) {
    const id = text(row["contact_id"]);
    if (!id) continue;
    const phones = [text(row["phone"]), text(row["mobile"])].map(lastTen).filter(Boolean);
    const rowName = nameKey(text(row["contact_name"])), company = nameKey(text(row["company_name"]));
    seen.set(id, {
      id, name: text(row["contact_name"]), company: text(row["company_name"]),
      phone: text(row["mobile"]) || text(row["phone"]), gstNo: text(row["gst_no"]), gstTreatment: text(row["gst_treatment"]),
      contactType: text(row["contact_type"]).toLowerCase(), active: text(row["status"]).toLowerCase() !== "inactive",
      byPhone: Boolean(wantedPhone) && phones.includes(wantedPhone),
      byName: Boolean(wantedName) && (rowName.includes(wantedName) || company.includes(wantedName)),
    });
  }
  // Same phone first (the surest match), then exact names, vendors before customers.
  const rank = (match: ZohoVendorMatch) => (match.contactType === "vendor" ? 0 : 4) + (match.active ? 0 : 2) + (match.byPhone ? 0 : 1);
  return [...seen.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export function itemMatchFrom(row: Record<string, unknown>): ZohoItemMatch {
  const name = text(row["name"]), unit = text(row["unit"]).trim();
  const taxes = asRecords(row["item_tax_preferences"]);
  const percent = numberOr(taxes[0]?.["tax_percentage"]) ?? numberOr(row["tax_percentage"]);
  return {
    id: text(row["item_id"]), name, sku: text(row["sku"]), unit, hsn: text(row["hsn_or_sac"]), purchaseRate: numberOr(row["purchase_rate"], 0) ?? 0,
    active: text(row["status"]).toLowerCase() !== "inactive", canBePurchased: row["can_be_purchased"] !== false,
    kgPerUnit: kgPerZohoUnit(unit, name), gstPercent: percent && percent > 0 ? percent : null,
    gstLabel: percent && percent > 0 ? `${percent}%` : "",
  };
}

/** Exactly what Zoho's contact form needs for a new vendor. Zoho allows "consumer" only on customers, so an unregistered vendor is business_none. */
export function vendorBody(input: { name: string; phone: string; gstin: string; placeOfContact: string }): Record<string, unknown> {
  const parts = input.name.trim().split(/\s+/);
  const phone = phoneDigits(input.phone);
  return {
    contact_type: "vendor",
    contact_name: input.name.trim(),
    gst_treatment: input.gstin ? "business_gst" : "business_none",
    ...(input.gstin ? { gst_no: input.gstin } : {}),
    place_of_contact: input.placeOfContact,
    notes: "Added from the Grain Bazar rice sample desk",
    contact_persons: [{ first_name: parts[0] ?? input.name.trim(), last_name: parts.slice(1).join(" "), ...(phone ? { phone, mobile: phone } : {}), is_primary_contact: true }],
  };
}

/** A new item bought by weight, set up as the client's Sugar item is: stock-tracked, unit qtl, price per quintal. */
export function itemBody(input: { name: string; unit: string; hsn: string; purchaseRate: number; taxPreferences: { tax_id: string; tax_specification: string }[] | null }): Record<string, unknown> {
  return {
    name: input.name.trim(),
    unit: input.unit,
    item_type: "inventory",
    product_type: "goods",
    can_be_sold: true,
    can_be_purchased: true,
    // Zoho needs a selling rate on a stock item. The purchase rate stands in until someone sets a real one in Zoho.
    rate: input.purchaseRate,
    purchase_rate: input.purchaseRate,
    ...(BULK_UNITS[input.unit.toLowerCase()] === 100 ? { purchase_description: "QUINTAL PRICE" } : {}),
    hsn_or_sac: input.hsn,
    ...(input.taxPreferences ? { item_tax_preferences: input.taxPreferences } : {}),
  };
}

/** The item's GST choice from Zoho's tax list, matched the way the product sync does. Null unless exactly one GST and one IGST tax fit. */
export function gstPreferencesFrom(taxes: Record<string, unknown>[], gst: number) {
  const matches = (prefix: "GST" | "IGST") => taxes.filter((tax) =>
    Number(tax["tax_percentage"]) === gst && new RegExp(`^${prefix}\\s*${gst}(\\b|\\s|$)`, "i").test(text(tax["tax_name"]).trim()));
  const intra = matches("GST"), inter = matches("IGST");
  if (intra.length !== 1 || inter.length !== 1) return null;
  return [
    { tax_id: text(intra[0]!["tax_id"]), tax_specification: "intra" },
    { tax_id: text(inter[0]!["tax_id"]), tax_specification: "inter" },
  ];
}

export type CreationStore = {
  claim(args: { kind: "vendor" | "item"; key: string; displayName: string; attemptId: string; actor: PoActor }): Promise<
    | { outcome: "claimed" } | { outcome: "done"; zoho_id: string; attempt_id: string } | { outcome: "in_progress"; by: string } | { outcome: "verify_first"; attempt_id: string }
  >;
  takeover(args: { kind: "vendor" | "item"; key: string; expectedAttempt: string; attemptId: string; actor: PoActor }): Promise<TakeoverAnswer>;
  finish(args: { kind: "vendor" | "item"; key: string; attemptId: string; state: "done" | "rejected" | "uncertain"; zohoId: string; message: string }): Promise<void>;
};

export type CreationResult =
  | { kind: "created"; id: string }
  /** Already in Zoho under this name. Nothing was created; use this one. */
  | { kind: "exists"; id: string; message: string }
  | { kind: "rejected"; message: string }
  | { kind: "uncertain"; message: string }
  | { kind: "in_progress"; message: string };

/**
 * Creates one Zoho vendor or item, at most once per name, and only after the admin confirmed it on screen. `findExact` asks Zoho
 * whether that exact name exists now. It runs first, and again before any retry of a send that got no clear answer.
 */
export async function createInZohoOnce(
  deps: { store: CreationStore; zoho: ZohoSend; newId: () => string },
  kind: "vendor" | "item",
  input: { name: string; body: Record<string, unknown>; resource: string; idField: string; responseKey: string; findExact: () => Promise<string | null> },
  actor: PoActor,
): Promise<CreationResult> {
  const what = kind === "vendor" ? "vendor" : "item";
  const key = nameKey(input.name);
  const exists = (id: string): CreationResult => ({ kind: "exists", id, message: `Zoho already has a ${what} called "${input.name}". Use that one.` });
  const before = await input.findExact();
  if (before) return exists(before);
  const attemptId = deps.newId();
  const claim = await deps.store.claim({ kind, key, displayName: input.name.trim(), attemptId, actor });
  if (claim.outcome === "in_progress") return { kind: "in_progress", message: `${claim.by || "Another admin"} is creating this ${what} right now.` };
  if (claim.outcome === "done") {
    // This website created it, yet the name search missed it. Believe the stored ID unless Zoho says it has gone.
    let stored: ZohoRaw;
    try {
      stored = await deps.zoho(`${input.resource}/${encodeURIComponent(claim.zoho_id)}`, "GET");
    } catch {
      return { kind: "uncertain", message: `Zoho could not be asked about this ${what}. Try again in a moment.` };
    }
    if (zohoVerdict(stored) === "ok") return exists(claim.zoho_id);
    if (stored.status !== 404) return { kind: "uncertain", message: `Zoho could not be asked about this ${what}. Try again in a moment.` };
  }
  if (claim.outcome === "done" || claim.outcome === "verify_first") {
    // No such name in Zoho: it was deleted there, or the last send never landed.
    const taken = await deps.store.takeover({ kind, key, expectedAttempt: claim.attempt_id, attemptId, actor });
    if (taken.outcome === "too_soon") return { kind: "uncertain", message: `Zoho may still be working on the last request. Wait ${Math.max(1, Number(taken.wait_seconds))} seconds and search again.` };
    if (taken.outcome === "changed") return { kind: "in_progress", message: `Someone else has just acted on this ${what}. Search again in a moment.` };
  }
  let raw: ZohoRaw;
  const unclear = async (detail: string): Promise<CreationResult> => {
    await deps.store.finish({ kind, key, attemptId, state: "uncertain", zohoId: "", message: detail });
    const again = await input.findExact().catch(() => null);
    if (again) {
      await deps.store.finish({ kind, key, attemptId, state: "done", zohoId: again, message: "" });
      return { kind: "created", id: again };
    }
    return { kind: "uncertain", message: `Zoho did not give a clear answer, so this ${what} may or may not exist. Wait ${PO_RETRY_SECONDS / 60} minutes and search again. Do not add it by hand.` };
  };
  try {
    raw = await deps.zoho(input.resource, "POST", input.body);
  } catch (cause) {
    return unclear(cause instanceof Error ? cause.message : "no answer");
  }
  const verdict = zohoVerdict(raw);
  if (verdict === "rejected") {
    const message = `${plainZohoRefusal(raw)} The ${what} was not created.`;
    await deps.store.finish({ kind, key, attemptId, state: "rejected", zohoId: "", message });
    return { kind: "rejected", message };
  }
  const id = text(asRecord(raw.body?.[input.responseKey])[input.idField]);
  if (verdict === "uncertain" || !id) return unclear(`Zoho answered ${raw.status}`);
  await deps.store.finish({ kind, key, attemptId, state: "done", zohoId: id, message: "" });
  return { kind: "created", id };
}
