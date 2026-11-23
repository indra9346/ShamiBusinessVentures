import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { KeyRound, LogOut, ShieldCheck } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { useApp } from "@/lib/store";
import { supabase } from "@/integrations/supabase/client";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { clearAdminIdleClock } from "@/lib/admin-idle";
import { forgetPanelAccess } from "@/lib/panel-menu";
import { Button } from "@/components/ui/button";
import { AdminCredentials } from "@/components/panel/AdminCredentials";

export const Route = createFileRoute("/admin/profile")({
  head: () => ({ meta: [{ title: "My profile | Grain Bazar Admin" }, { name: "robots", content: "noindex" }] }),
  component: AdminProfile,
});

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

/** The signed-in administrator's own account: who they are, when they last signed in, a password change and Log out. */
function AdminProfile() {
  const { user, logout } = useApp();
  const navigate = useNavigate();
  const [account, setAccount] = useState<{ email: string; phone: string; lastSignIn: string | null; created: string | null } | null>(null);

  useEffect(() => {
    if (STATIC_DATA_MODE) return;
    let active = true;
    void supabase.auth.getUser().then(({ data }) => {
      const me = data.user;
      if (active && me) setAccount({ email: me.email ?? "", phone: me.phone ?? "", lastSignIn: me.last_sign_in_at ?? null, created: me.created_at ?? null });
    });
    return () => { active = false; };
  }, []);

  const signOut = async () => {
    if (user?.id) clearAdminIdleClock(user.id);
    forgetPanelAccess();
    await supabase.auth.signOut({ scope: "local" });
    logout();
    navigate({ to: "/" });
  };

  const rows: [string, string][] = [
    ["Name", user?.name || "—"],
    ["Email", account?.email || user?.email || "—"],
    ["Phone", account?.phone || user?.phone || "—"],
    ["Role", "Administrator"],
    ["Last sign-in", when(account?.lastSignIn)],
    ["Account made", when(account?.created)],
  ];

  return (
    <PanelLayout items={adminNav} tone="admin" title="My profile" subtitle="Your administrator account">
      <div className="grid max-w-3xl gap-6">
        <Panel title="Account">
          <dl className="divide-y divide-border text-sm">
            {rows.map(([label, value]) => (
              <div key={label} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2.5">
                <dt className="text-slate">{label}</dt>
                <dd className="min-w-0 break-words font-semibold text-navy">{value}</dd>
              </div>
            ))}
          </dl>
        </Panel>
        {(account?.email || user?.email) && <AdminCredentials email={account?.email || user?.email || ""} />}
        <Panel title="Security">
          <p className="mb-3 flex items-start gap-2 text-sm text-slate">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-gold" />
            <span>Never share your password, or write it in a chat or a pinned message. If someone else may know it, change it now.</span>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to="/reset-password"><KeyRound className="mr-1.5 h-4 w-4" /> Reset password by email</Link>
            </Button>
            <Button variant="outline" size="sm" className="text-danger" onClick={() => void signOut()}>
              <LogOut className="mr-1.5 h-4 w-4" /> Log out of this browser
            </Button>
          </div>
        </Panel>
      </div>
    </PanelLayout>
  );
}
