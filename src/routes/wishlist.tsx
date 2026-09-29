import { createFileRoute, Link } from "@tanstack/react-router";
import { Heart } from "lucide-react";
import { SiteLayout, Breadcrumbs } from "@/components/site/SiteLayout";
import { ProductCard } from "@/components/site/ProductCard";
import { isStorefrontProduct, products } from "@/lib/data";
import { useApp } from "@/lib/store";

export const Route = createFileRoute("/wishlist")({
  head: () => ({
    meta: [
      { title: "My Wishlist | Shami Business Ventures" },
      { name: "description", content: "Saved S1 sugar products in your Shami wishlist." },
      { property: "og:title", content: "My Wishlist | Shami" },
      { property: "og:description", content: "Products you saved for later." },
    ],
  }),
  component: Wishlist,
});

function Wishlist() {
  const { wishlist } = useApp();
  const items = products.filter((p) => wishlist.includes(p.id) && isStorefrontProduct(p));
  return (
    <SiteLayout>
      <div className="border-b border-border bg-ivory">
        <div className="mx-auto max-w-7xl px-6 py-8">
          <Breadcrumbs items={[{ label: "Wishlist" }]} />
          <h1 className="mt-3 text-3xl font-bold text-navy">My Wishlist</h1>
        </div>
      </div>
      <div className="mx-auto max-w-7xl px-6 py-10">
        {items.length === 0 ? (
          <div className="grid place-items-center gap-3 py-20 text-center">
            <Heart className="h-10 w-10 text-gold" />
            <p className="text-lg font-bold text-navy">Your wishlist is empty</p>
            <Link to="/shop" className="mt-2 rounded-md bg-navy px-6 py-3 text-sm font-semibold text-white hover:bg-midnight">
              Browse Products
            </Link>
          </div>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {items.map((p) => (
              <ProductCard key={p.id} product={p} />
            ))}
          </div>
        )}
      </div>
    </SiteLayout>
  );
}