import { Phone } from "lucide-react";
import { useSiteDetails } from "@/lib/site-details";
import { telHref } from "@/lib/site-details-rules";

/** The number on every customer account page, from Admin > Settings > Website details. */
export function CustomerCareLine() {
  const { phone } = useSiteDetails();
  if (!phone) return null;
  return (
    <p className="mt-6 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border pt-4 text-sm text-slate">
      <Phone className="h-4 w-4 shrink-0 text-gold" />
      <span>Customer care:</span>
      <a href={telHref(phone)} className="font-semibold text-navy hover:underline">{phone}</a>
    </p>
  );
}
