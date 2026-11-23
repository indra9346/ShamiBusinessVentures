import { createFileRoute, Link } from "@tanstack/react-router";
import { Heart } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel } from "@/components/panel/widgets";
import { ProductCard } from "@/components/site/ProductCard";
import { accountNav } from "@/lib/account-nav";
import { isStorefrontProduct } from "@/lib/data";
import { useApp } from "@/lib/store";

/*
 * The customer's wishlist inside My Account (13 Nov 2026). The panel menu used to open the shop's /wishlist page,
 * which has no account menu, so a customer who chose Wishlist could not get back to the rest of the panel.
 * The shop page stays for the heart in the site header.
 */
export const Route = createFileRoute("/account/wishlist")({
  head: () => ({
    meta: [
      { title: "My Wishlist | Shami Business Ventures" },
      { name: "description", content: "Products you saved for later." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AccountWishlist,
});

function AccountWishlist() {
  const { wishlist, products } = useApp();
  const items = products.filter((p) => wishlist.includes(p.id) && isStorefrontProduct(p));
  return (
    <PanelLayout items={accountNav} tone="customer" title="My Wishlist" subtitle="Products you saved for later.">
      <Panel id="wishlist" title={`${items.length} ${items.length === 1 ? "product" : "products"}`}>
        {items.length === 0 ? (
          <div className="grid place-items-center gap-3 py-12 text-center">
            <Heart className="h-10 w-10 text-gold" />
            <p className="text-lg font-bold text-navy">Your wishlist is empty</p>
            <Link to="/shop" className="mt-2 rounded-md bg-navy px-6 py-3 text-sm font-semibold text-white hover:bg-midnight">
              Browse Products
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-3 xl:grid-cols-4">
            {items.map((p) => (
              <ProductCard key={p.id} product={p} />
            ))}
          </div>
        )}
      </Panel>
    </PanelLayout>
  );
}
