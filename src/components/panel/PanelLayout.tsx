import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Bell, LogOut, Menu, Search, X } from "lucide-react";
import { useState, useMemo, type ReactNode } from "react";
import { LogoMark } from "@/components/brand/Logo";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { LanguageSwitcher } from "@/components/site/LanguageSwitcher";

export type NavItem = {
  label: string;
  to: string;
  icon: React.ComponentType<{ className?: string }>;
};

export function PanelLayout({
  items,
  tone,
  title,
  subtitle,
  children,
}: {
  items: NavItem[];
  tone: "customer" | "vendor" | "admin";
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [globalQuery, setGlobalQuery] = useState("");
  const {
    user,
    logout,
    notifications,
    markRead,
    markAllRead,
    products,
    categories,
    customers,
    vendors,
    orders,
  } = useApp();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const relevantNotifs = useMemo(() => {
    return notifications.filter((n) => {
      if (tone === "admin") return n.role === "admin" || !n.role;
      if (tone === "vendor") return n.role === "vendor" || !n.role;
      return n.role === "customer" || !n.role;
    });
  }, [notifications, tone]);

  const unreadCount = useMemo(() => {
    return relevantNotifs.filter((n) => !n.read).length;
  }, [relevantNotifs]);

  const searchResults = useMemo(() => {
    const query = globalQuery.trim().toLowerCase();
    if (!query) return [];
    return [
      ...products
        .filter((item) => `${item.name} ${item.sku} ${item.category}`.toLowerCase().includes(query))
        .map((item) => ({
          label: item.name,
          detail: `${item.sku} · Product`,
          to: `/admin/products/${item.id}`,
        })),
      ...categories
        .filter((item) => item.name.toLowerCase().includes(query))
        .map((item) => ({ label: item.name, detail: "Category", to: "/admin/categories" })),
      ...customers
        .filter((item) => `${item.name} ${item.email} ${item.phone}`.toLowerCase().includes(query))
        .map((item) => ({
          label: item.name,
          detail: `${item.phone} · Customer`,
          to: `/admin/customers/${item.id}`,
        })),
      ...vendors
        .filter((item) =>
          `${item.business} ${item.owner} ${item.email} ${item.phone}`
            .toLowerCase()
            .includes(query),
        )
        .map((item) => ({
          label: item.business,
          detail: `${item.phone} · Vendor`,
          to: `/admin/vendors/${item.id}`,
        })),
      ...orders
        .filter((item) =>
          `${item.id} ${item.customer} ${item.phone} ${item.txn} ${item.utr ?? ""}`
            .toLowerCase()
            .includes(query),
        )
        .map((item) => ({
          label: item.id,
          detail: `${item.customer} · Order`,
          to: `/admin/orders/${item.id}`,
        })),
    ].slice(0, 8);
  }, [globalQuery, products, categories, customers, vendors, orders]);

  const sidebarBg =
    tone === "customer" ? "bg-navy" : tone === "vendor" ? "bg-midnight" : "bg-midnight";
  const pageBg = tone === "admin" ? "bg-[oklch(0.972_0.004_258)]" : "bg-panel";

  const sidebar = (
    <div className={cn("flex h-full w-64 flex-col", sidebarBg)}>
      <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
        <Link to="/" className="flex items-center">
          <LogoMark className="h-9 w-9 rounded-lg bg-white p-1.5 object-contain shadow-sm" />
          <span className="ml-2 text-sm font-extrabold tracking-wide text-white">GRAIN BAZAR</span>
        </Link>
        <button
          onClick={() => setOpen(false)}
          className="text-white/60 lg:hidden"
          aria-label="Close menu"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
      <p className="px-5 pt-5 pb-2 text-[11px] font-semibold tracking-[0.18em] text-gold uppercase">
        {tone} panel
      </p>
      <nav className="flex-1 space-y-1 overflow-y-auto px-3 pb-6">
        {items.map((item) => {
          const active = pathname === item.to;
          return (
            <Link
              key={item.to}
              to={item.to}
              onClick={() => setOpen(false)}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                active
                  ? "bg-white/10 text-gold shadow-[inset_3px_0_0_0_var(--gold)]"
                  : "text-white/70 hover:bg-white/5 hover:text-gold",
              )}
            >
              <item.icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{item.label}</span>
            </Link>
          );
        })}
        <button
          onClick={() => {
            logout();
            navigate({ to: "/" });
          }}
          className="mt-2 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-white/70 transition-colors hover:bg-white/5 hover:text-danger"
        >
          <LogOut className="h-4 w-4" /> Logout
        </button>
      </nav>
    </div>
  );

  return (
    <div className={cn("flex min-h-screen w-full", pageBg)}>
      <aside className="sticky top-0 hidden h-screen shrink-0 lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div className="animate-rise">{sidebar}</div>
          <button
            className="flex-1 bg-midnight/60"
            onClick={() => setOpen(false)}
            aria-label="Close"
          />
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 border-b border-border bg-card/90 backdrop-blur">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <button
                onClick={() => setOpen(true)}
                className="text-navy lg:hidden"
                aria-label="Open menu"
              >
                <Menu className="h-5 w-5" />
              </button>
              <div className="min-w-0">
                <h1 className="truncate text-lg font-bold text-navy sm:text-xl">{title}</h1>
                {subtitle && <p className="truncate text-xs text-slate">{subtitle}</p>}
              </div>
            </div>
            <div className="flex items-center gap-2 sm:gap-3">
              <LanguageSwitcher />
              <div className="relative hidden md:block">
                <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate" />
                <Input
                  placeholder="Search products, people, orders…"
                  value={globalQuery}
                  onChange={(event) => setGlobalQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && searchResults[0]) {
                      navigate({ to: searchResults[0].to as never });
                      setGlobalQuery("");
                    }
                    if (event.key === "Escape") setGlobalQuery("");
                  }}
                  className="h-9 w-56 pl-9"
                />
                {searchResults.length > 0 && (
                  <div className="absolute right-0 top-full z-50 mt-1 max-h-80 w-72 overflow-auto rounded-lg border border-border bg-card shadow-xl">
                    {searchResults.map((result) => (
                      <button
                        key={`${result.to}-${result.label}`}
                        type="button"
                        onClick={() => {
                          navigate({ to: result.to as never });
                          setGlobalQuery("");
                        }}
                        className="flex w-full items-center justify-between gap-3 border-b border-border/60 px-3 py-2 text-left last:border-0 hover:bg-ivory"
                      >
                        <span className="truncate text-sm font-medium text-navy">
                          {result.label}
                        </span>
                        <span className="shrink-0 text-[10px] text-slate">{result.detail}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setNotifOpen((v) => !v)}
                  className={cn(
                    "relative rounded-full border border-border p-2 text-navy transition-colors hover:border-gold hover:text-gold",
                    notifOpen && "border-gold text-gold bg-gold/10",
                  )}
                  aria-label="Notifications"
                >
                  <Bell className="h-4 w-4" />
                  {unreadCount > 0 && (
                    <span className="absolute -top-1 -right-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-gold px-1 text-[9px] font-black text-midnight shadow-xs ring-1 ring-white">
                      {unreadCount > 9 ? "9+" : unreadCount}
                    </span>
                  )}
                </button>

                {notifOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-40"
                      onClick={() => setNotifOpen(false)}
                      aria-hidden="true"
                    />
                    <div className="absolute right-0 top-full mt-2 w-80 sm:w-96 rounded-xl border border-border bg-card shadow-2xl z-50 overflow-hidden animate-rise">
                      <div className="flex items-center justify-between border-b border-border bg-ivory/60 px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold text-navy">Notifications</span>
                          {unreadCount > 0 && (
                            <span className="rounded-full bg-gold/20 px-2 py-0.5 text-[10px] font-bold text-navy">
                              {unreadCount} new
                            </span>
                          )}
                        </div>
                        {unreadCount > 0 && (
                          <button
                            type="button"
                            onClick={() => markAllRead()}
                            className="text-xs font-semibold text-gold hover:text-navy hover:underline transition-colors"
                          >
                            Mark all as read
                          </button>
                        )}
                      </div>

                      <div className="max-h-[360px] overflow-y-auto divide-y divide-border/60">
                        {relevantNotifs.length === 0 ? (
                          <div className="p-6 text-center text-xs text-slate">
                            No notifications right now
                          </div>
                        ) : (
                          relevantNotifs.slice(0, 6).map((n) => (
                            <div
                              key={n.id}
                              onClick={() => {
                                markRead(n.id);
                                if (tone === "admin") {
                                  if (n.body.includes("ORD-")) {
                                    setNotifOpen(false);
                                    navigate({ to: "/admin/orders" });
                                  } else if (n.title.toLowerCase().includes("vendor")) {
                                    setNotifOpen(false);
                                    navigate({ to: "/admin/vendors" });
                                  } else if (n.title.toLowerCase().includes("stock")) {
                                    setNotifOpen(false);
                                    navigate({ to: "/admin/inventory" });
                                  }
                                }
                              }}
                              className={cn(
                                "flex items-start gap-3 p-3.5 transition-colors cursor-pointer hover:bg-ivory/80",
                                !n.read && "bg-amber-50/40",
                              )}
                            >
                              <div
                                className={cn(
                                  "mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold",
                                  n.type === "success" && "bg-emerald-100 text-emerald-700",
                                  n.type === "warning" && "bg-amber-100 text-amber-700",
                                  n.type === "info" && "bg-blue-100 text-blue-700",
                                )}
                              >
                                {n.type === "success" ? "✓" : n.type === "warning" ? "!" : "i"}
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center justify-between gap-1">
                                  <p
                                    className={cn(
                                      "text-xs leading-tight text-navy",
                                      !n.read ? "font-bold" : "font-semibold",
                                    )}
                                  >
                                    {n.title}
                                  </p>
                                  <span className="text-[10px] text-slate shrink-0">{n.time}</span>
                                </div>
                                <p className="mt-1 line-clamp-2 text-[11px] text-slate leading-normal">
                                  {n.body}
                                </p>
                              </div>
                              {!n.read && (
                                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-gold" />
                              )}
                            </div>
                          ))
                        )}
                      </div>

                      <div className="border-t border-border bg-ivory/40 p-2.5 text-center">
                        <Link
                          to={
                            tone === "admin"
                              ? "/admin/notifications"
                              : tone === "vendor"
                                ? "/vendor/dashboard"
                                : "/account/notifications"
                          }
                          onClick={() => setNotifOpen(false)}
                          className="block text-xs font-bold text-navy hover:text-gold transition-colors py-1"
                        >
                          {tone === "admin"
                            ? "View All Notifications →"
                            : "View Notification Centre →"}
                        </Link>
                      </div>
                    </div>
                  </>
                )}
              </div>
              <div className="flex items-center gap-2 rounded-full border border-border py-1 pr-3 pl-1">
                <span className="grid h-7 w-7 place-items-center rounded-full bg-navy text-[11px] font-bold text-white">
                  {(user?.name ?? tone).slice(0, 2).toUpperCase()}
                </span>
                <span className="hidden text-xs font-semibold text-navy sm:inline">
                  {user?.name ?? `Demo ${tone}`}
                </span>
              </div>
            </div>
          </div>
        </header>
        <main className="min-w-0 flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
