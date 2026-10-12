import { createFileRoute, Link, Outlet, useMatch, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ProductCard } from "@/components/site/ProductCard";
import { ArrowLeft } from "lucide-react";
import { SiteLayout, Breadcrumbs } from "@/components/site/SiteLayout";
import { TileGrid } from "@/components/site/TileGrid";
import { getCategoryNode } from "@/lib/category-tree";
import { isStorefrontProduct, type Product } from "@/lib/data";
import { useApp } from "@/lib/store";

type RiceSearch = { subcategory?: "Raw Rice" | "Steam Rice"; weight?: string };

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

export const Route = createFileRoute("/categories/$slug")({
  validateSearch: (search: Record<string, unknown>): RiceSearch => ({
    ...(search["subcategory"] === "Raw Rice" || search["subcategory"] === "Steam Rice"
      ? { subcategory: search["subcategory"] }
      : {}),
    ...(parseKg(search["weight"]) !== undefined ? { weight: String(parseKg(search["weight"])) } : {}),
  } satisfies RiceSearch),
  head: ({ params }) => {
    const node = getCategoryNode(params.slug);
    const name = node?.name ?? "Category";
    return {
      meta: [
        { title: `${name} varieties | Shami Business Ventures` },
        {
          name: "description",
          content: `Browse ${name} varieties and pack sizes from verified mills with GST invoicing.`,
        },
        { property: "og:title", content: `${name} varieties | Shami Business Ventures` },
        {
          property: "og:description",
          content: `Pick a ${name} variety to see live pricing and stock.`,
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
  const { products, productCatalogStatus } = useApp();
  const [weightInput, setWeightInput] = useState(search.weight ?? "");
  useEffect(() => setWeightInput(search.weight ?? ""), [search.weight]);
  const node = getCategoryNode(slug);
  const childMatch = useMatch({ from: "/categories/$slug/$child", shouldThrow: false });

  if (!node) {
    return (
      <SiteLayout>
        <div className="mx-auto max-w-7xl px-4 py-16 text-center sm:px-6">
          <h1 className="text-2xl font-bold text-navy">Category not found</h1>
          <Link to="/categories" className="mt-4 inline-block text-sm font-semibold text-gold">
            Back to categories
          </Link>
        </div>
      </SiteLayout>
    );
  }

  if (childMatch) {
    return <Outlet />;
  }

  return (
    <SiteLayout>
      <div className="border-b border-border bg-ivory">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
          <Breadcrumbs items={[{ label: "Categories", to: "/categories" }, { label: node.name }]} />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Link
              to="/categories"
              aria-label="Back to categories"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-border bg-card text-navy transition-colors hover:border-gold hover:text-gold"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <h1 className="text-2xl font-bold text-navy sm:text-3xl">{node.name}</h1>
            {node.slug === "oil" && (
              <Link
                to="/shop"
                search={{ category: "Oil" }}
                className="ml-auto rounded-md bg-navy px-4 py-2 text-sm font-semibold text-white hover:bg-navy/90"
              >
                Shop all oils
              </Link>
            )}
          </div>
          <p className="mt-2 text-sm text-slate">{node.tagline}</p>
          {node.slug === "rice" && (
            <div className="mt-5 grid gap-3 sm:grid-cols-2 sm:max-w-2xl">
              <label className="grid gap-1.5 text-xs font-semibold text-navy">
                Rice type
                <select
                  value={search.subcategory ?? ""}
                  onChange={(event) => void navigate({
                    to: "/categories/$slug",
                    params: { slug },
                    search: {
                      ...(event.target.value ? { subcategory: event.target.value as NonNullable<RiceSearch["subcategory"]> } : {}),
                    },
                    replace: true,
                  })}
                  className="h-10 rounded-md border border-border bg-card px-3 text-sm font-normal text-charcoal focus:border-gold focus:outline-none"
                >
                  <option value="">All rice</option>
                  <option value="Raw Rice">Raw Rice</option>
                  <option value="Steam Rice">Steam Rice</option>
                </select>
              </label>
              <label className="grid gap-1.5 text-xs font-semibold text-navy">
                KG filter
                <input
                  type="number"
                  inputMode="decimal"
                  min="0.1"
                  step="any"
                  list="available-rice-pack-sizes"
                  placeholder="Choose or enter kg"
                  value={weightInput}
                  onChange={(event) => {
                    const value = event.target.value;
                    setWeightInput(value);
                    const kg = parseKg(value);
                    void navigate({
                      to: "/categories/$slug",
                      params: { slug },
                      search: {
                        ...(search.subcategory ? { subcategory: search.subcategory } : {}),
                        ...(kg !== undefined ? { weight: formatKg(kg) } : {}),
                      },
                      replace: true,
                    });
                  }}
                  className="h-10 rounded-md border border-border bg-card px-3 text-sm font-normal text-charcoal focus:border-gold focus:outline-none"
                />
                <datalist id="available-rice-pack-sizes">
                  {availableRiceWeights(products).map((weight) => (
                    <option key={weight} value={weight} label={`${weight} kg currently listed`} />
                  ))}
                </datalist>
                <span className="font-normal text-slate">Choose a listed pack size or enter another size to request it.</span>
              </label>
            </div>
          )}
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-12">
        {node.slug === "rice" ? (
          <RiceProducts
            products={products}
            status={productCatalogStatus}
            subcategory={search.subcategory}
            weight={search.weight}
          />
        ) : (
          <TileGrid tiles={node.tiles} basePath={node.slug} />
        )}
      </div>
    </SiteLayout>
  );
}

function riceType(product: Product) {
  const value = `${product.subcategory} ${product.name}`.toLowerCase();
  if (/\bsteam(?:ed)?\b/.test(value)) return "Steam Rice";
  if (/\braw\b/.test(value)) return "Raw Rice";
  return undefined;
}

function packWeightKg(product: { weight: string }) {
  const match = product.weight.match(/(\d+(?:\.\d+)?)\s*(?:kg|kgs|kilograms?)\b/i);
  return match ? parseKg(match[1]) : undefined;
}

function availableRiceWeights(products: Product[]) {
  const rows = products.filter((product) =>
    product.category.trim().toLowerCase() === "rice" &&
    isStorefrontProduct(product),
  );
  return [...new Set(rows.map(packWeightKg).filter((weight): weight is number => weight !== undefined))]
    .sort((a, b) => a - b)
    .map(formatKg);
}

function RiceProducts({
  products,
  status,
  subcategory,
  weight,
}: {
  products: Product[];
  status: "loading" | "ready" | "unavailable";
  subcategory: RiceSearch["subcategory"];
  weight: string | undefined;
}) {
  const riceProducts = products.filter((product) => {
    if (product.category.trim().toLowerCase() !== "rice" || !isStorefrontProduct(product)) return false;
    if (subcategory && riceType(product) !== subcategory) return false;
    if (weight && packWeightKg(product) !== parseKg(weight)) return false;
    return true;
  });

  if (status !== "ready") {
    return (
      <p className="rounded-lg border border-dashed border-border bg-card p-8 text-center text-sm text-slate">
        {status === "loading" ? "Loading available rice products…" : "Rice products are temporarily unavailable. Please try again shortly."}
      </p>
    );
  }

  if (riceProducts.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-card p-8 text-center">
        <p className="text-sm text-slate">
          {subcategory
            ? `No ${subcategory.toLowerCase()} products are available${weight ? ` in ${weight} kg packs` : ""} right now.`
            : weight
              ? `No rice products are available in ${weight} kg packs right now.`
              : "No rice products are available right now."}
        </p>
        {weight ? (
          <>
            <p className="mt-2 text-sm text-slate">Our supply desk can review a request for this pack size.</p>
            <Link
              to="/contact"
              search={{
                request: "product-configuration",
                category: "Rice",
                ...(subcategory ? { subcategory } : {}),
                weight,
              }}
              className="mt-4 inline-flex rounded-md bg-navy px-4 py-2 text-sm font-semibold text-white hover:bg-navy/90"
            >
              Request this rice configuration
            </Link>
          </>
        ) : (
          <p className="mt-2 text-sm text-slate">Select or enter the KG pack size you need to request a configuration.</p>
        )}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {riceProducts.map((product) => <ProductCard key={product.id} product={product} />)}
    </div>
  );
}
