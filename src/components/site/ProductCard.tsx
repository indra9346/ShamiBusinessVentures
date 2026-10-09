import { Link } from "@tanstack/react-router";
import { Heart, Star } from "lucide-react";
import { toast } from "sonner";
import { inr, type Product } from "@/lib/data";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import { showCustomerNotification } from "@/components/site/CartFloatingNotification";
import { AddToCartPicker } from "@/components/site/AddToCartPicker";

export function ProductCard({
  product,
  layout = "grid",
}: {
  product: Product;
  layout?: "grid" | "list";
}) {
  const { addToCart, toggleWishlist, wishlist } = useApp();
  const off = product.mrp > product.price ? Math.max(0, Math.round(((product.mrp - product.price) / product.mrp) * 100)) : 0;
  const wished = wishlist.includes(product.id);
  const availableStock = Math.max(0, Math.floor((Number(product.stock) || 0) - (Number(product.reserved) || 0)));

  if (layout === "list") {
    return (
      <article className="card-premium group relative flex flex-row overflow-hidden transition-all hover:border-gold hover:shadow-elevated">
        <div className="relative w-32 sm:w-48 shrink-0 overflow-hidden bg-ivory">
          <Link to="/product/$id" params={{ id: product.id }} className="block h-full w-full">
            <img
              src={product.image || `/products/${product.category.toLowerCase()}.jpg`}
              alt={product.name}
              loading="lazy"
              width={800}
              height={800}
              onError={(e) => {
                const cat = product.category.toLowerCase();
                (e.currentTarget as HTMLImageElement).src =
                  cat.includes("sugar")
                    ? "/products/sugar.jpg"
                    : cat.includes("oil")
                    ? "/products/oil.jpg"
                    : "/products/rice.jpg";
              }}
              className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
            />
          </Link>
          {off > 0 && (
            <span className="absolute top-2 left-2 rounded-full bg-gold px-2 py-0.5 text-[10px] sm:text-[11px] font-bold text-midnight shadow-xs">
              {off}% OFF
            </span>
          )}
          {product.tags.includes("new") && (
            <span className="absolute bottom-2 left-2 rounded-full bg-navy px-2 py-0.5 text-[10px] font-semibold text-white">
              New
            </span>
          )}
          <button
            type="button"
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
            className="absolute top-2 right-2 grid h-8 w-8 sm:h-9 sm:w-9 place-items-center rounded-full border border-border bg-card/90 text-slate backdrop-blur-xs transition-colors hover:border-gold hover:text-gold"
          >
            <Heart className={cn("h-4 w-4", wished && "fill-gold text-gold")} />
          </button>
        </div>

        <div className="flex flex-1 flex-col justify-between p-3 sm:p-5 min-w-0">
          <div>
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] sm:text-[11px] font-medium tracking-wider text-slate uppercase truncate">
                {product.vendor}
              </p>
              <div className="flex items-center gap-1 text-[11px] sm:text-xs text-slate shrink-0">
                <span className="flex items-center gap-0.5 font-semibold text-gold">
                  <Star className="h-3 w-3 sm:h-3.5 sm:w-3.5 fill-gold" /> {product.rating}
                </span>
                <span>({product.reviews})</span>
              </div>
            </div>

            <Link
              to="/product/$id"
              params={{ id: product.id }}
              className="mt-1 line-clamp-2 text-sm sm:text-base font-bold text-navy transition-colors hover:text-gold"
            >
              {product.name}
            </Link>

            <p className="mt-1 text-[11px] sm:text-xs text-slate">
              {product.weight} · SKU: {product.sku}
            </p>

            <div className="mt-2 flex flex-wrap items-baseline gap-2">
              <span className="text-base sm:text-lg font-bold text-navy">{inr(product.price)}</span>
              <span className="text-xs sm:text-sm text-slate line-through">{inr(product.mrp)}</span>
              {off > 0 && (
                <span className="text-xs font-semibold text-gold">
                  Save {inr(product.mrp - product.price)}
                </span>
              )}
            </div>

            {availableStock === 0 && (
              <p className="mt-1 text-xs font-medium text-danger">Currently unavailable</p>
            )}
          </div>

          <div className="mt-3 flex flex-wrap sm:flex-nowrap items-center gap-2 pt-1">
            <div className="w-full sm:w-auto sm:min-w-36">
              <AddToCartPicker product={product} />
            </div>
            <Link
              to="/checkout"
              search={{ productId: product.id }}
              onClick={(e) => {
                if (availableStock === 0) {
                  e.preventDefault();
                  return;
                }
                addToCart(product.id);
              }}
              tabIndex={availableStock === 0 ? -1 : undefined}
              aria-disabled={availableStock === 0}
              className={cn(
                "flex h-9 sm:h-10 flex-1 items-center justify-center rounded-md bg-gold px-4 text-xs sm:text-sm font-bold text-midnight transition-colors hover:bg-gold-light",
                availableStock === 0 && "pointer-events-none opacity-40",
              )}
            >
              Buy Now
            </Link>
          </div>
        </div>
      </article>
    );
  }

  return (
    <article className="card-premium group relative flex flex-col overflow-hidden">
      <div className="relative overflow-hidden bg-ivory">
        <Link to="/product/$id" params={{ id: product.id }}>
          <img
            src={product.image || `/products/${product.category.toLowerCase()}.jpg`}
            alt={product.name}
            loading="lazy"
            width={800}
            height={800}
            onError={(e) => {
              const cat = product.category.toLowerCase();
              (e.currentTarget as HTMLImageElement).src =
                cat.includes("sugar")
                  ? "/products/sugar.jpg"
                  : cat.includes("oil")
                  ? "/products/oil.jpg"
                  : "/products/rice.jpg";
            }}
            className="aspect-square w-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
        </Link>
        {off > 0 && (
          <span className="absolute top-2 left-2 sm:top-3 sm:left-3 rounded-full bg-gold px-2 py-0.5 sm:px-2.5 sm:py-1 text-[10px] sm:text-[11px] font-bold text-midnight shadow-xs">
            {off}% OFF
          </span>
        )}
        {product.tags.includes("new") && (
          <span className="absolute top-2 right-11 sm:top-3 sm:right-12 rounded-full bg-navy px-2 py-0.5 sm:px-2.5 sm:py-1 text-[10px] sm:text-[11px] font-semibold text-white">
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
          className="absolute top-2 right-2 sm:top-2.5 sm:right-2.5 grid h-8 w-8 sm:h-9 sm:w-9 place-items-center rounded-full border border-border bg-card text-slate transition-colors hover:border-gold hover:text-gold"
        >
          <Heart className={cn("h-4 w-4", wished && "fill-gold text-gold")} />
        </button>
      </div>

      <div className="flex flex-1 flex-col p-3 sm:p-4">
        <p className="text-[10px] sm:text-[11px] font-medium tracking-wider text-slate uppercase truncate">{product.vendor}</p>
        <Link
          to="/product/$id"
          params={{ id: product.id }}
          className="mt-1 line-clamp-2 text-xs sm:text-base font-semibold text-navy transition-colors hover:text-gold"
        >
          {product.name}
        </Link>
        <div className="mt-1.5 sm:mt-2 flex items-center gap-1.5 sm:gap-2 text-[11px] sm:text-xs text-slate">
          <span className="flex items-center gap-1 font-semibold text-gold">
            <Star className="h-3 w-3 sm:h-3.5 sm:w-3.5 fill-gold" /> {product.rating}
          </span>
          <span>({product.reviews})</span>
        </div>

        <div className="mt-2 sm:mt-3 flex flex-wrap items-baseline gap-1.5 sm:gap-2">
          <span className="text-sm sm:text-lg font-bold text-navy">{inr(product.price)}</span>
          <span className="text-xs sm:text-sm text-slate line-through">{inr(product.mrp)}</span>
          {off > 0 && <span className="text-[10px] sm:text-xs font-semibold text-gold">Save {inr(product.mrp - product.price)}</span>}
        </div>

        {availableStock === 0 && <p className="mt-1 text-xs font-medium text-danger">Currently unavailable</p>}

        <div className="mt-3 sm:mt-4 flex flex-col sm:flex-row gap-1.5 sm:gap-2 pt-1">
          <AddToCartPicker product={product} />
          <Link
            to="/checkout"
            search={{ productId: product.id }}
            onClick={(e) => {
              if (availableStock === 0) {
                e.preventDefault();
                return;
              }
              addToCart(product.id);
            }}
            tabIndex={availableStock === 0 ? -1 : undefined}
            aria-disabled={availableStock === 0}
            className={cn(
              "flex flex-1 items-center justify-center rounded-md bg-gold px-3 py-2 sm:py-2.5 text-xs font-bold text-midnight transition-colors hover:bg-gold-light",
              availableStock === 0 && "pointer-events-none opacity-40",
            )}
          >
            Buy Now
          </Link>
        </div>
      </div>
    </article>
  );
}
