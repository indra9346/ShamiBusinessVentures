import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { LogoMark } from "@/components/brand/Logo";
import { LanguageSwitcher } from "@/components/site/LanguageSwitcher";

export function AuthCard({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="grid min-h-screen bg-hero-gradient lg:grid-cols-2">
      <div className="relative hidden flex-col justify-between p-12 lg:flex">
        <Link to="/">
          <LogoMark className="h-12 brightness-0 invert-[0.97]" />
        </Link>
        <div>
          <h2 className="max-w-md text-3xl leading-tight font-extrabold text-white">
            A premium, trustworthy <span className="text-gold">business marketplace</span>
          </h2>
          <p className="mt-4 max-w-md text-sm text-white/60">
            Mill-direct sugar and essentials, verified vendors, and complete order visibility for customers,
            vendors and administrators.
          </p>
        </div>
        <p className="text-xs text-white/40">© 2026 Shami Business Ventures Pvt. Ltd.</p>
      </div>

      <div className="flex items-center justify-center bg-background p-6 sm:p-12">
        <div className="w-full max-w-md">
          <div className="flex items-center justify-between gap-3">
            <div className="lg:hidden">
              <LogoMark className="h-11" />
            </div>
            <LanguageSwitcher className="ml-auto" />
          </div>
          <h1 className="mt-6 text-2xl font-bold text-navy">{title}</h1>
          <p className="mt-1.5 text-sm text-slate">{subtitle}</p>
          <div className="mt-8 space-y-4">{children}</div>
          {footer && <div className="mt-6 text-sm text-slate">{footer}</div>}
        </div>
      </div>
    </div>
  );
}