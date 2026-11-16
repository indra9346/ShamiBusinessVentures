import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { ChevronsLeft, ChevronsRight, LogOut, Menu, RefreshCw, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { BrandLogo, LogoMark } from "@/components/brand/Logo";
import { FavouriteToggle, FavouritesBar, FavouritesNav, PanelSearch } from "@/components/panel/PanelSearch";
import { useLiveRefresh } from "@/components/partners/PartnerWidgets";
import { LanguageSwitcher } from "@/components/site/LanguageSwitcher";
import { supabase } from "@/integrations/supabase/client";
import { activeNavTarget } from "@/lib/panel-menu";
import { partnerNav } from "@/lib/panel-nav";
import { asMonthStatement, type MonthStatement } from "@/lib/partner-month";
import { monthStart } from "@/lib/partners";
import { cn } from "@/lib/utils";

export type PartnerMe = { id: string; name: string; branchId: string; godown: string; signaturePath: string | null };

type PartnerContextValue = {
  me: PartnerMe;
  month: string;
  setMonth: (month: string) => void;
  /** The chosen month's profit-share statement, or null when the godown is on per-unit commission that month. */
  statement: MonthStatement | null;
};

const PartnerContext = createContext<PartnerContextValue | null>(null);

/** The signed-in channel partner, the chosen month and its statement, for every page inside the partner panel. */
export function usePartner(): PartnerContextValue {
  const value = useContext(PartnerContext);
  if (!value) throw new Error("usePartner is used outside the partner panel");
  return value;
}

/** Pages whose figures follow the chosen month: the month box shows on these only. */
const MONTH_PAGES = new Set(["/partner", "/partner/income", "/partner/commissions", "/partner/leaderboard"]);
const COLLAPSED_KEY = "gb-partner-sidebar-collapsed";

/**
 * The channel partner's panel (owner, 16 Nov 2026: "need same left pages panel like admin"): the admin panel's dark side
 * menu (folds to icons on a computer, opens from the menu button on a phone) and a header with the page's title, search,
 * language and the month; each part of the old long page is its own page. Only an active channel partner stays: anyone
 * else goes to the partner sign-in, as before. The sign-in page itself is shown as it is.
 */
export function PartnerLayout() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isLogin = pathname.replace(/\/+$/, "") === "/partner/login";
  const [me, setMe] = useState<PartnerMe | null>(null);
  const [month, setMonth] = useState(monthStart());
  const [statement, setStatement] = useState<MonthStatement | null>(null);
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    try { return localStorage.getItem(COLLAPSED_KEY) === "1"; } catch { return false; }
  });
  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0"); } catch { /* storage blocked */ }
  };

  // Only an active partner may stay here; anyone else goes to the partner login.
  useEffect(() => {
    if (isLogin) return;
    let stop = false;
    void (async () => {
      const { data: session } = await supabase.auth.getSession();
      const userId = session.session?.user.id;
      if (!userId) { navigate({ to: "/partner/login", replace: true }); return; }
      const { data: partner } = await supabase.from("channel_partners").select("id,name,branch_id,status").eq("user_id", userId).maybeSingle();
      if (!partner || partner.status !== "active") { await supabase.auth.signOut({ scope: "local" }); navigate({ to: "/partner/login", replace: true }); return; }
      // Read on its own: a database without the column yet must not sign the partner out.
      const [{ data: branch }, { data: signed }] = await Promise.all([
        supabase.from("branches").select("name").eq("id", partner.branch_id).maybeSingle(),
        supabase.from("channel_partners").select("signature_path").eq("id", partner.id).maybeSingle(),
      ]);
      if (stop) return;
      setMe({ id: partner.id, name: partner.name, branchId: partner.branch_id, godown: branch?.name ?? partner.branch_id, signaturePath: signed?.signature_path ?? null });
    })();
    return () => { stop = true; };
  }, [isLogin, navigate]);

  // The month's statement, read again every 30 seconds as the figures change.
  const loadStatement = useCallback(async () => {
    if (!me) return;
    const { data, error } = await supabase.rpc("partner_month_statement", { _month: month });
    setStatement(error ? null : asMonthStatement(data));
  }, [me, month]);
  useLiveRefresh(loadStatement, [loadStatement]);

  // A new page starts at its top, with the phone menu shut.
  useEffect(() => { setOpen(false); }, [pathname]);

  if (isLogin) return <Outlet />;
  if (!me) {
    return <div className="grid min-h-screen place-items-center bg-panel text-sm text-slate"><span className="inline-flex items-center gap-2"><RefreshCw className="h-4 w-4 animate-spin" /> Opening your dashboard…</span></div>;
  }

  const activeTo = activeNavTarget(pathname, partnerNav);
  const title = partnerNav.find((item) => item.to === activeTo)?.label ?? "Dashboard";
  const signOut = async () => { await supabase.auth.signOut({ scope: "local" }); navigate({ to: "/partner/login" }); };

  const renderSidebar = (rail: boolean) => (
    <div className={cn("flex h-full flex-col bg-midnight transition-[width] duration-200 ease-out", rail ? "w-[88px]" : "w-64")}>
      <div className={cn("flex items-center gap-2 border-b border-white/10 py-4", rail ? "justify-center px-2" : "justify-between px-4")}>
        <Link to="/partner" className="flex min-w-0 items-center" title="Grain Bazar" aria-label="Partner dashboard">
          {rail ? <LogoMark onDark className="h-11 w-11" /> : <BrandLogo shape="wide" onDark eager className="h-10 w-auto" sizes="187px" />}
        </Link>
        <button type="button" onClick={() => setOpen(false)} className="text-white/60 lg:hidden" aria-label="Close menu">
          <X className="h-5 w-5" />
        </button>
      </div>
      {!rail && (
        <div className="px-5 pt-5 pb-2">
          <p className="text-[11px] font-semibold tracking-[0.18em] text-gold uppercase">Partner panel</p>
          <p className="mt-1 truncate text-xs text-white/60">{me.godown}</p>
        </div>
      )}
      <nav className={cn("flex-1 overflow-x-hidden overflow-y-auto pb-6", rail ? "space-y-0.5 px-1 pt-3 [scrollbar-width:thin]" : "space-y-1 px-3")}>
        <FavouritesNav panel="partner" rail={rail} onPick={() => setOpen(false)} />
        {partnerNav.map((item) => {
          const active = item.to === activeTo;
          return (
            <Link
              key={item.to}
              to={item.to}
              data-nav-active={active ? "" : undefined}
              onClick={() => setOpen(false)}
              title={rail ? item.label : undefined}
              aria-label={rail ? item.label : undefined}
              className={cn(
                "rounded-lg font-medium transition-colors",
                rail ? "flex flex-col items-center gap-1 px-0.5 py-2 text-[10px] leading-tight" : "flex items-center gap-3 px-3 py-2.5 text-sm",
                active
                  ? rail ? "bg-white/10 text-gold" : "bg-white/10 text-gold shadow-[inset_3px_0_0_0_var(--gold)]"
                  : "text-white/70 hover:bg-white/5 hover:text-gold",
              )}
            >
              <item.icon className={cn("shrink-0", rail ? "h-5 w-5" : "h-4 w-4")} />
              <span className={cn(rail ? "line-clamp-2 w-full text-center" : "truncate")}>{item.label}</span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => void signOut()}
          title={rail ? "Sign out" : undefined}
          className={cn(
            "mt-2 w-full rounded-lg font-medium text-white/70 transition-colors hover:bg-white/5 hover:text-danger",
            rail ? "flex flex-col items-center gap-1 px-1 py-2 text-[10px]" : "flex items-center gap-3 px-3 py-2.5 text-sm",
          )}
        >
          <LogOut className={rail ? "h-5 w-5" : "h-4 w-4"} /> Sign out
        </button>
      </nav>
      <button
        type="button"
        onClick={toggleCollapsed}
        title={rail ? "Expand menu" : "Collapse menu"}
        aria-label={rail ? "Expand menu" : "Collapse menu"}
        aria-expanded={!rail}
        className={cn(
          "hidden items-center border-t border-white/10 py-3 text-white/60 transition-colors hover:bg-white/5 hover:text-gold lg:flex",
          rail ? "justify-center" : "justify-end gap-2 px-5 text-xs font-medium",
        )}
      >
        {rail ? <ChevronsRight className="h-5 w-5" /> : <>Collapse <ChevronsLeft className="h-4 w-4" /></>}
      </button>
    </div>
  );

  return (
    <PartnerContext.Provider value={{ me, month, setMonth, statement }}>
      <div className="flex min-h-screen w-full bg-[oklch(0.972_0.004_258)]">
        <aside className="sticky top-0 hidden h-screen shrink-0 lg:block">{renderSidebar(collapsed)}</aside>
        {open && (
          <div className="fixed inset-0 z-50 flex lg:hidden">
            <div className="animate-rise">{renderSidebar(false)}</div>
            <button type="button" className="flex-1 bg-midnight/60" onClick={() => setOpen(false)} aria-label="Close" />
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-40 border-b border-border bg-card/90 backdrop-blur">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 sm:px-6">
              <div className="flex min-w-0 items-center gap-3">
                <button type="button" onClick={() => setOpen(true)} className="text-navy lg:hidden" aria-label="Open menu">
                  <Menu className="h-5 w-5" />
                </button>
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-1">
                    <h1 className="truncate text-lg font-bold text-navy sm:text-xl">{title}</h1>
                    <FavouriteToggle panel="partner" label={title} />
                  </div>
                  <p className="truncate text-xs text-slate">{me.name} · {me.godown}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 sm:gap-3">
                {MONTH_PAGES.has(activeTo ?? "") && (
                  <input type="month" value={month.slice(0, 7)} max={monthStart().slice(0, 7)}
                    onChange={(event) => event.target.value && setMonth(`${event.target.value}-01`)}
                    className="hidden h-9 rounded-md border border-input bg-white px-2 text-sm sm:block" aria-label="Month" />
                )}
                <LanguageSwitcher compact className="sm:hidden" />
                <LanguageSwitcher className="hidden sm:inline-flex" />
                <PanelSearch panel="partner" />
              </div>
            </div>
            {MONTH_PAGES.has(activeTo ?? "") && (
              <div className="border-t border-border px-4 py-2 sm:hidden">
                <input type="month" value={month.slice(0, 7)} max={monthStart().slice(0, 7)}
                  onChange={(event) => event.target.value && setMonth(`${event.target.value}-01`)}
                  className="h-9 w-full rounded-md border border-input bg-white px-2 text-sm" aria-label="Month" />
              </div>
            )}
          </header>
          <main className="mx-auto w-full max-w-6xl flex-1 space-y-6 px-4 py-6 sm:px-6">
            <FavouritesBar panel="partner" />
            <Outlet />
          </main>
        </div>
      </div>
    </PartnerContext.Provider>
  );
}
