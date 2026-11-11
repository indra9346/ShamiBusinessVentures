import { createFileRoute, Link } from "@tanstack/react-router";
import { pageHead, SITE_NAME } from "@/lib/seo";
import { SiteLayout, Breadcrumbs } from "@/components/site/SiteLayout";
import {
  POLICY_INTRO,
  POLICY_TITLE,
  POLICY_UPDATED,
  privacyPolicySections,
  type PolicyLink,
  type PolicySection,
} from "@/lib/privacy-policy";

/** The rule that switches the Google Analytics tag on, so its section shows only in a build where the tag can run. */
const ANALYTICS_ON = /^G-[A-Z0-9]{4,20}$/.test(String(import.meta.env["VITE_GA_MEASUREMENT_ID"] ?? "").trim());

export const Route = createFileRoute("/privacy")({
  head: () => pageHead({
    title: `Privacy Policy | ${SITE_NAME}`,
    description: "How Grain Bazar, run by Shami Business Ventures Pvt. Ltd., collects, uses and shares your information: accounts, addresses, orders, location and cookies.",
    path: "/privacy",
  }),
  component: Privacy,
});

function Privacy() {
  return (
    <SiteLayout>
      <div className="border-b border-border bg-ivory">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
          <Breadcrumbs items={[{ label: POLICY_TITLE }]} />
          <h1 className="mt-3 text-2xl font-bold text-navy sm:text-3xl">{POLICY_TITLE}</h1>
          <p className="mt-1 text-sm text-slate">{POLICY_UPDATED}</p>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-14">
        <div className="max-w-3xl space-y-8 text-[15px] leading-relaxed text-charcoal">
          <p>{POLICY_INTRO}</p>
          {privacyPolicySections(ANALYTICS_ON).map((section) => (
            <PolicyBlock key={section.heading} section={section} />
          ))}
        </div>
      </div>
    </SiteLayout>
  );
}

function PolicyBlock({ section }: { section: PolicySection }) {
  return (
    <section>
      <h2 className="text-lg font-bold text-navy sm:text-xl">{section.heading}</h2>
      {section.intro?.map((text) => <p key={text} className="mt-3">{text}</p>)}
      {section.items && (
        <ul className="mt-3 list-disc space-y-2 pl-5">
          {section.items.map((item) => (
            <li key={item.text}>
              {item.lead && <><strong className="font-semibold text-navy">{item.lead}</strong>{": "}</>}
              {item.text}
            </li>
          ))}
        </ul>
      )}
      {section.outro?.map((text) => <p key={text} className="mt-3">{text}</p>)}
      {section.links && (
        <ul className="mt-3 space-y-2">
          {section.links.map((link) => <li key={link.href}><PolicyAnchor link={link} /></li>)}
        </ul>
      )}
    </section>
  );
}

function PolicyAnchor({ link }: { link: PolicyLink }) {
  const className = "font-semibold text-navy underline transition-colors hover:text-gold";
  if (link.href.startsWith("/")) return <Link to={link.href} className={className}>{link.label}</Link>;
  const external = link.href.startsWith("http");
  return (
    <a href={link.href} target={external ? "_blank" : undefined} rel={external ? "noreferrer noopener" : undefined} className={className}>
      {link.label}
    </a>
  );
}
