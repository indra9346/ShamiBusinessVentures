import { createFileRoute } from "@tanstack/react-router";
import { Building2, Factory, Globe2, Users } from "lucide-react";
import { SiteLayout, Breadcrumbs, SectionHeading } from "@/components/site/SiteLayout";
import { LogoMark } from "@/components/brand/Logo";

export const Route = createFileRoute("/about")({
  head: () => ({
    meta: [
      { title: "About Shami Business Ventures Pvt. Ltd." },
      {
        name: "description",
        content:
          "Shami Business Ventures Pvt. Ltd. operates a premium multi-vendor marketplace for sugar and essentials across India.",
      },
      { property: "og:title", content: "About Shami Business Ventures Pvt. Ltd." },
      { property: "og:description", content: "Mill-direct sourcing, verified vendors and institutional-grade logistics." },
    ],
  }),
  component: About,
});

function About() {
  return (
    <SiteLayout>
      <div className="border-b border-border bg-ivory">
        <div className="mx-auto max-w-7xl px-6 py-8">
          <Breadcrumbs items={[{ label: "About" }]} />
          <h1 className="mt-3 text-3xl font-bold text-navy">About the Company</h1>
        </div>
      </div>

      <div className="mx-auto grid max-w-7xl gap-12 px-6 py-14 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6 text-[15px] leading-relaxed text-charcoal">
          <p>
            Shami Business Ventures Pvt. Ltd. is a commodity trading and distribution company operating a
            premium multi-vendor marketplace for sugar, rice, edible oils and pulses. We connect certified
            mills and regional distributors with retailers, canteens, hotels and institutional buyers across
            India.
          </p>
          <p>
            Every vendor onboarded to the platform is validated for GST registration, FSSAI licensing and
            warehouse capability. Orders are split by vendor, fulfilled with tracked freight, and invoiced with
            complete tax breakups so procurement teams can reconcile input credit without follow-ups.
          </p>
          <SectionHeading eyebrow="What we stand for" title="Built for procurement teams" />
          <div className="grid gap-5 sm:grid-cols-2">
            {[
              [Factory, "Mill-direct sourcing", "S1, S2 and M30 grades procured straight from partner mills."],
              [Users, "Verified vendor network", "KYC, GST and bank verification before the first listing."],
              [Globe2, "Pan-India fulfilment", "Freight partners covering 480+ pin codes."],
              [Building2, "Enterprise ready", "Zoho Inventory, Books, CRM and Analytics integration architecture."],
            ].map(([Icon, t, d]) => {
              const I = Icon as React.ComponentType<{ className?: string }>;
              return (
                <div key={t as string} className="rounded-lg border border-border bg-card p-5 shadow-card">
                  <I className="h-5 w-5 text-gold" />
                  <p className="mt-3 font-semibold text-navy">{t as string}</p>
                  <p className="mt-1 text-sm text-slate">{d as string}</p>
                </div>
              );
            })}
          </div>
        </div>

        <aside className="h-max rounded-lg border border-border bg-ivory p-6 shadow-card">
          <LogoMark className="h-14" />
          <div className="hairline-gold my-5" />
          <dl className="space-y-4 text-sm">
            {[
              ["Registered name", "Shami Business Ventures Pvt. Ltd."],
              ["GSTIN", "29ABCDE1234F1Z5"],
              ["FSSAI", "10023456789012"],
              ["Head office", "Belagavi, Karnataka"],
              ["Categories", "Sugar · Rice · Oils · Pulses"],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-[11px] font-semibold tracking-wider text-slate uppercase">{k}</dt>
                <dd className="font-medium text-navy">{v}</dd>
              </div>
            ))}
          </dl>
        </aside>
      </div>
    </SiteLayout>
  );
}