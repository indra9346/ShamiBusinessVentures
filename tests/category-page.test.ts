import { test } from "node:test";
import assert from "node:assert/strict";
import { categoryIsMissing, categorySlug, findStoreCategory, ownEntry, storeCategorySlug } from "../src/lib/category-slug.ts";

const rows = [{ name: "Rice" }, { name: "Sugar" }, { name: "Oil" }, { name: "Dal & Millet" }];

test("a category's address is the one every link uses", () => {
  assert.equal(categorySlug("Rice"), "rice");
  assert.equal(categorySlug("Dal & Millet"), "dal-and-millet");
  assert.equal(storeCategorySlug("Cooking Oil"), "oil");
  assert.equal(storeCategorySlug("Oil"), "oil");
});

test("an address never finds JavaScript's built-ins", () => {
  const tree = { rice: 1 };
  assert.equal(ownEntry(tree, "rice"), 1);
  for (const key of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
    assert.equal(ownEntry(tree, key), undefined, key);
  }
});

test("a store category is found by its address", () => {
  assert.equal(findStoreCategory("dal-and-millet", rows), rows[3]);
  assert.equal(findStoreCategory("oil", [{ name: "Cooking Oil" }])?.name, "Cooking Oil");
  assert.deepEqual(findStoreCategory("rice", [null, 3, { name: 4 }, { name: "Rice" }]), { name: "Rice" }, "bad rows are skipped");
  assert.equal(findStoreCategory("rice", null), undefined);
});

test("an address is missing only when the list was read and it is not there", () => {
  assert.equal(categoryIsMissing("$slug", rows), true);
  assert.equal(categoryIsMissing("does-not-exist", rows), true);
  assert.equal(categoryIsMissing("Rice", rows), true, "addresses are lower case");
  assert.equal(categoryIsMissing("constructor", rows), true);
  assert.equal(categoryIsMissing("anything", []), true, "an empty table is a real empty list");
  assert.equal(categoryIsMissing("sugar", rows), false);
  assert.equal(categoryIsMissing("dal-and-millet", rows), false);
});

test("with no list, nothing is called missing", () => {
  assert.equal(categoryIsMissing("$slug", null), false);
  assert.equal(categoryIsMissing("dal-and-millet", undefined), false);
});
