import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { SiteLayout, Breadcrumbs } from "@/components/site/SiteLayout";
import { TileGrid } from "@/components/site/TileGrid";
import { getCategoryNode } from "@/lib/category-tree";

export const Route = createFileRoute("/categories/$slug")({
  head: ({ params }) => {
    const node = getCategoryNode(params.slug);
    const name = node?.name ?? "Category";
    return {
      meta: [
        { title: `${name} varieties | Shami Business Ventures` },
        { name: "description", content: `Browse ${name} varieties and pack sizes from verified mills with GST invoicing.` },
        { property: "og:title", content: `${name} varieties | Shami Business Ventures` },
        { property: "og:description", content: `Pick a ${name} variety to see live pricing and stock.` },
      ],
    };
  },
  component: CategoryLevel,
});

function CategoryLevel() {
  const { slug } = Route.useParams();
  const node = getCategoryNode(slug);

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

  return (
    <SiteLayout>
      <div className="border-b border-border bg-ivory">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
          <Breadcrumbs items={[{ label: "Categories", to: "/categories" }, { label: node.name }]} />
          <div className="mt-3 flex items-center gap-3">
            <Link
              to="/categories"
              aria-label="Back to categories"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-border bg-card text-navy transition-colors hover:border-gold hover:text-gold"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <h1 className="text-2xl font-bold text-navy sm:text-3xl">{node.name}</h1>
          </div>
          <p className="mt-2 text-sm text-slate">{node.tagline}</p>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-12">
        <TileGrid tiles={node.tiles} basePath={node.slug} />
      </div>
    </SiteLayout>
  );
}
