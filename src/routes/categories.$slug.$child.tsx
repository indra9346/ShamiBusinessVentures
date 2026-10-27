import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { pageHead, SITE_NAME } from "@/lib/seo";
import { SiteLayout } from "@/components/site/SiteLayout";
import { TileGrid } from "@/components/site/TileGrid";
import { getCategoryNode } from "@/lib/category-tree";

export const Route = createFileRoute("/categories/$slug/$child")({
  beforeLoad: ({ params }) => {
    const child = getCategoryNode(params.slug)?.children?.[params.child];
    if (child) {
      throw redirect({
        to: "/categories/$slug",
        params: { slug: params.slug },
        search: { subcategory: child.name },
      });
    }
  },
  head: ({ params }) => {
    const child = getCategoryNode(params.slug)?.children?.[params.child];
    const name = child?.name ?? "Brands";
    return pageHead({
      title: `${name} | ${SITE_NAME}`,
      description: `Choose ${name.toLowerCase()} at Grain Bazar and see live prices, pack sizes and stock, with GST invoices.`,
      path: `/categories/${params.slug}/${params.child}`,
    });
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
      <h1 className="sr-only">{sub.name}</h1>
      {node.slug === "oil" && (
        <div className="mx-auto flex max-w-7xl justify-end px-4 pt-4 sm:px-6">
          <Link
            to="/shop"
            search={{ category: "Oil" }}
            className="rounded-md bg-navy px-4 py-2 text-sm font-semibold text-white hover:bg-navy/90"
          >
            Shop all oils
          </Link>
        </div>
      )}

      <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 sm:py-6">
        <TileGrid tiles={sub.tiles} basePath={node.slug} />
      </div>
    </SiteLayout>
  );
}
