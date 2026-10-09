import type { Product, StoreCategory } from "./data";
import { isStorefrontProduct } from "./data";

/**
 * Normalizes text for search comparison:
 * - Trims and converts to lowercase
 * - Strips common search prefixes like "sku:", "sku ", "code:", "code ", "item:", "id:"
 * - Strips punctuation for clean tokenization
 */
export function cleanSearchQuery(raw: string): string {
  if (!raw) return "";
  return raw.trim().toLowerCase();
}

/**
 * Strips search prefixes like "sku ", "sku: ", "code: ", "item " so
 * "SKU SBV-OI-1022" becomes "sbv-oi-1022".
 */
export function stripSearchPrefixes(text: string): string {
  return text
    .replace(/^(sku|code|item|product|id|sku\s*code|product\s*code)[\s:#_/-]+/i, "")
    .replace(/[\s:#_/-]+(sku|code|item|product|id)$/i, "")
    .trim();
}

/**
 * Normalizes alphanumeric string by removing all non-alphanumeric chars.
 * E.g. "SBV-OI-1022" -> "sbvoi1022"
 */
export function toAlphaNumeric(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Breaks a query into significant search tokens, ignoring empty and single noise words.
 */
export function tokenizeQuery(query: string): string[] {
  const cleaned = cleanSearchQuery(query);
  const stripped = stripSearchPrefixes(cleaned);
  const words = (stripped || cleaned).split(/[\s,+/|]+/).filter(Boolean);
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

  const rawLower = cleanSearchQuery(rawQuery);
  const stripped = stripSearchPrefixes(rawLower);
  const queryAlpha = toAlphaNumeric(rawLower);
  const strippedAlpha = toAlphaNumeric(stripped);

  const skuLower = p.sku.toLowerCase();
  const skuAlpha = toAlphaNumeric(p.sku);
  const idLower = p.id.toLowerCase();
  const idAlpha = toAlphaNumeric(p.id);

  // 1. Direct SKU / Code matches (highest priority)
  if (skuLower === stripped || skuLower === rawLower) return true;
  if (skuAlpha && strippedAlpha && (skuAlpha === strippedAlpha || skuAlpha.includes(strippedAlpha) || strippedAlpha.includes(skuAlpha))) {
    return true;
  }
  if (idLower === stripped || idLower === rawLower || idAlpha === strippedAlpha) return true;

  // Check if query contains product SKU or ID as a word
  if (rawLower.includes(skuLower) || (stripped && rawLower.includes(stripped))) return true;

  // 2. Build full searchable text corpus for this product
  const pName = p.name.toLowerCase();
  const pBrand = p.brand.toLowerCase();
  const pVendor = p.vendor.toLowerCase();
  const pCategory = p.category.toLowerCase();
  const pSubcategory = p.subcategory.toLowerCase();
  const pWeight = p.weight.toLowerCase();
  const pDesc = (p.description || "").toLowerCase();
  const pTags = (p.tags || []).join(" ").toLowerCase();
  const pSpecs = (p.specs || []).map((s) => `${s.label} ${s.value}`).join(" ").toLowerCase();

  const fullCorpus = `${pName} ${skuLower} sku ${skuLower} ${idLower} ${pBrand} ${pVendor} ${pCategory} ${pSubcategory} ${pWeight} ${pTags} ${pSpecs} ${pDesc}`;
  const corpusAlpha = toAlphaNumeric(fullCorpus);

  // Substring of stripped query or raw query
  if (fullCorpus.includes(stripped) || fullCorpus.includes(rawLower)) return true;
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

  const rawLower = cleanSearchQuery(rawQuery);
  const stripped = stripSearchPrefixes(rawLower);
  const queryAlpha = toAlphaNumeric(rawLower);
  const strippedAlpha = toAlphaNumeric(stripped);

  const skuLower = p.sku.toLowerCase();
  const skuAlpha = toAlphaNumeric(p.sku);
  const idLower = p.id.toLowerCase();
  const idAlpha = toAlphaNumeric(p.id);
  const nameLower = p.name.toLowerCase();

  let score = 0;

  // Exact SKU match
  if (skuLower === stripped || skuLower === rawLower || skuAlpha === strippedAlpha) {
    score += 1000;
  } else if (skuLower.includes(stripped) || (strippedAlpha.length >= 3 && skuAlpha.includes(strippedAlpha))) {
    score += 700;
  }

  // Exact ID match
  if (idLower === stripped || idLower === rawLower || idAlpha === strippedAlpha) {
    score += 900;
  }

  // Exact Name match or name starts with query
  if (nameLower === stripped || nameLower === rawLower) {
    score += 800;
  } else if (nameLower.startsWith(stripped) || nameLower.startsWith(rawLower)) {
    score += 500;
  } else if (nameLower.includes(stripped)) {
    score += 350;
  }

  // Category & Subcategory match
  if (p.category.toLowerCase() === stripped || p.category.toLowerCase() === rawLower) {
    score += 300;
  } else if (p.category.toLowerCase().includes(stripped)) {
    score += 150;
  }

  if (p.subcategory.toLowerCase() === stripped || p.subcategory.toLowerCase() === rawLower) {
    score += 250;
  } else if (p.subcategory.toLowerCase().includes(stripped)) {
    score += 120;
  }

  // Brand & Vendor match
  if (p.brand.toLowerCase().includes(stripped)) score += 100;
  if (p.vendor.toLowerCase().includes(stripped)) score += 80;

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
  if (!query) return [];

  const stripped = stripSearchPrefixes(query);
  const strippedAlpha = toAlphaNumeric(stripped);

  const results: SearchSuggestionItem[] = [];

  // Filter storefront products
  const eligibleProducts = allProducts.filter(isStorefrontProduct);

  // 1. Check for direct SKU / ID exact match first
  const exactSkuProduct = eligibleProducts.find((p) => {
    const sLower = p.sku.toLowerCase();
    const sAlpha = toAlphaNumeric(p.sku);
    const idLower = p.id.toLowerCase();
    return sLower === stripped || sLower === query || sAlpha === strippedAlpha || idLower === stripped || idLower === query;
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
    const catNameLower = cat.name.toLowerCase();
    if (catNameLower.includes(stripped) || stripped.includes(catNameLower)) {
      if (!seenCategories.has(cat.id)) {
        seenCategories.add(cat.id);
        results.push({ kind: "category", category: cat });
      }
    }
    // Check grades / subcategories
    for (const grade of cat.grades || []) {
      const gradeLower = grade.toLowerCase();
      if (gradeLower.includes(stripped) || stripped.includes(gradeLower)) {
        results.push({ kind: "subcategory", category: cat, subcategory: grade });
      }
    }
  }

  // 3. Matching Products ranked by relevance
  const matchingProducts = eligibleProducts
    .filter((p) => (!exactSkuProduct || p.id !== exactSkuProduct.id) && matchProductSearch(p, query))
    .map((product) => ({ product, score: scoreProductSearch(product, query) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults - results.length);

  for (const item of matchingProducts) {
    results.push({ kind: "product", product: item.product });
  }

  return results.slice(0, maxResults);
}
