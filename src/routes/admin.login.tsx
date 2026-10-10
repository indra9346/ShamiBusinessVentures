import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { AuthCard } from "@/components/site/AuthCard";
import { Input } from "@/components/ui/input";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { useApp } from "@/lib/store";
import { signInProvisionedAccount } from "@/lib/provisioned-auth";

export const Route = createFileRoute("/admin/login")({
  head: () => ({
    meta: [
      { title: "Admin Login | Shami Business Ventures" },
      {
        name: "description",
        content: "Administrator sign-in with a provisioned email and password.",
      },
      { property: "og:title", content: "Admin Login | Shami" },
      {
        property: "og:description",
        content: "Restricted access to the marketplace control centre.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminLogin,
});

function AdminLogin() {
  const { login } = useApp();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const finish = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      if (STATIC_DATA_MODE) {
        const cleanEmail = email.trim().toLowerCase();
        login({ name: cleanEmail.split("@")[0] || "Admin", email: cleanEmail, role: "admin" });
        toast.info("Static preview sign-in", {
          description: "This preview does not authenticate against production.",
        });
        navigate({ to: "/admin/dashboard", replace: true });
        return;
      }

      const account = await signInProvisionedAccount(email, password, "admin");
      if (!account) return;
      login({ ...account, role: "admin" });
      toast.success("Signed in to the admin panel");
      navigate({ to: "/admin/dashboard", replace: true });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthCard
      title="Admin Login"
      subtitle="Use the administrator email and password provisioned for you. Public admin registration is disabled."
    >
      <form autoComplete="off" onSubmit={(event) => void finish(event)} className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-charcoal">
            Administrator email
          </span>
          <Input
            required
            type="email"
            autoComplete="off"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-charcoal">Password</span>
          <Input
            required
            type="password"
            autoComplete="off"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-md bg-navy py-3 text-sm font-semibold text-white transition-colors hover:bg-midnight disabled:opacity-60"
        >
          {submitting ? "Signing in…" : "Sign in to Admin Panel"}
        </button>
        <p className="text-xs text-slate">
          Admin access requires an existing Supabase Auth account with an administrator role. No OTP
          is used for admin sign-in.
        </p>
        <Link
          to="/reset-password"
          className="inline-block text-sm font-semibold text-gold hover:underline"
        >
          Set or reset password
        </Link>
      </form>
    </AuthCard>
  );
}
