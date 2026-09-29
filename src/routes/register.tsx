import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { AuthCard } from "@/components/site/AuthCard";
import { Input } from "@/components/ui/input";
import { useApp } from "@/lib/store";

export const Route = createFileRoute("/register")({
  head: () => ({
    meta: [
      { title: "Create Account | Shami Business Ventures" },
      { name: "description", content: "Register as a buyer for bulk and retail sugar, rice, oils and pulses." },
      { property: "og:title", content: "Create Your Shami Account" },
      { property: "og:description", content: "Register to order from verified vendors with GST invoicing." },
    ],
  }),
  component: RegisterPage,
});

function RegisterPage() {
  const { login } = useApp();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: "", email: "", phone: "", password: "" });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (form.name.trim().length < 2 || !form.email.includes("@") || form.password.length < 6) {
      toast.error("Please complete all fields correctly");
      return;
    }
    login({ name: form.name, email: form.email, role: "customer" });
    toast.success("Account created");
    navigate({ to: "/account" });
  };

  return (
    <AuthCard
      title="Create Account"
      subtitle="Order from verified vendors with GST invoicing"
      footer={
        <>
          Already registered?{" "}
          <Link to="/login" className="font-semibold text-gold hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {(
          [
            ["Full name", "name"],
            ["Email", "email"],
            ["Phone", "phone"],
            ["Password", "password"],
          ] as const
        ).map(([label, key]) => (
          <label key={key} className="block">
            <span className="mb-1.5 block text-xs font-semibold text-charcoal">{label}</span>
            <Input
              type={key === "password" ? "password" : "text"}
              value={form[key]}
              onChange={(e) => setForm({ ...form, [key]: e.target.value })}
            />
          </label>
        ))}
        <button className="w-full rounded-md bg-navy py-3 text-sm font-semibold text-white hover:bg-midnight">
          Create Account
        </button>
      </form>
    </AuthCard>
  );
}