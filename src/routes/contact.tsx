import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Mail, MapPin, MessageSquare, Phone } from "lucide-react";
import { z } from "zod";
import { toast } from "sonner";
import { SiteLayout, Breadcrumbs } from "@/components/site/SiteLayout";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export const Route = createFileRoute("/contact")({
  head: () => ({
    meta: [
      { title: "Contact the Shami Supply Desk" },
      { name: "description", content: "Reach Shami Business Ventures Pvt. Ltd. for bulk quotes, vendor onboarding and support." },
      { property: "og:title", content: "Contact Shami Business Ventures" },
      { property: "og:description", content: "Bulk quotes, vendor onboarding and order support." },
    ],
  }),
  component: Contact,
});

const schema = z.object({
  name: z.string().trim().min(2, "Enter your full name").max(100),
  email: z.string().trim().email("Enter a valid email").max(255),
  phone: z.string().trim().regex(/^[0-9+\s-]{8,15}$/, "Enter a valid phone number"),
  message: z.string().trim().min(10, "Tell us a bit more").max(1000),
});

function Contact() {
  const [form, setForm] = useState({ name: "", email: "", phone: "", message: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const res = schema.safeParse(form);
    if (!res.success) {
      const next: Record<string, string> = {};
      res.error.issues.forEach((i) => (next[String(i.path[0])] = i.message));
      setErrors(next);
      return;
    }
    setErrors({});
    setLoading(true);
    setTimeout(() => {
      setLoading(false);
      setForm({ name: "", email: "", phone: "", message: "" });
      toast.success("Enquiry submitted", { description: "Our supply desk will respond within one business day." });
    }, 900);
  };

  return (
    <SiteLayout>
      <div className="border-b border-border bg-ivory">
        <div className="mx-auto max-w-7xl px-6 py-8">
          <Breadcrumbs items={[{ label: "Contact" }]} />
          <h1 className="mt-3 text-3xl font-bold text-navy">Contact Us</h1>
        </div>
      </div>

      <div className="mx-auto grid max-w-7xl gap-10 px-6 py-14 lg:grid-cols-[minmax(0,1fr)_380px]">
        <form onSubmit={submit} className="rounded-lg border border-border bg-card p-6 shadow-card sm:p-8">
          <h2 className="text-lg font-bold text-navy">Send an enquiry</h2>
          <p className="mt-1 text-sm text-slate">Bulk quotes, vendor onboarding or order support.</p>
          <div className="mt-6 grid gap-5 sm:grid-cols-2">
            <Field label="Full name" error={errors["name"]}>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={100} />
            </Field>
            <Field label="Email" error={errors["email"]}>
              <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} maxLength={255} />
            </Field>
            <Field label="Phone" error={errors["phone"]}>
              <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} maxLength={15} />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Message" error={errors["message"]}>
                <Textarea
                  rows={5}
                  maxLength={1000}
                  value={form.message}
                  onChange={(e) => setForm({ ...form, message: e.target.value })}
                />
              </Field>
            </div>
          </div>
          <button
            disabled={loading}
            className="mt-6 rounded-md bg-navy px-7 py-3 text-sm font-semibold text-white transition-colors hover:bg-midnight disabled:opacity-60"
          >
            {loading ? "Submitting…" : "Submit Enquiry"}
          </button>
        </form>

        <aside className="h-max space-y-4">
          {[
            [MapPin, "Registered office", "Shami House, Industrial Estate, Belagavi, Karnataka 590010"],
            [Phone, "Supply desk", "+91 95385 00840 (Mon–Sat, 9am–7pm)"],
            [Mail, "Email", "care@shamiventures.in"],
            [MessageSquare, "WhatsApp", "+91 95385 00840"],
          ].map(([Icon, t, d]) => {
            const I = Icon as React.ComponentType<{ className?: string }>;
            return (
              <div key={t as string} className="flex gap-4 rounded-lg border border-border bg-card p-5 shadow-card">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-navy/5 text-gold">
                  <I className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <p className="font-semibold text-navy">{t as string}</p>
                  <p className="text-sm text-slate">{d as string}</p>
                </div>
              </div>
            );
          })}
        </aside>
      </div>
    </SiteLayout>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold text-charcoal">{label}</span>
      {children}
      {error && <span className="mt-1 block text-xs font-medium text-danger">{error}</span>}
    </label>
  );
}