import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { getCategoryChild } from "@/lib/category-tree";

// A sub-category's address opens its category, filtered to it. Any other address here is no page:
// the category route shows its not-found message, with a real 404.
export const Route = createFileRoute("/categories/$slug/$child")({
  beforeLoad: ({ params }) => {
    const child = getCategoryChild(params.slug, params.child);
    if (!child) throw notFound();
    throw redirect({
      to: "/categories/$slug",
      params: { slug: params.slug },
      search: { subcategory: child.name },
    });
  },
});
