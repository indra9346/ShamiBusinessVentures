import { useState } from "react";
import { toast } from "sonner";
import { Hash } from "lucide-react";
import { Panel } from "@/components/panel/widgets";
import { Button } from "@/components/ui/button";
import { forgetZohoContactNumbers } from "@/hooks/use-zoho-contact-numbers";
import { CONTACT_NUMBER_BATCH, contactNumberFetchLines, type ContactNumberFetch } from "@/lib/zoho-contact-numbers";

/**
 * Admin > Zoho Commerce: "Fetch customer and vendor numbers from Zoho" (owner, 12 Nov 2026). Each press asks Zoho for
 * the next linked contacts, a few at a time, and keeps their Customer No. / Vendor No. on the website, where the admin
 * pages, the invoices and the delivery papers show them. Read-only in Zoho. The hourly check and every contact sync keep
 * them up to date after that.
 */
export function ZohoContactNumbersPanel({ connected }: { connected: boolean }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ContactNumberFetch | null>(null);
  const [error, setError] = useState("");

  const fetchNumbers = async () => {
    setBusy(true);
    setError("");
    try {
      const { fetchZohoContactNumbers } = await import("@/lib/zoho-commerce.functions");
      const next = await fetchZohoContactNumbers();
      setResult(next);
      // The pages read the numbers again the next time they open.
      forgetZohoContactNumbers();
      if (!next.needsMigration && !(next.pausedUntil && !next.read)) toast.success("Customer and vendor numbers fetched", { description: `Contacts read from Zoho now: ${next.read}` });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Zoho could not be read");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Customer and vendor numbers">
      <p className="max-w-3xl text-sm leading-relaxed text-slate">
        Zoho Books gives each customer and vendor a number (Customer No. / Vendor No.). The website shows it on the customer and vendor pages, on orders, on invoices and on delivery notes and slips.
      </p>
      <p className="mb-3 mt-1 max-w-3xl text-sm leading-relaxed text-slate">
        {`Each press reads up to ${CONTACT_NUMBER_BATCH} linked contacts from Zoho. Nothing is changed in Zoho.`}
      </p>
      <Button size="sm" className="bg-navy text-white hover:bg-navy/90" disabled={busy || !connected} onClick={() => void fetchNumbers()}>
        <Hash className={`mr-1.5 h-4 w-4 ${busy ? "animate-pulse" : ""}`} />
        {busy ? "Fetching numbers…" : "Fetch customer and vendor numbers from Zoho"}
      </Button>
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      {result && (
        <div className="mt-3 space-y-1 text-sm text-navy" role="status">
          {contactNumberFetchLines(result).map((line) => <p key={line}>{line}</p>)}
          {result.failed.length > 0 && (
            <p className="text-xs text-slate">
              <span>Zoho contact IDs not read:</span> <span data-no-translate className="font-mono">{result.failed.join(", ")}</span>
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}
