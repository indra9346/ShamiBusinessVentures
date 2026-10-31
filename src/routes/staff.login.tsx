import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { showAuthNotice } from "@/components/site/AuthNotice";
import { AuthCard } from "@/components/site/AuthCard";
import { Input } from "@/components/ui/input";
import { cleanMobile, staffLoginEmail } from "@/lib/attendance";
import { normalisePhone } from "@/lib/otp";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/staff/login")({
  head: () => ({ meta: [{ title: "Godown Staff Login | Grain Bazar" }, { name: "robots", content: "noindex" }] }),
  component: StaffLogin,
});

/** Sign-in for godown employees: mobile number + the password the Grain Bazar office set for them. */
function StaffLogin() {
  const navigate = useNavigate();
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  // Already signed in as an active employee: straight to attendance.
  useEffect(() => {
    void supabase.auth.getSession().then(async ({ data }) => {
      if (!data.session?.user) return;
      const { data: employee } = await supabase.from("staff_employees").select("status").eq("user_id", data.session.user.id).maybeSingle();
      if (employee?.status === "active") navigate({ to: "/staff", replace: true });
    });
  }, [navigate]);

  const signIn = async (event: React.FormEvent) => {
    event.preventDefault();
    const mobile = cleanMobile(phone);
    if (!mobile) { showAuthNotice("Enter a valid 10-digit Indian mobile number"); return; }
    if (!password) { showAuthNotice("Enter your password"); return; }
    setBusy(true);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email: staffLoginEmail(mobile), password });
      if (error || !data.user) {
        showAuthNotice(/invalid login credentials/i.test(error?.message ?? "") ? "Incorrect mobile number or password" : "Could not sign in", "Check both and try again. Forgot your password? Ask the Grain Bazar office to set a new one.");
        return;
      }
      const { data: employee } = await supabase.from("staff_employees").select("status").eq("user_id", data.user.id).maybeSingle();
      if (!employee || employee.status !== "active") {
        await supabase.auth.signOut();
        showAuthNotice(employee ? "Your staff login is deactivated" : "This is not a godown staff login", "Contact the Grain Bazar office.");
        return;
      }
      navigate({ to: "/staff", replace: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Godown Staff Login" subtitle="Mark your attendance on your godown's attendance device. Sign in with your mobile number and the password the Grain Bazar office gave you.">
      <form autoComplete="off" onSubmit={(event) => void signIn(event)} className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-charcoal">Mobile number</span>
          <div className="flex items-center gap-2">
            <span className="rounded-md border border-border bg-ivory px-3 py-2 text-sm font-semibold text-navy">+91</span>
            <Input value={phone} onChange={(event) => setPhone(normalisePhone(event.target.value))} inputMode="numeric" name="staff_mobile" autoComplete="username" placeholder="98XXXXXXXX" />
          </div>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-charcoal">Password</span>
          <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} name="staff_password" autoComplete="current-password" />
        </label>
        <button disabled={busy} className="w-full rounded-md bg-navy py-3 text-sm font-semibold text-white transition-colors hover:bg-midnight disabled:opacity-60">
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="text-xs text-slate">Forgot your password? Ask the Grain Bazar office to set a new one.</p>
        <p className="text-xs text-slate">Setting up the godown's attendance device? <Link to="/staff/device" className="font-semibold text-navy underline">Register this device</Link></p>
      </form>
    </AuthCard>
  );
}
