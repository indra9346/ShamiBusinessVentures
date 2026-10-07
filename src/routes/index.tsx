import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { SiteLayout } from "@/components/site/SiteLayout";
import { Button } from "@/components/ui/button";
import { storeCategorySeed } from "@/lib/data";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Grain Bazar | Rice, Sugar & Oil" },
      {
        name: "description",
        content: "Find and buy quality rice, sugar and oil products with ease at Grain Bazar.",
      },
      { property: "og:title", content: "Grain Bazar | Rice, Sugar & Oil" },
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
  return (
    <SiteLayout>
      <section className="mx-auto max-w-7xl px-4 py-10 sm:px-6 sm:py-14">
        <div className="mb-8 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-card p-5 sm:p-7">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-gold">GRAIN BAZAR</p>
            <h1 className="mt-1 text-2xl font-bold text-navy sm:text-3xl">
              Business essentials, made simple.
            </h1>
            <p className="mt-2 text-sm text-slate">
              Browse quality staples by category or search from the header.
            </p>
          </div>
          <Button asChild className="h-10 px-5 font-semibold">
            <Link to="/shop">Browse products</Link>
          </Button>
        </div>
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
          {storeCategorySeed.map((category) => {
            const slug = category.name.toLowerCase();
            return (
              <Link
                key={category.id}
                to="/categories/$slug"
                params={{ slug }}
                className="flex min-w-0 flex-col items-center rounded-lg border border-border bg-card px-2 py-4 text-center shadow-card hover:border-gold sm:px-5 sm:py-7"
              >
                <span className="block aspect-square w-full max-w-28 overflow-hidden rounded-full bg-ivory ring-4 ring-ivory sm:max-w-40">
                  <img
                    src={category.image}
                    alt={category.name}
                    width={640}
                    height={640}
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                </span>
                <span className="mt-3 text-base font-bold text-navy sm:text-xl">
                  {category.name}
                </span>
                <span className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-gold sm:text-sm">
                  View <ArrowRight className="h-3.5 w-3.5" />
                </span>
              </Link>
            );
          })}
        </div>
      </section>
    </SiteLayout>
  );
}
