import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ArrowLeft, Printer, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { renderSVG } from "uqr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  addressLines, companyHeading, copyLabel, deliveryMethodLabel, gateWords, isPickup, istDateTime, paperWarnings, slipPages,
  type DeliveryGate, type DeliveryNote, type DeliveryNoteView, type SlipPage,
} from "@/lib/delivery-notes";
import {
  handedOverWarning, paperKindWords, paperLink, paperStamp, personWords, qrCaption, type DeliveryPaperRow, type PaperHandover, type PaperPrint,
} from "@/lib/delivery-papers";
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
/** What the last press printed. The QR codes exist only here, in this tab: the database keeps their hashes. */
type Paper = {
  printedAt: string | null; noteCopy: number | null; slipCopies: Record<string, number>; selection: Selection;
  noteCode: string | null; slipCodes: Record<string, string>;
  notePaper: PaperPrint | null; slipPapers: Record<string, PaperPrint>;
};

/*
 * On screen the sheets are as wide as the phone or window allows. On paper each is one A4 page (a long
 * note runs on, repeating its table header) and only what was chosen prints, each on its own page.
 * The sheets print only for a few minutes after a press of Print, which has just re-checked the payment
 * and recorded the copy. Otherwise the browser's own print menu gets a line saying to use the button, so
 * a tab left open can't print a stale check or a copy nobody recorded.
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
  .dn-sheet tfoot { display: table-row-group; }
  .dn-root[data-armed="no"] .dn-docs { display: none !important; }
  .dn-root[data-armed="no"] .dn-use-button { display: block !important; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
`;

/**
 * How long after a press the paper may still print. A phone's print screen asks for the page after
 * print() returns, and again if the paper size is changed, so this can't be one print only.
 */
const ARMED_MS = 300_000;

const EMPTY_PAPER: Paper = { printedAt: null, noteCopy: null, slipCopies: {}, selection: { note: true, slips: [] }, noteCode: null, slipCodes: {}, notePaper: null, slipPapers: {} };

/** Each paper's prints so far, from the database: "note" and "slip:2". */
function printsByPaper(papers: DeliveryPaperRow[]) {
  const map = new Map<string, DeliveryPaperRow[]>();
  for (const row of papers) {
    const key = row.doc === "note" ? "note" : `slip:${row.slip_line}`;
    map.set(key, [...(map.get(key) ?? []), row]);
  }
  return map;
}

/** "Original printed 10 Nov, 2:05 PM · 2 duplicates" for the screen. */
function printedSoFar(rows: DeliveryPaperRow[] | undefined) {
  if (!rows?.length) return "not printed yet: the next print is the original";
  const current = [...rows].reverse().find((row) => row.kind !== "duplicate");
  const duplicates = rows.filter((row) => row.kind === "duplicate").length;
  const replaced = rows.filter((row) => row.kind === "replacement").length;
  return [
    current ? `${paperKindWords(current.kind).en.toLowerCase()} printed ${istDateTime(current.printed_at)}` : "",
    replaced ? `${replaced} replacement${replaced === 1 ? "" : "s"}` : "",
    duplicates ? `${duplicates} duplicate${duplicates === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" · ");
}

function DeliveryNotePrintPage() {
  const { orderNo } = Route.useParams();
  const [view, setView] = useState<DeliveryNoteView | null>(null);
  const [failed, setFailed] = useState("");
  const [busy, setBusy] = useState(false);
  const [paper, setPaper] = useState<Paper>(EMPTY_PAPER);
  const [armed, setArmed] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [reason, setReason] = useState("");
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

  useEffect(() => () => window.clearTimeout(disarmTimer.current), []);

  const press = async (selection: Selection, replaceReason?: string) => {
    setBusy(true);
    try {
      const { record, view: next } = await recordDeliveryPrint({ data: { orderNo, note: selection.note, slipLines: selection.slips, replaceReason } });
      flushSync(() => {
        setView(next);
        setPaper({
          selection, printedAt: record.printedAt, noteCopy: record.noteCopy, slipCopies: record.slipCopies,
          noteCode: record.noteCode, slipCodes: record.slipCodes, notePaper: record.notePaper, slipPapers: record.slipPapers,
        });
        setArmed(true);
        if (replaceReason) { setReplacing(false); setReason(""); }
      });
      window.clearTimeout(disarmTimer.current);
      window.print();
      disarmTimer.current = window.setTimeout(() => setArmed(false), ARMED_MS);
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
  // The items handed over now: a handover an administrator has reopened no longer counts.
  const reopened = new Set((view?.reopens ?? []).map((row) => row.handover_id));
  const handovers: Record<string, PaperHandover> = Object.fromEntries((view?.handovers ?? []).filter((row) => !reopened.has(row.id)).map((row) => [String(row.slip_line), {
    at: row.handed_over_at, by: row.actor_name, role: row.actor_role === "admin" || row.actor_role === "partner" ? row.actor_role : "staff",
    godown: row.branch_name, registered_phone: row.device_registered, round: row.round,
  } satisfies PaperHandover]));
  const handedLines = Object.keys(handovers).map(Number).sort((a, b) => a - b);
  const openSlips = allSlips.filter((line) => !handovers[String(line)]);
  const noteWarnings = handedLines.length === 0 ? warnings : [...warnings, handedLines.length === slips.length
    ? "ALL ITEMS ALREADY HANDED OVER. FOR RECORDS ONLY. DO NOT DELIVER AGAIN."
    : `ITEM${handedLines.length === 1 ? "" : "S"} ${handedLines.join(", ")} ALREADY HANDED OVER. DELIVER ONLY THE REST.`];
  const prints = printsByPaper(view?.papers ?? []);
  const hasOriginal = (key: string) => (prints.get(key) ?? []).some((row) => row.kind !== "duplicate");
  const replaceable = [...(hasOriginal("note") && openSlips.length ? ["note"] : []), ...openSlips.filter((line) => hasOriginal(`slip:${line}`)).map(String)];

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
            {view?.qrReady === false && (
              <p className="rounded-md border-2 border-red-300 bg-red-50 p-3 text-sm font-bold text-red-900">
                Printing is paused: the database doesn't have the delivery-slip QR update yet, so the papers would have no QR code. Ask your developer to apply it.
              </p>
            )}
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
            <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-950">
              <p>
                <span className="font-bold">QR codes:</span> the first print of each paper is its <span className="font-bold">original</span>, the only paper that hands goods over (once per item). Every later print is a <span className="font-bold">duplicate copy</span> 1, 2, … for records: it is stamped DUPLICATE and its QR scans red.
              </p>
              <ul className="mt-1 space-y-0.5">
                <li>Note: {printedSoFar(prints.get("note"))}</li>
                {slips.map((slip) => <li key={slip.slip}>Slip {slip.slip}: {printedSoFar(prints.get(`slip:${slip.slip}`))}</li>)}
              </ul>
            </div>
            {replaceable.length > 0 && (
              replacing ? (
                <div className="space-y-2 rounded-md border-2 border-navy p-3 text-xs">
                  <p className="font-bold text-navy">Replacement original</p>
                  <p>For an original that was lost or never came out of the printer. The new paper says REPLACEMENT ORIGINAL; the old original's QR stops working. Only for goods still to go.</p>
                  <Input aria-label="Why the original is being replaced" value={reason} maxLength={300} onChange={(event) => setReason(event.target.value)}
                    placeholder="Reason, for example: print screen was cancelled" className="h-8 text-xs" />
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-slate">Replace:</span>
                    {replaceable.map((key) => (
                      <Button key={key} size="sm" className="h-8 bg-navy px-2.5 text-white hover:bg-navy/90" disabled={busy || reason.trim().length < 3}
                        onClick={() => void press(key === "note" ? { note: true, slips: [] } : { note: false, slips: [Number(key)] }, reason.trim())}>
                        {key === "note" ? "Note" : `Slip ${key}`}
                      </Button>
                    ))}
                    <Button size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => setReplacing(false)}>Back</Button>
                  </div>
                </div>
              ) : (
                <button type="button" className="flex items-center gap-1 text-xs font-semibold text-navy hover:underline" onClick={() => setReplacing(true)}>
                  <RotateCcw className="h-3.5 w-3.5" /> Original lost or didn't print? Replacement original…
                </button>
              )
            )}
            {handedLines.length > 0 && (
              <ul className="space-y-0.5 text-xs text-emerald-900">
                {handedLines.map((line) => {
                  const handover = handovers[String(line)]!;
                  return <li key={line}>Slip {line} handed over {istDateTime(handover.at)} by {personWords(handover.by, handover.role, handover.godown, handover.registered_phone).en}</li>;
                })}
              </ul>
            )}
          </>
        )}
      </div>

      {note && state && (
        <div className="dn-docs" data-no-translate>
          <NoteSheet note={note} state={state} warnings={noteWarnings} paper={paper} slipCount={slips.length} />
          {slips.map((slip) => (
            <SlipSheet key={slip.slip} slip={slip} note={note} paper={paper}
              warnings={handovers[String(slip.slip)] ? [...warnings, handedOverWarning(handovers[String(slip.slip)])] : warnings} />
          ))}
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

/** The big stamp on a duplicate (and the replacement note on a replacement original), in both languages. */
function Stamp({ print }: { print: PaperPrint | null | undefined }) {
  const stamp = paperStamp(print);
  if (!stamp) return null;
  const duplicate = print?.kind === "duplicate";
  return (
    <div className={`dn-keep my-3 border-[4px] border-black p-3 text-center ${duplicate ? "bg-neutral-100" : ""}`}>
      <p className={`${duplicate ? "text-3xl" : "text-2xl"} font-black uppercase tracking-widest`}>{stamp.title.en}</p>
      <p className={`${duplicate ? "text-2xl" : "text-xl"} font-black`}>{stamp.title.kn}</p>
      <p className="mt-1 text-xs font-bold uppercase">{stamp.detail.en}</p>
      <p className="text-xs font-bold">{stamp.detail.kn}</p>
    </div>
  );
}

/** The copy line: what this paper is. Before a press, or for a paper the last press didn't print, there is nothing yet. */
function PrintedLine({ printedAt, copy, print, inPrint }: { printedAt: string | null; copy: number | null | undefined; print: PaperPrint | null | undefined; inPrint: boolean }) {
  const label = print ? paperKindWords(print.kind, print.duplicate_no).en : copyLabel(copy);
  const printed = Boolean(printedAt && inPrint);
  return (
    <>
      <Row label="Printed" value={printed ? istDateTime(printedAt!) : printedAt ? "Not in the last print" : "Not printed yet: the time appears when you press Print"} strong />
      <Row label="Copy" value={printed ? label : "—"} strong={Boolean(printed && print && print.kind !== "original")} />
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

/**
 * The paper's QR: a link to the scan page with this copy's code after "#". Before a press there is no code, so the
 * sheet shows where it will be. The caption says what the paper is, in both languages.
 */
function PaperQr({ code, print, size }: { code: string | null | undefined; print: PaperPrint | null | undefined; size: "note" | "slip" }) {
  // About 0.8 mm (note) and 1 mm (slip) per square: easy for a phone held at arm's length.
  const box = size === "slip" ? "h-[40mm] w-[40mm]" : "h-[34mm] w-[34mm]";
  const caption = qrCaption(print?.kind, print?.duplicate_no);
  return (
    <figure className={`dn-keep ${size === "slip" ? "w-[40mm]" : "w-[34mm]"} shrink-0 text-center`}>
      {code ? (
        <div className={`${box} mx-auto [&>svg]:h-full [&>svg]:w-full`} role="img" aria-label="QR code to check this paper"
          // uqr returns a self-contained <svg> of the QR code (no scripts). A white border of 4 squares, as the QR
          // standard asks, so every reader finds the code's edges.
          dangerouslySetInnerHTML={{ __html: renderSVG(paperLink(window.location.origin, code), { ecc: "M", border: 4 }) }} />
      ) : (
        <div className={`${box} mx-auto grid place-items-center border-2 border-dashed border-neutral-400 p-2 text-[11px] text-neutral-600`}>
          The QR code appears when you press Print
        </div>
      )}
      {code && (
        <figcaption className="mt-1 text-[10px] leading-tight text-neutral-700">
          <span className="block font-bold uppercase">{paperKindWords(print?.kind, print?.duplicate_no).en} · {paperKindWords(print?.kind, print?.duplicate_no).kn}</span>
          <span className="block">{caption.en}</span>
          <span className="block">{caption.kn}</span>
        </figcaption>
      )}
    </figure>
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
      <Stamp print={paper.noteCode ? paper.notePaper : null} />
      <Warnings warnings={warnings} />
      <div className="mt-3 flex flex-wrap items-start gap-4">
        <dl className="grid min-w-0 flex-1 basis-[60%] gap-x-6 gap-y-1 sm:grid-cols-2 print:grid-cols-2">
          <Row label="Order no." value={note.order_no} strong />
          <Row label="Invoice no." value={note.invoice_number} strong />
          <Row label="Order date" value={istDateTime(snapshot.order_placed_at)} />
          <Row label="Generated" value={`${istDateTime(note.generated_at)} by ${note.generated_by_name}`} />
          <PrintedLine printedAt={paper.printedAt} copy={paper.noteCopy} print={paper.notePaper} inPrint={paper.selection.note} />
          <Row label="Delivery" value={deliveryMethodLabel(snapshot.shipping_method)} />
          <Row label="Payment" value={state.code === "paid" ? "Paid in full" : "See the warning above"} strong />
        </dl>
        <PaperQr code={paper.noteCode} print={paper.notePaper} size="note" />
      </div>

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
            <th colSpan={hasStockNo ? 5 : 4} className="pb-1 font-semibold">
              {note.note_no} · Order {note.order_no}{paper.notePaper && paper.notePaper.kind !== "original" ? ` · ${paperKindWords(paper.notePaper.kind, paper.notePaper.duplicate_no).en.toUpperCase()}` : ""}
            </th>
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
  const code = paper.slipCodes[String(slip.slip)];
  const print = paper.slipPapers[String(slip.slip)];
  return (
    <section className={SHEET} data-print={paper.selection.slips.includes(slip.slip) ? "yes" : "no"}>
      <CompanyHead note={note} title="Delivery slip" side={`Slip ${slip.slip} of ${slip.of}`} />
      <Stamp print={code ? print : null} />
      <Warnings warnings={warnings} />
      <div className="dn-keep my-5 flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1 basis-[60%] border-2 border-black p-4">
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
        <PaperQr code={code} print={print} size="slip" />
      </div>
      <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2 print:grid-cols-2">
        <Row label="Note no." value={note.note_no} strong />
        <Row label="Order no." value={note.order_no} strong />
        <Row label="Invoice no." value={note.invoice_number} />
        <Row label="Customer" value={snapshot.customer.business_name || snapshot.customer.name} />
        <Row label="Godown" value={snapshot.godown.name ?? ""} />
        <Row label="Delivery" value={deliveryMethodLabel(snapshot.shipping_method)} />
        <Row label="Generated" value={istDateTime(note.generated_at)} />
        <PrintedLine printedAt={paper.printedAt} copy={copy} print={print} inPrint={paper.selection.slips.includes(slip.slip)} />
      </dl>
      <div className="dn-keep mt-8 grid grid-cols-2 gap-4">
        <Signature label="Goods issued by (godown)" />
        <Signature label="Received by" />
      </div>
    </section>
  );
}
