const STOREFRONT_PREFIXES = ["/", "/shop", "/cart", "/checkout", "/account", "/wishlist", "/product", "/categories", "/about", "/contact", "/login", "/register"];

export function isStorefrontPath(pathname: string) {
  if (pathname.startsWith("/admin") || pathname.startsWith("/vendor")) return false;
  return STOREFRONT_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(`${prefix}?`));
}

export function registerStorefrontServiceWorker() {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  if (import.meta.env.DEV) return;
  if (!isStorefrontPath(window.location.pathname)) return;
  void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
    /* install can fail on unsupported hosts */
  });
}
