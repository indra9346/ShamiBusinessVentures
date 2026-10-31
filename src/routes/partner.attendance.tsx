import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowLeft, LogOut, RefreshCw } from "lucide-react";
import { LogoMark } from "@/components/brand/Logo";
import { AttendanceManager } from "@/components/attendance/AttendanceManager";
import { StockCountLog } from "@/components/stock/StockCountLog";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/partner/attendance")({
  head: () => ({ meta: [{ title: "Godown Attendance | Grain Bazar Partner" }, { name: "robots", content: "noindex" }] }),
  component: PartnerAttendance,
});

type Me = { name: string; branchId: string; godown: string };

/** The channel partner's attendance desk for their godown: today, approvals (with head office), register. */
function PartnerAttendance() {
  const navigate = useNavigate();
  const [me, setMe] = useState<Me | null>(null);

  // Only an active partner may stay here; anyone else goes to the partner login.
  useEffect(() => {
    void (async () => {
      const { data: session } = await supabase.auth.getSession();
      const userId = session.session?.user.id;
      if (!userId) { navigate({ to: "/partner/login", replace: true }); return; }
      const { data: partner } = await supabase.from("channel_partners").select("name,branch_id,status").eq("user_id", userId).maybeSingle();
      if (!partner || partner.status !== "active") { await supabase.auth.signOut(); navigate({ to: "/partner/login", replace: true }); return; }
      const { data: branch } = await supabase.from("branches").select("name").eq("id", partner.branch_id).maybeSingle();
      setMe({ name: partner.name, branchId: partner.branch_id, godown: branch?.name ?? partner.branch_id });
    })();
  }, [navigate]);

  if (!me) {
    return <div className="grid min-h-screen place-items-center bg-panel text-sm text-slate"><span className="inline-flex items-center gap-2"><RefreshCw className="h-4 w-4 animate-spin" /> Opening attendance…</span></div>;
  }

  return (
    <div className="min-h-screen bg-[oklch(0.972_0.004_258)]">
      <header className="sticky top-0 z-30 border-b border-border bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <LogoMark className="h-9 w-9 rounded-lg bg-card p-1 object-contain shadow-sm" />
            <div>
              <p className="text-sm font-extrabold tracking-wide text-navy">Godown Attendance & Stock</p>
              <p className="text-xs text-slate">{me.name} · {me.godown}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link to="/partner" className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-sm text-navy hover:border-gold hover:text-gold">
              <ArrowLeft className="h-4 w-4" /> Commission dashboard
            </Link>
            <button type="button" onClick={async () => { await supabase.auth.signOut(); navigate({ to: "/partner/login" }); }}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-sm text-navy hover:border-gold hover:text-gold">
              <LogOut className="h-4 w-4" /> Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl space-y-10 px-4 py-6">
        <AttendanceManager viewer="partner" partnerBranchId={me.branchId} />
        <StockCountLog godowns={[{ id: me.branchId, name: me.godown }]} />
      </main>
    </div>
  );
}
