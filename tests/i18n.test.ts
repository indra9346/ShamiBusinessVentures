import { test } from "node:test";
import assert from "node:assert/strict";
import { loadKannada, translateText } from "../src/lib/i18n-core.ts";
import { kn } from "../src/lib/i18n-kn.ts";

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

test("menu labels from the admin sidebar are all Kannada", () => {
  for (const label of ["Branches", "Enquiries", "Pricing", "Channel Partners", "Partner Report", "Payments & Matching", "UPI Payments", "Godown Report", "Attendance"]) {
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
