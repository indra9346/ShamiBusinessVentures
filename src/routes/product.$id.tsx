import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useState } from "react";
import { Heart, Minus, Plus, ShieldCheck, Star, Truck, Store } from "lucide-react";
import { toast } from "sonner";
import { SiteLayout, Breadcrumbs, SectionHeading } from "@/components/site/SiteLayout";
import { ProductCard } from "@/components/site/ProductCard";
import { inr, isStorefrontProduct, products, reviews, vendors } from "@/lib/data";
import { useApp } from "@/lib/store";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { showCartNotification, showCustomerNotification } from "@/components/site/CartFloatingNotification";

export const Route = createFileRoute("/product/$id")({
  loader: ({ params }) => {
    const product = products.find((p) => p.id === params.id);
    if (!product) throw notFound();
    return { product };
  },
  head: ({ loaderData }) => {
    if (!loaderData) {
      return { meta: [{ title: "Product not found | Shami" }, { name: "robots", content: "noindex" }] };
    }
    const p = loaderData.product;
    return {
      meta: [
        { title: `${p.name} — ${inr(p.price)} | Shami Business Ventures` },
        { name: "description", content: `${p.name} from ${p.vendor}. ${p.weight} pack at ${inr(p.price)}.` },
        { property: "og:title", content: `${p.name} | Shami` },
        { property: "og:description", content: `${p.weight} · ${inr(p.price)} · Sold by ${p.vendor}` },
      ],
    };
  },
  component: ProductDetail,
});

function ProductDetail() {
  const { product } = Route.useLoaderData();
  const { addToCart, toggleWishlist, wishlist } = useApp();
  const [qty, setQty] = useState(1);
  const [active, setActive] = useState(0);
  const vendor = vendors.find((v) => v.id === product.vendorId)!;
  const off = Math.round(((product.mrp - product.price) / product.mrp) * 100);
  const gallery = [product.image, product.image, product.image];
  const related = products.filter((p) => isStorefrontProduct(p) && p.id !== product.id).slice(0, 4);

  return (
    <SiteLayout>
      <div className="border-b border-border bg-ivory">
        <div className="mx-auto max-w-7xl px-6 py-6">
          <Breadcrumbs items={[{ label: "Shop", to: "/shop" }, { label: product.category }, { label: product.name }]} />
        </div>
      </div>

      <div className="mx-auto grid max-w-7xl gap-10 px-6 py-10 lg:grid-cols-2">
        <div>
          <div className="overflow-hidden rounded-xl border border-border bg-ivory">
            <img
              src={gallery[active]}
              alt={product.name}
              width={800}
              height={800}
              className="aspect-square w-full object-cover"
            />
          </div>
          <div className="mt-4 flex gap-3">
            {gallery.map((g, i) => (
              <button
                key={i}
                onClick={() => setActive(i)}
                className={cn(
                  "h-20 w-20 overflow-hidden rounded-lg border-2",
                  active === i ? "border-gold" : "border-border",
                )}
              >
                <img src={g} alt="" loading="lazy" width={800} height={800} className="h-full w-full object-cover" />
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="text-[11px] font-bold tracking-[0.18em] text-gold uppercase">{product.brand}</p>
          <h1 className="mt-2 text-2xl font-bold text-navy sm:text-3xl">{product.name}</h1>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-slate">
            <span className="flex items-center gap-1 font-semibold text-gold">
              <Star className="h-4 w-4 fill-gold" /> {product.rating}
            </span>
            <span>{product.reviews} reviews</span>
            <span className="text-border">|</span>
            <span>
              Sold by <span className="font-semibold text-navy">{product.vendor}</span>
            </span>
            <span className="text-border">|</span>
            <span>SKU {product.sku}</span>
          </div>

          <div className="mt-6 flex flex-wrap items-baseline gap-3">
            <span className="text-3xl font-extrabold text-navy">{inr(product.price)}</span>
            <span className="text-lg text-slate line-through">{inr(product.mrp)}</span>
            {off > 0 && <span className="rounded-full bg-gold/12 px-2.5 py-1 text-xs font-bold text-gold">{off}% off</span>}
          </div>
          <p className="mt-1 text-xs text-slate">Inclusive of all taxes · Pack size {product.weight}</p>

          <p className={cn("mt-4 text-sm font-semibold", product.stock > 0 ? "text-success" : "text-danger")}>
            {product.stock > 0 ? `In stock — ${product.stock} units available` : "Currently out of stock"}
          </p>

          <div className="mt-6 flex flex-wrap items-center gap-4">
            <div className="flex items-center rounded-md border border-border">
              <button onClick={() => setQty(Math.max(1, qty - 1))} className="p-3 text-navy hover:text-gold" aria-label="Decrease">
                <Minus className="h-4 w-4" />
              </button>
              <span className="w-12 text-center font-semibold text-navy">{qty}</span>
              <button onClick={() => setQty(qty + 1)} className="p-3 text-navy hover:text-gold" aria-label="Increase">
                <Plus className="h-4 w-4" />
              </button>
            </div>
            <button
              disabled={product.stock === 0}
              onClick={() => {
                addToCart(product.id, qty);
                showCartNotification("Added to cart", `${qty} × ${product.name}`, "add", product.image);
              }}
              className="flex-1 rounded-md bg-navy px-6 py-3.5 text-sm font-semibold text-white transition-colors hover:bg-midnight disabled:opacity-40 sm:flex-none"
            >
              Add to Cart
            </button>
            <Link
              to="/checkout"
              search={{ productId: product.id }}
              onClick={() => {
                addToCart(product.id, qty);
                showCustomerNotification(
                  `${product.name} — CHECKOUT`,
                  `${qty} × ${product.name} · Instant checkout`,
                  "success",
                  product.image
                );
              }}
              className={cn(
                "flex-1 rounded-md bg-gold px-6 py-3.5 text-center text-sm font-bold text-midnight transition-colors hover:bg-gold-light sm:flex-none",
                product.stock === 0 && "pointer-events-none opacity-40",
              )}
            >
              Buy Now
            </Link>
            <button
              onClick={() => {
                const nextWished = !wishlist.includes(product.id);
                toggleWishlist(product.id);
                showCustomerNotification(
                  nextWished ? "Added to wishlist" : "Removed from wishlist",
                  product.name,
                  nextWished ? "success" : "remove",
                  product.image
                );
              }}
              aria-label="Wishlist"
              className="grid h-12 w-12 place-items-center rounded-md border border-border text-slate hover:border-gold hover:text-gold"
            >
              <Heart className={cn("h-5 w-5", wishlist.includes(product.id) && "fill-gold text-gold")} />
            </button>
          </div>

          <div className="mt-8 grid gap-3 rounded-lg border border-border bg-ivory p-5 text-sm sm:grid-cols-3">
            {[
              [Truck, "Delivery in 2–4 days"],
              [ShieldCheck, "FSSAI certified batch"],
              [Store, "GST invoice provided"],
            ].map(([Icon, label]) => {
              const I = Icon as React.ComponentType<{ className?: string }>;
              return (
                <div key={label as string} className="flex items-center gap-2 text-charcoal">
                  <I className="h-4 w-4 shrink-0 text-gold" /> {label as string}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-6 pb-14">
        <Tabs defaultValue="desc">
          <TabsList className="flex-wrap">
            <TabsTrigger value="desc">Description</TabsTrigger>
            <TabsTrigger value="spec">Specifications</TabsTrigger>
            <TabsTrigger value="vendor">Vendor</TabsTrigger>
            <TabsTrigger value="delivery">Delivery</TabsTrigger>
            <TabsTrigger value="reviews">Reviews</TabsTrigger>
          </TabsList>
          <TabsContent value="desc" className="rounded-lg border border-border bg-card p-6 text-sm leading-relaxed text-charcoal">
            {product.description}
          </TabsContent>
          <TabsContent value="spec" className="rounded-lg border border-border bg-card p-6">
            <dl className="grid gap-4 text-sm sm:grid-cols-2">
              {[
                ["Category", product.category],
                ["Subcategory", product.subcategory],
                ["Pack size", product.weight],
                ["SKU", product.sku],
                ["Brand", product.brand],
                ["Tax", "5% GST included"],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between border-b border-border pb-2">
                  <dt className="text-slate">{k}</dt>
                  <dd className="font-semibold text-navy">{v}</dd>
                </div>
              ))}
            </dl>
          </TabsContent>
          <TabsContent value="vendor" className="rounded-lg border border-border bg-card p-6 text-sm">
            <p className="text-lg font-bold text-navy">{vendor.business}</p>
            <p className="mt-1 text-slate">
              {vendor.city} · GSTIN {vendor.gst}
            </p>
            <p className="mt-4 text-charcoal">
              {vendor.products} active listings · {vendor.orders} orders fulfilled · Verified vendor since 2024.
            </p>
          </TabsContent>
          <TabsContent value="delivery" className="rounded-lg border border-border bg-card p-6 text-sm text-charcoal">
            Standard freight delivery in 2–4 business days across 480+ pin codes. Free delivery on orders above
            ₹10,000. Cash on delivery available up to ₹25,000.
          </TabsContent>
          <TabsContent value="reviews" className="rounded-lg border border-border bg-card p-6">
            <div className="space-y-5">
              {reviews.map((r) => (
                <div key={r.id} className="border-b border-border pb-5 last:border-0 last:pb-0">
                  <div className="flex items-center gap-2">
                    <span className="flex items-center gap-1 rounded bg-gold/12 px-2 py-0.5 text-xs font-bold text-gold">
                      <Star className="h-3 w-3 fill-gold" /> {r.rating}
                    </span>
                    <p className="font-semibold text-navy">{r.title}</p>
                  </div>
                  <p className="mt-2 text-sm text-charcoal">{r.body}</p>
                  <p className="mt-2 text-xs text-slate">
                    {r.customer} · {r.date}
                  </p>
                </div>
              ))}
            </div>
          </TabsContent>
        </Tabs>
      </div>

      <div className="bg-ivory">
        <div className="mx-auto max-w-7xl px-6 py-14">
          <SectionHeading eyebrow="You may also like" title="Related Products" />
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {related.map((p) => (
              <ProductCard key={p.id} product={p} />
            ))}
          </div>
        </div>
      </div>
    </SiteLayout>
  );
}
