import { createFileRoute, Link } from "@tanstack/react-router";
import { pageHead } from "@/lib/seo";
import { SiteLayout, SectionHeading } from "@/components/site/SiteLayout";
import { CategoryCards, useVisibleCategories } from "@/components/site/CategoryCards";
import { FlipkartCategoryBar } from "@/components/site/FlipkartCategoryBar";
import { ProductCard } from "@/components/site/ProductCard";
import { isStorefrontProduct } from "@/lib/data";
import { useApp } from "@/lib/store";

export const Route = createFileRoute("/categories/")({
  head: () => pageHead({
    title: "Rice, Sugar & Cooking Oil Categories | Grain Bazar",
    description: "Browse rice grades (raw, steam, basmati), Grade S1 refined sugar and edible oils at Grain Bazar by Shami Business Ventures, with godown prices and stock.",
    path: "/categories",
  }),
  component: Categories,
});

function Categories() {
  const cats = useVisibleCategories();
  const { products } = useApp();

  return (
    <SiteLayout>
      <FlipkartCategoryBar />
      <h1 className="sr-only">Shop by Category</h1>

      <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6 sm:py-8">
        <CategoryCards />
      </div>

      <div className="mx-auto max-w-7xl space-y-12 px-4 pb-14 sm:px-6 sm:space-y-14">
        {cats.map((c) => {
          const items = products.filter((p) => p.category === c.name && isStorefrontProduct(p));
          if (!items.length) return null;
          return (
            <section key={c.id}>
              <SectionHeading
                eyebrow={c.grades.join(" · ")}
                title={c.name}
                action={
                  <Link
                    to="/shop"
                    search={{ category: c.name }}
                    className="text-sm font-semibold text-navy hover:text-gold"
                  >
                    Shop {c.name}
                  </Link>
                }
              />
              <div className="grid grid-cols-2 gap-2.5 sm:gap-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {items.map((p) => (
                  <ProductCard key={p.id} product={p} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </SiteLayout>
  );
}
