import { test } from "node:test";
import assert from "node:assert/strict";
import { gstStateCodeOf } from "../src/lib/gstin.ts";
import { sameZohoAddress, sameZohoPlace, ZOHO_PLACE_CODES, zohoAddressBody, zohoInvoiceAddressesToCopy, zohoAddressesFromContact, zohoAddressesToUpdate, zohoOrderAddress, zohoOrderAddressOpen, zohoOrderFinished } from "../src/lib/zoho-sync-core.ts";

const orderCopy = { id: "a1", name: " Ravi Kumar ", phone: "9876500000", line: " 12 Market Road ", city: "Hubli", state: "Karnataka", pin: "580020" };
const asZoho = { attention: "Ravi Kumar", address: "12 Market Road", city: "Hubli", state: "Karnataka", zip: "580020" };

test("the order's copy becomes Zoho's address fields, with no leftover landmark", () => {
  assert.deepEqual(zohoOrderAddress(orderCopy), {
    attention: "Ravi Kumar", address: "12 Market Road", street2: "", city: "Hubli", state: "Karnataka", zip: "580020", country: "India", phone: "9876500000",
  });
});

test("a copy with no street, city, state or PIN is not written", () => {
  for (const key of ["line", "city", "state", "pin"]) assert.equal(zohoOrderAddress({ ...orderCopy, [key]: "  " }), null, key);
  for (const value of [null, undefined, "text", 5]) assert.equal(zohoOrderAddress(value), null);
});

test("addresses match on person and place, ignoring case, spacing, phone, landmark and country", () => {
  assert.ok(sameZohoAddress({ ...asZoho, attention: "RAVI  KUMAR", address: "12  market road", phone: "1", street2: "Near temple", country: "IN" }, asZoho));
  for (const key of ["attention", "address", "city", "state", "zip"]) assert.ok(!sameZohoAddress({ ...asZoho, [key]: "other" }, asZoho), key);
  assert.ok(!sameZohoAddress({}, asZoho));
  assert.ok(!sameZohoAddress(undefined, asZoho));
});

test("the same place ignores who it is for", () => {
  assert.ok(sameZohoPlace({ ...asZoho, attention: "Someone else" }, asZoho));
  assert.ok(!sameZohoAddress({ ...asZoho, attention: "Someone else" }, asZoho));
  for (const key of ["address", "city", "state", "zip"]) assert.ok(!sameZohoPlace({ ...asZoho, [key]: "other" }, asZoho), key);
});

test("only the sales order's addresses that differ are written", () => {
  const address = zohoOrderAddress(orderCopy)!;
  const other = { ...asZoho, address: "99 Old Street" };
  assert.deepEqual(zohoAddressesToUpdate({ shipping_address: asZoho, billing_address: asZoho }, address), []);
  assert.deepEqual(zohoAddressesToUpdate({ shipping_address: other, billing_address: other }, address), ["shipping", "billing"]);
  assert.deepEqual(zohoAddressesToUpdate({ shipping_address: asZoho, billing_address: other }, address), ["billing"]);
  assert.deepEqual(zohoAddressesToUpdate({}, address), ["shipping", "billing"]);
});

test("only a sales order not yet void, closed, invoiced or shipped takes an address", () => {
  assert.ok(zohoOrderAddressOpen({ order_status: "draft", invoiced_status: "not_invoiced", shipped_status: "pending" }));
  assert.ok(zohoOrderAddressOpen({ status: "open", shipped_status: "" }));
  for (const status of ["void", "cancelled", "closed", "fulfilled"]) assert.ok(!zohoOrderAddressOpen({ order_status: status }), status);
  assert.ok(!zohoOrderAddressOpen({ status: "void" }));
  for (const invoiced of ["invoiced", "partially_invoiced"]) assert.ok(!zohoOrderAddressOpen({ order_status: "open", invoiced_status: invoiced }), invoiced);
  for (const shipped of ["shipped", "partially_shipped", "fulfilled", "delivered"]) assert.ok(!zohoOrderAddressOpen({ order_status: "open", shipped_status: shipped }), shipped);
});

test("a sales order is finished when void, or closed with the goods gone", () => {
  for (const status of ["void", "cancelled"]) assert.ok(zohoOrderFinished({ order_status: status }), status);
  assert.ok(zohoOrderFinished({ status: "void" }));
  assert.ok(zohoOrderFinished({ order_status: "closed", invoiced_status: "invoiced", shipped_status: "fulfilled" }));
  assert.ok(!zohoOrderFinished({ order_status: "open", invoiced_status: "invoiced", shipped_status: "fulfilled" }));
  assert.ok(!zohoOrderFinished({ order_status: "draft" }));
  // Live, 3 Nov 2026: Zoho closes a sales order as soon as it is invoiced, with nothing shipped.
  const invoicedLive = { status: "confirmed", order_status: "closed", invoiced_status: "invoiced", shipped_status: "pending" };
  assert.ok(!zohoOrderFinished(invoicedLive));
  assert.ok(!zohoOrderAddressOpen(invoicedLive));
});

test("an address still equal to the contact's was never set for the order; any other was", () => {
  const saved = { ...asZoho, address: "99 Old Street", address_id: "1" };
  const staff = { ...asZoho, address: "Set by staff" };
  const contact = { shipping_address: saved, billing_address: saved };
  assert.deepEqual(zohoAddressesFromContact({ shipping_address: saved, billing_address: saved }, contact, ["shipping", "billing"]), ["shipping", "billing"]);
  assert.deepEqual(zohoAddressesFromContact({ shipping_address: staff, billing_address: saved }, contact, ["shipping", "billing"]), ["billing"]);
  assert.deepEqual(zohoAddressesFromContact({ shipping_address: staff, billing_address: staff }, contact, ["shipping", "billing"]), []);
  assert.deepEqual(zohoAddressesFromContact({ shipping_address: saved, billing_address: saved }, contact, ["billing"]), ["billing"]);
  assert.deepEqual(zohoAddressesFromContact({ shipping_address: saved }, {}, ["shipping"]), []);
});

test("a Zoho address becomes the update call's body, keeping what the sales order holds", () => {
  const onSalesOrder = { company_name: "", address: " 12 Market Road ", street2: "Near temple", city: "Hubli", state: "Karnataka", zip: "580020", country: "India", country_code: "IN", phone: "98765", attention: "Ravi", fax: "" };
  assert.deepEqual(zohoAddressBody(onSalesOrder), { attention: "Ravi", address: "12 Market Road", street2: "Near temple", city: "Hubli", state: "Karnataka", zip: "580020", country: "India", phone: "98765" });
  assert.equal(zohoAddressBody({ ...asZoho, country: "" })?.country, "India");
  for (const key of ["address", "city", "state", "zip"]) assert.equal(zohoAddressBody({ ...asZoho, [key]: "" }), null, key);
  assert.equal(zohoAddressBody(undefined), null);
});

test("only the addresses an invoice shows differently from its sales order are copied", () => {
  const onInvoice = { street: "99 Old Street", address: "99 Old Street", street2: "TEST", city: "Challakere", state: "Karnataka", zip: "577522", country: "India", country_code: "IN", fax: "", phone: "", attention: "kiran (TEST)" };
  const blank = { address: "", street2: "", city: "", state: "", zip: "", country: "", attention: "" };
  assert.deepEqual(zohoInvoiceAddressesToCopy({ shipping_address: onInvoice, billing_address: onInvoice }, { shipping_address: asZoho, billing_address: asZoho }), ["shipping", "billing"]);
  assert.deepEqual(zohoInvoiceAddressesToCopy({ shipping_address: asZoho, billing_address: asZoho }, { shipping_address: asZoho, billing_address: asZoho }), []);
  assert.deepEqual(zohoInvoiceAddressesToCopy({ shipping_address: onInvoice, billing_address: asZoho }, { shipping_address: asZoho, billing_address: asZoho }), ["shipping"]);
  assert.deepEqual(zohoInvoiceAddressesToCopy({ shipping_address: onInvoice, billing_address: onInvoice }, { shipping_address: asZoho, billing_address: blank }), ["shipping"], "a sales order's blank address is not copied");
});

test("Zoho's copy on a live invoice counts as its contact's, so a new draft takes the sales order's address", () => {
  // Read from a real invoice and its contact, 3 Nov 2026 (street and names replaced).
  const onInvoice = { street: "Street", address: "Street", street2: "Landmark", city: "Challakere", state: "Karnataka", zip: "577522", country: "India", country_code: "IN", fax: "", phone: "", attention: "Name" };
  const onContact = { address_id: "3579709000002858005", attention: "Name", address: "Street", street2: "Landmark", city: "Challakere", state_code: "", state: "Karnataka", zip: "577522", country: "India", county: "", country_code: "IN", phone: "", fax: "", latitude: "", longitude: "" };
  const invoice = { status: "draft", shipping_address: onInvoice, billing_address: onInvoice };
  const salesOrder = { shipping_address: asZoho, billing_address: asZoho };
  const contact = { shipping_address: onContact, billing_address: onContact };
  assert.deepEqual(zohoAddressesFromContact(invoice, contact, zohoInvoiceAddressesToCopy(invoice, salesOrder)), ["shipping", "billing"]);
});

test("Zoho's copy on a live sales order counts as the same address as its contact's", () => {
  // Read from a real sales order and its contact, 3 Nov 2026 (street and names replaced).
  const onSalesOrder = { company_name: "", address: "Street", street2: "", city: "Chikkaballapur", state: "Karnataka", zip: "560102", country: "India", country_code: "IN", county: "", state_code: "KA", fax: "", phone: "", latitude: "", longitude: "", attention: "Name" };
  const onContact = { address_id: "3579709000002859227", attention: "Name", address: "Street", street2: "", city: "Chikkaballapur", state_code: "", state: "Karnataka", zip: "560102", country: "India", county: "", country_code: "IN", phone: "", fax: "", latitude: "", longitude: "" };
  assert.ok(sameZohoAddress(onSalesOrder, onContact));
});

test("a delivery state maps to Zoho's place of supply; an unknown one to nothing", () => {
  const place = (state: string) => ZOHO_PLACE_CODES[gstStateCodeOf(state) ?? ""];
  assert.equal(place("Karnataka"), "KA");
  assert.equal(place(" karnataka "), "KA");
  assert.equal(place("Andhra Pradesh"), "AD");
  assert.equal(place("Tamil Nadu"), "TN");
  assert.equal(place("Karnatak"), undefined);
  assert.equal(place(""), undefined);
});
