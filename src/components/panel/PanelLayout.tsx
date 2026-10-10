import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { AlertTriangle, Bell, LogOut, Menu, RefreshCw, Search, X } from "lucide-react";
import { useState, useMemo, useEffect, type ReactNode } from "react";
import { LogoMark } from "@/components/brand/Logo";
import { useApp } from "@/lib/store";
import { isStorefrontProduct } from "@/lib/data";
import { orderBelongsToUser } from "@/lib/account-identity";
import { cn } from "@/lib/utils";
import { notificationTarget } from "@/lib/notification-target";
import { notificationBelongsToUser } from "@/lib/account-identity";
import { Input } from "@/components/ui/input";
import { LanguageSwitcher } from "@/components/site/LanguageSwitcher";
import { supabase } from "@/integrations/supabase/client";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";

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
    hydrated,
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
  const [verifiedRole, setVerifiedRole] = useState(false);
  const [roleCheckError, setRoleCheckError] = useState("");
  const [verificationAttempt, setVerificationAttempt] = useState(0);
  const [adminIdleTimeoutMinutes, setAdminIdleTimeoutMinutes] = useState(30);

  useEffect(() => {
    if (tone !== "admin" || STATIC_DATA_MODE) return;
    let active = true;
    void supabase
      .from("settings")
      .select("value")
      .eq("key", "security_config")
      .maybeSingle()
      .then(({ data, error }) => {
        if (!active || error) return;
        const config =
          data?.value && typeof data.value === "object" && !Array.isArray(data.value)
            ? (data.value as Record<string, unknown>)
            : {};
        const rawAutoLogout = config["autoLogout"];
        const rawSessionHours = config["session_hours"];
        let configured: number | null = null;
        if (rawAutoLogout !== null && rawAutoLogout !== undefined && rawAutoLogout !== "") {
          const num = Number(rawAutoLogout);
          if (Number.isFinite(num)) configured = num;
        } else if (
          rawSessionHours !== null &&
          rawSessionHours !== undefined &&
          rawSessionHours !== ""
        ) {
          const hours = Number(rawSessionHours);
          if (Number.isFinite(hours) && hours > 0) configured = hours * 60;
        }
        if (configured !== null && Number.isFinite(configured) && configured >= 5) {
          setAdminIdleTimeoutMinutes(Math.min(1440, configured));
        }
      });
    const applySavedTimeout = (event: Event) => {
      const value = Number((event as CustomEvent<number>).detail);
      if (Number.isFinite(value) && value >= 5) setAdminIdleTimeoutMinutes(Math.min(1440, value));
    };
    window.addEventListener("admin-idle-timeout-updated", applySavedTimeout);
    return () => {
      active = false;
      window.removeEventListener("admin-idle-timeout-updated", applySavedTimeout);
    };
  }, [tone]);

  useEffect(() => {
    if (tone !== "admin" || !user?.id || !verifiedRole || typeof window === "undefined") return;
    const key = `shami-admin-last-activity:${user.id}`;
    const timeoutMs = adminIdleTimeoutMinutes * 60_000;
    if (!localStorage.getItem(key)) localStorage.setItem(key, String(Date.now()));
    let signingOut = false;
    const recordActivity = () => {
      localStorage.setItem(key, String(Date.now()));
    };
    const expireIfIdle = () => {
      if (document.visibilityState !== "visible") return;
      const lastActivity = Number(localStorage.getItem(key) ?? 0);
      if (signingOut || !lastActivity || Date.now() - lastActivity < timeoutMs) return;
      signingOut = true;
      void supabase.auth.signOut().finally(() => {
        localStorage.removeItem(key);
        logout();
        navigate({ to: "/admin/login", replace: true });
      });
    };
    const activityEvents = ["pointerdown", "keydown", "scroll", "touchstart"] as const;
    for (const eventName of activityEvents)
      window.addEventListener(eventName, recordActivity, { passive: true });
    const storageListener = (event: StorageEvent) => {
      if (event.key === key) expireIfIdle();
    };
    window.addEventListener("storage", storageListener);
    const interval = window.setInterval(expireIfIdle, 15_000);
    const handleVisibilityChange = () => {
      // Switching to another browser tab is not activity in this tab. Reset the
      // idle clock when the administrator returns so the tab switch itself
      // cannot unexpectedly end an otherwise valid admin session.
      if (document.visibilityState === "visible") recordActivity();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    expireIfIdle();
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("storage", storageListener);
      for (const eventName of activityEvents) window.removeEventListener(eventName, recordActivity);
    };
  }, [tone, user?.id, verifiedRole, adminIdleTimeoutMinutes, logout, navigate]);

  useEffect(() => {
    let active = true;
    setVerifiedRole(false);
    setRoleCheckError("");
    if (!hydrated)
      return () => {
        active = false;
      };
    if (STATIC_DATA_MODE) {
      if (user?.role === tone) setVerifiedRole(true);
      else
        navigate({
          to: tone === "admin" ? "/admin/login" : tone === "vendor" ? "/vendor/login" : "/login",
          replace: true,
        });
      return () => {
        active = false;
      };
    }
    void (async () => {
      const {
        data: { user: authUser },
        error: authError,
      } = await supabase.auth.getUser();
      if (authError) {
        if (active)
          setRoleCheckError(
            "We could not verify your sign-in right now. Your session has been kept; try again when your connection is available.",
          );
        return;
      }
      if (!authUser) {
        if (active) {
          navigate({
            to: tone === "admin" ? "/admin/login" : tone === "vendor" ? "/vendor/login" : "/login",
            replace: true,
          });
        }
        return;
      }
      const { data: roleRecord, error } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", authUser.id)
        .eq("role", tone)
        .maybeSingle();
      if (!active) return;
      if (error) {
        setRoleCheckError(
          "We could not confirm this account’s panel access. Your sign-in has been kept; try again when your connection is available.",
        );
        return;
      }
      if (!roleRecord) {
        await supabase.auth.signOut();
        logout();
        navigate({
          to: tone === "admin" ? "/admin/login" : tone === "vendor" ? "/vendor/login" : "/login",
          replace: true,
        });
        return;
      }
      setVerifiedRole(true);
    })().catch(() => {
      if (active) {
        setRoleCheckError(
          "We could not verify your sign-in. Your session has been kept; retry the access check.",
        );
      }
    });
    return () => {
      active = false;
    };
  }, [hydrated, tone, logout, navigate, verificationAttempt]);

  const relevantNotifs = useMemo(() => {
    return notifications.filter((n) => {
      if (tone === "admin") return n.role === "admin" || !n.role;
      if (tone === "vendor") return n.role === "vendor" || !n.role;
      return (n.role === "customer" || !n.role) && (Boolean(n.databaseId) || notificationBelongsToUser(n, user, orders));
    });
  }, [notifications, tone, user, orders]);

  const unreadCount = useMemo(() => {
    return relevantNotifs.filter((n) => !n.read).length;
  }, [relevantNotifs]);

  const searchResults = useMemo(() => {
    const query = globalQuery.trim().toLowerCase();
    if (!query) return [];
    const vendor = vendors.find((item) => item.email.toLowerCase() === user?.email.toLowerCase());
    const availableProducts = tone === "vendor"
      ? products.filter((item) => item.vendorId === vendor?.id || item.vendor === vendor?.business)
      : tone === "customer" ? products.filter(isStorefrontProduct) : products;
    const availableOrders = tone === "admin"
      ? orders
      : tone === "vendor"
        ? orders.filter((item) => item.items.some((line) => line.vendorId === vendor?.id))
        : orders.filter((item) => orderBelongsToUser(item, user));
    return [
      ...availableProducts
        .filter((item) => `${item.name} ${item.sku} ${item.category} ${item.vendor}`.toLowerCase().includes(query))
        .map((item) => ({
          label: item.name,
          detail: `${item.sku} · Product`,
          to: tone === "admin" ? `/admin/products/${item.id}` : tone === "vendor" ? `/vendor/products?q=${encodeURIComponent(query)}` : `/shop?q=${encodeURIComponent(query)}`,
        })),
      ...(tone === "admin" ? categories : [])
        .filter((item) => item.name.toLowerCase().includes(query))
        .map((item) => ({ label: item.name, detail: "Category", to: "/admin/categories" })),
      ...(tone === "admin" ? customers : [])
        .filter((item) => `${item.name} ${item.email} ${item.phone}`.toLowerCase().includes(query))
        .map((item) => ({
          label: item.name,
          detail: `${item.phone} · Customer`,
          to: `/admin/customers/${item.id}`,
        })),
      ...(tone === "admin" ? vendors : [])
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
      ...availableOrders
        .filter((item) => {
          const searchable = tone === "admin"
            ? `${item.id} ${item.customer} ${item.phone} ${item.txn} ${item.utr ?? ""} ${item.status} ${item.payment}`
            : `${item.id} ${item.customer} ${item.status} ${item.items.filter((line) => tone !== "vendor" || line.vendorId === vendor?.id).map((line) => `${line.product.name} ${line.product.sku}`).join(" ")}`;
          return searchable.toLowerCase().includes(query);
        })
        .map((item) => ({
          label: item.id,
          detail: `${item.customer} · Order`,
          to: tone === "admin" ? `/admin/orders/${item.id}` : tone === "vendor" ? `/vendor/orders?q=${encodeURIComponent(query)}` : `/account/orders?q=${encodeURIComponent(query)}`,
        })),
    ].slice(0, 8);
  }, [globalQuery, products, categories, customers, vendors, orders, tone, user]);

  // Keep hooks above this guard. React requires the same hooks on the initial
  // loading render and on the later authenticated render.
  if (!hydrated || !verifiedRole) {
    return (
      <div className="grid min-h-screen place-items-center bg-panel p-6 text-sm text-slate">
        {roleCheckError ? (
          <div
            role="alert"
            className="max-w-md rounded-lg border border-amber-200 bg-white p-6 text-center shadow-card"
          >
            <AlertTriangle className="mx-auto h-8 w-8 text-amber-600" />
            <p className="mt-3 font-semibold text-navy">
              Administrator access could not be checked
            </p>
            <p className="mt-2 leading-relaxed">{roleCheckError}</p>
            <button
              type="button"
              onClick={() => setVerificationAttempt((attempt) => attempt + 1)}
              className="mt-4 inline-flex items-center gap-2 rounded-md bg-navy px-4 py-2 font-medium text-white hover:bg-navy/90"
            >
              <RefreshCw className="h-4 w-4" /> Try again
            </button>
          </div>
        ) : (
          <div className="inline-flex items-center gap-2">
            <RefreshCw className="h-4 w-4 animate-spin" /> Checking your secure sign-in…
          </div>
        )}
      </div>
    );
  }

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
          onClick={async () => {
            await supabase.auth.signOut();
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
                  placeholder={tone === "admin" ? "Search products, people, orders…" : tone === "vendor" ? "Search my products and orders…" : "Search products and my orders…"}
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
                            <button
                              key={n.id}
                              type="button"
                              onClick={() => {
                                markRead(n.id);
                                setNotifOpen(false);
                                const target = notificationTarget(n, tone, user, orders);
                                navigate({ to: target as never });
                              }}
                              className={cn(
                                "flex w-full items-start gap-3 p-3.5 text-left transition-colors hover:bg-ivory/80",
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
                            </button>
                          ))
                        )}
                      </div>

                      <div className="border-t border-border bg-ivory/40 p-2.5 text-center">
                        <Link
                          to={
                            tone === "admin"
                              ? "/admin/notifications"
                              : tone === "vendor"
                                ? "/vendor/notifications"
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
