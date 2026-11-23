import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronDown, KeyRound, LogOut, UserRound } from "lucide-react";
import type { SessionUser } from "@/lib/store";
import { cn } from "@/lib/utils";

type Tone = "customer" | "vendor" | "admin";

const ROLE_LABEL: Record<Tone, string> = { admin: "Administrator", vendor: "Vendor", customer: "Customer" };
const PROFILE_PATH = { admin: "/admin/profile", vendor: "/vendor/profile", customer: "/account/profile" } as const;

/**
 * The round initials button at the top right of every panel: who is signed in, their profile, a password change and
 * Log out, in one small menu. Closes on a tap outside, on Escape and after choosing.
 */
export function AccountMenu({ tone, user, onSignOut }: { tone: Tone; user: SessionUser | null; onSignOut: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const name = user?.name || `Demo ${tone}`;
  const initials = name.trim().split(/\s+/).map((part) => part[0] ?? "").join("").slice(0, 2).toUpperCase() || tone.slice(0, 2).toUpperCase();

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => { if (box.current && !box.current.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const signOut = async () => {
    setSigningOut(true);
    try { await onSignOut(); } finally { setSigningOut(false); setOpen(false); }
  };

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className={cn("flex items-center gap-2 rounded-full border border-border py-1 pr-1 pl-1 transition-colors hover:border-gold sm:pr-2", open && "border-gold")}
      >
        <span className="grid h-7 w-7 place-items-center rounded-full bg-navy text-[11px] font-bold text-white">{initials}</span>
        <span className="hidden max-w-[10rem] truncate text-xs font-semibold text-navy sm:inline">{name}</span>
        <ChevronDown className={cn("hidden h-3.5 w-3.5 text-slate transition-transform sm:block", open && "rotate-180")} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-50 mt-2 w-[min(18rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border bg-card shadow-xl">
          <div className="flex items-center gap-3 border-b border-border bg-ivory/50 px-4 py-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-navy text-sm font-bold text-white">{initials}</span>
            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-navy">{name}</p>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-gold">{ROLE_LABEL[tone]}</p>
              {user?.email && <p className="truncate text-xs text-slate">{user.email}</p>}
            </div>
          </div>
          <div className="p-1.5">
            <Link to={PROFILE_PATH[tone]} role="menuitem" onClick={() => setOpen(false)}
              className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-charcoal hover:bg-ivory">
              <UserRound className="h-4 w-4 text-gold" /> My profile
            </Link>
            {/* Customers sign in with a one-time code, so they have no password to change. */}
            {tone !== "customer" && (
              <Link to="/reset-password" role="menuitem" onClick={() => setOpen(false)}
                className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-charcoal hover:bg-ivory">
                <KeyRound className="h-4 w-4 text-gold" /> Change password
              </Link>
            )}
          </div>
          <div className="border-t border-border p-1.5">
            <button type="button" role="menuitem" disabled={signingOut} onClick={() => void signOut()}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-semibold text-danger hover:bg-red-50 disabled:opacity-60">
              <LogOut className="h-4 w-4" /> {signingOut ? "Logging out…" : "Log out"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
