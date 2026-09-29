import { useState, type FormEvent } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, BadgeCheck, Search, ShieldCheck, ShoppingCart, Truck } from "lucide-react";
import { SiteLayout } from "@/components/site/SiteLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { inr, isStorefrontProduct, storeCategorySeed, type Product } from "@/lib/data";
import { useApp } from "@/lib/store";
import { useLanguage } from "@/lib/i18n";
import { showCartNotification, showCustomerNotification } from "@/components/site/CartFloatingNotification";
import heroImg from "@/assets/hero-sugar.jpg";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Shami Business Ventures | Rice, Sugar & Oil" },
      {
        name: "description",
        content: "Find and buy quality rice, sugar and oil products with ease at Shami Business Ventures.",
      },
      { property: "og:title", content: "Shami Business Ventures | Rice, Sugar & Oil" },
      {
        property: "og:description",
        content: "Buy quality grocery products from verified vendors, all in one place.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  const { products } = useApp();
  const { t } = useLanguage();
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const popularProducts = products.filter(isStorefrontProduct).slice(0, 8);

  const searchProducts = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    navigate({ to: "/shop", search: { q: query.trim() } });
  };

  return (
    <SiteLayout>
      <section className="mx-auto max-w-7xl px-4 pt-6 sm:px-6">
        <form onSubmit={searchProducts} className="flex max-w-xl gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("Search category, product, code or brand")}
              aria-label={t("Search products")}
              className="h-10 rounded-full pl-9 text-sm"
            />
          </div>
          <Button type="submit" size="sm" className="h-10 shrink-0 rounded-full px-4 font-bold">
            <Search className="h-4 w-4 sm:hidden" />
            <span className="hidden sm:inline">Search</span>
          </Button>
        </form>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="mb-5 flex items-end justify-between gap-4">
          <h2 className="text-2xl font-bold text-navy sm:text-3xl">Shop by Category</h2>
          <Link to="/categories" className="shrink-0 text-sm font-semibold text-navy transition-colors hover:text-gold">
            View all
          </Link>
        </div>
        <div className="grid grid-cols-3 gap-3 sm:gap-6">
          {storeCategorySeed.map((category) => {
            const slug = category.name.toLowerCase();
            return (
              <Link
                key={category.id}
                to="/categories/$slug"
                params={{ slug }}
                className="group flex min-w-0 flex-col items-center rounded-lg border border-border bg-card px-2 py-4 text-center shadow-card transition-all hover:-translate-y-1 hover:border-gold hover:shadow-elevated sm:px-5 sm:py-7"
              >
                <span className="block aspect-square w-full max-w-28 overflow-hidden rounded-full bg-ivory ring-4 ring-ivory sm:max-w-40">
                  <img
                    src={category.image}
                    alt={t(category.name)}
                    width={640}
                    height={640}
                    loading="lazy"
                    className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
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

      <section className="bg-ivory">
        <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 sm:py-14">
          <div className="mb-6 flex items-end justify-between gap-4">
            <div>
              <p className="text-xs font-bold text-gold">Picked for you</p>
              <h2 className="mt-1 text-2xl font-bold text-navy sm:text-3xl">Popular Products</h2>
            </div>
            <Link to="/shop" className="shrink-0 text-sm font-semibold text-navy transition-colors hover:text-gold">
              View all
            </Link>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 sm:gap-5 lg:grid-cols-4">
            {popularProducts.map((product) => <HomeProductCard key={product.id} product={product} />)}
          </div>
          <div className="mt-8 text-center">
            <Button asChild size="lg" className="h-11 px-7 font-bold">
              <Link to="/shop">All Products <ArrowRight /></Link>
            </Button>
          </div>
        </div>
      </section>
    </SiteLayout>
  );
}

function HomeProductCard({ product }: { product: Product }) {
  const { addToCart } = useApp();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const discount = Math.round(((product.mrp - product.price) / product.mrp) * 100);

  const add = () => {
    addToCart(product.id);
    showCartNotification(t("Added to cart"), t(product.name), "add", product.image);
  };

  const buy = () => {
    addToCart(product.id);
    showCustomerNotification(
      `${product.name} — CHECKOUT`,
      "Redirecting to instant checkout...",
      "success",
      product.image
    );
    navigate({ to: "/checkout", search: { productId: product.id } });
  };

  return (
    <article className="grid min-h-32 grid-cols-[104px_minmax(0,1fr)] overflow-hidden rounded-lg border border-border bg-card shadow-card sm:flex sm:min-h-0 sm:flex-col">
      <Link to="/product/$id" params={{ id: product.id }} className="relative block overflow-hidden bg-background sm:aspect-square">
        <img src={product.image} alt={product.name} width={600} height={600} loading="lazy" className="h-full w-full object-cover transition-transform duration-500 hover:scale-105" />
        {discount > 0 && (
          <span className="absolute top-2 left-2 rounded-full bg-gold px-2 py-1 text-[10px] font-bold text-midnight" data-no-translate>{discount}% OFF</span>
        )}
      </Link>
      <div className="flex min-w-0 flex-col p-3 sm:p-4">
        <Link to="/product/$id" params={{ id: product.id }} className="line-clamp-2 text-sm font-semibold leading-5 text-navy hover:text-gold sm:text-base">
          {product.name}
        </Link>
        <div className="mt-2 flex flex-wrap items-baseline gap-x-2">
          <span className="font-bold text-navy" data-no-translate>{inr(product.price)}</span>
          {discount > 0 && <span className="text-xs text-slate line-through" data-no-translate>{inr(product.mrp)}</span>}
        </div>
        <div className="mt-auto grid grid-cols-2 gap-2 pt-3">
          <Button type="button" variant="outline" size="sm" onClick={add} disabled={product.stock === 0} className="h-9 px-2 font-bold">
            <ShoppingCart /> Add
          </Button>
          <Button type="button" size="sm" onClick={buy} disabled={product.stock === 0} className="h-9 px-2 font-bold">
            Buy Now
          </Button>
        </div>
      </div>
    </article>
  );
}
