import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PRODUCT_IMAGES,
  addImages,
  imageAtScroll,
  imageFields,
  isImageAddress,
  makeMainImage,
  moveImage,
  productImages,
  removeImage,
  stepImage,
  tidyImages,
  withImages,
} from "../src/lib/product-images.ts";
import { productJsonLd } from "../src/lib/seo.ts";

const A = "https://x.supabase.co/storage/v1/object/public/catalog-images/u/products/a.webp";
const B = "https://x.supabase.co/storage/v1/object/public/catalog-images/u/products/b.webp";
const C = "https://x.supabase.co/storage/v1/object/public/catalog-images/u/products/c.webp";

test("a product with one picture has a gallery of one, as before", () => {
  assert.deepEqual(productImages({ image: A }), [A]);
  assert.deepEqual(productImages({ image: A, images: [] }), [A]);
  assert.deepEqual(productImages({}), []);
});

test("the main picture comes first, then the others in order, without blanks, repeats or odd values", () => {
  assert.deepEqual(productImages({ image: A, images: [B, C] }), [A, B, C]);
  assert.deepEqual(productImages({ image: ` ${A} `, images: [A, "", "  ", null, 7, B, B] }), [
    A,
    B,
  ]);
  // A payload where `images` is not a list (hand-edited, or from an older copy) still shows its main picture.
  assert.deepEqual(productImages({ image: A, images: "oops" }), [A]);
  // No main picture saved: the first further picture leads.
  assert.deepEqual(productImages({ image: "", images: [B, C] }), [B, C]);
});

test("never more than the limit", () => {
  const many = Array.from({ length: 12 }, (_, i) => `https://cdn.example/${i}.jpg`);
  assert.equal(tidyImages(many).length, MAX_PRODUCT_IMAGES);
  assert.equal(productImages({ image: A, images: many }).length, MAX_PRODUCT_IMAGES);
  assert.equal(productImages({ image: A, images: many })[0], A);
});

test("saving splits the list: the first is image (what cards, cart, Google and Zoho read), the rest images", () => {
  assert.deepEqual(imageFields([A, B, C]), { image: A, images: [B, C] });
  assert.deepEqual(imageFields([A]), { image: A, images: [] });
  assert.deepEqual(imageFields([]), { image: "", images: [] });
  assert.deepEqual(imageFields([A, A, B]), { image: A, images: [B] });
  // Read back, the same list.
  assert.deepEqual(productImages(imageFields([C, A, B])), [C, A, B]);
});

test("reorder, set as main and remove", () => {
  assert.deepEqual(moveImage([A, B, C], 0, 1), [B, A, C]);
  assert.deepEqual(moveImage([A, B, C], 2, 1), [A, C, B]);
  assert.deepEqual(moveImage([A, B, C], 2, 9), [A, B, C]); // past the end: stays last
  assert.deepEqual(moveImage([A, B, C], 1, -3), [B, A, C]); // before the start: becomes first
  assert.deepEqual(moveImage([A, B], 5, 0), [A, B]); // no such picture: unchanged
  assert.deepEqual(makeMainImage([A, B, C], 2), [C, A, B]);
  assert.deepEqual(makeMainImage([A, B, C], 0), [A, B, C]);
  assert.deepEqual(removeImage([A, B, C], 1), [A, C]);
  // Removing the main picture makes the next one the main picture.
  assert.deepEqual(imageFields(removeImage([A, B, C], 0)), { image: B, images: [C] });
  assert.deepEqual(removeImage([A], 0), []);
});

test("a form keeps the main picture in image and the others in images, whatever the editor does", () => {
  const form = { name: "S1", image: A, images: [B] };
  assert.deepEqual(
    withImages(form, (current) => [...current, C]),
    { name: "S1", image: A, images: [B, C] },
  );
  assert.deepEqual(
    withImages(form, (current) => makeMainImage(current, 1)),
    { name: "S1", image: B, images: [A] },
  );
  assert.deepEqual(withImages(form, []), { name: "S1", image: "", images: [] });
  // A form whose main picture was cleared (a product code taken off) still lists its other pictures.
  assert.deepEqual(
    withImages({ image: "", images: [B, C] }, (current) => current),
    { image: B, images: [C] },
  );
});

test("adding pictures skips repeats and stops at the limit, and says how many", () => {
  assert.deepEqual(addImages([A], [B, " ", A, C]), {
    images: [A, B, C],
    added: 2,
    repeated: 1,
    overLimit: 0,
  });
  const seven = Array.from(
    { length: MAX_PRODUCT_IMAGES - 1 },
    (_, i) => `https://cdn.example/${i}.jpg`,
  );
  const full = addImages(seven, [A, B, C]);
  assert.equal(full.images.length, MAX_PRODUCT_IMAGES);
  assert.equal(full.added, 1);
  assert.equal(full.overLimit, 2);
});

test("pasted addresses: full web addresses and the site's own pictures only", () => {
  assert.ok(isImageAddress(A));
  assert.ok(isImageAddress("http://example.com/p.png"));
  assert.ok(isImageAddress(" /products/rice.jpg "));
  assert.equal(isImageAddress(""), false);
  assert.equal(isImageAddress("rice.jpg"), false);
  assert.equal(isImageAddress("//evil.example/p.png"), false);
  assert.equal(isImageAddress("javascript:alert(1)"), false);
  assert.equal(isImageAddress("https://example.com/a b.png"), false);
});

test("arrows stop at the first and last picture; a swipe lands on the nearest picture", () => {
  assert.equal(stepImage(0, -1, 3), 0);
  assert.equal(stepImage(0, 1, 3), 1);
  assert.equal(stepImage(2, 1, 3), 2);
  assert.equal(stepImage(5, 0, 3), 2);
  assert.equal(stepImage(0, 1, 0), 0);
  assert.equal(imageAtScroll(0, 360, 3), 0);
  assert.equal(imageAtScroll(350, 360, 3), 1);
  assert.equal(imageAtScroll(900, 360, 3), 2);
  assert.equal(imageAtScroll(5000, 360, 3), 2);
  assert.equal(imageAtScroll(100, 0, 3), 0);
});

test("Google gets every picture, the main one first, once each", () => {
  const data = productJsonLd({
    id: "P1",
    name: "S1 Sugar 50kg",
    price: 2500,
    image: A,
    images: [B, A, "", C],
  });
  assert.deepEqual(data.image, [A, B, C]);
  assert.deepEqual(
    productJsonLd({ id: "P1", name: "x", price: 1, image: "/products/rice.jpg" }).image,
    ["https://grainbazar.com/products/rice.jpg"],
  );
  assert.equal("image" in productJsonLd({ id: "P1", name: "x", price: 1 }), false);
});
