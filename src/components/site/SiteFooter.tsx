import { Link } from "@tanstack/react-router";
import { Facebook, Instagram, Mail, MapPin, Phone, Youtube } from "lucide-react";
import { Logo } from "@/components/brand/Logo";
import { storefrontCategories } from "@/lib/data";
import webHostingBabaLogo from "@/assets/web-hosting-baba-logo.png";

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
        <div className="flex flex-col gap-4 pt-6 text-xs sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p>© 2026 Shami Business Ventures Pvt. Ltd. All rights reserved.</p>
            <p className="mt-0.5 text-white/50">GSTIN 29ABCDE1234F1Z5 · FSSAI 10023456789012</p>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 text-white/75 text-xs sm:text-[13px]">
            <span className="font-medium tracking-wide">Designed &amp; Developed with</span>
            <span
              className="inline-flex items-center mx-1 select-none align-middle"
              aria-label="love"
              title="Crafted with passion"
            >
              <span className="inline-block animate-realistic-3d-heart transform-gpu">
                <svg
                  viewBox="0 0 32 32"
                  className="h-4.5 w-4.5 sm:h-5 sm:w-5"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <defs>
                    <radialGradient id="footerHeart3d" cx="35%" cy="30%" r="65%">
                      <stop offset="0%" stopColor="#ff5a79" />
                      <stop offset="40%" stopColor="#ef233c" />
                      <stop offset="85%" stopColor="#a30022" />
                      <stop offset="100%" stopColor="#590012" />
                    </radialGradient>
                    <linearGradient id="footerHeartHighlight" x1="20%" y1="15%" x2="55%" y2="55%">
                      <stop offset="0%" stopColor="#ffffff" stopOpacity="0.85" />
                      <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
                    </linearGradient>
                  </defs>
                  <path
                    d="M16 28.5C15.6 28.5 15.2 28.3 14.9 28C11.5 24.6 3 17.5 3 10.5C3 5.8 6.8 2 11.5 2C13.8 2 15.1 3.1 16 4.2C16.9 3.1 18.2 2 20.5 2C25.2 2 29 5.8 29 10.5C29 17.5 20.5 24.6 17.1 28C16.8 28.3 16.4 28.5 16 28.5Z"
                    fill="url(#footerHeart3d)"
                  />
                  <ellipse
                    cx="10.5"
                    cy="7.5"
                    rx="4.5"
                    ry="2.5"
                    transform="rotate(-35 10.5 7.5)"
                    fill="url(#footerHeartHighlight)"
                  />
                </svg>
              </span>
            </span>
            <span className="font-medium tracking-wide">by</span>
            <a
              href="https://webhostingbaba.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center transition-all duration-300 hover:scale-105 hover:opacity-95"
              title="Web Hosting Baba — https://webhostingbaba.com/"
            >
              <img
                src={webHostingBabaLogo}
                alt="Web Hosting Baba"
                className="h-6 w-auto object-contain rounded shadow-sm"
              />
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
