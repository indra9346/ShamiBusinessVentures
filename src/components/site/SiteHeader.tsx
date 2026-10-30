import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Heart, Menu, Search, ShoppingCart, User, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Logo } from "@/components/brand/Logo";
import { useApp } from "@/lib/store";
import { Input } from "@/components/ui/input";
import { inr, isStorefrontProduct } from "@/lib/data";
import { LanguageSwitcher } from "@/components/site/LanguageSwitcher";

import { SearchAutosuggest } from "@/components/site/SearchAutosuggest";
import { HeaderCrackers, HeaderZari } from "@/components/site/DiwaliDecor";
import { useFestiveTheme } from "@/lib/festive";

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
  const festive = useFestiveTheme();
  // The festival decorations are for the home page only.
  const onHome = useRouterState({ select: (state) => state.location.pathname === "/" });
  const festiveHere = festive.on && onHome;

  return (
    <header className="sticky top-0 z-50 w-full">
      {/* With the festival crackers playing the header is solid (no live blur under a moving video). */}
      <div className={`relative isolate border-b border-white/10 ${festiveHere ? "bg-navy" : "bg-navy/95 backdrop-blur-md"}`}>
        {festiveHere && <><HeaderCrackers /><HeaderZari /></>}
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

          <div className="flex items-center gap-1 sm:gap-2">
            <LanguageSwitcher light compact className="sm:hidden" />
            <LanguageSwitcher light className="hidden sm:inline-flex" />
            <Link
              to="/wishlist"
              className="relative flex h-9 w-9 items-center justify-center rounded-full text-white transition-colors hover:text-gold sm:h-10 sm:w-10"
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
              className="flex h-9 w-9 items-center justify-center rounded-full text-white transition-colors hover:text-gold sm:h-10 sm:w-10 lg:hidden"
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
  const previous = useRef<{ subtotal: number; count: number } | null>(null);

  useEffect(() => {
    const prev = previous.current;
    previous.current = { subtotal, count: cartCount };
    // Skip the first render (and hydration from storage) — only animate real changes.
    if (!prev) return;
    if (prev.subtotal === subtotal && prev.count === cartCount) return;
    setPulseKey((k) => k + 1);
  }, [subtotal, cartCount]);

  const itemsLabel = `${cartCount} ${cartCount === 1 ? "Item" : "Items"}`;
  const animate = pulseKey > 0;

  return (
    <Link
      to="/cart"
      className="group relative flex h-9 w-9 items-center justify-center rounded-full border border-gold/50 bg-white/5 text-white transition-colors duration-200 hover:border-gold hover:bg-white/10 sm:h-10 sm:w-auto sm:gap-2 sm:px-3.5"
      aria-label={`Shopping cart, ${itemsLabel}, total ${inr(subtotal)}`}
    >
      <span className="relative flex shrink-0 items-center justify-center">
        {animate && (
          <span
            key={`ring-${pulseKey}`}
            aria-hidden
            className="animate-cart-ring pointer-events-none absolute inset-0 rounded-full border-2 border-gold/70"
          />
        )}
        <ShoppingCart
          key={`icon-${pulseKey}`}
          className={`h-[18px] w-[18px] text-gold transition-transform duration-300 group-hover:scale-110 sm:h-5 sm:w-5 ${animate ? "animate-cart-pop" : ""}`}
        />
        {cartCount > 0 && (
          <span
            key={`count-${pulseKey}`}
            className={`absolute -top-2 -right-2.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-gold px-1 text-[10px] font-bold leading-none text-midnight ring-2 ring-navy ${animate ? "animate-cart-pop" : ""}`}
          >
            {cartCount > 99 ? "99+" : cartCount}
          </span>
        )}
      </span>

      {/* Tablet & desktop: total next to the icon (phones see it in the bottom cart bar) */}
      <span
        key={`d-${pulseKey}`}
        className={`hidden origin-left pl-1 text-sm font-bold tabular-nums text-gold-light sm:inline ${animate ? "animate-cart-pop" : ""}`}
      >
        {inr(subtotal)}
      </span>

      <span className="sr-only" aria-live="polite">
        {animate ? `Cart updated: ${itemsLabel}, ${inr(subtotal)}` : ""}
      </span>
    </Link>
  );
}
