import { test } from "node:test";
import assert from "node:assert/strict";
import { loadKannada, translateText } from "../src/lib/i18n-core.ts";
import { kn } from "../src/lib/i18n-kn.ts";
import { productDescription } from "../src/lib/seo.ts";
import { DEFAULT_RULES, MARK_WORDS, REGISTER_LEGEND, leaveProblem, ruleLines, rulesProblem } from "../src/lib/attendance.ts";
import { availableParts, availableText, bagCountText, parseAvailable } from "../src/lib/rice-samples.ts";

await loadKannada();

test("English mode never changes text", () => {
  assert.equal(translateText("Godown Report", "en"), "Godown Report");
});

test("exact labels translate and keep their surrounding spaces", () => {
  assert.equal(translateText("Home", "kn"), kn.Home);
  assert.equal(translateText("  Home ", "kn"), `  ${kn.Home} `);
});

test("numbers, symbols and blank text pass through", () => {
  for (const value of ["", "  ", "₹1,250", "42", "·"]) assert.equal(translateText(value, "kn"), value);
});

test("every template keeps each placeholder exactly once", () => {
  for (const [english, kannada] of Object.entries(kn)) {
    const slots = (text: string) => (text.match(/\{\d+\}/g) ?? []).sort().join(",");
    assert.equal(slots(kannada), slots(english), `placeholders differ for "${english}"`);
  }
});

test("no Kannada entry is empty", () => {
  for (const [english, kannada] of Object.entries(kn)) assert.ok(kannada.trim(), `empty translation for "${english}"`);
});

test("templates fill in live values, translating values that are labels themselves", () => {
  const templates = Object.keys(kn).filter((key) => /^\{0\} [A-Za-z]/.test(key) && !/\{1\}/.test(key));
  assert.ok(templates.length > 0, "dictionary has {0} templates");
  const english = templates[0];
  const rendered = translateText(english.replace("{0}", "17"), "kn");
  assert.equal(rendered, kn[english].replace("{0}", "17"));
  const labelled = translateText(english.replace("{0}", "Home"), "kn");
  assert.equal(labelled, kn[english].replace("{0}", kn.Home));
});

test("English plural endings in templates disappear in Kannada", () => {
  const english = Object.keys(kn).find((key) => /[a-z]\{1\}/.test(key) && /^[^{]*\{0\}[^{]*[a-z]\{1\}$/.test(key));
  assert.ok(english, "a plural template exists");
  const one = english.replace("{0}", "1").replace("{1}", "");
  const many = english.replace("{0}", "4").replace("{1}", "s");
  assert.equal(translateText(many, "kn"), kn[english].replace("{0}", "4").replace("{1}", ""));
  assert.equal(translateText(one, "kn"), kn[english].replace("{0}", "1").replace("{1}", ""));
});

test("short templates don't hijack ordinary English phrases", () => {
  assert.ok("{0} of {1}" in kn);
  assert.equal(translateText("₹4,000 of ₹10,000", "kn"), kn["{0} of {1}"].replace("{0}", "₹4,000").replace("{1}", "₹10,000"));
  assert.ok(!translateText("Bag of Steam Rice", "kn").includes("{"));
  assert.equal(translateText("Country of Origin", "kn"), kn["Country of Origin"] ?? "ಮೂಲ ದೇಶ");
});

test("a godown's attendance rules read in Kannada", () => {
  const latin = /[A-Za-z]{3,}/;
  const variants = [DEFAULT_RULES, { ...DEFAULT_RULES, late_counted_from: "grace_end" as const, half_day_below_min: 270, absent_below_min: 60, missed_checkout: "half_day" as const, weekly_off: null, require_device: false, presence_interval_min: 0, leave_partner_required: false, shift_end: "17:45" },
    { ...DEFAULT_RULES, missed_checkout: "absent" as const }];
  for (const rules of variants) {
    for (const line of ruleLines(rules)) {
      for (const text of [line.label, ...line.value]) {
        assert.ok(!latin.test(translateText(text, "kn").replace(/\b[ap]m\b/g, "")), `no Kannada for "${text}"`);
      }
    }
  }
  assert.ok(!latin.test(translateText(REGISTER_LEGEND, "kn").replace(/\b(HD|LV|WO)\b/g, "")));
  for (const word of Object.values(MARK_WORDS)) assert.ok(!latin.test(translateText(word, "kn")), `no Kannada for "${word}"`);
  const problems = [
    leaveProblem("2026-11-01", "2026-11-09", "Fever", "2026-10-31", { leave_max_days: 2, leave_back_days: 0, leave_ahead_days: 30 }),
    leaveProblem("2026-10-01", "2026-10-01", "Fever", "2026-10-31", { leave_max_days: 2, leave_back_days: 0, leave_ahead_days: 30 }),
    leaveProblem("2026-10-01", "2026-10-01", "Fever", "2026-10-31", { leave_max_days: 2, leave_back_days: 5, leave_ahead_days: 30 }),
    leaveProblem("2026-12-31", "2026-12-31", "Fever", "2026-10-31", { leave_max_days: 2, leave_back_days: 0, leave_ahead_days: 30 }),
    rulesProblem({ ...DEFAULT_RULES, early_grace_min: 999 }), rulesProblem({ ...DEFAULT_RULES, half_day_below_min: 2000 }), rulesProblem({ ...DEFAULT_RULES, half_day_below_min: 60, absent_below_min: 60 }),
    rulesProblem({ ...DEFAULT_RULES, gps_accuracy_limit_m: 1 }), rulesProblem({ ...DEFAULT_RULES, presence_interval_min: 20 }), rulesProblem({ ...DEFAULT_RULES, presence_early_min: 500 }),
    rulesProblem({ ...DEFAULT_RULES, presence_interval_min: 40 }), rulesProblem({ ...DEFAULT_RULES, leave_types: [] }), rulesProblem({ ...DEFAULT_RULES, leave_max_days: 0 }), rulesProblem({ ...DEFAULT_RULES, leave_back_days: 999 }),
  ];
  for (const text of problems) {
    assert.ok(text, "a problem was found");
    assert.ok(!latin.test(translateText(text!, "kn")), `no Kannada for "${text}"`);
  }
});

test("menu labels from the admin sidebar are all Kannada", () => {
  for (const label of ["Branches", "Enquiries", "Pricing", "Channel Partners", "Partner Report", "Payments & Matching", "UPI Payments", "Godown Report", "Attendance", "Stock Counts"]) {
    const out = translateText(label, "kn");
    assert.ok(!/[A-Za-z]/.test(out.replace(/UPI|Zoho/g, "")), `${label} → ${out}`);
  }
});

test("database status values translate in any case", () => {
  assert.equal(translateText("approved", "kn"), translateText("Approved", "kn"));
  assert.equal(translateText("out_for_delivery", "kn"), kn["Out for Delivery"]);
  assert.notEqual(translateText("Packed", "kn"), "Packed");
});

test("a label with a count keeps the count", () => {
  assert.equal(translateText("Home (15)", "kn"), `${kn.Home} (15)`);
});

test("dates show Kannada month names; vendor names stay as written", () => {
  assert.ok(!/Oct/.test(translateText("27 Oct 2026", "kn")));
  assert.equal(translateText("Shami Sugar Mills", "kn"), "Shami Sugar Mills");
});

test("notifications written by the database are translated with their values", () => {
  const out = translateText("Order ORD-26102719610 is now Delivered.", "kn");
  assert.ok(out.includes("ORD-26102719610") && out.includes(kn.Delivered) && !/is now/.test(out));
});

test("a product description made from its facts reads in Kannada", () => {
  const withPack = translateText(productDescription({ name: "Long Grain Basumathi Rice", weight: "10 kg" }), "kn");
  assert.ok(withPack.includes("10 kg") && withPack.includes("ಪ್ಯಾಕ್ ಗಾತ್ರ") && withPack.includes("GST"), withPack);
  assert.doesNotMatch(withPack, /pack size|Sold by/);
  const noPack = translateText(productDescription({ name: "Belgaum Sugar - 50 kg Bag", weight: "50 kg bag" }), "kn");
  assert.doesNotMatch(noPack, /pack size|Sold by/);
});

test("a rice sample's available quantity reads in Kannada, in bags or quintals", () => {
  const inBags = { quantity_qntl: 52, quantity_bags: 200, bag_kg: 26 };
  const parts = availableParts(inBags);
  assert.equal(translateText(parts.figure, "kn"), "200 ಚೀಲಗಳು");
  assert.equal(translateText(parts.under, "kn"), "ತಲಾ 26 kg · 52 ಕ್ವಿಂಟಾಲ್");
  assert.equal(translateText(availableText(inBags), "kn"), "26 kg ನ 200 ಚೀಲಗಳು (52 ಕ್ವಿಂಟಾಲ್)");
  assert.equal(translateText(availableText({ quantity_qntl: 0.26, quantity_bags: 1, bag_kg: 26 }), "kn"), "26 kg ನ 1 ಚೀಲ (0.26 ಕ್ವಿಂಟಾಲ್)");
  assert.equal(translateText(availableText({ quantity_qntl: 52, quantity_bags: null, bag_kg: null }), "kn"), "52 ಕ್ವಿಂಟಾಲ್");
  assert.equal(translateText(availableParts({ quantity_qntl: 52, quantity_bags: null, bag_kg: null }).under, "kn"), "ಕ್ವಿಂಟಾಲ್");
  // The History dialog renders the label and the quantity as separate text, like the card and compare.
  assert.equal(translateText("Available: ", "kn"), `${kn["Available:"]} `);
  assert.equal(translateText(`52 quintal available (${bagCountText(200)} of 26 kg)`, "kn"), "52 ಕ್ವಿಂಟಾಲ್ ಲಭ್ಯ (26 kg ನ 200 ಚೀಲಗಳು)");
  assert.equal(translateText("= 1,200.5 quintal", "kn"), "= 1,200.5 ಕ್ವಿಂಟಾಲ್");
  assert.equal(translateText("Price / quintal", "kn"), "ಬೆಲೆ / ಕ್ವಿಂಟಾಲ್");
  for (const kind of ["quintal", "bags"] as const) {
    const answer = parseAvailable({ unit: kind, quantity: "", bagKg: "" });
    assert.ok(!answer.ok && translateText(answer.message, "kn") !== answer.message, `${kind}: ${answer.ok ? "" : answer.message}`);
  }
  const noWeight = parseAvailable({ unit: "bags", quantity: "200", bagKg: "" });
  assert.ok(!noWeight.ok && translateText(noWeight.message, "kn") !== noWeight.message);
});
