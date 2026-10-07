import { createFileRoute, Link } from "@tanstack/react-router";
import { SiteLayout } from "@/components/site/SiteLayout";
import { CategoryCards } from "@/components/site/CategoryCards";

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
      <section className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-12">
        <div className="mb-5 flex items-end justify-between gap-4">
          <h1 className="text-2xl font-bold text-navy sm:text-3xl">Shop by Category</h1>
          <Link
            to="/categories"
            className="shrink-0 text-sm font-semibold text-navy transition-colors hover:text-gold"
          >
            View all
          </Link>
        </div>
        <CategoryCards />
      </section>
    </SiteLayout>
  );
}
