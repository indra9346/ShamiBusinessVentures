import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AuthCard } from "@/components/site/AuthCard";
import { Input } from "@/components/ui/input";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/reset-password")({
  head: () => ({
    meta: [
      { title: "Set Staff Password | Grain Bazar" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ResetPasswordPage,
});

type Screen = "request" | "set" | "sent" | "done";

function ResetPasswordPage() {
  const [screen, setScreen] = useState<Screen>("request");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const url = new URL(window.location.href);
    const hashParams = new URLSearchParams(url.hash.slice(1));
    if (url.searchParams.has("code") || hashParams.get("type") === "recovery") {
      setScreen("set");
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") setScreen("set");
    });
    return () => subscription.unsubscribe();
  }, []);

  const requestReset = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (STATIC_DATA_MODE) {
      toast.error("Password setup is unavailable in static preview mode");
      return;
    }

    setSubmitting(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) throw error;
      setScreen("sent");
    } catch (error) {
      toast.error("Could not send the password setup email", {
        description: error instanceof Error ? error.message : "Please try again later.",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const setNewPassword = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (password.length < 8) {
      toast.error("Use a password with at least 8 characters");
      return;
    }
    if (password !== confirmation) {
      toast.error("The passwords do not match");
      return;
    }

    setSubmitting(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      await supabase.auth.signOut();
      setScreen("done");
      toast.success("Password set successfully. Sign in with your new password.");
    } catch (error) {
      toast.error("Could not set the password", {
        description: error instanceof Error ? error.message : "Open the latest password setup email and try again.",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const loginLinks = (
    <div className="flex flex-wrap gap-x-4 gap-y-2">
      <Link to="/vendor/login" className="font-semibold text-gold hover:underline">Vendor login</Link>
      <Link to="/admin/login" className="font-semibold text-gold hover:underline">Admin login</Link>
    </div>
  );

  if (screen === "set") {
    return (
      <AuthCard title="Set your password" subtitle="Choose a password for your provisioned staff account." footer={loginLinks}>
        <form onSubmit={(event) => void setNewPassword(event)} className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-charcoal">New password</span>
            <Input required type="password" minLength={8} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-charcoal">Confirm password</span>
            <Input required type="password" minLength={8} autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
          </label>
          <button type="submit" disabled={submitting} className="w-full rounded-md bg-navy py-3 text-sm font-semibold text-white hover:bg-midnight disabled:opacity-60">
            {submitting ? "Saving…" : "Set password"}
          </button>
        </form>
      </AuthCard>
    );
  }

  if (screen === "sent") {
    return (
      <AuthCard title="Check your email" subtitle="If this Auth account exists, Supabase will send a password setup link. Open the latest email on this device to continue." footer={loginLinks}>
        <p className="text-sm text-slate">The link returns to this page so you can set your password. It does not change your vendor or admin role.</p>
        <button type="button" onClick={() => setScreen("request")} className="text-sm font-semibold text-gold hover:underline">Try another email</button>
      </AuthCard>
    );
  }

  if (screen === "done") {
    return (
      <AuthCard title="Password set" subtitle="Your staff password is ready. Sign in using your email and new password; staff sign-in does not use OTP." footer={loginLinks}>
        <p className="text-sm text-slate">Choose Vendor login or Admin login above, depending on your assigned role.</p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Set or reset staff password" subtitle="Enter the email for your provisioned vendor or admin account. We’ll email a secure password setup link." footer={loginLinks}>
      <form onSubmit={(event) => void requestReset(event)} className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-charcoal">Staff account email</span>
          <Input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <button type="submit" disabled={submitting} className="w-full rounded-md bg-navy py-3 text-sm font-semibold text-white hover:bg-midnight disabled:opacity-60">
          {submitting ? "Sending…" : "Email password setup link"}
        </button>
      </form>
    </AuthCard>
  );
}
