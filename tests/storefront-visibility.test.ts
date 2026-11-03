import { test } from "node:test";
import assert from "node:assert/strict";
import { hiddenReason, shownOnStorefront, storefrontPatch } from "../src/lib/storefront-visibility.ts";
import { readFileSync } from "node:fs";
import { loadKannada, translateText } from "../src/lib/i18n-core.ts";
import { kn } from "../src/lib/i18n-kn.ts";
import {
  DEFAULT_SITE_DETAILS,
  HEAD_OFFICE_ADDRESS,
  cleanSiteDetails,
  parseSiteDetails,
  siteDetailsProblem,
  telHref,
  visibleSiteDetails,
  whatsappHref,
} from "../src/lib/site-details-rules.ts";

test("shown only when approved, switched on and not a Zoho copy", () => {
  assert.equal(shownOnStorefront({ status: "approved", active: true, vendorId: "VENDOR-001" }), true);
  assert.equal(shownOnStorefront({ status: "approved", vendorId: "VENDOR-001" }), true);
  assert.equal(shownOnStorefront({ status: "approved", active: false, vendorId: "VENDOR-001" }), false);
  assert.equal(shownOnStorefront({ status: "rejected", active: true, vendorId: "VENDOR-001" }), false);
  assert.equal(shownOnStorefront({ status: "pending", active: true, vendorId: "VENDOR-001" }), false);
  assert.equal(shownOnStorefront({ status: "approved", active: true, vendorId: "zoho:60066526172" }), false);
});

test("showing a rejected, switched-off product approves it and switches it on", () => {
  // The live case: S1 Sugar Retail Pack 1kg was Rejected + Inactive, and switching Active on alone left it hidden.
  const product = { status: "rejected" as const, active: false, vendorId: "VENDOR-001" };
  const patch = storefrontPatch(product, true);
  assert.deepEqual(patch, { status: "approved", active: true });
  assert.equal(shownOnStorefront({ ...product, ...patch }), true);
  assert.deepEqual(storefrontPatch({ status: "pending", active: true }, true), { status: "approved" });
  assert.equal(storefrontPatch({ status: "approved", active: true }, true), null);
});

test("hiding only switches it off and keeps the approval", () => {
  const product = { status: "approved" as const, active: true, vendorId: "VENDOR-001" };
  const patch = storefrontPatch(product, false);
  assert.deepEqual(patch, { active: false });
  assert.equal(shownOnStorefront({ ...product, ...patch }), false);
  assert.equal(storefrontPatch({ status: "approved", active: false }, false), null);
  // Shown again later: approval was kept, so only the switch changes.
  assert.deepEqual(storefrontPatch({ ...product, ...patch }, true), { active: true });
});

test("the reason a product is hidden", () => {
  assert.equal(hiddenReason({ status: "approved", active: true }), null);
  assert.equal(hiddenReason({ status: "approved", active: false }), "Switched off");
  assert.equal(hiddenReason({ status: "rejected", active: true }), "Rejected");
  assert.equal(hiddenReason({ status: "pending", active: true }), "Awaiting approval");
  assert.equal(hiddenReason({ status: "approved", active: true, vendorId: "zoho:1" }), "Zoho copy");
});

test("website details: before an admin saves, customers see what the owner gave", () => {
  const visible = visibleSiteDetails(parseSiteDetails(undefined));
  assert.equal(visible.address, "179, 5th Main Rd, BCC Layout, Chandra Layout, Bengaluru, Karnataka 560040");
  assert.equal(visible.gstin, "29ABJCS7870F1ZR");
  assert.equal(visible.phone, "+91 98459 66288");
  assert.equal(visible.hours, "Mon–Sat, 9am–6pm");
  assert.equal(visible.whatsapp, "+91 93532 95398");
  assert.equal(visible.email, "headoffice@shamibusiness.com");
  assert.equal(siteDetailsProblem(DEFAULT_SITE_DETAILS), null);
});

test("website details: a switched-off or empty detail is never shown", () => {
  const details = parseSiteDetails({
    email: { value: "desk@example.com", show: false },
    phone: { value: "", show: true },
    gstin: { value: "  29ABJCS7870F1ZR  ", show: true },
  });
  const visible = visibleSiteDetails(details);
  assert.equal(visible.email, "");
  assert.equal(visible.phone, "");
  assert.equal(visible.gstin, "29ABJCS7870F1ZR");
  assert.equal(visible.address, HEAD_OFFICE_ADDRESS, "a detail the row doesn't hold keeps its default");
});

test("website details: a bad saved row can't break the page", () => {
  for (const saved of [null, "text", 5, [], { email: "plain text", gstin: [] }]) {
    assert.deepEqual(parseSiteDetails(saved), DEFAULT_SITE_DETAILS);
  }
  const odd = parseSiteDetails({ email: { value: 7, show: "yes" } });
  assert.deepEqual(odd.email, { value: "", show: false });
});

test("website details: what stops the admin saving", () => {
  const withDetail = (field: keyof typeof DEFAULT_SITE_DETAILS, value: string, show = true) =>
    siteDetailsProblem({ ...DEFAULT_SITE_DETAILS, [field]: { value, show } });
  assert.match(withDetail("email", "") ?? "", /email/);
  assert.match(withDetail("email", "not an address") ?? "", /email/);
  assert.equal(withDetail("email", "desk@grainbazar.com"), null);
  assert.equal(withDetail("email", "", false), null, "a hidden detail isn't checked");
  // The old sample has the right shape but the wrong check digit.
  assert.match(withDetail("gstin", "29ABCDE1234F1Z5") ?? "", /GSTIN/);
  assert.match(withDetail("gstin", "29ABJCS7870F1ZA") ?? "", /GSTIN/);
  assert.equal(withDetail("gstin", "29abjcs7870f1zr"), null);
  assert.match(withDetail("fssai", "12345") ?? "", /FSSAI/);
  assert.equal(withDetail("fssai", "1234 5678 9012 34"), null);
  assert.match(withDetail("phone", "12345") ?? "", /phone/);
  assert.match(withDetail("whatsapp", "12345") ?? "", /WhatsApp/);
  assert.match(withDetail("hours", "") ?? "", /hours/);
  assert.equal(withDetail("hours", "", false), null);
  assert.match(withDetail("address", "Short") ?? "", /address/);
});

test("website details: saved tidily, and phone links work however the number is typed", () => {
  const clean = cleanSiteDetails({ ...DEFAULT_SITE_DETAILS, gstin: { value: " 29abjcs 7870f1zr ", show: true }, email: { value: " a@b.co ", show: true } });
  assert.equal(clean.gstin.value, "29ABJCS7870F1ZR");
  assert.equal(clean.email.value, "a@b.co");
  for (const phone of ["+91 95385 00840", "95385 00840", "095385-00840", "919538500840"]) {
    assert.equal(telHref(phone), "tel:+919538500840");
    assert.equal(whatsappHref(phone), "https://wa.me/919538500840");
  }
});

test("the dead email domains and the old office are gone from what customers see", () => {
  const files = ["src/components/site/SiteFooter.tsx", "src/routes/contact.tsx", "src/routes/about.tsx", "src/components/site/NotInYourArea.tsx", "src/lib/i18n-kn.ts"];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const old of ["shamiventures.in", "shamibusiness.in", "Shami House", "590010", "95385", "9538500840"]) assert.ok(!source.includes(old), `${old} is still in ${file}`);
  }
  for (const file of ["src/components/site/SiteFooter.tsx", "src/routes/about.tsx"]) {
    assert.ok(!readFileSync(file, "utf8").includes("29ABCDE1234F1Z5"), `the sample GSTIN is still in ${file}`);
  }
});

test("the company details read in Kannada", async () => {
  await loadKannada();
  assert.ok(kn[HEAD_OFFICE_ADDRESS], "the head office address has its Kannada");
  assert.equal(translateText(HEAD_OFFICE_ADDRESS, "kn"), kn[HEAD_OFFICE_ADDRESS]);
  assert.equal(translateText("Chat on WhatsApp (+91 95385 00840)", "kn"), kn["Chat on WhatsApp ({0})"]!.replace("{0}", "+91 95385 00840"));
  assert.equal(translateText("Please try again, or call us on +91 83100 84308.", "kn"), kn["Please try again, or call us on {0}."]!.replace("{0}", "+91 83100 84308"));
  assert.ok(kn["Email Desk ("]);
  assert.equal(translateText("+91 98459 66288 (Mon–Sat, 9am–6pm)", "kn"), kn["{0} (Mon–Sat, 9am–6pm)"]!.replace("{0}", "+91 98459 66288"));
  assert.equal(translateText("Head office and customer care:", "kn"), kn["Head office and customer care:"]);
});
