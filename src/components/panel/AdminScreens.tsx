import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { LogOut, MonitorSmartphone, RefreshCw, Save } from "lucide-react";
import { Panel } from "@/components/panel/widgets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import {
  ADMIN_SCREENS_KEY,
  ADMIN_SCREENS_MAX,
  openAdminScreens,
  parseScreenLimit,
  signOutAdminScreen,
  type AdminScreen,
  type AdminScreenCheck,
} from "@/lib/admin-screens";

const time = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function ScreenRow({ screen, action }: { screen: AdminScreen; action?: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-white p-3 text-sm">
      <div className="min-w-0">
        <p className="font-semibold text-navy">
          {screen.device || "Unknown device"}
          {screen.this_screen && <span className="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-800">This screen</span>}
          {screen.held && <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-800">Waiting (limit reached)</span>}
        </p>
        <p className="text-xs text-slate">{`${screen.email ?? "Admin"} · signed in ${time(screen.started_at)} · last active ${time(screen.last_seen)}`}</p>
      </div>
      {action}
    </li>
  );
}

/** Shown instead of the admin portal while this screen is over the limit. */
export function AdminScreenLimitReached({ held, busy, onRetry, onTakeOver, onLogOut }: {
  held: AdminScreenCheck; busy: boolean; onRetry: () => void; onTakeOver: () => void; onLogOut: () => void;
}) {
  const open = (held.screens ?? []).filter((screen) => !screen.held && !screen.this_screen);
  return (
    <div className="grid min-h-screen place-items-center bg-panel p-6 text-sm text-slate">
      <div role="alert" className="w-full max-w-lg rounded-lg border border-amber-200 bg-card p-6 shadow-card">
        <MonitorSmartphone className="mx-auto h-8 w-8 text-amber-600" />
        <p className="mt-3 text-center text-base font-bold text-navy">{`Admin screen limit reached (${held.limit} at a time)`}</p>
        <p className="mt-2 text-center leading-relaxed">
          {`This login is already open on ${held.limit === 1 ? "another screen" : `${held.limit} other screens`}. Close one of them (it frees its place within 3 minutes) and this screen comes in by itself, or use this screen now: the least recently used screen is signed out.`}
        </p>
        {open.length > 0 && (
          <ul className="mt-4 space-y-2">{open.map((screen) => <ScreenRow key={screen.session_id} screen={screen} />)}</ul>
        )}
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Button className="bg-navy text-white hover:bg-navy/90" disabled={busy} onClick={onTakeOver}>Use this screen instead</Button>
          <Button variant="outline" disabled={busy} onClick={onRetry}><RefreshCw className={busy ? "mr-1 h-4 w-4 animate-spin" : "mr-1 h-4 w-4"} /> Try again</Button>
          <Button variant="ghost" onClick={onLogOut}><LogOut className="mr-1 h-4 w-4" /> Log out</Button>
        </div>
      </div>
    </div>
  );
}

/** Settings > Security: the limit, and the admin screens open now with a Sign out button each. */
export function AdminScreensSettings() {
  const [limitText, setLimitText] = useState("0");
  const [screens, setScreens] = useState<AdminScreen[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [signingOut, setSigningOut] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const open = await openAdminScreens();
      setScreens(open.screens);
      setLimitText(String(open.limit));
      setLoadError("");
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "Could not load the open screens");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    const limit = parseScreenLimit(limitText);
    if (limit === null) { toast.error(`Enter a whole number from 0 to ${ADMIN_SCREENS_MAX.toLocaleString("en-IN")} (0 = no limit)`); return; }
    setSaving(true);
    const { error } = await supabase.from("settings").upsert([{ key: ADMIN_SCREENS_KEY, value: { max_screens: limit }, is_public: false }], { onConflict: "key" });
    setSaving(false);
    if (error) { toast.error("Could not save the screen limit", { description: error.message }); return; }
    toast.success(limit === 0 ? "No limit on admin screens" : `Up to ${limit} admin screen${limit === 1 ? "" : "s"} at a time per login`, {
      description: "Screens over a new, lower limit are held at their next check, within a minute.",
    });
    void load();
  };

  const signOut = async (screen: AdminScreen) => {
    setSigningOut(screen.session_id);
    try {
      await signOutAdminScreen(screen.session_id);
      toast.success(`${screen.device || "That screen"} is signed out`, { description: "It goes to the admin login within a minute." });
      void load();
    } catch (cause) {
      toast.error("Could not sign that screen out", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setSigningOut("");
    }
  };

  return (
    <Panel title="Admin screens open at the same time">
      <div className="grid gap-4 xl:max-w-3xl">
        <p className="text-sm text-slate">
          How many screens (browsers, phones or computers) can use the admin portal at the same time with the same login. 0 = no limit.
          When the limit is full, a new screen waits until one closes, or takes over the least recently used one.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="admin-screen-limit">Screens at a time per admin login</Label>
            <Input id="admin-screen-limit" type="number" inputMode="numeric" min={0} max={ADMIN_SCREENS_MAX} step={1} className="w-40"
              value={limitText} onChange={(event) => setLimitText(event.target.value)} />
          </div>
          <Button className="bg-navy text-white hover:bg-navy/90" disabled={saving || Boolean(loadError)} onClick={() => void save()}>
            <Save className="mr-1 h-4 w-4" /> {saving ? "Saving…" : "Save limit"}
          </Button>
        </div>
        <div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-bold text-navy">{loading ? "Open screens…" : `Open screens (${screens.length})`}</p>
            <Button variant="outline" size="sm" disabled={loading} onClick={() => void load()}><RefreshCw className={loading ? "mr-1 h-3.5 w-3.5 animate-spin" : "mr-1 h-3.5 w-3.5"} /> Refresh</Button>
          </div>
          {loadError ? (
            <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
              {`Could not load the open screens: ${loadError}. If this is new, run the SQL file 20261123180000_admin_screen_limit.sql in Supabase first.`}
            </p>
          ) : (
            <ul className="mt-2 space-y-2">
              {screens.map((screen) => (
                <ScreenRow key={screen.session_id} screen={screen} action={screen.this_screen ? undefined : (
                  <Button variant="outline" size="sm" disabled={signingOut === screen.session_id} onClick={() => void signOut(screen)}>
                    <LogOut className="mr-1 h-3.5 w-3.5" /> {signingOut === screen.session_id ? "Signing out…" : "Sign out"}
                  </Button>
                )} />
              ))}
              {!loading && screens.length === 0 && <li className="text-sm text-slate">No admin screen has checked in in the last 3 minutes.</li>}
            </ul>
          )}
        </div>
      </div>
    </Panel>
  );
}
