/*
 * A product's pictures. The main picture stays in `image`: product cards, the cart, search, Google
 * and the Zoho item all read only that. Any further pictures for the product page's gallery are in
 * `images`, in the order the admin set. Pure, so the node tests can load it.
 */

/** The most pictures one product can hold (the main picture included), the same as a product code. */
export const MAX_PRODUCT_IMAGES = 8;

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** The list without blanks or repeats, in order, at most MAX_PRODUCT_IMAGES long. */
export function tidyImages(list: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const tidy: string[] = [];
  for (const item of list) {
    const url = text(item);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    tidy.push(url);
    if (tidy.length === MAX_PRODUCT_IMAGES) break;
  }
  return tidy;
}

/** Every picture of a product, the main one first. Takes the saved payload as it is, so odd values are skipped. */
export function productImages(product: { image?: unknown; images?: unknown }): string[] {
  return tidyImages([product.image, ...(Array.isArray(product.images) ? product.images : [])]);
}

/** What a product saves from the editor's list: the first picture as `image`, the others as `images`. */
export function imageFields(list: readonly string[]): { image: string; images: string[] } {
  const tidy = tidyImages(list);
  return { image: tidy[0] ?? "", images: tidy.slice(1) };
}

/** A new list, or a change worked out from the list as it is when the change lands (uploads finish later). */
export type ImagesUpdate = string[] | ((current: string[]) => string[]);

/** A form's `image` (main) and `images` (the others) after a change in the pictures editor. */
export function withImages<T extends { image: string; images: string[] }>(
  fields: T,
  update: ImagesUpdate,
): T {
  const next = typeof update === "function" ? update(productImages(fields)) : update;
  return { ...fields, ...imageFields(next) };
}

/** The picture at `from` moved to `to` (kept in range). */
export function moveImage(list: readonly string[], from: number, to: number): string[] {
  if (from < 0 || from >= list.length) return [...list];
  const target = Math.max(0, Math.min(list.length - 1, to));
  const next = [...list];
  const [picked] = next.splice(from, 1);
  next.splice(target, 0, picked!);
  return next;
}

/** The picture at `index` becomes the main picture; the others keep their order. */
export function makeMainImage(list: readonly string[], index: number): string[] {
  return moveImage(list, index, 0);
}

/** The list without the picture at `index`. Removing the main picture makes the next one main. */
export function removeImage(list: readonly string[], index: number): string[] {
  return list.filter((_, at) => at !== index);
}

/**
 * New pictures added at the end. Pictures already in the list, and any past the limit, are left out
 * and counted, so the editor can say why.
 */
export function addImages(list: readonly string[], urls: readonly string[]) {
  const images = [...list];
  let repeated = 0;
  let overLimit = 0;
  for (const raw of urls) {
    const url = raw.trim();
    if (!url) continue;
    if (images.includes(url)) repeated += 1;
    else if (images.length >= MAX_PRODUCT_IMAGES) overLimit += 1;
    else images.push(url);
  }
  return { images, added: images.length - list.length, repeated, overLimit };
}

/** A pasted picture address the editor accepts: a full web address, or a picture on this site ("/products/rice.jpg"). */
export function isImageAddress(value: string): boolean {
  const url = value.trim();
  return /^https?:\/\/\S+$/i.test(url) || /^\/[^/\s]\S*$/.test(url);
}

/** The picture `delta` steps from `index` in a gallery of `count`, stopping at the first and last. */
export function stepImage(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, index + delta));
}

/**
 * Which picture a swiped gallery shows: the scroll position divided by the width of one picture,
 * rounded. A width of 0 (not laid out yet) means the first.
 */
export function imageAtScroll(scrollLeft: number, width: number, count: number): number {
  if (!(width > 0) || count <= 0) return 0;
  return stepImage(Math.round(Math.abs(scrollLeft) / width), 0, count);
}
