import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { SiteHeader } from "./SiteHeader";
import { SiteFooter } from "./SiteFooter";

export function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}

export function Breadcrumbs({ items }: { items: { label: string; to?: string }[] }) {
  return (
    <nav className="flex flex-wrap items-center gap-1.5 text-xs text-slate">
      <Link to="/" className="transition-colors hover:text-gold">
        Home
      </Link>
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5">
          <ChevronRight className="h-3.5 w-3.5 text-border" />
          {i.to ? (
            <Link to={i.to} className="transition-colors hover:text-gold">
              {i.label}
            </Link>
          ) : (
            <span className="font-semibold text-navy">{i.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  action,
}: {
  eyebrow?: string;
  title: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-8 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-4">
      <div className="min-w-0">
        {eyebrow && (
          <p className="mb-2 text-[11px] font-bold tracking-[0.2em] text-gold uppercase">{eyebrow}</p>
        )}
        <h2 className="text-2xl font-bold text-navy sm:text-3xl">{title}</h2>
      </div>
      {action}
    </div>
  );
}