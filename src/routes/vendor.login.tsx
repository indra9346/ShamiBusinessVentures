import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { AuthCard } from "@/components/site/AuthCard";
import { Input } from "@/components/ui/input";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { useApp } from "@/lib/store";
import { signInProvisionedAccount } from "@/lib/provisioned-auth";

export const Route = createFileRoute("/vendor/login")({
  head: () => ({
    meta: [
      { title: "Vendor Login | Grain Bazar" },
      { name: "description", content: "Sign in to the vendor panel with your provisioned business account." },
      { property: "og:title", content: "Vendor Login | Grain Bazar" },
      { property: "og:description", content: "Manage your Grain Bazar listings, orders, stock and earnings." },
    ],
  }),
  component: VendorLogin,
});

function VendorLogin() {
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
        login({ name: cleanEmail.split("@")[0] || "Vendor", email: cleanEmail, role: "vendor" });
        toast.info("Static preview sign-in", { description: "This preview does not authenticate against production." });
        navigate({ to: "/vendor/dashboard", replace: true });
        return;
      }

      const account = await signInProvisionedAccount(email, password, "vendor");
      if (!account) return;
      login({ ...account, role: "vendor" });
      toast.success("Signed in to the vendor panel");
      navigate({ to: "/vendor/dashboard", replace: true });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthCard
      title="Vendor Login"
      subtitle="Use the business email and password assigned to your vendor account. Vendor access is provisioned by an administrator."
    >
      <form onSubmit={(event) => void finish(event)} className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-charcoal">Business email</span>
          <Input
            required
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-charcoal">Password</span>
          <Input
            required
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-md bg-navy py-3 text-sm font-semibold text-white transition-colors hover:bg-midnight disabled:opacity-60"
        >
          {submitting ? "Signing in…" : "Sign in to Vendor Panel"}
        </button>
        <p className="text-xs text-slate">
          Vendor access is restricted to accounts with an active vendor role and assigned vendor ID. No OTP is used for vendor sign-in.
        </p>
      </form>
    </AuthCard>
  );
}
