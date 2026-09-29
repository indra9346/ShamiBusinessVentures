import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { SiteLayout, Breadcrumbs } from "@/components/site/SiteLayout";
import { TileGrid } from "@/components/site/TileGrid";
import { getCategoryNode } from "@/lib/category-tree";

export const Route = createFileRoute("/categories/$slug/$child")({
  head: ({ params }) => {
    const child = getCategoryNode(params.slug)?.children?.[params.child];
    const name = child?.name ?? "Brands";
    return {
      meta: [
        { title: `${name} brands | Shami Business Ventures` },
        { name: "description", content: `Choose a ${name} brand and see live pricing, pack sizes and stock.` },
        { property: "og:title", content: `${name} brands | Shami Business Ventures` },
        { property: "og:description", content: `Verified ${name} brands with GST invoicing and pan-India delivery.` },
      ],
    };
  },
  component: ChildLevel,
});

function ChildLevel() {
  const { slug, child } = Route.useParams();
  const node = getCategoryNode(slug);
  const sub = node?.children?.[child];

  if (!node || !sub) {
    return (
      <SiteLayout>
        <div className="mx-auto max-w-7xl px-4 py-16 text-center sm:px-6">
          <h1 className="text-2xl font-bold text-navy">Subcategory not found</h1>
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
          <Breadcrumbs
            items={[
              { label: "Categories", to: "/categories" },
              { label: node.name, to: `/categories/${node.slug}` },
              { label: sub.name },
            ]}
          />
          <div className="mt-3 flex items-center gap-3">
            <Link
              to="/categories/$slug"
              params={{ slug: node.slug }}
              aria-label={`Back to ${node.name}`}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-border bg-card text-navy transition-colors hover:border-gold hover:text-gold"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <h1 className="text-2xl font-bold text-navy sm:text-3xl">{sub.name}</h1>
          </div>
          <p className="mt-2 text-sm text-slate">{sub.tagline}</p>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-12">
        <TileGrid tiles={sub.tiles} basePath={node.slug} />
      </div>
    </SiteLayout>
  );
}
