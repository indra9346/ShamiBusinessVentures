import { createFileRoute, Link, Outlet, useMatch, useNavigate } from "@tanstack/react-router";
import { ProductCard } from "@/components/site/ProductCard";
import { LayoutGrid } from "lucide-react";
import { SiteLayout } from "@/components/site/SiteLayout";
import { FlipkartCategoryBar } from "@/components/site/FlipkartCategoryBar";
import { getCategoryNode, categorySlug, type Tile } from "@/lib/category-tree";
import { cn } from "@/lib/utils";
import { isStorefrontProduct, type Product } from "@/lib/data";
import { availableProductBrands, normalizeFacetValue, productMatchesBrand } from "@/lib/search";
import { useApp } from "@/lib/store";

type CategorySearch = { subcategory?: string; brand?: string };

function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLength) : undefined;
}

export const Route = createFileRoute("/categories/$slug")({
  validateSearch: (search: Record<string, unknown>): CategorySearch => {
    const subcategory = cleanText(search["subcategory"], 100);
    const brand = cleanText(search["brand"], 100);
    return {
      ...(subcategory ? { subcategory } : {}),
      ...(brand ? { brand } : {}),
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
          content: `Browse ${name} products by type and brand.`,
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
  const category = categories.find(
    (item) => categorySlug(item.name === "Cooking Oil" ? "Oil" : item.name) === slug,
  );
  const displayName = node?.name ?? category?.name;
  const catalogCategory =
    category?.name === "Cooking Oil"
      ? "Oil"
      : (category?.name ?? (node?.slug === "oil" ? "Oil" : node?.name));
  const isRice = catalogCategory?.toLowerCase() === "rice";
  const catalogCategoryNames = new Set(
    [catalogCategory, ...(slug === "oil" ? ["Cooking Oil"] : [])]
      .filter((name): name is string => Boolean(name))
      .map(normalizeFacetValue),
  );
  const childMatch = useMatch({ from: "/categories/$slug/$child", shouldThrow: false });

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

  const categoryProducts = products.filter(
    (product) =>
      (catalogCategoryNames.has(normalizeFacetValue(product.category)) ||
        categorySlug(safeText(product.category)) === slug) &&
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
  const filteredProducts = categoryProducts.filter((product) => {
    if (search.brand && !productMatchesBrand(product, search.brand)) return false;
    if (
      search.subcategory &&
      normalizeFacetValue(productSubcategory(product, isRice)) !==
        normalizeFacetValue(search.subcategory)
    ) {
      return false;
    }
    return true;
  });

  // Image for each tile: a real product image from that group when one exists,
  // otherwise the configured tile image from the category tree, otherwise the category image.
  const treeTiles: Tile[] = [
    ...(node?.tiles ?? []),
    ...Object.values(node?.children ?? {}).flatMap((child) => child.tiles),
  ];
  const tileImageFor = (label: string, matcher: (product: Product) => boolean) => {
    const fromProduct = categoryProducts.find(
      (product) => matcher(product) && safeText(product.image).trim(),
    )?.image;
    if (fromProduct) return fromProduct;
    const key = normalizeFacetValue(label);
    const fromTree = treeTiles.find((tile) => normalizeFacetValue(tile.label) === key)?.image;
    return fromTree ?? category?.image ?? node?.image ?? "";
  };
  const filterTiles: FilterTile[] = [
    ...subcategories.map((value) => ({
      key: `type:${value}`,
      label: value,
      image: tileImageFor(
        value,
        (product) =>
          normalizeFacetValue(productSubcategory(product, isRice)) === normalizeFacetValue(value),
      ),
      search: { subcategory: value } as CategorySearch,
      active:
        !!search.subcategory &&
        normalizeFacetValue(search.subcategory) === normalizeFacetValue(value) &&
        !search.brand,
      count: categoryProducts.filter(
        (product) =>
          normalizeFacetValue(productSubcategory(product, isRice)) === normalizeFacetValue(value),
      ).length,
    })),
    ...brands.map((value) => ({
      key: `brand:${value}`,
      label: value,
      image: tileImageFor(value, (product) => productMatchesBrand(product, value)),
      search: { brand: value } as CategorySearch,
      active: !!search.brand && normalizeFacetValue(search.brand) === normalizeFacetValue(value),
      count: categoryProducts.filter((product) => productMatchesBrand(product, value)).length,
      isBrand: true,
    })),
  ];
  const hasActiveFilter = Boolean(search.subcategory || search.brand);
  const goTo = (query: CategorySearch) =>
    void navigate({ to: "/categories/$slug", params: { slug }, search: query, replace: true });

  return (
    <SiteLayout>
      <FlipkartCategoryBar active={slug} />
      <div className="border-b border-border bg-ivory">
        <div className="mx-auto max-w-7xl px-4 py-3 sm:px-6 sm:py-4">
          <h1 className="sr-only">{displayName}</h1>
          {/* Flipkart-style sub-category tiles (image + label) */}
          <div className="-mx-4 overflow-x-auto scrollbar-none px-4 sm:mx-0 sm:px-0">
            <ul className="flex w-max min-w-full gap-3 pb-1 sm:gap-4">
              <li className="shrink-0">
                <button
                  type="button"
                  onClick={() => goTo({})}
                  aria-pressed={!hasActiveFilter}
                  className="group flex w-[4.5rem] flex-col items-center gap-1.5 transition-all duration-200 hover:-translate-y-1 sm:w-24"
                >
                  <span
                    className={cn(
                      "grid h-16 w-16 place-items-center rounded-2xl border-2 bg-card transition-all duration-200 sm:h-20 sm:w-20",
                      !hasActiveFilter
                        ? "border-gold bg-amber-50 shadow-[0_0_0_3px_rgba(212,175,55,0.18)]"
                        : "border-stone-200 group-hover:border-navy/40 group-hover:shadow-md",
                    )}
                  >
                    <LayoutGrid
                      className={cn(
                        "h-6 w-6 sm:h-7 sm:w-7",
                        !hasActiveFilter ? "text-gold" : "text-navy",
                      )}
                    />
                  </span>
                  <span className="w-full truncate text-center text-xs font-semibold text-stone-800">
                    All {displayName}
                  </span>
                  <span className="text-[10px] text-stone-500">
                    {categoryProducts.length} items
                  </span>
                </button>
              </li>
              {filterTiles.map((tile) => (
                <li key={tile.key} className="shrink-0">
                  <button
                    type="button"
                    onClick={() => goTo(tile.active ? {} : tile.search)}
                    aria-pressed={tile.active}
                    title={tile.isBrand ? `${tile.label} (brand)` : tile.label}
                    className="group flex w-[4.5rem] flex-col items-center gap-1.5 transition-all duration-200 hover:-translate-y-1 sm:w-24"
                  >
                    <span
                      className={cn(
                        "relative grid h-16 w-16 place-items-center overflow-hidden rounded-2xl border-2 bg-card transition-all duration-200 sm:h-20 sm:w-20",
                        tile.active
                          ? "border-gold shadow-[0_0_0_3px_rgba(212,175,55,0.18)]"
                          : "border-stone-200 group-hover:border-navy/40 group-hover:shadow-md",
                      )}
                    >
                      {tile.image ? (
                        <img
                          src={tile.image}
                          alt=""
                          loading="lazy"
                          width={80}
                          height={80}
                          className="h-full w-full object-contain p-1.5 transition-transform duration-300 group-hover:scale-110"
                        />
                      ) : (
                        <span className="text-lg font-bold text-navy">
                          {tile.label.slice(0, 1)}
                        </span>
                      )}
                      {tile.isBrand && (
                        <span className="absolute bottom-0 inset-x-0 bg-navy/85 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white">
                          Brand
                        </span>
                      )}
                    </span>
                    <span
                      className={cn(
                        "w-full truncate text-center text-xs font-semibold",
                        tile.active ? "text-navy" : "text-stone-800",
                      )}
                    >
                      {tile.label}
                    </span>
                    <span className="text-[10px] text-stone-500">{tile.count} items</span>
                  </button>
                </li>
              ))}
            </ul>
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
              {hasActiveFilter
                ? `No ${displayName.toLowerCase()} products match the selected filters right now.`
                : `No ${displayName.toLowerCase()} products are available right now.`}
            </p>
            {hasActiveFilter ? (
              <>
                <p className="mt-2 text-sm text-slate">
                  Our supply desk can review a request for this configuration.
                </p>
                <Link
                  to="/contact"
                  search={{
                    request: "product-configuration",
                    category: displayName,
                    ...(search.subcategory ? { subcategory: search.subcategory } : {}),
                    ...(search.brand ? { brand: search.brand } : {}),
                  }}
                  className="mt-4 inline-flex rounded-md bg-navy px-4 py-2 text-sm font-semibold text-white hover:bg-navy/90"
                >
                  Request this configuration
                </Link>
              </>
            ) : (
              <p className="mt-2 text-sm text-slate">
                Please check back soon or contact our supply desk.
              </p>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2.5 sm:gap-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {filteredProducts.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        )}
      </div>
    </SiteLayout>
  );
}

type FilterTile = {
  key: string;
  label: string;
  image: string;
  search: CategorySearch;
  active: boolean;
  count: number;
  isBrand?: boolean;
};

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
  return [...unique.values()].sort((a, b) => a.localeCompare(b));
}
