import { Link } from "@tanstack/react-router";
import { Heart, Package, Star } from "lucide-react";
import { getDisplayDiscountPercent, getPricingDisplayMode, inr, type Product } from "@/lib/data";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import { showCustomerNotification } from "@/components/site/CartFloatingNotification";
import { AddToCartPicker } from "@/components/site/AddToCartPicker";

const LOW_STOCK_FALLBACK = 20;

function fallbackImage(category: string) {
  const cat = category.toLowerCase();
  return cat.includes("sugar")
    ? "/products/sugar.jpg"
    : cat.includes("oil")
      ? "/products/oil.jpg"
      : "/products/rice.jpg";
}

function stockState(product: Product, availableStock: number) {
  if (availableStock <= 0)
    return { label: "Out of Stock", dot: "bg-red-500", text: "text-red-600" } as const;
  const threshold = Math.max(1, Number(product.minimumStock) || LOW_STOCK_FALLBACK);
  if (availableStock <= threshold)
    return {
      label: `Low Stock · ${availableStock} left`,
      dot: "bg-amber-500",
      text: "text-amber-700",
    } as const;
  return { label: "In Stock", dot: "bg-emerald-500", text: "text-emerald-700" } as const;
}

/** Price block shared by grid + list layouts. Honours the admin "Pricing Display Mode". */
function PriceBlock({ product, size = "sm" }: { product: Product; size?: "sm" | "lg" }) {
  const mrpOnly = getPricingDisplayMode(product) === "mrp_only";
  const off = getDisplayDiscountPercent(product);
  const priceClass = size === "lg" ? "text-base sm:text-lg" : "text-sm sm:text-base";

  if (mrpOnly) {
    return (
      <div className="flex flex-wrap items-baseline gap-1">
        <span className={cn(priceClass, "font-bold text-navy")}>{inr(product.price)}</span>
        <span className="text-[11px] font-medium text-slate-500">MRP</span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
      <span className={cn(priceClass, "font-bold text-navy")}>{inr(product.price)}</span>
      {product.mrp > product.price && (
        <span className="text-[11px] sm:text-xs text-slate-500 line-through">
          {inr(product.mrp)}
        </span>
      )}
      {off > 0 && (
        <span className="text-[11px] sm:text-xs font-bold text-emerald-600">{off}% off</span>
      )}
      {off > 0 && (
        <span className="basis-full text-[10px] sm:text-[11px] font-medium text-emerald-700">
          Save {inr(product.mrp - product.price)}
        </span>
      )}
    </div>
  );
}

function RatingBadge({ product }: { product: Product }) {
  if (!(Number(product.rating) > 0)) return null;
  return (
    <div className="flex items-center gap-1.5">
      <span className="inline-flex items-center gap-0.5 rounded-sm bg-emerald-600 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
        {product.rating}
        <Star className="h-2.5 w-2.5 fill-white" />
      </span>
      <span className="text-[10px] sm:text-[11px] font-medium text-slate-500">
        ({product.reviews.toLocaleString("en-IN")})
      </span>
    </div>
  );
}

export function ProductCard({
  product,
  layout = "grid",
}: {
  product: Product;
  layout?: "grid" | "list";
}) {
  const { addToCart, toggleWishlist, wishlist } = useApp();
  const off = getDisplayDiscountPercent(product);
  const wished = wishlist.includes(product.id);
  const availableStock = Math.max(
    0,
    Math.floor((Number(product.stock) || 0) - (Number(product.reserved) || 0)),
  );
  const stock = stockState(product, availableStock);

  const onWishlist = () => {
    const nextWished = !wished;
    toggleWishlist(product.id);
    showCustomerNotification(
      nextWished ? "Added to wishlist" : "Removed from wishlist",
      product.name,
      nextWished ? "success" : "remove",
      product.image,
    );
  };

  const image = (
    <img
      src={product.image || `/products/${product.category.toLowerCase()}.jpg`}
      alt={product.name}
      loading="lazy"
      width={400}
      height={300}
      onError={(e) => {
        const el = e.currentTarget as HTMLImageElement;
        const next = fallbackImage(product.category);
        if (!el.src.endsWith(next)) el.src = next;
      }}
      className="h-full w-full object-contain p-2.5 transition-transform duration-300 ease-in-out group-hover:scale-105"
    />
  );

  const discountBadge = off > 0 && (
    <span className="absolute top-2 left-2 rounded-sm bg-emerald-600 px-1.5 py-0.5 text-[10px] font-bold text-white shadow-xs">
      {off}% OFF
    </span>
  );

  const newBadge = product.tags.includes("new") && (
    <span
      className={cn(
        "absolute left-2 rounded-sm bg-amber-400 px-1.5 py-0.5 text-[10px] font-bold text-amber-950",
        off > 0 ? "top-7" : "top-2",
      )}
    >
      NEW
    </span>
  );

  const wishlistButton = (
    <button
      type="button"
      onClick={onWishlist}
      aria-label={wished ? "Remove from wishlist" : "Add to wishlist"}
      aria-pressed={wished}
      className="absolute top-1.5 right-1.5 grid h-9 w-9 place-items-center rounded-full bg-white/90 text-slate-500 shadow-xs backdrop-blur-xs transition-all duration-200 hover:scale-110 hover:text-rose-500"
    >
      <Heart className={cn("h-4 w-4", wished && "fill-rose-500 text-rose-500")} />
    </button>
  );

  const buyNow = (className?: string) => (
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
        "flex h-9 items-center justify-center rounded-md bg-gold px-2 text-[11px] sm:text-xs font-bold text-midnight transition-all duration-200 hover:bg-gold-light active:scale-[0.98]",
        availableStock === 0 && "pointer-events-none opacity-40",
        className,
      )}
    >
      Buy Now
    </Link>
  );

  const unitChip = product.weight && (
    <span className="inline-flex max-w-full items-center gap-1 rounded-sm bg-slate-100 px-1.5 py-0.5 text-[10px] sm:text-[11px] font-semibold text-slate-700">
      <Package className="h-3 w-3 shrink-0 text-slate-500" />
      <span className="truncate">{product.weight}</span>
    </span>
  );

  const stockIndicator = (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[10px] sm:text-[11px] font-semibold",
        stock.text,
      )}
    >
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", stock.dot)} aria-hidden />
      {stock.label}
    </span>
  );

  if (layout === "list") {
    return (
      <article className="group relative flex flex-row overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xs transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-gold/60 hover:shadow-md">
        <div className="relative w-28 shrink-0 overflow-hidden bg-slate-50/80 sm:w-44">
          <Link
            to="/product/$id"
            params={{ id: product.id }}
            className="block h-full min-h-32 w-full"
          >
            {image}
          </Link>
          {discountBadge}
          {newBadge}
          {wishlistButton}
        </div>

        <div className="flex min-w-0 flex-1 flex-col justify-between gap-2 p-3 sm:p-4">
          <div className="min-w-0 space-y-1">
            <p className="truncate text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              {product.vendor}
            </p>
            <Link
              to="/product/$id"
              params={{ id: product.id }}
              className="line-clamp-2 text-xs sm:text-sm font-bold text-navy transition-colors hover:text-gold"
            >
              {product.name}
            </Link>
            <div className="flex flex-wrap items-center gap-2">
              <RatingBadge product={product} />
              {unitChip}
            </div>
            <PriceBlock product={product} size="lg" />
            {stockIndicator}
          </div>

          <div className="flex flex-wrap items-start gap-2 sm:flex-nowrap has-[[data-picker-open]]:flex-col has-[[data-picker-open]]:sm:flex-col">
            <div className="w-full sm:w-40 has-[[data-picker-open]]:sm:w-full has-[[data-picker-open]]:sm:max-w-sm">
              <AddToCartPicker product={product} compact />
            </div>
            {buyNow("flex-1 sm:flex-none sm:w-28")}
          </div>
        </div>
      </article>
    );
  }

  return (
    <article className="group relative flex h-full min-w-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xs transition-all duration-200 ease-out hover:-translate-y-1 hover:border-gold/60 hover:shadow-md">
      <div className="relative overflow-hidden bg-slate-50/80">
        <Link to="/product/$id" params={{ id: product.id }} className="block aspect-[4/3] w-full">
          {image}
        </Link>
        {discountBadge}
        {newBadge}
        {wishlistButton}
      </div>

      <div className="flex flex-1 flex-col gap-1 p-2.5 sm:p-3">
        <p className="truncate text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          {product.vendor}
        </p>
        <Link
          to="/product/$id"
          params={{ id: product.id }}
          className="line-clamp-2 min-h-[2lh] text-xs sm:text-sm font-bold leading-snug text-navy transition-colors hover:text-gold"
        >
          {product.name}
        </Link>
        <div className="flex flex-wrap items-center gap-1.5">
          <RatingBadge product={product} />
          {unitChip}
        </div>
        <div className="mt-0.5">
          <PriceBlock product={product} />
        </div>
        {stockIndicator}

        <div className="mt-auto flex flex-col gap-1.5 pt-2 min-[400px]:flex-row has-[[data-picker-open]]:flex-col">
          <div className="min-w-0 flex-1">
            <AddToCartPicker product={product} compact />
          </div>
          {buyNow("min-[400px]:flex-1")}
        </div>
      </div>
    </article>
  );
}
