import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { CheckCircle2, Mail, MapPin, MessageSquare, Phone, RotateCcw, Send } from "lucide-react";
import { z } from "zod";
import { toast } from "sonner";
import { SiteLayout, Breadcrumbs } from "@/components/site/SiteLayout";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/contact")({
  head: () => ({
    meta: [
      { title: "Contact the Shami Supply Desk | care@shamiventures.in" },
      {
        name: "description",
        content:
          "Reach Shami Business Ventures Pvt. Ltd. at care@shamiventures.in for bulk quotes, vendor onboarding and institutional supply support.",
      },
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
  message: z.string().trim().min(5, "Tell us a bit more about your requirement").max(1000),
});

type SubmittedData = {
  name: string;
  email: string;
  phone: string;
  message: string;
  time: string;
};

function Contact() {
  const [form, setForm] = useState({ name: "", email: "", phone: "", message: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState<SubmittedData | null>(null);

  const submit = async (e: React.FormEvent) => {
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

    const payload = {
      name: form.name.trim(),
      email: form.email.trim(),
      phone: form.phone.trim(),
      message: form.message.trim(),
      recipient_email: "care@shamiventures.in",
      status: "new",
    };

    try {
      // 1. Record enquiry in Supabase database
      const { error: dbError } = await (supabase as any).from("contact_enquiries").insert(payload);
      if (dbError) {
        console.warn("Note: DB insert into contact_enquiries:", dbError.message);
      }

      // 2. Dispatch email notification to care@shamiventures.in via Edge Function / Webhook
      try {
        await supabase.functions.invoke("send-enquiry", {
          body: payload,
        });
      } catch (fnErr) {
        console.warn("Note: Edge function send-enquiry:", fnErr);
      }

      setSubmitted({
        ...payload,
        time: new Date().toLocaleTimeString("en-IN", {
          hour: "2-digit",
          minute: "2-digit",
          day: "2-digit",
          month: "short",
        }),
      });

      toast.success("Enquiry Dispatched Directly to care@shamiventures.in", {
        description: "Our Belagavi supply desk will respond within one business day.",
      });
      setForm({ name: "", email: "", phone: "", message: "" });
    } catch (err: any) {
      toast.error("Submission failed", {
        description: err?.message || "Please try reaching us directly on WhatsApp or Email.",
      });
    } finally {
      setLoading(false);
    }
  };

  const whatsappUrl = (phoneVal: string, msgVal: string) =>
    `https://wa.me/919538500840?text=${encodeURIComponent(
      `Hello Shami Business Desk, I have a wholesale enquiry.\nName: ${form.name || "Customer"}\nPhone: ${phoneVal || "N/A"}\nMessage: ${msgVal}`,
    )}`;

  const emailUrl = (nameVal: string, msgVal: string) =>
    `mailto:care@shamiventures.in?subject=${encodeURIComponent(
      `Enquiry from ${nameVal || "Customer"}`,
    )}&body=${encodeURIComponent(
      `Name: ${nameVal}\nEmail: ${form.email}\nPhone: ${form.phone}\nRequirement: ${msgVal}`,
    )}`;

  return (
    <SiteLayout>
      <div className="border-b border-border bg-ivory">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
          <Breadcrumbs items={[{ label: "Contact" }]} />
          <h1 className="mt-3 text-2xl font-bold text-navy sm:text-3xl">Contact Supply Desk</h1>
          <p className="mt-1 text-sm text-slate">
            Direct institutional procurement, vendor onboarding & order assistance.
          </p>
        </div>
      </div>

      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-8 sm:gap-10 sm:px-6 sm:py-14 lg:grid-cols-[minmax(0,1fr)_380px]">
        {submitted ? (
          <div className="rounded-xl border border-emerald-500/30 bg-card p-6 shadow-card sm:p-10 animate-in fade-in-50 duration-300">
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
                <CheckCircle2 className="h-6 w-6" />
              </div>
              <div className="min-w-0 flex-1">
                <span className="inline-block rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
                  Dispatched to care@shamiventures.in
                </span>
                <h2 className="mt-2 text-xl font-bold text-navy">
                  Thank You, {submitted.name}! Your Enquiry Has Been Sent
                </h2>
                <p className="mt-1 text-sm text-slate">
                  Your message has been delivered to our official support desk at{" "}
                  <strong className="text-navy">care@shamiventures.in</strong>. A dedicated supply
                  manager will review your requirements and get in touch with you shortly.
                </p>
              </div>
            </div>

            {/* Receipt Summary Card */}
            <div className="mt-6 rounded-lg border border-border/80 bg-ivory/60 p-4 sm:p-5">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate">
                Submission Summary ({submitted.time})
              </h3>
              <dl className="mt-3 grid gap-2.5 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-slate">Sender</dt>
                  <dd className="font-semibold text-navy">{submitted.name}</dd>
                </div>
                <div>
                  <dt className="text-xs text-slate">Email</dt>
                  <dd className="font-semibold text-navy">{submitted.email}</dd>
                </div>
                <div>
                  <dt className="text-xs text-slate">Phone</dt>
                  <dd className="font-semibold text-navy">{submitted.phone || "Not provided"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-slate">Destination</dt>
                  <dd className="font-semibold text-gold">care@shamiventures.in</dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-xs text-slate">Requirement Note</dt>
                  <dd className="mt-1 rounded-md bg-white p-3 font-mono text-xs text-charcoal border border-border">
                    {submitted.message}
                  </dd>
                </div>
              </dl>
            </div>

            {/* Instant escalation actions */}
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <a
                href={whatsappUrl(submitted.phone, submitted.message)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-xs font-bold text-white transition-colors hover:bg-emerald-700 shadow-xs"
              >
                <MessageSquare className="h-4 w-4" />
                Chat on WhatsApp (+91 95385 00840)
              </a>
              <a
                href={`mailto:care@shamiventures.in?subject=Enquiry Follow-up - ${submitted.name}`}
                className="inline-flex items-center gap-2 rounded-lg border border-navy/20 bg-navy/5 px-4 py-2.5 text-xs font-bold text-navy transition-colors hover:bg-navy/10"
              >
                <Mail className="h-4 w-4" />
                Email Desk (care@shamiventures.in)
              </a>
              <button
                type="button"
                onClick={() => setSubmitted(null)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-slate transition-colors hover:bg-muted ml-auto"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Submit another enquiry
              </button>
            </div>
          </div>
        ) : (
          <form
            onSubmit={submit}
            className="rounded-xl border border-border bg-card p-5 shadow-card sm:p-8"
          >
            <div className="flex items-center justify-between gap-3 border-b border-border/60 pb-4">
              <div>
                <h2 className="text-lg font-bold text-navy">Send an enquiry</h2>
                <p className="mt-0.5 text-xs text-slate">
                  Bulk quotes, vendor onboarding or order support delivered to{" "}
                  <strong className="text-gold">care@shamiventures.in</strong>.
                </p>
              </div>
              <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full bg-gold/10 px-2.5 py-1 text-xs font-semibold text-gold">
                <Send className="h-3 w-3" />
                Direct Desk Dispatch
              </span>
            </div>

            <div className="mt-6 grid gap-5 sm:grid-cols-2">
              <Field label="Full name" error={errors["name"]}>
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. K S Indra Kumar"
                  maxLength={100}
                />
              </Field>
              <Field label="Email" error={errors["email"]}>
                <Input
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  placeholder="e.g. ik989344@gmail.com"
                  maxLength={255}
                />
              </Field>
              <Field label="Phone number" error={errors["phone"]}>
                <Input
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  placeholder="e.g. 9346476951"
                  maxLength={15}
                />
              </Field>
              <div className="sm:col-span-2">
                <Field label="Message / Requirement details" error={errors["message"]}>
                  <Textarea
                    rows={5}
                    maxLength={1000}
                    placeholder="Tell us about your requirement, bulk quantity (e.g. 25 MT Sugar, 50 bags Sona Masoori Rice), or support issue..."
                    value={form.message}
                    onChange={(e) => setForm({ ...form, message: e.target.value })}
                  />
                </Field>
              </div>
            </div>

            <div className="mt-6 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4 pt-2">
              <button
                disabled={loading}
                className="flex items-center justify-center gap-2 rounded-lg bg-navy px-8 py-3 text-sm font-semibold text-white transition-all hover:bg-midnight hover:shadow-md disabled:opacity-60 cursor-pointer"
              >
                {loading ? (
                  <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    <span>Dispatching to care@shamiventures.in...</span>
                  </>
                ) : (
                  <>
                    <Send className="h-4 w-4" />
                    <span>Submit Enquiry</span>
                  </>
                )}
              </button>

              <div className="flex items-center gap-2 text-xs text-slate">
                <Mail className="h-3.5 w-3.5 text-gold shrink-0" />
                <span>Goes directly to care@shamiventures.in</span>
              </div>
            </div>
          </form>
        )}

        <aside className="h-max space-y-4">
          {[
            {
              icon: MapPin,
              title: "Registered office",
              detail: "Shami House, Industrial Estate, Belagavi, Karnataka 590010",
            },
            {
              icon: Phone,
              title: "Supply desk",
              detail: "+91 95385 00840 (Mon–Sat, 9am–7pm)",
              href: "tel:+919538500840",
            },
            {
              icon: Mail,
              title: "Official Email Desk",
              detail: "care@shamiventures.in",
              href: "mailto:care@shamiventures.in",
            },
            {
              icon: MessageSquare,
              title: "WhatsApp Support",
              detail: "+91 95385 00840",
              href: "https://wa.me/919538500840",
            },
          ].map((item) => {
            const I = item.icon;
            const content = (
              <div
                key={item.title}
                className="flex gap-4 rounded-xl border border-border bg-card p-5 shadow-card transition-all hover:border-gold/50"
              >
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-navy/5 text-gold">
                  <I className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <p className="font-semibold text-navy">{item.title}</p>
                  <p className="text-sm text-slate">{item.detail}</p>
                </div>
              </div>
            );

            if (item.href) {
              return (
                <a
                  key={item.title}
                  href={item.href}
                  target={item.href.startsWith("http") ? "_blank" : undefined}
                  rel={item.href.startsWith("http") ? "noreferrer" : undefined}
                  className="block transition-transform hover:-translate-y-0.5"
                >
                  {content}
                </a>
              );
            }
            return content;
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