import { Link } from "@tanstack/react-router";
import { Facebook, Instagram, Mail, MapPin, Phone, Youtube } from "lucide-react";
import { Logo } from "@/components/brand/Logo";
import { storefrontCategories } from "@/lib/data";

const socials = [
  { Icon: Instagram, href: "https://www.instagram.com/grain_bazar/", label: "Instagram" },
  { Icon: Youtube, href: "https://www.youtube.com/@GrainBazar", label: "YouTube" },
  { Icon: Facebook, href: "https://www.facebook.com/profile.php?id=61593879955539", label: "Facebook" },
];

export function SiteFooter() {
  return (
    <footer className="bg-midnight text-white/70">
      <div className="mx-auto max-w-7xl px-6 py-14">
        <div className="grid gap-10 md:grid-cols-2 lg:grid-cols-4">
          <div>
            <Logo />
            <p className="mt-5 max-w-xs text-sm leading-relaxed">
              A premium multi-vendor marketplace for sugar and everyday essentials, operated by Shami
              Business Ventures Pvt. Ltd. with verified mills and institutional-grade logistics.
            </p>
            <div className="mt-5 flex gap-3">
              {socials.map(({ Icon, href, label }) => (
                <a
                  key={label}
                  href={href}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="grid h-9 w-9 place-items-center rounded-full border border-white/15 transition-colors hover:border-gold hover:text-gold"
                  aria-label={label}
                >
                  <Icon className="h-4 w-4" />
                </a>
              ))}
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold tracking-widest text-gold uppercase">Categories</h3>
            <ul className="mt-5 space-y-3 text-sm">
              {storefrontCategories.map((c) => (
                <li key={c.name}>
                  <Link to="/shop" search={{ category: c.name }} className="transition-colors hover:text-gold">
                    {c.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="text-sm font-semibold tracking-widest text-gold uppercase">Company</h3>
            <ul className="mt-5 space-y-3 text-sm">
              {[
                ["About Us", "/about"],
                ["Contact", "/contact"],
                ["Become a Vendor", "/vendor/register"],
                ["Vendor Login", "/vendor/login"],
                ["Admin Login", "/admin/login"],
              ].map(([label, to]) => (
                <li key={to}>
                  <Link to={to!} className="transition-colors hover:text-gold">
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="text-sm font-semibold tracking-widest text-gold uppercase">Get in touch</h3>
            <ul className="mt-5 space-y-4 text-sm">
              <li className="flex gap-3">
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-gold" />
                Shami House, Industrial Estate, Belagavi, Karnataka 590010
              </li>
              <li className="flex gap-3">
                <Phone className="h-4 w-4 shrink-0 text-gold" /> +91 95385 00840
              </li>
              <li className="flex gap-3">
                <Mail className="h-4 w-4 shrink-0 text-gold" /> care@shamiventures.in
              </li>
            </ul>
          </div>
        </div>

        <div className="hairline-gold mt-12" />
        <div className="flex flex-col gap-2 pt-6 text-xs sm:flex-row sm:items-center sm:justify-between">
          <p>© 2026 Shami Business Ventures Pvt. Ltd. All rights reserved.</p>
          <p>GSTIN 29ABCDE1234F1Z5 · FSSAI 10023456789012</p>
        </div>
      </div>
    </footer>
  );
}