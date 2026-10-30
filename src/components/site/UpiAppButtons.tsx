import type { ReactElement } from "react";
import { upiAppLinks } from "@/lib/upi-pay";

/*
 * The UPI app buttons on the pay screen: each app's own mark in its colours, as large tiles that
 * are easy to tap with a thumb. The marks are drawn inline (no image downloads).
 */

function GooglePayMark() {
  return (
    <svg viewBox="0 0 40 40" className="h-9 w-9" aria-hidden>
      <rect width="40" height="40" rx="10" fill="#fff" />
      <path d="M27.6 20.3c0-.6-.1-1.2-.2-1.8H20v3.4h4.3a3.7 3.7 0 0 1-1.6 2.4v2h2.6c1.5-1.4 2.3-3.5 2.3-6Z" fill="#4285F4" />
      <path d="M20 28c2.2 0 4-.7 5.3-1.9l-2.6-2a4.8 4.8 0 0 1-7.2-2.5h-2.7v2.1A8 8 0 0 0 20 28Z" fill="#34A853" />
      <path d="M15.5 21.6a4.8 4.8 0 0 1 0-3.2v-2.1h-2.7a8 8 0 0 0 0 7.4l2.7-2.1Z" fill="#FBBC04" />
      <path d="M20 15.2c1.2 0 2.3.4 3.2 1.2l2.3-2.3A8 8 0 0 0 12.8 16.3l2.7 2.1a4.8 4.8 0 0 1 4.5-3.2Z" fill="#EA4335" />
    </svg>
  );
}

function PhonePeMark() {
  return (
    <svg viewBox="0 0 40 40" className="h-9 w-9" aria-hidden>
      <rect width="40" height="40" rx="10" fill="#5F259F" />
      <text x="20" y="27" textAnchor="middle" fontSize="19" fontWeight="700" fill="#fff" fontFamily="'Noto Sans Devanagari','Mangal',sans-serif">पे</text>
    </svg>
  );
}

function PaytmMark() {
  return (
    <svg viewBox="0 0 40 40" className="h-9 w-9" aria-hidden>
      <rect width="40" height="40" rx="10" fill="#fff" />
      <text x="20" y="24.5" textAnchor="middle" fontSize="12.5" fontWeight="800" fontFamily="Arial,Helvetica,sans-serif" letterSpacing="-0.4">
        <tspan fill="#002E6E">Pay</tspan><tspan fill="#00BAF2">tm</tspan>
      </text>
    </svg>
  );
}

function UpiMark() {
  return (
    <svg viewBox="0 0 40 40" className="h-9 w-9" aria-hidden>
      <rect width="40" height="40" rx="10" fill="#fff" />
      <path d="M22.5 11.5 28.5 20l-6 8.5 1.6-8.5-1.6-8.5Z" fill="#097939" />
      <path d="M18.5 11.5 24.5 20l-6 8.5 1.6-8.5-1.6-8.5Z" fill="#ED752E" />
      <text x="11.5" y="23.4" textAnchor="middle" fontSize="8.5" fontWeight="800" fontStyle="italic" fill="#3D3D3D" fontFamily="Arial,Helvetica,sans-serif">UPI</text>
    </svg>
  );
}

const MARKS: Record<string, () => ReactElement> = {
  "Google Pay": GooglePayMark,
  PhonePe: PhonePeMark,
  Paytm: PaytmMark,
  "Any UPI app": UpiMark,
};

export function UpiAppButtons({ uri }: { uri: string }) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {upiAppLinks(uri).map((link) => {
        const Mark = MARKS[link.app] ?? UpiMark;
        return (
          <a
            key={link.app}
            href={link.href}
            className="flex min-h-[4.5rem] flex-col items-center justify-center gap-1.5 rounded-xl border border-border bg-white px-1 py-2 text-center shadow-xs transition-colors hover:border-gold active:bg-ivory"
          >
            <span data-no-translate className="overflow-hidden rounded-[10px] ring-1 ring-black/5">
              <Mark />
            </span>
            <span className="text-[11px] font-semibold leading-tight text-navy">{link.app}</span>
          </a>
        );
      })}
    </div>
  );
}
