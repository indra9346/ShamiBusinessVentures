/*
 * The addresses of the category pages, and which addresses are not one. Pure, so the node tests can
 * load it (category-tree.ts brings the pictures).
 */

export const categorySlug = (name: string) =>
  name.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** The address of a store category ("Cooking Oil" lives at /categories/oil). */
export const storeCategorySlug = (name: string) => categorySlug(name === "Cooking Oil" ? "Oil" : name);

/** A record's own entry: "constructor" or "toString" in an address must not find JavaScript's built-ins. */
export const ownEntry = <T>(record: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

/** The store category at this address, from the store's list or raw database payloads. */
export function findStoreCategory<T>(slug: string, categories: readonly T[] | null | undefined): T | undefined {
  return categories?.find((category) => {
    const name = (category as { name?: unknown } | null)?.name;
    return typeof name === "string" && storeCategorySlug(name) === slug;
  });
}

/**
 * Only a list that was actually read can say an address is no category. With no list nobody can
 * tell, so a real category is never turned away because the data has not arrived.
 */
export const categoryIsMissing = (slug: string, categories: readonly unknown[] | null | undefined) =>
  !!categories && !findStoreCategory(slug, categories);
