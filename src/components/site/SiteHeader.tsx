import { Link, useNavigate } from "@tanstack/react-router";
import { Heart, Menu, Search, ShoppingCart, User, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Logo } from "@/components/brand/Logo";
import { useApp } from "@/lib/store";
import { Input } from "@/components/ui/input";
import { inr, isStorefrontProduct } from "@/lib/data";
import { LanguageSwitcher } from "@/components/site/LanguageSwitcher";

import { SearchAutosuggest } from "@/components/site/SearchAutosuggest";

const nav = [
  { label: "Home", to: "/" },
  { label: "Shop", to: "/shop" },
  { label: "Categories", to: "/categories" },
  { label: "About", to: "/about" },
  { label: "Contact", to: "/contact" },
];

export function SiteHeader() {
  const { cartCount, subtotal, wishlist, user } = useApp();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const navigate = useNavigate();

  return (
    <header className="sticky top-0 z-50 w-full">
      <div className="hidden bg-midnight text-[13px] text-white/70 md:block">
        <div className="mx-auto flex max-w-7xl items-center justify-end px-6 py-2">
          <div className="flex items-center gap-5">
            <LanguageSwitcher light />
          </div>
        </div>
      </div>

      <div className="border-b border-white/10 bg-navy/95 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-3.5 py-2.5 sm:px-6 sm:py-3">
          <Logo />

          <div className="relative hidden min-w-0 flex-1 max-w-xl mx-6 lg:block">
            <SearchAutosuggest
              value={q}
              onChange={setQ}
              onSearch={(query) => {
                navigate({ to: "/shop", search: query ? { q: query } : {} });
                setQ("");
                setOpen(false);
              }}
              placeholder="Search S1 sugar, SKU or vendor…"
              variant="header"
              id="header-desktop-search"
            />
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2">
            <Link
              to="/wishlist"
              className="relative flex h-10 w-10 items-center justify-center rounded-full text-white transition-colors hover:text-gold"
              aria-label="Wishlist"
            >
              <Heart className="h-5 w-5" />
              {wishlist.length > 0 && <Badge count={wishlist.length} />}
            </Link>
            <HeaderCartButton cartCount={cartCount} subtotal={subtotal} />
            <Link
              to={user ? (user.role === "admin" ? "/admin/dashboard" : user.role === "vendor" ? "/vendor/dashboard" : "/account") : "/login"}
              className="hidden items-center gap-2 rounded-full border border-white/20 px-4 py-2 text-sm font-medium text-white transition-colors hover:border-gold hover:text-gold sm:flex"
            >
              <User className="h-4 w-4" />
              {user ? user.name.split(" ")[0] : "Login"}
            </Link>
            <button
              onClick={() => setOpen((v) => !v)}
              className="flex h-10 w-10 items-center justify-center rounded-full text-white transition-colors hover:text-gold lg:hidden"
              aria-label="Menu"
            >
              {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>

        <nav className="mx-auto hidden max-w-7xl items-center gap-8 px-6 lg:flex">
          {nav.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              activeOptions={{ exact: n.to === "/" }}
              className="group relative py-3 text-sm font-medium tracking-wide text-white/85 uppercase transition-colors hover:text-gold data-[status=active]:text-gold"
              activeProps={{ className: "text-gold" }}
            >
              {n.label}
              <span className="absolute bottom-0 left-0 h-0.5 w-full origin-left scale-x-0 bg-gold transition-transform duration-300 group-hover:scale-x-100 group-data-[status=active]:scale-x-100" />
            </Link>
          ))}
        </nav>
      </div>

      {open && (
        <div className="animate-rise border-b border-white/10 bg-navy px-4 pb-5 lg:hidden">
          <div className="py-2.5">
            <SearchAutosuggest
              value={q}
              onChange={setQ}
              onSearch={(query) => {
                navigate({ to: "/shop", search: query ? { q: query } : {} });
                setQ("");
                setOpen(false);
              }}
              placeholder="Search S1 sugar, SKU or vendor…"
              variant="header"
              id="header-mobile-search"
            />
          </div>
          <div className="grid gap-1">
            {nav.map((n) => (
              <Link
                key={n.to}
                to={n.to}
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-2.5 text-sm font-medium text-white/85 hover:bg-white/5 hover:text-gold"
                activeProps={{ className: "text-gold bg-white/5" }}
              >
                {n.label}
              </Link>
            ))}
          </div>

          <div className="mt-4 border-t border-white/10 pt-3">
            {user ? (
              <div className="grid gap-1">
                <Link
                  to={user.role === "admin" ? "/admin/dashboard" : user.role === "vendor" ? "/vendor/dashboard" : "/account"}
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-gold hover:bg-white/5"
                >
                  <User className="h-4 w-4" /> {user.name} ({user.role})
                </Link>
                {user.role === "customer" && (
                  <Link
                    to="/account/orders"
                    onClick={() => setOpen(false)}
                    className="rounded-lg px-3 py-2 text-sm text-white/80 hover:bg-white/5"
                  >
                    My Orders
                  </Link>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <Link
                  to="/login"
                  onClick={() => setOpen(false)}
                  className="flex items-center justify-center gap-2 rounded-lg border border-white/20 py-2.5 text-center text-sm font-semibold text-white hover:border-gold hover:text-gold"
                >
                  <User className="h-4 w-4" /> Login
                </Link>
                <Link
                  to="/register"
                  onClick={() => setOpen(false)}
                  className="rounded-lg bg-gold py-2.5 text-center text-sm font-bold text-midnight hover:bg-gold-light"
                >
                  Register
                </Link>
              </div>
            )}
            <div className="mt-3 flex items-center justify-between px-3 pt-2">
              <span className="text-xs text-white/60">Language</span>
              <LanguageSwitcher light />
            </div>
          </div>
        </div>
      )}
    </header>
  );
}

function Badge({ count }: { count: number }) {
  return (
    <span className="absolute top-1 right-1 grid h-4 min-w-4 place-items-center rounded-full bg-gold px-1 text-[10px] font-bold text-midnight">
      {count}
    </span>
  );
}

/**
 * Live cart pill. Reads cartCount/subtotal straight from the store context, so it re-renders
 * the instant AddToCartPicker / cart quantity controls change the cart. Whenever the total
 * changes (after first paint) it replays a short "pop" + ring animation.
 */
function HeaderCartButton({ cartCount, subtotal }: { cartCount: number; subtotal: number }) {
  const [pulseKey, setPulseKey] = useState(0);
  const [direction, setDirection] = useState<"up" | "down">("up");
  const previous = useRef<{ subtotal: number; count: number } | null>(null);

  useEffect(() => {
    const prev = previous.current;
    previous.current = { subtotal, count: cartCount };
    // Skip the first render (and hydration from storage) — only animate real changes.
    if (!prev) return;
    if (prev.subtotal === subtotal && prev.count === cartCount) return;
    setDirection(subtotal >= prev.subtotal ? "up" : "down");
    setPulseKey((k) => k + 1);
  }, [subtotal, cartCount]);

  const itemsLabel = `${cartCount} ${cartCount === 1 ? "Item" : "Items"}`;
  const animate = pulseKey > 0;

  return (
    <Link
      to="/cart"
      className="group relative flex h-10 items-center gap-2 rounded-full border border-gold/70 bg-gradient-to-r from-midnight/90 via-navy/95 to-midnight/90 py-1 pl-2.5 pr-3 text-white shadow-[0_0_12px_rgba(234,179,8,0.35)] ring-1 ring-gold/40 transition-all duration-300 hover:scale-[1.02] hover:border-gold hover:shadow-[0_0_20px_rgba(234,179,8,0.6)] sm:gap-2.5 sm:px-3.5"
      aria-label={`Shopping cart, ${itemsLabel}, total ${inr(subtotal)}`}
    >
      <span className="relative flex shrink-0 items-center justify-center">
        {animate && (
          <span
            key={`ring-${pulseKey}`}
            aria-hidden
            className="animate-cart-ring pointer-events-none absolute inset-0 rounded-full border-2 border-amber-300"
          />
        )}
        <ShoppingCart
          key={`icon-${pulseKey}`}
          className={`h-5 w-5 text-amber-400 drop-shadow-xs transition-transform duration-300 group-hover:scale-110 ${animate ? "animate-cart-pop" : ""}`}
        />
        {cartCount > 0 && (
          <span
            key={`count-${pulseKey}`}
            className={`absolute -top-2 -right-2.5 flex h-4 min-w-[17px] items-center justify-center rounded-full bg-gradient-to-br from-amber-300 via-amber-400 to-yellow-500 px-1 text-[10px] font-black text-midnight shadow-md ring-1 ring-midnight/90 ${animate ? "animate-cart-pop" : ""}`}
          >
            {cartCount > 99 ? "99+" : cartCount}
          </span>
        )}
      </span>

      <span className="h-5 w-px bg-gradient-to-b from-transparent via-gold/50 to-transparent" aria-hidden />

      {/* Mobile: compact price pill */}
      <span
        key={`m-${pulseKey}`}
        className={`font-mono text-[12px] font-black leading-none tracking-tight text-gold-light drop-shadow-xs sm:hidden ${animate ? "animate-cart-pop" : ""}`}
      >
        {inr(subtotal)}
      </span>

      {/* Desktop: two-tier stack */}
      <span className="hidden flex-col text-left leading-tight sm:flex">
        <span className="text-[11px] font-bold leading-none tracking-wide text-white/95">{itemsLabel}</span>
        <span
          key={`d-${pulseKey}`}
          className={`origin-left font-mono text-[13px] font-black leading-tight tracking-tight text-gold-light drop-shadow-[0_0_6px_rgba(214,170,60,0.45)] ${animate ? "animate-cart-pop" : ""}`}
        >
          {inr(subtotal)}
        </span>
      </span>

      {animate && (
        <span
          key={`spark-${pulseKey}`}
          aria-hidden
          className="animate-cart-pop pointer-events-none absolute -top-1.5 -right-1 select-none text-xs"
        >
          {direction === "up" ? "✨" : ""}
        </span>
      )}
      <span className="sr-only" aria-live="polite">
        {animate ? `Cart updated: ${itemsLabel}, ${inr(subtotal)}` : ""}
      </span>
    </Link>
  );
}
