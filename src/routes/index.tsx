import { useState, type FormEvent } from "react";
import { CategoryImage } from "@/components/site/CategoryImage";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { pageHead, jsonLdScript, organizationJsonLd, websiteJsonLd, DEFAULT_DESCRIPTION } from "@/lib/seo";
import { ArrowRight } from "lucide-react";
import { SiteLayout } from "@/components/site/SiteLayout";
import { Button } from "@/components/ui/button";
import { isStorefrontProduct } from "@/lib/data";
import { useApp } from "@/lib/store";
import { useLanguage } from "@/lib/i18n";
import { SearchAutosuggest } from "@/components/site/SearchAutosuggest";
import { ProductCard } from "@/components/site/ProductCard";
import { FlipkartCategoryBar } from "@/components/site/FlipkartCategoryBar";
import { AdShowcase } from "@/components/site/AdShowcase";

export const Route = createFileRoute("/")({
  head: () => ({
    ...pageHead({
      title: "Grain Bazar | Buy Rice, Sugar & Cooking Oil Online in Karnataka",
      description: DEFAULT_DESCRIPTION,
      path: "/",
    }),
    scripts: [jsonLdScript(organizationJsonLd()), jsonLdScript(websiteJsonLd())],
  }),
  component: Index,
});

function Index() {
  const { products, categories, productCatalogStatus, categoryCatalogStatus } = useApp();
  const { t } = useLanguage();
  const [query, setQuery] = useState("");
  const navigate = useNavigate();

  const popularProducts = products.filter(isStorefrontProduct).slice(0, 8);
  // Only the live categories are shown; until they arrive, grey placeholders hold their place
  // (never the built-in pictures, which would flash and then change).
  const displayCategories = categories.filter((c) => c.enabled).slice(0, 3);
  const categoriesLoading = categoryCatalogStatus === "loading" && displayCategories.length === 0;
  const productsLoading = productCatalogStatus === "loading" && popularProducts.length === 0;

  const searchProducts = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (query.trim()) {
      navigate({ to: "/shop", search: { q: query.trim() } });
    } else {
      navigate({ to: "/shop" });
    }
  };

  return (
    <SiteLayout>
      {/* Offers band (Admin > Ad Banners) with the Flipkart-style category strip in front of it */}
      <AdShowcase>
        <FlipkartCategoryBar />
      </AdShowcase>

      {/* Search Bar with Real-Time Autosuggestions */}
      <section className="mx-auto max-w-7xl px-4 pt-4 sm:px-6 sm:pt-6">
        <div className="max-w-xl">
          <SearchAutosuggest
            value={query}
            onChange={setQuery}
            onSearch={(q) => {
              if (q) navigate({ to: "/shop", search: { q } });
              else navigate({ to: "/shop" });
            }}
            placeholder={t("Search category, product, code or brand")}
            variant="home"
          />
        </div>
      </section>

      {/* Shop by Category - Circular Cards */}
      <section className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="mb-5 flex items-end justify-between gap-4">
          <h2 className="text-2xl font-bold text-navy sm:text-3xl">Shop by Category</h2>
          <Link
            to="/categories"
            className="shrink-0 text-sm font-semibold text-navy transition-colors hover:text-gold"
          >
            View all
          </Link>
        </div>
        <div className="grid grid-cols-3 gap-3 sm:gap-6">
          {categoriesLoading && [0, 1, 2].map((i) => (
            <div key={i} aria-hidden className="flex flex-col items-center overflow-hidden rounded-lg border border-border bg-card pb-4 sm:pb-6">
              <span className="block aspect-square w-full animate-pulse bg-stone-200/70" />
              <span className="mt-3 h-4 w-16 animate-pulse rounded bg-stone-200/70 sm:h-5" />
              <span className="mt-2 h-3 w-10 animate-pulse rounded bg-stone-200/50" />
            </div>
          ))}
          {displayCategories.map((category) => {
            const slug = category.name.toLowerCase();
            return (
              <Link
                key={category.id}
                to="/categories/$slug"
                params={{ slug }}
                className="group flex min-w-0 flex-col items-center overflow-hidden rounded-lg border border-border bg-card pb-4 text-center shadow-card transition-[border-color,box-shadow] hover:border-gold hover:shadow-elevated sm:pb-6"
              >
                <span className="block aspect-square w-full overflow-hidden bg-ivory">
                  <CategoryImage
                    src={category.image || `/categories/${slug}.jpg`}
                    alt={t(category.name)}
                    fit={category.imageFit}
                    width={640}
                    height={640}
                    onError={(e) => {
                      const cat = slug.toLowerCase();
                      (e.currentTarget as HTMLImageElement).src =
                        cat.includes("sugar")
                          ? "/categories/sugar.jpg"
                          : cat.includes("oil")
                          ? "/categories/oil.jpg"
                          : "/categories/rice.jpg";
                    }}
                  />
                </span>
                <span className="mt-3 text-base font-bold text-navy sm:text-xl">{category.name}</span>
                <span className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-gold sm:text-sm">
                  View <ArrowRight className="h-3.5 w-3.5" />
                </span>
              </Link>
            );
          })}
        </div>
      </section>

      {/* Popular Products - Responsive Horizontal on Mobile, Grid on Desktop */}
      <section className="bg-ivory/60">
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-12">
          <div className="mb-6 flex items-end justify-between gap-4">
            <div>
              <p className="text-xs font-bold text-gold">Picked for you</p>
              <h2 className="mt-1 text-2xl font-bold text-navy sm:text-3xl">Popular Products</h2>
            </div>
            <Link
              to="/categories"
              className="shrink-0 text-sm font-semibold text-navy transition-colors hover:text-gold"
            >
              View all
            </Link>
          </div>
          <div className="grid grid-cols-2 gap-2.5 sm:gap-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {productsLoading && Array.from({ length: 4 }, (_, i) => (
              <div key={i} aria-hidden className="flex flex-col overflow-hidden rounded-xl border border-stone-200 bg-card">
                <span className="block aspect-[4/3] w-full animate-pulse bg-stone-200/70" />
                <div className="space-y-2 p-2.5 sm:p-3">
                  <span className="block h-3.5 w-11/12 animate-pulse rounded bg-stone-200/70" />
                  <span className="block h-3.5 w-2/3 animate-pulse rounded bg-stone-200/60" />
                  <span className="block h-5 w-1/3 animate-pulse rounded bg-stone-200/70" />
                  <span className="block h-9 w-full animate-pulse rounded-md bg-stone-200/60" />
                </div>
              </div>
            ))}
            {popularProducts.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
          <div className="mt-8 text-center">
            <Button asChild size="lg" className="h-11 px-7 font-bold bg-navy text-white hover:bg-midnight">
              <Link to="/categories">
                All Products <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </div>
        </div>
      </section>
    </SiteLayout>
  );
}
