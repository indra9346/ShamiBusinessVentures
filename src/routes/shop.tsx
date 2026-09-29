import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { LayoutGrid, List, Search, SlidersHorizontal } from "lucide-react";
import { SiteLayout, Breadcrumbs } from "@/components/site/SiteLayout";
import { ProductCard } from "@/components/site/ProductCard";
import { inr, isStorefrontProduct, vendors } from "@/lib/data";
import { useVisibleCategories } from "@/components/site/CategoryCards";
import { useApp } from "@/lib/store";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

type ShopSearch = { q?: string | undefined; category?: string | undefined; sort?: string | undefined };

export const Route = createFileRoute("/shop")({
  validateSearch: (s: Record<string, unknown>): ShopSearch => ({
    q: typeof s["q"] === "string" ? (s["q"] as string) : undefined,
    category: typeof s["category"] === "string" ? (s["category"] as string) : undefined,
    sort: typeof s["sort"] === "string" ? (s["sort"] as string) : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Shop S1 Sugar | Shami Business Ventures" },
      {
        name: "description",
        content:
          "Browse premium S1 refined sugar bags and retail packs from verified mills. GST invoicing and pan-India delivery.",
      },
      { property: "og:title", content: "Shop S1 Sugar | Shami Business Ventures" },
      { property: "og:description", content: "Filter by price, vendor and rating across S1 sugar SKUs." },
    ],
  }),
  component: Shop,
});

const sorts = ["Popular", "Newest", "Price Low → High", "Price High → Low", "Highest Rated"];

function Shop() {
  const search = Route.useSearch();
  const { products } = useApp();
  const visibleCats = useVisibleCategories();
  const [q, setQ] = useState(search.q ?? "");
  const [cats, setCats] = useState<string[]>(search.category ? [search.category] : []);
  const [vends, setVends] = useState<string[]>([]);
  const [maxPrice, setMaxPrice] = useState(5000);
  const [minRating, setMinRating] = useState(0);
  const [inStock, setInStock] = useState(false);
  const [offersOnly, setOffersOnly] = useState(false);
  const [sort, setSort] = useState(search.sort ?? "Popular");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [page, setPage] = useState(1);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const perPage = 8;

  const filtered = useMemo(() => {
    const allowed = visibleCats.map((c) => c.name);
    let list = products.filter((p) => isStorefrontProduct(p) && allowed.includes(p.category));
    if (q) {
      const t = q.toLowerCase();
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(t) ||
          p.sku.toLowerCase().includes(t) ||
          p.brand.toLowerCase().includes(t) ||
          p.vendor.toLowerCase().includes(t) ||
          p.category.toLowerCase().includes(t) ||
          p.subcategory.toLowerCase().includes(t) ||
          p.weight.toLowerCase().includes(t),
      );
    }
    if (cats.length) {
      const norm = (v: string) => v.toLowerCase().replace(/grade|\s+/g, "");
      list = list.filter(
        (p) =>
          cats.includes(p.category) ||
          cats.includes(p.subcategory) ||
          cats.some((c) => norm(p.subcategory).includes(norm(c)) || norm(p.name).includes(norm(c))),
      );
    }
    if (vends.length) list = list.filter((p) => vends.includes(p.vendor));
    list = list.filter((p) => p.price <= maxPrice);
    if (minRating) list = list.filter((p) => p.rating >= minRating);
    if (inStock) list = list.filter((p) => p.stock > 0);
    if (offersOnly) list = list.filter((p) => p.mrp > p.price);
    const sorted = [...list];
    if (sort === "Price Low → High") sorted.sort((a, b) => a.price - b.price);
    if (sort === "Price High → Low") sorted.sort((a, b) => b.price - a.price);
    if (sort === "Highest Rated") sorted.sort((a, b) => b.rating - a.rating);
    if (sort === "Newest") sorted.reverse();
    return sorted;
  }, [products, visibleCats, q, cats, vends, maxPrice, minRating, inStock, offersOnly, sort]);

  const pages = Math.max(1, Math.ceil(filtered.length / perPage));
  const current = filtered.slice((page - 1) * perPage, page * perPage);

  const toggle = (arr: string[], set: (v: string[]) => void, v: string) =>
    set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  return (
    <SiteLayout>
      <div className="border-b border-border bg-ivory">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
          <Breadcrumbs items={[{ label: "Shop" }]} />
          <h1 className="mt-3 text-2xl font-bold text-navy sm:text-3xl">Shop All Products</h1>
          <p className="mt-2 text-sm text-slate">
            {filtered.length} products from {vendors.filter((v) => v.status === "approved").length} verified vendors
          </p>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 pt-6 sm:px-6 lg:hidden">
        <button
          onClick={() => setFiltersOpen((v) => !v)}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-card py-2.5 text-sm font-semibold text-navy"
        >
          <SlidersHorizontal className="h-4 w-4 text-gold" /> {filtersOpen ? "Hide Filters" : "Show Filters"}
        </button>
      </div>

      <div className="mx-auto grid max-w-7xl gap-6 px-4 py-8 sm:px-6 lg:grid-cols-[280px_minmax(0,1fr)] lg:gap-8 lg:py-10">
        <aside
          className={cn(
            "h-max rounded-lg border border-border bg-card p-5 shadow-card lg:sticky lg:top-40 lg:block",
            !filtersOpen && "hidden",
          )}
        >
          <h2 className="flex items-center gap-2 text-sm font-bold tracking-wide text-navy uppercase">
            <SlidersHorizontal className="h-4 w-4 text-gold" /> Filters
          </h2>

          <FilterGroup title="Category">
            {visibleCats.map((c) => (
              <div key={c.id} className="space-y-2">
                <Row label={c.name} checked={cats.includes(c.name)} onChange={() => toggle(cats, setCats, c.name)} bold />
                <div className="ml-5 space-y-2">
                  {c.grades.map((s) => (
                    <Row key={s} label={s} checked={cats.includes(s)} onChange={() => toggle(cats, setCats, s)} />
                  ))}
                </div>
              </div>
            ))}
          </FilterGroup>

          <FilterGroup title={`Price up to ${inr(maxPrice)}`}>
            <Slider value={[maxPrice]} onValueChange={(v) => setMaxPrice(v[0]!)} min={50} max={5000} step={50} />
          </FilterGroup>

          <FilterGroup title="Vendor">
            {vendors
              .filter((v) => v.status === "approved")
              .map((v) => (
                <Row
                  key={v.id}
                  label={v.business}
                  checked={vends.includes(v.business)}
                  onChange={() => toggle(vends, setVends, v.business)}
                />
              ))}
          </FilterGroup>

          <FilterGroup title="Rating">
            {[4.5, 4, 3.5].map((r) => (
              <Row key={r} label={`${r} & above`} checked={minRating === r} onChange={() => setMinRating(minRating === r ? 0 : r)} />
            ))}
          </FilterGroup>

          <FilterGroup title="Availability & Offers">
            <Row label="In stock only" checked={inStock} onChange={() => setInStock(!inStock)} />
            <Row label="On offer" checked={offersOnly} onChange={() => setOffersOnly(!offersOnly)} />
          </FilterGroup>
        </aside>

        <div className="min-w-0">
          <div className="mb-6 flex flex-wrap items-center gap-3">
            <div className="relative min-w-0 flex-1 basis-full sm:basis-auto">
              <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate" />
              <Input
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setPage(1);
                }}
                placeholder="Search within results…"
                className="h-11 pl-10"
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
            <div className="flex overflow-hidden rounded-md border border-border">
              {(["grid", "list"] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  aria-label={`${v} view`}
                  className={cn("p-2.5", view === v ? "bg-navy text-white" : "bg-card text-slate hover:text-gold")}
                >
                  {v === "grid" ? <LayoutGrid className="h-4 w-4" /> : <List className="h-4 w-4" />}
                </button>
              ))}
            </div>
          </div>

          {current.length === 0 ? (
            <div className="grid place-items-center gap-2 rounded-lg border border-border bg-card py-20 text-center">
              <p className="font-semibold text-navy">No products match your filters</p>
              <p className="text-sm text-slate">Try widening the price range or clearing category filters.</p>
            </div>
          ) : (
            <div className={cn("grid gap-5", view === "grid" ? "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3" : "grid-cols-1")}>
              {current.map((p) => (
                <ProductCard key={p.id} product={p} />
              ))}
            </div>
          )}

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