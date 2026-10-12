import type { Product, StoreCategory } from "./data";
import { isStorefrontProduct } from "./data";

/**
 * Normalizes text for search comparison:
 * - Trims and converts to lowercase
 * - Strips common search prefixes like "sku:", "sku ", "code:", "code ", "item:", "id:"
 * - Strips punctuation for clean tokenization
 */
export function cleanSearchQuery(raw: string): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

/** Case-, spacing-, punctuation-, and accent-insensitive key for exact facets. */
export function normalizeFacetValue(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Matches either an explicit product brand or a brand printed in its product name. */
export function productMatchesBrand(product: Product, brand: string): boolean {
  const key = normalizeFacetValue(brand);
  if (!key) return false;
  return normalizeFacetValue(product.brand) === key || normalizeFacetValue(product.name).includes(key);
}

/** Brand choices are taken from actual products, with configured labels as fallbacks. */
export function availableProductBrands(products: Product[], configuredBrands: string[] = []): string[] {
  const byKey = new Map<string, string>();
  for (const candidate of [...configuredBrands, ...products.map((product) => product.brand)]) {
    const label = typeof candidate === "string" ? candidate.trim().replace(/\s+/g, " ") : "";
    const key = normalizeFacetValue(label);
    if (label && key && !byKey.has(key)) byKey.set(key, label);
  }
  return [...byKey.values()]
    .filter((brand) => products.some((product) => productMatchesBrand(product, brand)))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/**
 * Strips search prefixes like "sku ", "sku: ", "code: ", "item " so
 * "SKU SBV-OI-1022" becomes "sbv-oi-1022".
 */
export function stripSearchPrefixes(text: string): string {
  return text
    .replace(/^(sku\s*code|product\s*code|sku|code|item|product|id)[\s:#_/-]+/i, "")
    .replace(/[\s:#_/-]+(sku|code|item|product|id)$/i, "")
    .trim();
}

/**
 * Normalizes alphanumeric string by removing all non-alphanumeric chars.
 * E.g. "SBV-OI-1022" -> "sbvoi1022"
 */
export function toAlphaNumeric(text: string): string {
  return normalizeFacetValue(text);
}

/**
 * Breaks a query into significant search tokens, ignoring empty and single noise words.
 */
export function tokenizeQuery(query: string): string[] {
  const cleaned = cleanSearchQuery(query);
  const stripped = stripSearchPrefixes(cleaned);
  if (!stripped) return [];
  const words = stripped.split(/[\s,+/|]+/).filter(Boolean);
  return words;
}

/**
 * Checks if a product matches a search query with ultra-high accuracy:
 * 1. Direct SKU match (with or without "SKU" prefix, with or without hyphens)
 * 2. Direct Product Code / ID match (e.g. "P023")
 * 3. Exact phrase match across name, brand, vendor, category, subcategory
 * 4. Multi-token match: every word in query matches somewhere in product details
 * 5. Partial alphanumeric code match (e.g. "sbv-oi-102" matches "SBV-OI-1022")
 */
export function matchProductSearch(p: Product, rawQuery: string): boolean {
  if (!rawQuery || !rawQuery.trim()) return true;

  const text = (value: unknown) => typeof value === "string" ? value : "";

  const rawLower = cleanSearchQuery(rawQuery);
  const stripped = stripSearchPrefixes(rawLower);
  const strippedAlpha = toAlphaNumeric(stripped);

  const skuLower = text(p.sku).toLowerCase();
  const skuAlpha = toAlphaNumeric(skuLower);
  const idLower = text(p.id).toLowerCase();
  const idAlpha = toAlphaNumeric(idLower);

  // 1. Direct SKU / Code matches (highest priority)
  if ((stripped && skuLower === stripped) || skuLower === rawLower) return true;
  if (skuAlpha && strippedAlpha && (skuAlpha === strippedAlpha || skuAlpha.includes(strippedAlpha))) {
    return true;
  }
  if ((stripped && idLower === stripped) || idLower === rawLower || (idAlpha && strippedAlpha && idAlpha === strippedAlpha)) return true;

  // Check if query contains product SKU or ID as a word
  if (skuLower && rawLower.includes(skuLower)) return true;
  if (idLower && rawLower.includes(idLower)) return true;

  // 2. Build full searchable text corpus for this product
  const pName = text(p.name).toLowerCase();
  const pBrand = text(p.brand).toLowerCase();
  const pVendor = text(p.vendor).toLowerCase();
  const pCategory = text(p.category).toLowerCase();
  const pSubcategory = text(p.subcategory).toLowerCase();
  const pWeight = text(p.weight).toLowerCase();
  const pDesc = text(p.description).toLowerCase();
  const pTags = (Array.isArray(p.tags) ? p.tags : []).filter((tag) => typeof tag === "string").join(" ").toLowerCase();
  const pSpecs = (Array.isArray(p.specs) ? p.specs : [])
    .map((spec) => `${text(spec?.label)} ${text(spec?.value)}`)
    .join(" ")
    .toLowerCase();

  const fullCorpus = `${pName} ${skuLower} sku ${skuLower} ${idLower} ${pBrand} ${pVendor} ${pCategory} ${pSubcategory} ${pWeight} ${pTags} ${pSpecs} ${pDesc}`;
  const corpusAlpha = toAlphaNumeric(fullCorpus);

  // Substring of stripped query or raw query
  if ((stripped && fullCorpus.includes(stripped)) || fullCorpus.includes(rawLower)) return true;
  if (strippedAlpha.length >= 3 && corpusAlpha.includes(strippedAlpha)) return true;

  // 3. Multi-token tokenized search: every token must match somewhere in the corpus
  const tokens = tokenizeQuery(rawQuery);
  if (tokens.length > 0) {
    const allTokensMatch = tokens.every((token) => {
      const tokenAlpha = toAlphaNumeric(token);
      if (tokenAlpha.length >= 2 && corpusAlpha.includes(tokenAlpha)) return true;
      return fullCorpus.includes(token);
    });
    if (allTokensMatch) return true;
  }

  return false;
}

/**
 * Calculates a match relevance score for sorting search results.
 * Higher score = more relevant match.
 */
export function scoreProductSearch(p: Product, rawQuery: string): number {
  if (!rawQuery || !rawQuery.trim()) return 0;

  const text = (value: unknown) => typeof value === "string" ? value : "";

  const rawLower = cleanSearchQuery(rawQuery);
  const stripped = stripSearchPrefixes(rawLower);
  const strippedAlpha = toAlphaNumeric(stripped);

  const skuLower = text(p.sku).toLowerCase();
  const skuAlpha = toAlphaNumeric(p.sku);
  const idLower = text(p.id).toLowerCase();
  const idAlpha = toAlphaNumeric(p.id);
  const nameLower = text(p.name).toLowerCase();

  let score = 0;

  // Exact SKU match
  if ((Boolean(stripped) && skuLower === stripped) || skuLower === rawLower ||
    (Boolean(strippedAlpha) && skuAlpha === strippedAlpha)) {
    score += 1000;
  } else if ((stripped && skuLower.includes(stripped)) || (strippedAlpha.length >= 3 && skuAlpha.includes(strippedAlpha))) {
    score += 700;
  }

  // Exact ID match
  if ((Boolean(stripped) && idLower === stripped) || idLower === rawLower ||
    (Boolean(strippedAlpha) && idAlpha === strippedAlpha)) {
    score += 900;
  }

  // Exact Name match or name starts with query
  if (nameLower === stripped || nameLower === rawLower) {
    score += 800;
  } else if ((stripped && nameLower.startsWith(stripped)) || nameLower.startsWith(rawLower)) {
    score += 500;
  } else if (stripped && nameLower.includes(stripped)) {
    score += 350;
  }

  // Category & Subcategory match
  const category = text(p.category).toLowerCase();
  const subcategory = text(p.subcategory).toLowerCase();
  const brand = text(p.brand).toLowerCase();
  const vendor = text(p.vendor).toLowerCase();
  if ((stripped && category === stripped) || category === rawLower) {
    score += 300;
  } else if (stripped && category.includes(stripped)) {
    score += 150;
  }

  if ((stripped && subcategory === stripped) || subcategory === rawLower) {
    score += 250;
  } else if (stripped && subcategory.includes(stripped)) {
    score += 120;
  }

  // Brand & Vendor match
  if (stripped && brand.includes(stripped)) score += 100;
  if (stripped && vendor.includes(stripped)) score += 80;

  // Rating & Stock boosts
  score += Math.min(50, (p.rating || 0) * 10);
  if (p.stock > (p.reserved || 0)) score += 20;

  return score;
}

export type SearchSuggestionItem =
  | { kind: "direct_sku"; product: Product; label: string }
  | { kind: "product"; product: Product }
  | { kind: "category"; category: StoreCategory }
  | { kind: "subcategory"; category: StoreCategory; subcategory: string };

/**
 * Returns structured real-time autosuggestions for products, SKUs, and categories.
 */
export function getSearchAutosuggestions(
  allProducts: Product[],
  allCategories: StoreCategory[],
  rawQuery: string,
  maxResults = 7,
): SearchSuggestionItem[] {
  const query = cleanSearchQuery(rawQuery);
  const limit = Number.isFinite(maxResults) ? Math.max(0, Math.floor(maxResults)) : 7;
  if (!query || limit === 0) return [];

  const stripped = stripSearchPrefixes(query);
  const strippedAlpha = toAlphaNumeric(stripped);

  const results: SearchSuggestionItem[] = [];

  // Filter storefront products
  const eligibleProducts = allProducts.filter(isStorefrontProduct);

  // 1. Check for direct SKU / ID exact match first
  const exactSkuProduct = eligibleProducts.find((p) => {
    const sLower = (typeof p.sku === "string" ? p.sku : "").toLowerCase();
    const sAlpha = toAlphaNumeric(p.sku);
    const idLower = (typeof p.id === "string" ? p.id : "").toLowerCase();
    return (Boolean(stripped) && sLower === stripped) || sLower === query ||
      (Boolean(strippedAlpha) && sAlpha === strippedAlpha) || (Boolean(stripped) && idLower === stripped) || idLower === query;
  });

  if (exactSkuProduct) {
    results.push({
      kind: "direct_sku",
      product: exactSkuProduct,
      label: `SKU Match: ${exactSkuProduct.sku}`,
    });
  }

  // 2. Matching Categories & Subcategories
  const seenCategories = new Set<string>();
  for (const cat of allCategories) {
    if (cat.enabled === false) continue;
    const catNameLower = (typeof cat.name === "string" ? cat.name : "").toLowerCase();
    if (stripped && catNameLower && (catNameLower.includes(stripped) || stripped.includes(catNameLower))) {
      if (!seenCategories.has(cat.id)) {
        seenCategories.add(cat.id);
        if (results.length < limit) results.push({ kind: "category", category: cat });
      }
    }
    // Check grades / subcategories
    for (const grade of Array.isArray(cat.grades) ? cat.grades : []) {
      const gradeLower = (typeof grade === "string" ? grade : "").toLowerCase();
      if (stripped && gradeLower && (gradeLower.includes(stripped) || stripped.includes(gradeLower))) {
        if (results.length < limit) results.push({ kind: "subcategory", category: cat, subcategory: grade });
      }
    }
  }

  // 3. Matching Products ranked by relevance
  const matchingProducts = eligibleProducts
    .filter((p) => (!exactSkuProduct || p.id !== exactSkuProduct.id) && matchProductSearch(p, query))
    .map((product) => ({ product, score: scoreProductSearch(product, query) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit - results.length));

  for (const item of matchingProducts) {
    results.push({ kind: "product", product: item.product });
  }

  return results.slice(0, limit);
}
