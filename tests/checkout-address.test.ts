import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addressChangeBetween, addressChangeText, addressEditPatch, addressFieldsOf, addressFormProblem, addressLockReason, cleanAddressFields,
  lineProblems, lineProblemText, mapPointAfterEdit, mapPointOf, pinHint, pointIsTheSavedOne,
  type LineProblem, type SavedAddress,
} from "../src/lib/checkout-address.ts";
import { loadKannada, translateText } from "../src/lib/i18n-core.ts";

await loadKannada();

const saved: SavedAddress = {
  label: "Home", name: "Sample Customer", phone: "9000000001", line: "12 Sample Road", city: "Challakere", state: "Karnataka", pin: "577522", landmark: "Near the temple",
  latitude: 14.31, longitude: 76.65, locationAccuracy: 12, locatedAt: "2026-10-01T10:00:00.000Z",
};
const form = addressFieldsOf(saved);
const savedPoint = mapPointOf(saved);
const money = (amount: number) => `₹${amount.toLocaleString("en-IN")}`;

test("an edited address must pass the same check as a new one", () => {
  assert.equal(addressFormProblem(form), null);
  for (const change of [{ name: " " }, { phone: "90000" }, { line: "" }, { city: "  " }, { pin: "5775" }, { pin: "57752a" }]) {
    assert.ok(addressFormProblem({ ...form, ...change }), `should refuse ${JSON.stringify(change)}`);
  }
  assert.equal(addressFormProblem({ ...form, phone: "+91 90000 00001", pin: " 577522 " }), null);
  assert.equal(addressFormProblem({ ...form, label: "", landmark: "" }), null);
});

test("what is saved is trimmed, and a blank label reads Delivery", () => {
  const clean = cleanAddressFields({ ...form, label: " ", name: " A ", pin: " 577522 " });
  assert.deepEqual([clean.label, clean.name, clean.pin], ["Delivery", "A", "577522"]);
});

test("an edit that changes nothing writes nothing", () => {
  assert.equal(addressEditPatch(saved, form, savedPoint), null);
  assert.equal(addressEditPatch(saved, { ...form, line: " 12 Sample Road " }, savedPoint), null);
  const noLandmark = { ...saved, landmark: null };
  assert.equal(addressEditPatch(noLandmark, addressFieldsOf(noLandmark), savedPoint), null);
});

test("a house-number fix keeps the saved map point and does not resend it", () => {
  const patch = addressEditPatch(saved, { ...form, line: "12A Sample Road" }, savedPoint);
  assert.equal(patch?.line, "12A Sample Road");
  assert.ok(patch && !("latitude" in patch));
});

test("typing a different PIN removes the old map point", () => {
  assert.equal(mapPointAfterEdit(saved, savedPoint, "580020"), null);
  const patch = addressEditPatch(saved, { ...form, pin: "580020" }, savedPoint);
  assert.ok(patch && "latitude" in patch);
  assert.equal((patch as { latitude?: number }).latitude, undefined);
});

test("a point captured during the edit is kept, even with a typed PIN", () => {
  const fresh = { latitude: 15.36, longitude: 75.12, locationAccuracy: 8, locatedAt: "2026-11-02T10:00:00.000Z" };
  assert.equal(pointIsTheSavedOne(saved, fresh), false);
  assert.deepEqual(mapPointAfterEdit(saved, fresh, "580020"), fresh);
  const patch = addressEditPatch(saved, form, fresh);
  assert.equal((patch as { latitude?: number } | null)?.latitude, 15.36);
});

test("the saved point is recognised when the database writes its time differently", () => {
  const reread = { ...saved, locatedAt: "2026-10-01T10:00:00+00:00" };
  assert.equal(pointIsTheSavedOne(reread, savedPoint), true);
  assert.equal(mapPointAfterEdit(reread, savedPoint, "580020"), null);
  assert.equal(addressEditPatch(reread, form, savedPoint), null);
});

test("an address with no map point stays without one", () => {
  const plain: SavedAddress = { ...form, landmark: "" };
  assert.equal(mapPointOf(plain), null);
  assert.equal(mapPointAfterEdit(plain, null, "580020"), null);
  const patch = addressEditPatch(plain, { ...form, landmark: "", pin: "580020" }, null);
  assert.ok(patch && !("latitude" in patch));
});

test("lines the new godown cannot fill are named; the rest pass", () => {
  const problems = lineProblems([
    { id: "ok", name: "Rice", qty: 2, available: 50 },
    { id: "edge", name: "Dal", qty: 5, available: 5 },
    { id: "gone", name: "Sugar", qty: 1, available: null },
    { id: "low", name: "Oil", qty: 5, available: 2 },
    { id: "zero", name: "Salt", qty: 1, available: 0 },
  ]);
  assert.deepEqual(problems.map((line) => [line.id, line.kind]), [["gone", "not_sold"], ["low", "short"], ["zero", "short"]]);
  const [gone, low, zero] = problems as [LineProblem, LineProblem, LineProblem];
  assert.match(lineProblemText(gone, "Hubli"), /Sugar: not sold at the Hubli godown/);
  assert.match(lineProblemText(low, "Hubli"), /Oil: only 2 available at the Hubli godown, you have 5/);
  assert.match(lineProblemText(zero, "Hubli"), /Salt: out of stock at the Hubli godown/);
  assert.match(lineProblemText({ id: "x", name: "", qty: 1, available: null, kind: "not_sold" }, "Hubli"), /^This item:/);
});

test("a move of godown is always told, with the old and new total", () => {
  const before = { pin: "577522", godownId: "BR-CLK", godownName: "Challakere", total: 1050 };
  const now = { pin: "580020", godownId: "BR-HBL", godownName: "Hubli", total: 1155 };
  const change = addressChangeBetween(before, now);
  assert.deepEqual(change, { fromTotal: 1050, movedTo: "Hubli" });
  const text = addressChangeText(change!, 1155, money)!;
  assert.equal(text.title, "Your total changed from ₹1,050 to ₹1,155");
  assert.match(text.detail, /Hubli godown now serves this address/);
  assert.equal(addressChangeText({ fromTotal: 1155, movedTo: "Hubli" }, 1155, money)?.title, "Your total stays ₹1,155");
});

test("a new PIN at the same godown and the same total says nothing", () => {
  const before = { pin: "577522", godownId: "BR-CLK", godownName: "Challakere", total: 1050 };
  assert.equal(addressChangeBetween(before, { ...before, pin: "577536" }), null);
  assert.equal(addressChangeBetween(before, { ...before, pin: "577536", total: 1050.001 }), null);
  assert.deepEqual(addressChangeBetween(before, { ...before, pin: "577536", total: 1100 }), { fromTotal: 1050, movedTo: null });
});

test("the notice reads the total live, and goes when it comes back level with no move", () => {
  const change = { fromTotal: 1050, movedTo: "Hubli" };
  assert.equal(addressChangeText(change, 1405, money)?.title, "Your total changed from ₹1,050 to ₹1,405");
  assert.equal(addressChangeText({ fromTotal: 1050, movedTo: null }, 1050, money), null);
});

test("the form warns about a PIN before it is saved", () => {
  assert.equal(pinHint({ pin: "5805", outside: false, movesTo: "Hubli" }), null);
  assert.equal(pinHint({ pin: "577536", outside: false, movesTo: null }), null);
  assert.match(pinHint({ pin: "580020", outside: false, movesTo: "Hubli" }) ?? "", /served by the Hubli godown/);
  assert.match(pinHint({ pin: "560068", outside: true, movesTo: "Hubli" }) ?? "", /don't deliver to PIN 560068/);
});

test("a locked address says why, in the words that fit its state", () => {
  const waiting = addressLockReason({ paid: false, checking: false, godown: "Hubli" });
  assert.match(waiting, /held at the Hubli godown.*If you have not paid yet.*cancel this payment/);
  // Money may already be on its way: cancelling must never read as safe for someone who has paid.
  assert.match(waiting, /already paid, do not cancel: call us/);
  // A checkout with a UTR in cannot be cancelled, so it must not be told to.
  assert.doesNotMatch(addressLockReason({ paid: false, checking: true, godown: "Hubli" }), /cancel/);
  assert.match(addressLockReason({ paid: true, checking: false, godown: "Hubli" }), /order is placed/);
});

test("every message reads in Kannada, with its values in place", () => {
  const latin = /[A-Za-z]{3,}/;
  const named = (text: string) => text.replace(/\b(Rice|Hubli|PIN|Sample|Reorder)\b/g, "");
  const messages = [
    addressFormProblem({ ...form, name: "" })!,
    pinHint({ pin: "580020", outside: false, movesTo: "Hubli" })!,
    pinHint({ pin: "560068", outside: true, movesTo: null })!,
    addressChangeText({ fromTotal: 1050, movedTo: "Hubli" }, 1155, money)!.title,
    addressChangeText({ fromTotal: 1050, movedTo: "Hubli" }, 1050, money)!.title,
    addressChangeText({ fromTotal: 1050, movedTo: "Hubli" }, 1155, money)!.detail,
    addressChangeText({ fromTotal: 1050, movedTo: null }, 1155, money)!.detail,
    lineProblemText({ id: "a", name: "Rice", qty: 1, available: null, kind: "not_sold" }, "Hubli"),
    lineProblemText({ id: "a", name: "Rice", qty: 5, available: 2, kind: "short" }, "Hubli"),
    lineProblemText({ id: "a", name: "Rice", qty: 5, available: 0, kind: "short" }, "Hubli"),
    lineProblemText({ id: "a", name: "", qty: 1, available: null, kind: "not_sold" }, "nearest"),
    addressLockReason({ paid: true, checking: false, godown: "Hubli" }),
    addressLockReason({ paid: false, checking: true, godown: "Hubli" }),
    addressLockReason({ paid: false, checking: false, godown: "Hubli" }),
    "Edit your delivery address", "Edit this address", "Edit Home address", "Delivery address updated", "Deliver to", "Your address",
    "Please refresh the page and try again.",
    "Your past orders and any checkout waiting for payment keep the address they were placed with.",
    "Map point saved with this address",
    "The PIN changed, so the old map point will be removed. Use your current location to set a new one.",
    "Some items need a change before you can continue", "Remove the items listed on this page, or change your address.",
    "Set quantity to 2", "Change address", "Prices show once your address is in our service area.", "No item in your cart is sold at the Hubli godown.",
    "Updating prices…", "Address on this checkout", "Address on this order", "Save changes", "Edit", "Remove", "Cancel", "View on map",
  ];
  for (const message of messages) {
    const out = translateText(message, "kn");
    assert.notEqual(out, message, `no Kannada for "${message}"`);
    assert.ok(!latin.test(named(out)), `English left in "${out}"`);
    assert.ok(!/\{\d\}/.test(out), `unfilled placeholder in "${out}"`);
  }
  assert.ok(translateText("Your total changed from ₹1,050 to ₹1,155", "kn").includes("₹1,155"));
  assert.ok(translateText("Zzyx: only 2 available at the Hubli godown, you have 5", "kn").includes("Zzyx"));
});
