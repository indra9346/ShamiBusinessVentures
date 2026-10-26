import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AuthCard } from "@/components/site/AuthCard";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/partner/login")({
  head: () => ({ meta: [{ title: "Channel Partner Login | Grain Bazar" }, { name: "robots", content: "noindex" }] }),
  component: PartnerLogin,
});

/** Sign-in for godown channel partners, with the login the Grain Bazar admin created for them. */
function PartnerLogin() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Already signed in as an active partner: straight to the dashboard.
  useEffect(() => {
    void supabase.auth.getSession().then(async ({ data }) => {
      if (!data.session?.user) return;
      const { data: partner } = await supabase.from("channel_partners").select("status").eq("user_id", data.session.user.id).maybeSingle();
      if (partner?.status === "active") navigate({ to: "/partner", replace: true });
    });
  }, [navigate]);

  const finish = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
      if (error || !data.user) {
        toast.error(/invalid login credentials/i.test(error?.message ?? "") ? "Incorrect email or password" : "Could not sign in", {
          description: error?.message && !/invalid login/i.test(error.message) ? error.message : "Check both and try again.",
        });
        return;
      }
      const { data: partner } = await supabase.from("channel_partners").select("status").eq("user_id", data.user.id).maybeSingle();
      if (!partner || partner.status !== "active") {
        await supabase.auth.signOut();
        toast.error(partner ? "This channel partner login is suspended" : "This account is not a channel partner login", {
          description: "Contact the Grain Bazar office.",
        });
        return;
      }
      navigate({ to: "/partner", replace: true });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthCard
      title="Channel Partner Login"
      subtitle="Channel Partner Commission Platform. Sign in with the email and password the Grain Bazar office gave you."
    >
      <form autoComplete="off" onSubmit={(event) => void finish(event)} className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-charcoal">Email</span>
          <Input required type="email" name="partner_login_email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-charcoal">Password</span>
          <Input required type="password" name="partner_login_password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-md bg-navy py-3 text-sm font-semibold text-white transition-colors hover:bg-midnight disabled:opacity-60"
        >
          {submitting ? "Signing in…" : "Sign in to Partner Dashboard"}
        </button>
        <p className="text-xs text-slate">Forgot your password? Ask the Grain Bazar office to set a new one for you.</p>
      </form>
    </AuthCard>
  );
}
