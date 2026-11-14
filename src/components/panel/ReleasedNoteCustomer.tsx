import { useState } from "react";
import { ChevronDown, Store } from "lucide-react";
import { cn } from "@/lib/utils";

/** The customer's details on a released note, as godown_released_notes() returns them (20261114120000). */
export type ReleasedNoteCustomerDetails = { shop?: string; contact?: string; phone?: string; address?: string };

/**
 * The customer's shop name, name, phone and address on a released note, behind a button so the list stays short (owner,
 * 14 Nov 2026, on the partner's list: "need option to view shop name & phone number & address"). The database fills them
 * only for whoever may print the full delivery note (Admin > Delivery QR rules), so anyone else sees no button. The phone
 * can be tapped to call.
 */
export function ReleasedNoteCustomer({ row }: { row: ReleasedNoteCustomerDetails }) {
  const [open, setOpen] = useState(false);
  const shop = (row.shop ?? "").trim();
  const contact = (row.contact ?? "").trim();
  const phone = (row.phone ?? "").trim();
  const address = (row.address ?? "").trim();
  if (!shop && !contact && !phone && !address) return null;
  const dial = phone.replace(/[^\d+]/g, "");
  return (
    <div className="basis-full">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1 rounded-md py-0.5 text-xs font-semibold text-navy hover:text-gold">
        <Store className="h-3.5 w-3.5" />
        <span>{open ? "Hide customer details" : "Customer details"}</span>
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg border border-border bg-muted/40 p-2 text-xs">
          {shop && <><dt className="text-slate">Shop name</dt><dd className="break-words font-semibold text-charcoal">{shop}</dd></>}
          {contact && <><dt className="text-slate">Name</dt><dd className="break-words text-charcoal">{contact}</dd></>}
          {phone && (
            <><dt className="text-slate">Phone</dt><dd>{dial ? <a href={`tel:${dial}`} className="font-semibold text-navy underline-offset-2 hover:text-gold hover:underline">{phone}</a> : phone}</dd></>
          )}
          {address && <><dt className="text-slate">Address</dt><dd className="break-words text-charcoal">{address}</dd></>}
        </dl>
      )}
    </div>
  );
}
