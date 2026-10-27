import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { pageHead } from "@/lib/seo";
import { useEffect, useMemo, useState } from "react";
import { LayoutGrid, List, RotateCcw, Search, SlidersHorizontal, X } from "lucide-react";
import { SiteLayout } from "@/components/site/SiteLayout";
import { ProductCard } from "@/components/site/ProductCard";
import { inr, isStorefrontProduct } from "@/lib/data";
import { useVisibleCategories } from "@/components/site/CategoryCards";
import { useApp } from "@/lib/store";
import { Checkbox } from "@/components/ui/checkbox";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { availableProductBrands, matchProductSearch, normalizeFacetValue, productMatchesBrand, scoreProductSearch } from "@/lib/search";
import { SearchAutosuggest } from "@/components/site/SearchAutosuggest";
import { useStorefrontDisplay } from "@/lib/storefront-display";
import { FlipkartCategoryBar } from "@/components/site/FlipkartCategoryBar";
import { categoryTree } from "@/lib/category-tree";

type ShopSearch = { q?: string | undefined; category?: string | undefined; sort?: string | undefined };

export const Route = createFileRoute("/shop")({
  validateSearch: (s: Record<string, unknown>): ShopSearch => ({
    q: typeof s["q"] === "string" ? (s["q"] as string) : undefined,
    category: typeof s["category"] === "string" ? (s["category"] as string) : undefined,
    sort: typeof s["sort"] === "string" ? (s["sort"] as string) : undefined,
  }),
  head: () => pageHead({
    title: "Shop Rice, Sugar & Cooking Oil | Grain Bazar",
    description: "Shop raw, steam and basmati rice, S1 sugar 50 kg bags and sunflower and groundnut oil tins at godown prices. GST invoice, pickup or delivery from Challakere and Hubli.",
    path: "/shop",
  }),
  component: Shop,
});

const sorts = ["Popular", "Newest", "Price Low → High", "Price High → Low", "Highest Rated"];
const configuredBrands = Object.values(categoryTree).flatMap((category) =>
  Object.values(category.children ?? {}).flatMap((child) => child.tiles.filter((tile) => !tile.slug).map((tile) => tile.label)),
);

function Shop() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { products, vendors, productCatalogStatus } = useApp();
  const display = useStorefrontDisplay();

  const vendorOptions = useMemo(() => {
    const available = products.filter(isStorefrontProduct);
    const approved = vendors.filter((vendor) => String(vendor.status ?? "").trim().toLocaleLowerCase() === "approved");
    if (approved.length) {
      const options = approved
        .filter((vendor) => available.some((product) =>
          normalizeFacetValue(product.vendorId) === normalizeFacetValue(vendor.id) ||
          normalizeFacetValue(product.vendor) === normalizeFacetValue(vendor.business),
        ))
        .map((vendor) => ({ id: vendor.id, business: vendor.business }));
      if (options.length) {
        const unique = new Map<string, (typeof options)[number]>();
        for (const option of options) {
          const key = normalizeFacetValue(option.business);
          if (key && !unique.has(key)) unique.set(key, option);
        }
        return [...unique.values()];
      }
    }
    const unique = new Map<string, string>();
    for (const product of available) {
      const business = typeof product.vendor === "string" ? product.vendor.trim() : "";
      const key = normalizeFacetValue(business);
      if (key && !unique.has(key)) unique.set(key, business);
    }
    return [...unique.values()].map((business) => ({ id: business, business }));
  }, [vendors, products]);

  const visibleCats = useVisibleCategories();

  const highestPrice = useMemo(() => {
    const prices = products
      .filter(isStorefrontProduct)
      .map((product) => Number(product.price))
      .filter((price) => Number.isFinite(price) && price >= 0);
    if (!prices.length) return 5000;
    return Math.max(5000, Math.ceil(Math.max(...prices) / 100) * 100);
  }, [products]);

  const [q, setQ] = useState(search.q ?? "");
  const [cats, setCats] = useState<string[]>(search.category ? [search.category] : []);
  const [vends, setVends] = useState<string[]>([]);
  const [brands, setBrands] = useState<string[]>([]);
  const [maxPrice, setMaxPrice] = useState(5000);
  const [minRating, setMinRating] = useState(0);
  const [inStock, setInStock] = useState(false);
  const [offersOnly, setOffersOnly] = useState(false);
  const [sort, setSort] = useState(search.sort ?? "Popular");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [page, setPage] = useState(1);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const perPage = 8;

  // Sync state when URL search params change
  useEffect(() => {
    setQ(search.q ?? "");
    setCats(search.category ? [search.category] : []);
    setSort(sorts.includes(search.sort ?? "") ? search.sort! : "Popular");
    setPage(1);
  }, [search.q, search.category, search.sort]);

  // Adjust maxPrice default if catalog price ceiling is higher
  useEffect(() => {
    if (maxPrice > highestPrice || (highestPrice > 5000 && maxPrice === 5000)) {
      setMaxPrice(highestPrice);
    }
  }, [highestPrice, maxPrice]);

  useEffect(() => {
    setPage(1);
  }, [q, cats, vends, brands, maxPrice, minRating, inStock, offersOnly, sort]);

  // Pre-calculate live counts for vendors.
  const vendorCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of products) {
      if (!isStorefrontProduct(p)) continue;
      const vendorKey = normalizeFacetValue(p.vendor);
      const vendorIdKey = normalizeFacetValue(p.vendorId);
      if (vendorKey) counts.set(vendorKey, (counts.get(vendorKey) || 0) + 1);
      if (vendorIdKey) counts.set(vendorIdKey, (counts.get(vendorIdKey) || 0) + 1);
    }
    return counts;
  }, [products]);

  const eligibleProducts = useMemo(() => products.filter((product) =>
    isStorefrontProduct(product) && visibleCats.some((category) => categoryMatches(product.category, category.name)),
  ), [products, visibleCats]);
  const brandOptions = useMemo(() => availableProductBrands(eligibleProducts, configuredBrands), [eligibleProducts]);
  const usefulBrandOptions = brandOptions.filter((brand) => eligibleProducts.some((product) => !productMatchesBrand(product, brand)));
  const brandCounts = useMemo(() => new Map(brandOptions.map((brand) => [
    normalizeFacetValue(brand), eligibleProducts.filter((product) => productMatchesBrand(product, brand)).length,
  ])), [brandOptions, eligibleProducts]);

  // Precision filtered product list
  const filtered = useMemo(() => {
    let list = eligibleProducts;

    // 1. Precision Multi-token & SKU matching
    if (q.trim()) {
      list = list.filter((p) => matchProductSearch(p, q));
    }

    // 2. Categories & Subcategories
    if (cats.length) {
      const selectedKeys = cats.map(normalizeFacetValue);
      list = list.filter((p) => {
        const subcategoryKey = normalizeFacetValue(p.subcategory);
        const nameKey = normalizeFacetValue(p.name);
        return selectedKeys.some((key) => {
          if (!key) return false;
          const parentCategory = visibleCats.find((category) => {
            const categoryKey = normalizeFacetValue(category.name);
            return key === categoryKey ||
              (key === "oil" && categoryKey === "cookingoil") ||
              (key === "cookingoil" && categoryKey === "oil");
          });
          if (parentCategory) return categoryMatches(p.category, parentCategory.name);
          return subcategoryKey === key || nameKey.includes(key);
        });
      });
    }

    // 3. Vendors
    if (vends.length) {
      const selectedVendors = new Set(vends.map(normalizeFacetValue));
      list = list.filter((p) => selectedVendors.has(normalizeFacetValue(p.vendor)) || selectedVendors.has(normalizeFacetValue(p.vendorId)));
    }

    if (brands.length) {
      list = list.filter((product) => brands.some((brand) => productMatchesBrand(product, brand)));
    }

    // 4. Price ceiling
      list = list.filter((p) => Number.isFinite(Number(p.price)) && Number(p.price) <= maxPrice);

    // 5. Rating
    if (minRating) {
      list = list.filter((p) => Number.isFinite(Number(p.rating)) && Number(p.rating) >= minRating);
    }

    // 6. In stock (available units > 0)
    if (inStock) {
      list = list.filter((p) => Math.max(0, (Number(p.stock) || 0) - (Number(p.reserved) || 0)) > 0);
    }

    // 7. Offers only
    if (offersOnly) {
      list = list.filter((p) => Number(p.mrp) > Number(p.price));
    }

    // 8. Sorting & Relevance ranking
    const sorted = [...list];
    if (sort === "Price Low → High") {
      sorted.sort((a, b) => Number(a.price) - Number(b.price));
    } else if (sort === "Price High → Low") {
      sorted.sort((a, b) => Number(b.price) - Number(a.price));
    } else if (sort === "Highest Rated") {
      sorted.sort((a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0));
    } else if (sort === "Newest") {
      sorted.reverse();
    } else if (q.trim()) {
      // Default to relevance ranking when search query is present
      sorted.sort((a, b) => scoreProductSearch(b, q) - scoreProductSearch(a, q));
    }

    return sorted;
  }, [eligibleProducts, q, cats, vends, brands, maxPrice, minRating, inStock, offersOnly, sort]);
  const pages = Math.max(1, Math.ceil(filtered.length / perPage));
  const current = filtered.slice((page - 1) * perPage, page * perPage);

  const toggle = (arr: string[], set: (v: string[]) => void, v: string) =>
    set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  const hasActiveFilters = Boolean(
    q.trim() ||
    cats.length > 0 ||
    vends.length > 0 ||
    brands.length > 0 ||
    maxPrice < highestPrice ||
    minRating > 0 ||
    inStock ||
    offersOnly
  );

  const clearAllFilters = () => {
    setQ("");
    setCats([]);
    setVends([]);
    setBrands([]);
    setMaxPrice(highestPrice);
    setMinRating(0);
    setInStock(false);
    setOffersOnly(false);
    setSort("Popular");
    setPage(1);
    navigate({ to: "/shop", search: {} });
  };

  return (
    <SiteLayout>
      <FlipkartCategoryBar target="shop" active={cats.length === 1 ? cats[0] : search.category} />
      <h1 className="sr-only">Shop All Products</h1>

      <div className="mx-auto max-w-7xl px-4 pt-6 sm:px-6 lg:hidden">
        <button
          onClick={() => setFiltersOpen((v) => !v)}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-card py-2.5 text-sm font-semibold text-navy shadow-xs"
        >
          <SlidersHorizontal className="h-4 w-4 text-gold" /> {filtersOpen ? "Hide Filters" : "Show Filters"}
          {hasActiveFilters && (
            <span className="ml-1.5 rounded-full bg-gold px-2 py-0.5 text-[10px] font-bold text-navy">
              Active
            </span>
          )}
        </button>
      </div>

      <div className="mx-auto grid max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[280px_minmax(0,1fr)] lg:gap-8 lg:py-8">
        {/* Filters Sidebar */}
        <aside
          className={cn(
            "h-max rounded-lg border border-border bg-card p-5 shadow-card lg:sticky lg:top-40 lg:block",
            !filtersOpen && "hidden",
          )}
        >
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-bold tracking-wide text-navy uppercase">
              <SlidersHorizontal className="h-4 w-4 text-gold" /> Filters
            </h2>
            {hasActiveFilters && (
              <button
                type="button"
                onClick={clearAllFilters}
                className="text-xs font-semibold text-danger hover:underline inline-flex items-center gap-1"
              >
                <RotateCcw className="h-3 w-3" /> Reset
              </button>
            )}
          </div>

          <FilterGroup title="Category">
            {visibleCats.map((c) => {
              const catProducts = eligibleProducts.filter((product) => categoryMatches(product.category, c.name));
              const catCount = catProducts.length;
              return (
                <div key={c.id} className="space-y-2">
                  <Row
                    label={`${c.name} (${catCount})`}
                    checked={cats.some((selected) => normalizeFacetValue(selected) === normalizeFacetValue(c.name))}
                    onChange={() => toggle(cats, setCats, c.name)}
                    bold
                  />
                  <div className="ml-5 space-y-2">
                    {c.grades.map((s) => {
                      const subcategoryKey = normalizeFacetValue(s);
                      const subCount = catProducts.filter((product) => normalizeFacetValue(product.subcategory) === subcategoryKey).length;
                      return (
                        <Row
                          key={s}
                          label={subCount > 0 ? `${s} (${subCount})` : s}
                          checked={cats.includes(s)}
                          onChange={() => toggle(cats, setCats, s)}
                        />
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </FilterGroup>

          <FilterGroup title={`Price up to ${inr(maxPrice)}`}>
            <Slider
              value={[maxPrice]}
              onValueChange={(v) => setMaxPrice(v[0]!)}
              min={50}
              max={highestPrice}
              step={50}
            />
            <div className="mt-2 flex items-center justify-between text-xs text-slate">
              <span>₹50</span>
              <span className="font-semibold text-navy">{inr(maxPrice)}</span>
              <span>{inr(highestPrice)}</span>
            </div>
            {/* Quick Price Buttons */}
            <div className="mt-3 flex flex-wrap gap-1.5">
              {[
                { label: "≤ ₹500", val: 500 },
                { label: "≤ ₹1,000", val: 1000 },
                { label: "≤ ₹2,000", val: 2000 },
                { label: "All", val: highestPrice },
              ].map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => setMaxPrice(p.val)}
                  className={cn(
                    "rounded px-2 py-0.5 text-[11px] font-semibold border transition-colors",
                    maxPrice === p.val
                      ? "bg-navy text-white border-navy"
                      : "bg-ivory text-navy border-border hover:border-gold",
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </FilterGroup>

          {display.showVendor && (
          <FilterGroup title="Vendor">
            {vendorOptions.map((v) => {
              const count = vendorCounts.get(normalizeFacetValue(v.business)) || vendorCounts.get(normalizeFacetValue(v.id)) || 0;
              return (
                <Row
                  key={v.id}
                  label={count > 0 ? `${v.business} (${count})` : v.business}
                  checked={vends.includes(v.business)}
                  onChange={() => toggle(vends, setVends, v.business)}
                />
              );
            })}
          </FilterGroup>
          )}

          {/* A brand on every product (the house brand, Shami Select) filters nothing, so it is not offered. */}
          {usefulBrandOptions.length > 0 && (
            <FilterGroup title="Brand">
              {usefulBrandOptions.map((brand) => (
                <Row
                  key={brand}
                  label={`${brand} (${brandCounts.get(normalizeFacetValue(brand)) ?? 0})`}
                  checked={brands.includes(brand)}
                  onChange={() => toggle(brands, setBrands, brand)}
                />
              ))}
            </FilterGroup>
          )}

          {display.showRatings && (
          <FilterGroup title="Rating">
            {[4.5, 4, 3.5].map((r) => (
              <Row
                key={r}
                label={`${r} ★ & above`}
                checked={minRating === r}
                onChange={() => setMinRating(minRating === r ? 0 : r)}
              />
            ))}
          </FilterGroup>
          )}

          <FilterGroup title="Availability & Offers">
            <Row label="In stock only" checked={inStock} onChange={() => setInStock(!inStock)} />
            <Row label="On offer only" checked={offersOnly} onChange={() => setOffersOnly(!offersOnly)} />
          </FilterGroup>
        </aside>

        {/* Main Content Area */}
        <div className="min-w-0">
          {/* Search, Sort, and View Controls */}
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="relative min-w-0 flex-1 basis-full sm:basis-auto">
              <SearchAutosuggest
                value={q}
                onChange={(val) => {
                  setQ(val);
                  setPage(1);
                }}
                onSearch={(val) => {
                  setQ(val);
                  setPage(1);
                }}
                placeholder="Search category, product, code or SKU…"
                variant="shop"
                id="shop-page-search"
              />
            </div>

            <select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              className="h-11 w-full rounded-md border border-border bg-card px-3 text-sm font-medium text-navy sm:w-auto"
            >
              {sorts.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>

            <div
              role="group"
              aria-label="Product display view"
              className="flex items-center rounded-lg border border-border bg-card p-0.5 shadow-xs shrink-0"
            >
              <button
                type="button"
                onClick={() => setView("grid")}
                aria-pressed={view === "grid"}
                aria-label="Grid view, two columns on phones"
                title="Grid view · two columns on phones"
                className={cn(
                  "flex h-9 w-9 sm:h-10 sm:w-10 items-center justify-center rounded-md transition-all duration-200",
                  view === "grid"
                    ? "bg-navy text-white shadow-xs"
                    : "text-slate hover:bg-ivory hover:text-navy",
                )}
              >
                <LayoutGrid className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setView("list")}
                aria-pressed={view === "list"}
                aria-label="List view"
                title="List view"
                className={cn(
                  "flex h-9 w-9 sm:h-10 sm:w-10 items-center justify-center rounded-md transition-all duration-200",
                  view === "list"
                    ? "bg-navy text-white shadow-xs"
                    : "text-slate hover:bg-ivory hover:text-navy",
                )}
              >
                <List className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Active Filter Chips */}
          {hasActiveFilters && (
            <div className="mb-5 flex flex-wrap items-center gap-2 rounded-lg border border-border/80 bg-ivory/60 p-2.5">
              <span className="text-xs font-bold text-navy uppercase tracking-wider">Active:</span>
              {q.trim() && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-navy px-3 py-1 text-xs font-semibold text-white">
                  Search: "{q}"
                  <button
                    type="button"
                    onClick={() => setQ("")}
                    className="hover:text-gold transition-colors"
                    aria-label="Clear search term"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              )}
              {cats.map((c) => (
                <span key={c} className="inline-flex items-center gap-1.5 rounded-full bg-gold/25 px-3 py-1 text-xs font-semibold text-navy">
                  {c}
                  <button
                    type="button"
                    onClick={() => toggle(cats, setCats, c)}
                    className="hover:text-danger transition-colors"
                    aria-label={`Remove category filter ${c}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              {vends.map((v) => (
                <span key={v} className="inline-flex items-center gap-1.5 rounded-full bg-card px-3 py-1 text-xs font-semibold text-navy border border-border">
                  Vendor: {v}
                  <button
                    type="button"
                    onClick={() => toggle(vends, setVends, v)}
                    className="hover:text-danger transition-colors"
                    aria-label={`Remove vendor filter ${v}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              {brands.map((brand) => (
                <span key={brand} className="inline-flex items-center gap-1.5 rounded-full bg-card px-3 py-1 text-xs font-semibold text-navy border border-border">
                  Brand: {brand}
                  <button
                    type="button"
                    onClick={() => toggle(brands, setBrands, brand)}
                    className="hover:text-danger transition-colors"
                    aria-label={`Remove brand filter ${brand}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              {maxPrice < highestPrice && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-card px-3 py-1 text-xs font-semibold text-navy border border-border">
                  Price: ≤ {inr(maxPrice)}
                  <button
                    type="button"
                    onClick={() => setMaxPrice(highestPrice)}
                    className="hover:text-danger transition-colors"
                    aria-label="Reset price filter"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              )}
              {minRating > 0 && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-card px-3 py-1 text-xs font-semibold text-navy border border-border">
                  Rating: ≥ {minRating}★
                  <button
                    type="button"
                    onClick={() => setMinRating(0)}
                    className="hover:text-danger transition-colors"
                    aria-label="Reset rating filter"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              )}
              {inStock && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800 border border-emerald-200">
                  In Stock Only
                  <button
                    type="button"
                    onClick={() => setInStock(false)}
                    className="hover:text-danger transition-colors"
                    aria-label="Remove in stock filter"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              )}
              {offersOnly && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800 border border-amber-200">
                  On Offer Only
                  <button
                    type="button"
                    onClick={() => setOffersOnly(false)}
                    className="hover:text-danger transition-colors"
                    aria-label="Remove offers filter"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              )}
              <button
                type="button"
                onClick={clearAllFilters}
                className="ml-auto inline-flex items-center gap-1 text-xs font-bold text-danger hover:underline"
              >
                <RotateCcw className="h-3 w-3" /> Clear All Filters
              </button>
            </div>
          )}

          {/* Product Results Grid */}
          {current.length === 0 ? (
            <div className="grid place-items-center gap-3 rounded-lg border border-border bg-card p-12 text-center shadow-xs">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-ivory text-navy ring-1 ring-border">
                <Search className="h-6 w-6 text-gold" />
              </div>
              <p className="font-bold text-lg text-navy">
                {productCatalogStatus === "loading"
                  ? "Loading products…"
                  : productCatalogStatus === "unavailable"
                    ? "Products are temporarily unavailable"
                    : q.trim()
                      ? `No products match "${q}"`
                      : products.length === 0
                        ? "No products are available yet"
                        : "No products match your filters"}
              </p>
              <p className="max-w-md text-sm text-slate">
                {q.trim()
                  ? `We couldn't find any products matching "${q}". Try clearing filters or searching by SKU code like SBV-OI-1022 or P023.`
                  : "Try widening the price range or clearing category filters to view more products."}
              </p>
              <div className="mt-2 flex flex-wrap gap-2 justify-center">
                {q.trim() && (
                  <button
                    type="button"
                    onClick={() => setQ("")}
                    className="rounded-full bg-navy px-4 py-2 text-xs font-bold text-white transition-colors hover:bg-midnight"
                  >
                    Clear Search Query
                  </button>
                )}
                {hasActiveFilters && (
                  <button
                    type="button"
                    onClick={clearAllFilters}
                    className="rounded-full border border-border bg-card px-4 py-2 text-xs font-bold text-navy transition-colors hover:border-gold hover:text-gold"
                  >
                    Reset All Filters
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div
              className={cn(
                "grid transition-all duration-300",
                view === "grid"
                  ? "grid-cols-2 gap-2.5 sm:gap-4 md:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5"
                  : "grid-cols-1 gap-3 sm:gap-4",
              )}
            >
              {current.map((p) => (
                <ProductCard key={p.id} product={p} layout={view} />
              ))}
            </div>
          )}

          {/* Pagination */}
          {pages > 1 && (
            <div className="mt-10 flex flex-wrap items-center justify-between gap-4">
              <p className="text-xs text-slate">
                Showing {current.length} of {filtered.length} products
              </p>
              <div className="flex gap-1.5">
                {Array.from({ length: pages }).map((_, i) => (
                  <button
                    key={i}
                    onClick={() => setPage(i + 1)}
                    className={cn(
                      "h-9 w-9 rounded-md border text-sm font-semibold transition-colors",
                      page === i + 1
                        ? "border-navy bg-navy text-white"
                        : "border-border bg-card text-slate hover:border-gold hover:text-gold",
                    )}
                  >
                    {i + 1}
                  </button>
                ))}
              </div>
            </div>
          )}

          <p className="mt-8 text-xs text-slate">
            Looking for a custom bulk quote?{" "}
            <Link to="/contact" className="font-semibold text-gold hover:underline">
              Talk to our supply desk
            </Link>
            .
          </p>
        </div>
      </div>
    </SiteLayout>
  );
}

function FilterGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-6 border-t border-border pt-5">
      <p className="mb-3 text-xs font-bold tracking-wider text-navy uppercase">{title}</p>
      <div className="space-y-2.5">{children}</div>
    </div>
  );
}

function categoryMatches(productCategory: string, visibleCategory: string) {
  const productKey = normalizeFacetValue(productCategory);
  const visibleKey = normalizeFacetValue(visibleCategory);
  if (!productKey || !visibleKey) return false;
  if (productKey === visibleKey) return true;
  return (productKey === "oil" && visibleKey === "cookingoil") ||
    (productKey === "cookingoil" && visibleKey === "oil");
}

function Row({
  label,
  checked,
  onChange,
  bold,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
  bold?: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 text-sm text-slate hover:text-navy">
      <Checkbox checked={checked} onCheckedChange={onChange} />
      <span className={cn(bold && "font-semibold text-navy")}>{label}</span>
    </label>
  );
}
