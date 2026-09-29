import { createFileRoute, Link } from "@tanstack/react-router";
import { SiteLayout, Breadcrumbs, SectionHeading } from "@/components/site/SiteLayout";
import { CategoryCards, useVisibleCategories } from "@/components/site/CategoryCards";
import { ProductCard } from "@/components/site/ProductCard";
import { isStorefrontProduct } from "@/lib/data";
import { useApp } from "@/lib/store";

export const Route = createFileRoute("/categories/")({
  head: () => ({
    meta: [
      { title: "Categories — Rice, Sugar & Oil | Shami Business Ventures" },
      {
        name: "description",
        content:
          "Browse Shami Business Ventures categories — premium rice grades, Grade S1 refined sugar and edible oils from verified mills.",
      },
      { property: "og:title", content: "Rice, Sugar & Oil Categories | Shami Business Ventures" },
      { property: "og:description", content: "Category catalogue with live product counts and grades." },
    ],
  }),
  component: Categories,
});

function Categories() {
  const cats = useVisibleCategories();
  const { products } = useApp();

  return (
    <SiteLayout>
      <div className="border-b border-border bg-ivory">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
          <Breadcrumbs items={[{ label: "Categories" }]} />
          <h1 className="mt-3 text-2xl font-bold text-navy sm:text-3xl">Shop by Category</h1>
          <p className="mt-2 text-sm text-slate">Rice, Sugar and Oil sourced directly from certified mills.</p>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 sm:py-12">
        <CategoryCards />
      </div>

      <div className="mx-auto max-w-7xl space-y-12 px-4 pb-14 sm:px-6 sm:space-y-14">
        {cats.map((c) => {
          const items = products.filter((p) => p.category === c.name && isStorefrontProduct(p)).slice(0, 4);
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
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
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
