import { Link } from "@tanstack/react-router";
import { Heart, ShoppingCart, Star } from "lucide-react";
import { toast } from "sonner";
import { inr, type Product } from "@/lib/data";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import { showCartNotification, showCustomerNotification } from "@/components/site/CartFloatingNotification";

export function ProductCard({ product }: { product: Product }) {
  const { addToCart, toggleWishlist, wishlist } = useApp();
  const off = Math.round(((product.mrp - product.price) / product.mrp) * 100);
  const wished = wishlist.includes(product.id);

  return (
    <article className="card-premium group relative flex flex-col overflow-hidden">
      <div className="relative overflow-hidden bg-ivory">
        <Link to="/product/$id" params={{ id: product.id }}>
          <img
            src={product.image}
            alt={product.name}
            loading="lazy"
            width={800}
            height={800}
            className="aspect-square w-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
        </Link>
        {off > 0 && (
          <span className="absolute top-3 left-3 rounded-full bg-gold px-2.5 py-1 text-[11px] font-bold text-midnight">
            {off}% OFF
          </span>
        )}
        {product.tags.includes("new") && (
          <span className="absolute top-3 right-12 rounded-full bg-navy px-2.5 py-1 text-[11px] font-semibold text-white">
            New
          </span>
        )}
        <button
          onClick={() => {
            const nextWished = !wished;
            toggleWishlist(product.id);
            showCustomerNotification(
              nextWished ? "Added to wishlist" : "Removed from wishlist",
              product.name,
              nextWished ? "success" : "remove",
              product.image
            );
          }}
          aria-label="Toggle wishlist"
          className="absolute top-2.5 right-2.5 grid h-9 w-9 place-items-center rounded-full border border-border bg-card text-slate transition-colors hover:border-gold hover:text-gold"
        >
          <Heart className={cn("h-4 w-4", wished && "fill-gold text-gold")} />
        </button>
      </div>

      <div className="flex flex-1 flex-col p-4">
        <p className="text-[11px] font-medium tracking-wider text-slate uppercase">{product.vendor}</p>
        <Link
          to="/product/$id"
          params={{ id: product.id }}
          className="mt-1.5 line-clamp-2 font-semibold text-navy transition-colors hover:text-gold"
        >
          {product.name}
        </Link>
        <div className="mt-2 flex items-center gap-2 text-xs text-slate">
          <span className="flex items-center gap-1 font-semibold text-gold">
            <Star className="h-3.5 w-3.5 fill-gold" /> {product.rating}
          </span>
          <span>({product.reviews})</span>
        </div>

        <div className="mt-3 flex flex-wrap items-baseline gap-2">
          <span className="text-lg font-bold text-navy">{inr(product.price)}</span>
          <span className="text-sm text-slate line-through">{inr(product.mrp)}</span>
          {off > 0 && <span className="text-xs font-semibold text-gold">Save {inr(product.mrp - product.price)}</span>}
        </div>

        {product.stock === 0 && <p className="mt-1 text-xs font-medium text-danger">Currently unavailable</p>}

        <div className="mt-4 flex gap-2 pt-1">
          <button
            disabled={product.stock === 0}
            onClick={() => {
              addToCart(product.id);
              showCartNotification("Added to cart", product.name, "add", product.image);
            }}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-navy px-3 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-midnight disabled:opacity-40"
          >
            <ShoppingCart className="h-3.5 w-3.5" /> Add
          </button>
          <Link
            to="/checkout"
            search={{ productId: product.id }}
            onClick={() => {
              addToCart(product.id);
              showCustomerNotification(
                `${product.name} — CHECKOUT`,
                "Redirecting to instant checkout...",
                "success",
                product.image
              );
            }}
            className={cn(
              "flex flex-1 items-center justify-center rounded-md bg-gold px-3 py-2.5 text-xs font-bold text-midnight transition-colors hover:bg-gold-light",
              product.stock === 0 && "pointer-events-none opacity-40",
            )}
          >
            Buy Now
          </Link>
        </div>
      </div>
    </article>
  );
}
