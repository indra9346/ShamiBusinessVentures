import { useEffect, useRef, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { ArrowRight, ShoppingBag } from "lucide-react";
import { inr } from "@/lib/data";
import { useApp } from "@/lib/store";
import { useCartPreview } from "@/lib/cart-preview";
import { cn } from "@/lib/utils";

/** Storefront routes where the bar would duplicate the page's own summary. */
const HIDDEN_PREFIXES = ["/cart", "/checkout", "/admin", "/vendor", "/login", "/register", "/reset-password"];

/**
 * "You're shopping" bar — slides up from the bottom the moment the cart has at least one
 * item and stays fixed while the customer keeps browsing. Shows live count, weight and
 * total (straight from the store context, so it updates the instant quantities change),
 * with one-tap View Cart / Checkout.
 */
export function StickyCartBar() {
  const { cartItems: savedItems, cartCount: savedCount, subtotal: savedSubtotal } = useApp();
  // While the add-to-cart keypad is open, show the cart as it will be after "Add".
  const preview = useCartPreview();
  const previewing = !!preview && preview.qty > 0;
  const cartItems = !previewing
    ? savedItems
    : savedItems.some((line) => line.product.id === preview.product.id)
      ? savedItems.map((line) => line.product.id === preview.product.id ? { ...line, qty: line.qty + preview.qty } : line)
      : [...savedItems, { product: preview.product, qty: preview.qty }];
  const cartCount = savedCount + (previewing ? preview.qty : 0);
  const subtotal = savedSubtotal + (previewing ? preview.product.price * preview.qty : 0);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const hidden = HIDDEN_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  const visible = cartCount > 0 && !hidden;

  const [pulseKey, setPulseKey] = useState(0);
  const previous = useRef<number | null>(null);
  useEffect(() => {
    const prev = previous.current;
    previous.current = subtotal;
    if (prev === null || prev === subtotal) return;
    setPulseKey((k) => k + 1);
  }, [subtotal]);

  const totals = { kg: 0, L: 0 };
  for (const line of cartItems) {
    const match = String(line.product.weight ?? "").match(/(\d+(?:\.\d+)?)\s*(kg|g|l|ml|litres?)\b/i);
    if (!match) continue;
    const amount = Number(match[1]) * line.qty;
    const unit = match[2]!.toLowerCase();
    if (unit === "kg") totals.kg += amount;
    else if (unit === "g") totals.kg += amount / 1000;
    else if (unit === "ml") totals.L += amount / 1000;
    else totals.L += amount;
  }
  const measure = [
    totals.kg > 0 && `${totals.kg.toLocaleString("en-IN", { maximumFractionDigits: 2 })} kg`,
    totals.L > 0 && `${totals.L.toLocaleString("en-IN", { maximumFractionDigits: 2 })} L`,
  ].filter(Boolean);
  const distinct = cartItems.length;
  const summary = [
    `${distinct} ${distinct === 1 ? "product" : "products"}`,
    `${cartCount} ${cartCount === 1 ? "bag" : "bags"}`,
    ...measure,
  ].join(" · ");

  return (
    <>
      {/* Reserve space so the bar never covers the footer or the last row of cards */}
      <div aria-hidden className={cn("transition-[height] duration-300", visible ? "h-20 sm:h-[4.5rem]" : "h-0")} />

      <div
        role="region"
        aria-label="Your cart"
        aria-hidden={!visible}
        className={cn(
          "fixed inset-x-0 bottom-0 transition-transform duration-300 ease-out",
          previewing ? "pointer-events-none z-[60]" : "z-40",
          visible ? "translate-y-0" : "pointer-events-none translate-y-full",
        )}
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="border-t border-gold/40 bg-card/95 shadow-[0_-8px_30px_-12px_rgba(60,45,20,0.35)] backdrop-blur-md">
          <div className="mx-auto flex max-w-7xl items-center gap-3 px-3 py-2.5 sm:px-6 sm:py-3">
            <Link
              to="/cart"
              className="flex min-w-0 flex-1 items-center gap-2.5"
              aria-label={`View cart: ${cartCount} items, ${inr(subtotal)}`}
            >
              <span className="relative grid h-10 w-10 shrink-0 place-items-center rounded-full bg-navy text-gold">
                <ShoppingBag className="h-5 w-5" />
                <span
                  key={`b-${pulseKey}`}
                  className={cn(
                    "absolute -top-1.5 -right-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-gold px-1 text-[10px] font-black text-midnight ring-2 ring-card",
                    pulseKey > 0 && "animate-cart-pop",
                  )}
                >
                  {cartCount > 99 ? "99+" : cartCount}
                </span>
              </span>
              <span className="min-w-0 leading-tight">
                <span className="block truncate text-[11px] font-semibold uppercase tracking-wider text-slate">
                  {summary}
                </span>
                <span
                  key={`t-${pulseKey}`}
                  className={cn("block text-base font-extrabold text-navy sm:text-lg", pulseKey > 0 && "animate-cart-pop origin-left")}
                >
                  {inr(subtotal)}
                  <span className="ml-1.5 text-[11px] font-medium text-slate">
                    {previewing ? `incl. ${preview.qty} new` : "+ GST at checkout"}
                  </span>
                </span>
              </span>
            </Link>

            <Link
              to="/cart"
              className="hidden h-10 shrink-0 items-center rounded-md border border-navy/30 px-4 text-sm font-semibold text-navy transition-colors hover:border-gold hover:text-gold sm:inline-flex"
            >
              View Cart
            </Link>
            <Link
              to="/checkout"
              search={{}}
              className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-md bg-gold px-4 text-sm font-bold text-midnight shadow-sm transition-all hover:bg-gold-light active:scale-[0.98]"
            >
              Checkout <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
