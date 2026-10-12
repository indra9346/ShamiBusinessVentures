import { createFileRoute, Link, Outlet, useMatch, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ProductCard } from "@/components/site/ProductCard";
import { ArrowLeft } from "lucide-react";
import { SiteLayout, Breadcrumbs } from "@/components/site/SiteLayout";
import { getCategoryNode, categorySlug } from "@/lib/category-tree";
import { isStorefrontProduct, type Product } from "@/lib/data";
import { availableProductBrands, normalizeFacetValue, productMatchesBrand } from "@/lib/search";
import { useApp } from "@/lib/store";

type CategorySearch = { subcategory?: string; brand?: string; weight?: string; packSize?: string };

function parseKg(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*(?:kg|kgs|kilograms?)?$/i);
  if (!match) return undefined;
  const kg = Number(match[1]);
  return Number.isFinite(kg) && kg > 0 ? kg : undefined;
}

function formatKg(kg: number) {
  return Number.isInteger(kg) ? String(kg) : String(kg).replace(/0+$/, "").replace(/\.$/, "");
}

function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLength) : undefined;
}

export const Route = createFileRoute("/categories/$slug")({
  validateSearch: (search: Record<string, unknown>): CategorySearch => {
    const subcategory = cleanText(search["subcategory"], 100);
    const brand = cleanText(search["brand"], 100);
    const weight = parseKg(search["weight"]);
    const packSize = cleanText(search["packSize"], 60);
    return {
      ...(subcategory ? { subcategory } : {}),
      ...(brand ? { brand } : {}),
      ...(weight !== undefined ? { weight: String(weight) } : {}),
      ...(packSize ? { packSize } : {}),
    };
  },
  head: ({ params }) => {
    const node = getCategoryNode(params.slug);
    const name = node?.name ?? "Category";
    return {
      meta: [
        { title: `${name} products | Shami Business Ventures` },
        {
          name: "description",
          content: `Browse ${name} products, grades and pack sizes from verified suppliers.`,
        },
        { property: "og:title", content: `${name} products | Shami Business Ventures` },
        {
          property: "og:description",
          content: `Filter ${name} products by subcategory and pack size.`,
        },
      ],
    };
  },
  component: CategoryLevel,
});

function CategoryLevel() {
  const { slug } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { categories, products, productCatalogStatus, categoryCatalogStatus } = useApp();
  const node = getCategoryNode(slug);
  const category = categories.find((item) =>
    categorySlug(item.name === "Cooking Oil" ? "Oil" : item.name) === slug,
  );
  const displayName = node?.name ?? category?.name;
  const catalogCategory = category?.name === "Cooking Oil"
    ? "Oil"
    : category?.name ?? (node?.slug === "oil" ? "Oil" : node?.name);
  const isRice = catalogCategory?.toLowerCase() === "rice";
  const catalogCategoryNames = new Set(
    [catalogCategory, ...(slug === "oil" ? ["Cooking Oil"] : [])]
      .filter((name): name is string => Boolean(name))
      .map(normalizeFacetValue),
  );
  const childMatch = useMatch({ from: "/categories/$slug/$child", shouldThrow: false });
  const selectedPack = isRice ? search.weight ?? "" : search.packSize ?? "";
  const selectedFacet = search.brand ? `brand:${search.brand}` : search.subcategory ? `type:${search.subcategory}` : "";
  const [packInput, setPackInput] = useState(selectedPack);
  useEffect(() => setPackInput(selectedPack), [selectedPack]);

  if (childMatch) return <Outlet />;

  if (!displayName || !catalogCategory) {
    return (
      <SiteLayout>
        <div className="mx-auto max-w-7xl px-4 py-16 text-center sm:px-6">
          <p className="text-sm text-slate">
            {categoryCatalogStatus === "loading" ? "Loading category…" : "Category not found"}
          </p>
          <Link to="/categories" className="mt-4 inline-block text-sm font-semibold text-gold">
            Back to categories
          </Link>
        </div>
      </SiteLayout>
    );
  }

  const categoryProducts = products.filter((product) =>
    (catalogCategoryNames.has(normalizeFacetValue(product.category)) || categorySlug(safeText(product.category)) === slug) &&
    isStorefrontProduct(product),
  );
  const configuredSubcategories = [
    ...(category?.grades ?? []),
    ...Object.values(node?.children ?? {}).map((child) => child.name),
  ];
  const subcategories = availableSubcategories(categoryProducts, isRice, configuredSubcategories);
  const configuredBrands = Object.values(node?.children ?? {}).flatMap((child) =>
    child.tiles.filter((tile) => !tile.slug).map((tile) => tile.label),
  );
  const brands = availableProductBrands(categoryProducts, configuredBrands);
  const packSizes = isRice
    ? availableRiceWeights(categoryProducts)
    : availablePackSizes(categoryProducts);
  const filteredProducts = categoryProducts.filter((product) => {
    if (search.brand && !productMatchesBrand(product, search.brand)) return false;
    if (search.subcategory && normalizeFacetValue(productSubcategory(product, isRice)) !== normalizeFacetValue(search.subcategory)) {
      return false;
    }
    if (isRice && search.weight && packWeightKg(product) !== parseKg(search.weight)) return false;
    if (!isRice && search.packSize && normalizePackSize(product.weight) !== normalizePackSize(search.packSize)) return false;
    return true;
  });

  const changeFilter = (next: { subcategory?: string | undefined; brand?: string | undefined; value: string }) => {
    const query: CategorySearch = {
      ...(next.subcategory ? { subcategory: next.subcategory } : {}),
      ...(next.brand ? { brand: next.brand } : {}),
      ...(isRice
        ? (parseKg(next.value) !== undefined ? { weight: formatKg(parseKg(next.value)!) } : {})
        : (next.value.trim() ? { packSize: next.value.trim() } : {})),
    };
    void navigate({ to: "/categories/$slug", params: { slug }, search: query, replace: true });
  };

  return (
    <SiteLayout>
      <div className="border-b border-border bg-ivory">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
          <Breadcrumbs items={[{ label: "Categories", to: "/categories" }, { label: displayName }]} />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Link
              to="/categories"
              aria-label="Back to categories"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-border bg-card text-navy transition-colors hover:border-gold hover:text-gold"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <h1 className="text-2xl font-bold text-navy sm:text-3xl">{displayName}</h1>
          </div>
          <p className="mt-2 text-sm text-slate">{category?.tagline ?? node?.tagline ?? `Browse ${displayName} products`}</p>
          <div className="mt-5 grid gap-3 sm:max-w-2xl sm:grid-cols-2">
            <label className="grid gap-1.5 text-xs font-semibold text-navy">
              {isRice ? "Rice type" : "Product type"}
              <select
                value={selectedFacet}
                onChange={(event) => {
                  const selected = event.target.value;
                  changeFilter({
                    ...(selected.startsWith("brand:") ? { brand: selected.slice("brand:".length) } : {}),
                    ...(selected.startsWith("type:") ? { subcategory: selected.slice("type:".length) } : {}),
                    value: selectedPack,
                  });
                }}
                className="h-10 rounded-md border border-border bg-card px-3 text-sm font-normal text-charcoal focus:border-gold focus:outline-none"
              >
                <option value="">All {displayName.toLowerCase()}</option>
                <optgroup label="Product type">
                  {subcategories.map((value) => <option key={`type:${value}`} value={`type:${value}`}>{value}</option>)}
                </optgroup>
                {brands.length > 0 && (
                  <optgroup label="Brand">
                    {brands.map((value) => <option key={`brand:${value}`} value={`brand:${value}`}>{value}</option>)}
                  </optgroup>
                )}
              </select>
            </label>
            <label className="grid gap-1.5 text-xs font-semibold text-navy">
              {isRice ? "KG filter" : "Pack size filter"}
              <input
                type={isRice ? "number" : "text"}
                inputMode={isRice ? "decimal" : undefined}
                min={isRice ? "0.1" : undefined}
                step={isRice ? "any" : undefined}
                list="category-pack-sizes"
                placeholder={isRice ? "Choose or enter kg" : "Choose or enter a pack size"}
                value={packInput}
                onChange={(event) => {
                  const value = event.target.value;
                  setPackInput(value);
                  if (!value.trim() || !isRice || parseKg(value) !== undefined) {
                    changeFilter({
                      ...(search.subcategory ? { subcategory: search.subcategory } : {}),
                      ...(search.brand ? { brand: search.brand } : {}),
                      value,
                    });
                  }
                }}
                className="h-10 rounded-md border border-border bg-card px-3 text-sm font-normal text-charcoal focus:border-gold focus:outline-none"
              />
              <datalist id="category-pack-sizes">
                {packSizes.map((value) => (
                  <option key={value} value={value} label={`${value}${isRice ? " kg" : " currently listed"}`} />
                ))}
              </datalist>
              <span className="font-normal text-slate">
                Choose a listed size or enter another size to request it.
              </span>
            </label>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-12">
        {productCatalogStatus !== "ready" ? (
          <p className="rounded-lg border border-dashed border-border bg-card p-8 text-center text-sm text-slate">
            {productCatalogStatus === "loading"
              ? "Loading available products…"
              : `${displayName} products are temporarily unavailable. Please try again shortly.`}
          </p>
        ) : filteredProducts.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-card p-8 text-center">
            <p className="text-sm text-slate">
              {search.subcategory || search.brand || (isRice ? search.weight : search.packSize)
                ? `No ${displayName.toLowerCase()} products match the selected filters right now.`
                : `No ${displayName.toLowerCase()} products are available right now.`}
            </p>
            {search.brand || search.subcategory || (isRice ? search.weight : search.packSize) ? (
              <>
                <p className="mt-2 text-sm text-slate">Our supply desk can review a request for this configuration.</p>
                <Link
                  to="/contact"
                  search={{
                    request: "product-configuration",
                    category: displayName,
                    ...(search.subcategory ? { subcategory: search.subcategory } : {}),
                    ...(search.brand ? { brand: search.brand } : {}),
                    ...(isRice && search.weight ? { weight: search.weight } : {}),
                    ...(!isRice && search.packSize ? { packSize: search.packSize } : {}),
                  }}
                  className="mt-4 inline-flex rounded-md bg-navy px-4 py-2 text-sm font-semibold text-white hover:bg-navy/90"
                >
                  Request this configuration
                </Link>
              </>
            ) : (
              <p className="mt-2 text-sm text-slate">Choose or enter the pack size you need to request it.</p>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
            {filteredProducts.map((product) => <ProductCard key={product.id} product={product} />)}
          </div>
        )}
      </div>
    </SiteLayout>
  );
}

function safeText(value: unknown) {
  return typeof value === "string" ? value : "";
}

function riceType(product: Product) {
  const value = `${safeText(product.subcategory)} ${safeText(product.name)}`.toLocaleLowerCase();
  if (/\bsteam(?:ed)?\b/.test(value)) return "Steam Rice";
  if (/\braw\b/.test(value)) return "Raw Rice";
  return undefined;
}

function productSubcategory(product: Product, isRice: boolean) {
  return (isRice ? riceType(product) : undefined) ?? safeText(product.subcategory).trim();
}

function availableSubcategories(products: Product[], isRice: boolean, configured: string[]) {
  const values = [
    ...configured.map((value) => value.trim()).filter(Boolean),
    ...products.map((product) => productSubcategory(product, isRice)).filter(Boolean),
  ];
  const unique = new Map<string, string>();
  for (const value of values) {
    const key = normalizeFacetValue(value);
    if (key && !unique.has(key)) unique.set(key, value);
  }
  return [...unique.values()]
    .sort((a, b) => a.localeCompare(b));
}

function packWeightKg(product: { weight: string }) {
  const match = safeText(product.weight).match(/(\d+(?:\.\d+)?)\s*(?:kg|kgs|kilograms?)\b/i);
  return match ? parseKg(match[1]) : undefined;
}

function availableRiceWeights(products: Product[]) {
  return [...new Set(products.map(packWeightKg).filter((weight): weight is number => weight !== undefined))]
    .sort((a, b) => a - b)
    .map(formatKg);
}

function availablePackSizes(products: Product[]) {
  const unique = new Map<string, string>();
  for (const product of products) {
    const label = safeText(product.weight).trim();
    const key = normalizePackSize(label);
    if (key && !unique.has(key)) unique.set(key, label);
  }
  return [...unique.values()]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}

function normalizePackSize(value: unknown) {
  if (typeof value !== "string") return "";
  const cleaned = value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  const unitAliases: Array<[RegExp, string]> = [
    [/\b(?:kilograms?|kgs?)\b|(?<=\d)kg\b/g, "kg"],
    [/\b(?:grams?|gms?)\b|(?<=\d)g\b/g, "g"],
    [/\b(?:litres?|liters?|ltrs?)\b|(?<=\d)l\b/g, "l"],
    [/\b(?:millilitres?|milliliters?)\b|(?<=\d)ml\b/g, "ml"],
  ];
  let normalized = cleaned;
  for (const [pattern, replacement] of unitAliases) normalized = normalized.replace(pattern, replacement);
  return normalized.replace(/\s+/g, "");
}
