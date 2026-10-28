import { test } from "node:test";
import assert from "node:assert/strict";
import { businessDetailsProblem, gstStateCodeOf, normaliseGstin } from "../src/lib/gstin.ts";
import { einvoiceProblems, zohoGstFields } from "../src/lib/zoho-sync-core.ts";

test("checkout: business details are checked like the database checks them", () => {
  assert.equal(businessDetailsProblem("29ABCDE1234F1Z5", "Kiran Traders", "Karnataka"), null);
  assert.equal(normaliseGstin(" 29abcde 1234f1z5 "), "29ABCDE1234F1Z5");
  assert.equal(businessDetailsProblem(" 29abcde1234f1z5 ", "Kiran Traders", "karnataka"), null);
  assert.match(businessDetailsProblem("", "Kiran Traders", "Karnataka")!, /Enter your GSTIN/);
  assert.match(businessDetailsProblem("29ABCDE1234F1Z", "Kiran Traders", "Karnataka")!, /15 characters/);
  assert.match(businessDetailsProblem("29ABCDE1234F1X5", "Kiran Traders", "Karnataka")!, /not a valid GSTIN/);
  assert.match(businessDetailsProblem("29ABCDE1234F1Z5", " ", "Karnataka")!, /legal business name/);
  // The GSTIN's state (first two digits) must be the billing address's state.
  assert.match(businessDetailsProblem("27ABCDE1234F1Z5", "Kiran Traders", "Karnataka")!, /state code 27.*Karnataka \(29\)/);
  // Unknown state name: the format check still applies, the state check is skipped.
  assert.equal(businessDetailsProblem("27ABCDE1234F1Z5", "Kiran Traders", "Unknownland"), null);
  assert.equal(gstStateCodeOf("Jammu & Kashmir"), "01");
});

test("Zoho: a GSTIN makes contact, sales order and invoice a registered business with its place", () => {
  assert.deepEqual(zohoGstFields("29ABCDE1234F1Z5", "contact"), { gst_treatment: "business_gst", gst_no: "29ABCDE1234F1Z5", place_of_contact: "KA" });
  assert.deepEqual(zohoGstFields("27abcde1234f1z5", "order"), { gst_treatment: "business_gst", gst_no: "27ABCDE1234F1Z5", place_of_supply: "MH" });
  assert.deepEqual(zohoGstFields("07ABCDE1234F1Z5", "invoice"), { gst_treatment: "business_gst", gst_no: "07ABCDE1234F1Z5", place_of_supply: "DL", is_reverse_charge_applicable: false });
});

test("Zoho: no or invalid GSTIN is a consumer (B2C), never a half-filled business record", () => {
  for (const gstin of [null, "", "NA", "29ABCDE1234F1Z", "unregistered"]) {
    assert.deepEqual(zohoGstFields(gstin, "order"), { gst_treatment: "consumer" });
  }
});

test("IRP e-invoice readiness: GSTIN, legal name, full address with 6-digit PIN, 6/8-digit HSN", () => {
  const ready = {
    gstin: "29ABCDE1234F1Z5", legalName: "Kiran Traders",
    address: { line: "5th Main Road", city: "Challakere", state: "Karnataka", pin: "577522" },
    lines: [{ name: "S1 Sugar 50kg", hsn: "17019910" }, { name: "Sona Masoori 25kg", hsn: "100630" }],
  };
  assert.deepEqual(einvoiceProblems(ready), []);
  const problems = einvoiceProblems({
    gstin: "29ABCDE1234F1Z", legalName: "",
    address: { line: "", city: "Challakere", state: "", pin: "57752" },
    lines: [{ name: "Oil 15L Tin", hsn: "1512" }, { name: "Rice", hsn: null }],
  });
  assert.deepEqual(problems, [
    "buyer GSTIN missing or invalid",
    "buyer legal name missing",
    "billing address line missing",
    "billing state missing",
    "billing PIN code must be 6 digits",
    'HSN of Oil 15L Tin must be 6 or 8 digits (now "1512")',
    'HSN of Rice must be 6 or 8 digits (now "none")',
  ]);
});
