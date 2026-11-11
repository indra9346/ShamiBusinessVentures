// Offering "install Grain Bazar" on a phone. There is deliberately no service worker: this site changes prices, stock
// and code often, and a service worker can keep serving an old copy. Chrome no longer needs one to offer an install.
// No imports, so the tests can load it directly.

export const INSTALL_DISMISSED_KEY = "gb-install-offer-dismissed";

/** Browsing pages only: never while someone is buying, signing in, or working in a panel. */
const OFFER_PREFIXES = ["/shop", "/categories", "/product", "/about", "/contact"];

export function showsInstallOffer(pathname: string): boolean {
  if (pathname === "/") return true;
  return OFFER_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
