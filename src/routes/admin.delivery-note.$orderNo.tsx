import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ArrowLeft, Printer } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  addressLines, companyHeading, copyLabel, deliveryMethodLabel, gateWords, isPickup, isReprint, istDateTime, paperWarnings, slipPages,
  type DeliveryGate, type DeliveryNote, type DeliveryNoteView, type SlipPage,
} from "@/lib/delivery-notes";
import { getDeliveryNote, recordDeliveryPrint } from "@/lib/delivery-notes.functions";

export const Route = createFileRoute("/admin/delivery-note/$orderNo")({
  head: ({ params }) => ({
    meta: [
      { title: `Delivery note ${params.orderNo} | Shami Business Ventures Admin` },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: DeliveryNotePrintPage,
});

/** What the next press prints: the note, every slip, or both. */
type Selection = { note: boolean; slips: number[] };
type Paper = { printedAt: string | null; noteCopy: number | null; slipCopies: Record<string, number>; selection: Selection };

/*
 * On screen the sheets are as wide as the phone or window allows. On paper each is one A4 page (a long
 * note runs on, repeating its table header) and only what was chosen prints, each on its own page.
 * The sheets print only straight after a press of Print, which has just re-checked the payment and
 * recorded the copy. The browser's own print menu gets a line saying to use the button, so no paper can
 * carry a stale check, a wrong copy number or no record.
 */
const PRINT_CSS = `
@page { size: A4 portrait; margin: 10mm; }
@media print {
  html, body { background: #fff !important; }
  [data-sonner-toaster], .dn-screen-only { display: none !important; }
  .dn-root { background: #fff !important; padding: 0 !important; }
  .dn-sheet { box-shadow: none !important; border: 0 !important; margin: 0 !important; padding: 0 !important; max-width: none !important; width: 100% !important; }
  .dn-sheet[data-print="no"] { display: none !important; }
  .dn-sheet[data-print="yes"] ~ .dn-sheet[data-print="yes"] { break-before: page; page-break-before: always; }
  .dn-sheet tr, .dn-keep { break-inside: avoid; page-break-inside: avoid; }
  .dn-sheet thead { display: table-header-group; }
  .dn-root[data-armed="no"] .dn-docs { display: none !important; }
  .dn-root[data-armed="no"] .dn-use-button { display: block !important; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
`;

/** How long after a press the paper may still print (the print screen can be slow on a phone). */
const ARMED_MS = 120_000;

function DeliveryNotePrintPage() {
  const { orderNo } = Route.useParams();
  const [view, setView] = useState<DeliveryNoteView | null>(null);
  const [failed, setFailed] = useState("");
  const [busy, setBusy] = useState(false);
  const [paper, setPaper] = useState<Paper>({ printedAt: null, noteCopy: null, slipCopies: {}, selection: { note: true, slips: [] } });
  const [armed, setArmed] = useState(false);
  // One press allows one print; the browser's print event uses it up.
  const printsAllowed = useRef(0);
  const disarmTimer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const next = await getDeliveryNote({ data: { orderNo, fresh: false } });
      setView(next);
      setFailed("");
      const lines = next.note ? slipPages(next.note.snapshot).map((slip) => slip.slip) : [];
      setPaper((current) => (current.printedAt ? current : { ...current, selection: { note: true, slips: lines } }));
    } catch (cause) {
      setFailed(cause instanceof Error ? cause.message : "Could not open the delivery note");
    }
  }, [orderNo]);

  useEffect(() => { void load(); }, [load]);

  // A second print with no new press (the browser's menu) gets the "use the button" line, not a copy nobody recorded.
  useEffect(() => {
    const onBeforePrint = () => {
      if (printsAllowed.current > 0) { printsAllowed.current -= 1; return; }
      flushSync(() => setArmed(false));
    };
    window.addEventListener("beforeprint", onBeforePrint);
    return () => {
      window.removeEventListener("beforeprint", onBeforePrint);
      window.clearTimeout(disarmTimer.current);
    };
  }, []);

  const press = async (selection: Selection) => {
    setBusy(true);
    try {
      const { record, view: next } = await recordDeliveryPrint({ data: { orderNo, note: selection.note, slipLines: selection.slips } });
      flushSync(() => {
        setView(next);
        setPaper({ selection, printedAt: record.printedAt, noteCopy: record.noteCopy, slipCopies: record.slipCopies });
        setArmed(true);
      });
      printsAllowed.current = 1;
      window.clearTimeout(disarmTimer.current);
      disarmTimer.current = window.setTimeout(() => { printsAllowed.current = 0; setArmed(false); }, ARMED_MS);
      window.print();
    } catch (cause) {
      toast.error("Not printed", { description: cause instanceof Error ? cause.message : "The print could not be recorded" });
    } finally {
      setBusy(false);
    }
  };

  const note = view?.note ?? null;
  const slips = note ? slipPages(note.snapshot) : [];
  const allSlips = slips.map((slip) => slip.slip);
  const state = view?.state;
  const warnings = state && note ? paperWarnings(state) : [];

  return (
    <div className="dn-root min-h-screen bg-stone-200 px-3 py-4 text-black sm:px-6" data-armed={armed ? "yes" : "no"}>
      <style>{PRINT_CSS}</style>
      <p className="dn-use-button hidden text-lg font-bold">Please use the Print button on this page. It checks the payment again and records the print time and copy number.</p>
      <div className="dn-screen-only mx-auto mb-4 max-w-[210mm] space-y-3 rounded-lg bg-white p-3 shadow-sm sm:p-4">
        <Link to="/admin/orders/$id" params={{ id: orderNo }} className="inline-flex items-center gap-1 text-sm font-semibold text-navy hover:text-gold">
          <ArrowLeft className="h-4 w-4" /> Back to order {orderNo}
        </Link>
        {!view && !failed && <p className="text-sm text-slate">Opening the delivery note…</p>}
        {failed && (
          <p className="text-sm text-danger">{failed} <Link to="/admin/login" className="font-semibold underline">Admin sign in</Link></p>
        )}
        {view && !note && state && (
          <p className="text-sm text-danger">This order has no delivery note yet. {gateWords(state).title}: {gateWords(state).detail}</p>
        )}
        {note && (
          <>
            {warnings.length > 0 && (
              <div className="rounded-md border-2 border-red-300 bg-red-50 p-3 text-sm font-bold text-red-900">
                {warnings.map((warning) => <p key={warning}>{warning}</p>)}
                <p className="mt-1 font-normal">These warnings print on the paper. {state ? gateWords(state).detail : ""}</p>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" className="bg-navy text-white hover:bg-navy/90" disabled={busy} onClick={() => void press({ note: true, slips: allSlips })}>
                <Printer className="mr-1.5 h-4 w-4" /> Print note and all {allSlips.length} slip{allSlips.length === 1 ? "" : "s"}
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void press({ note: true, slips: [] })}>Note only</Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void press({ note: false, slips: allSlips })}>All slips only</Button>
            </div>
            {slips.length > 1 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-slate">One slip:</span>
                {slips.map((slip) => (
                  <Button key={slip.slip} size="sm" variant="outline" className="h-8 px-2.5" disabled={busy} onClick={() => void press({ note: false, slips: [slip.slip] })}>{slip.slip}</Button>
                ))}
              </div>
            )}
            <p className="text-xs text-slate">
              Each press of Print checks the payment with Zoho again, puts the exact time on the paper and counts as a copy, even if you then cancel the print screen. On a phone the print screen opens next: choose your printer or Save as PDF. If nothing opens, this browser cannot print from a page (some in-app browsers cannot): open the page in Chrome or Safari.
            </p>
          </>
        )}
      </div>

      {note && state && (
        <div className="dn-docs" data-no-translate>
          <NoteSheet note={note} state={state} warnings={warnings} paper={paper} slipCount={slips.length} />
          {slips.map((slip) => <SlipSheet key={slip.slip} slip={slip} note={note} warnings={warnings} paper={paper} />)}
        </div>
      )}
    </div>
  );
}

const SHEET = "dn-sheet mx-auto mb-4 w-full max-w-[210mm] bg-white p-4 text-[13px] leading-snug shadow-md sm:p-8";

function Warnings({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return (
    <div className="dn-keep my-3 border-[3px] border-black p-3 text-center text-base font-extrabold uppercase tracking-wide">
      {warnings.map((warning) => <p key={warning}>{warning}</p>)}
    </div>
  );
}

function PrintedLine({ printedAt, copy }: { printedAt: string | null; copy: number | null | undefined }) {
  return (
    <>
      <Row label="Printed" value={printedAt ? istDateTime(printedAt) : "Not printed yet: the time appears when you press Print"} strong />
      <Row label="Copy" value={printedAt ? copyLabel(copy) : "—"} strong={isReprint(copy)} />
    </>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-[76px] shrink-0 text-neutral-600">{label}</dt>
      <dd className={`min-w-0 break-words ${strong ? "font-bold" : "font-medium"}`}>{value}</dd>
    </div>
  );
}

function CompanyHead({ note, title, side }: { note: DeliveryNote; title: string; side: string }) {
  const company = companyHeading(note.snapshot.company);
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 border-b-2 border-black pb-3">
      <div className="min-w-0">
        <p className="text-base font-extrabold">{company.name || "Grain Bazar"}</p>
        {company.addressLines.map((line) => <p key={line} className="text-xs">{line}</p>)}
        {(company.gstin || company.phone) && <p className="text-xs">{[company.gstin && `GSTIN ${company.gstin}`, company.phone && `Phone ${company.phone}`].filter(Boolean).join(" · ")}</p>}
      </div>
      <div className="text-right">
        <p className="text-xl font-extrabold uppercase tracking-wide">{title}</p>
        <p className="text-lg font-extrabold">{side}</p>
      </div>
    </header>
  );
}

function Signature({ label }: { label: string }) {
  return (
    <div className="min-w-0">
      <div className="h-14 border-b border-black" />
      <p className="mt-1 text-xs font-semibold">{label}</p>
      <p className="text-[11px] text-neutral-600">Name, date and time</p>
    </div>
  );
}

function NoteSheet({ note, state, warnings, paper, slipCount }: { note: DeliveryNote; state: DeliveryGate; warnings: string[]; paper: Paper; slipCount: number }) {
  const { snapshot } = note;
  const pickup = isPickup(snapshot);
  const godownLines = addressLines(snapshot.godown);
  const customerLines = addressLines(snapshot.address);
  const lines = slipPages(snapshot);
  const totalQty = lines.reduce((sum, line) => sum + Number(line.qty), 0);
  const hasStockNo = lines.some((line) => line.stock_no);
  return (
    <section className={SHEET} data-print={paper.selection.note ? "yes" : "no"}>
      <CompanyHead note={note} title="Delivery note" side={note.note_no} />
      <Warnings warnings={warnings} />
      <dl className="mt-3 grid gap-x-6 gap-y-1 sm:grid-cols-2 print:grid-cols-2">
        <Row label="Order no." value={note.order_no} strong />
        <Row label="Invoice no." value={note.invoice_number} strong />
        <Row label="Order date" value={istDateTime(snapshot.order_placed_at)} />
        <Row label="Generated" value={`${istDateTime(note.generated_at)} by ${note.generated_by_name}`} />
        <PrintedLine printedAt={paper.printedAt} copy={paper.noteCopy} />
        <Row label="Delivery" value={deliveryMethodLabel(snapshot.shipping_method)} />
        <Row label="Payment" value={state.code === "paid" ? "Paid in full" : "See the warning above"} strong />
      </dl>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 print:grid-cols-2">
        <div className="dn-keep min-w-0 border border-neutral-400 p-3">
          <p className="text-[11px] font-bold uppercase tracking-wider text-neutral-600">Customer</p>
          <p className="mt-1 font-bold">{snapshot.customer.business_name || snapshot.customer.name}</p>
          {snapshot.customer.business_name && snapshot.customer.name && <p>{snapshot.customer.name}</p>}
          {snapshot.customer.gstin && <p>GSTIN {snapshot.customer.gstin}</p>}
          {snapshot.customer.phone && <p>Phone {snapshot.customer.phone}</p>}
          {pickup && customerLines.map((line) => <p key={line} className="break-words">{line}</p>)}
        </div>
        <div className="dn-keep min-w-0 border border-neutral-400 p-3">
          {pickup ? (
            <>
              <p className="text-[11px] font-bold uppercase tracking-wider text-neutral-600">Pickup from godown</p>
              <p className="mt-1 font-bold">{snapshot.godown.name}</p>
              {godownLines.map((line) => <p key={line} className="break-words">{line}</p>)}
              {snapshot.godown.phone && <p>Phone {snapshot.godown.phone}</p>}
            </>
          ) : (
            <>
              <p className="text-[11px] font-bold uppercase tracking-wider text-neutral-600">Deliver to</p>
              {snapshot.address.name && <p className="mt-1 font-bold">{snapshot.address.name}</p>}
              {customerLines.map((line) => <p key={line} className="break-words">{line}</p>)}
              {snapshot.address.phone && <p>Phone {snapshot.address.phone}</p>}
              <p className="mt-2 text-[11px] font-bold uppercase tracking-wider text-neutral-600">From godown</p>
              <p className="font-semibold">{snapshot.godown.name}</p>
              {godownLines.map((line) => <p key={line} className="break-words text-xs">{line}</p>)}
            </>
          )}
        </div>
      </div>

      <table className="mt-4 w-full border-collapse text-left text-[13px]">
        <thead>
          {/* Repeats on every page of a long note, so a loose page still says whose it is. */}
          <tr className="text-[11px] font-semibold">
            <th colSpan={hasStockNo ? 5 : 4} className="pb-1 font-semibold">{note.note_no} · Order {note.order_no}</th>
          </tr>
          <tr className="border-y-2 border-black text-[11px] uppercase tracking-wider">
            <th className="py-1.5 pr-2 font-bold">#</th>
            <th className="py-1.5 pr-2 font-bold">Item</th>
            <th className="py-1.5 pr-2 font-bold">Pack size</th>
            <th className="py-1.5 pr-2 text-right font-bold">Quantity</th>
            {hasStockNo && <th className="py-1.5 pl-2 font-bold">Stock no.</th>}
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.line} className="border-b border-neutral-400 align-top">
              <td className="py-1.5 pr-2">{line.line}</td>
              <td className="py-1.5 pr-2">
                <p className="font-semibold break-words">{line.name}</p>
                {line.sku && <p className="text-[11px] text-neutral-600">SKU {line.sku}</p>}
              </td>
              <td className="py-1.5 pr-2">{line.pack_size || "—"}</td>
              <td className="py-1.5 pr-2 text-right text-base font-bold">{line.qty}</td>
              {hasStockNo && <td className="py-1.5 pl-2 break-words">{line.stock_no || "—"}</td>}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-b-2 border-black font-bold">
            <td className="py-1.5 pr-2" colSpan={3}>{lines.length} item line{lines.length === 1 ? "" : "s"} · {slipCount} delivery slip{slipCount === 1 ? "" : "s"}</td>
            <td className="py-1.5 pr-2 text-right text-base">{totalQty}</td>
            {hasStockNo && <td />}
          </tr>
        </tfoot>
      </table>

      <p className="dn-keep mt-6 text-sm"><span className="font-semibold">Vehicle no.</span> ______________________</p>
      <div className="dn-keep mt-6 grid grid-cols-3 gap-4">
        <Signature label="Prepared by" />
        <Signature label="Goods issued by (godown)" />
        <Signature label="Received by (customer)" />
      </div>
    </section>
  );
}

function SlipSheet({ slip, note, warnings, paper }: { slip: SlipPage; note: DeliveryNote; warnings: string[]; paper: Paper }) {
  const { snapshot } = note;
  const copy = paper.slipCopies[String(slip.slip)];
  return (
    <section className={SHEET} data-print={paper.selection.slips.includes(slip.slip) ? "yes" : "no"}>
      <CompanyHead note={note} title="Delivery slip" side={`Slip ${slip.slip} of ${slip.of}`} />
      <Warnings warnings={warnings} />
      <div className="dn-keep my-5 border-2 border-black p-4">
        <p className="text-[11px] font-bold uppercase tracking-wider text-neutral-600">Item</p>
        <p className="text-2xl font-extrabold break-words">{slip.name}</p>
        {slip.sku && <p className="text-sm">SKU {slip.sku}</p>}
        <div className="mt-4 grid grid-cols-2 gap-3">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wider text-neutral-600">Quantity</p>
            <p className="text-4xl font-extrabold">{slip.qty}</p>
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-wider text-neutral-600">Pack size</p>
            <p className="text-2xl font-extrabold break-words">{slip.pack_size || "—"}</p>
          </div>
        </div>
        {slip.stock_no && <p className="mt-3 text-sm font-semibold">Stock no. {slip.stock_no}</p>}
      </div>
      <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2 print:grid-cols-2">
        <Row label="Note no." value={note.note_no} strong />
        <Row label="Order no." value={note.order_no} strong />
        <Row label="Invoice no." value={note.invoice_number} />
        <Row label="Customer" value={snapshot.customer.business_name || snapshot.customer.name} />
        <Row label="Godown" value={snapshot.godown.name ?? ""} />
        <Row label="Delivery" value={deliveryMethodLabel(snapshot.shipping_method)} />
        <Row label="Generated" value={istDateTime(note.generated_at)} />
        <PrintedLine printedAt={paper.printedAt} copy={copy} />
      </dl>
      <div className="dn-keep mt-8 grid grid-cols-2 gap-4">
        <Signature label="Goods issued by (godown)" />
        <Signature label="Received by" />
      </div>
    </section>
  );
}
