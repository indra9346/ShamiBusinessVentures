import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, Clock, FileCheck2, Printer, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Panel } from "@/components/panel/widgets";
import { Button } from "@/components/ui/button";
import { inrPrecise } from "@/lib/data";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { copyLabel, gateWords, istDateTime, paperWarnings, type DeliveryNoteEvent, type DeliveryNoteView } from "@/lib/delivery-notes";
import { generateDeliveryNote, getDeliveryNote, reopenDeliveryHandover, setDeliveryStop } from "@/lib/delivery-notes.functions";
import { paperKindWords, scanIsRefusal, scannedPaperLabel, scannerLabel, scanResultLabel, type DeliveryPaperRow } from "@/lib/delivery-papers";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const TONES = {
  ok: "border-emerald-200 bg-emerald-50 text-emerald-900",
  wait: "border-amber-200 bg-amber-50 text-amber-900",
  stop: "border-red-200 bg-red-50 text-red-900",
};

function eventText(event: DeliveryNoteEvent, papers: Map<number, DeliveryPaperRow>) {
  const who = event.actor_name ? ` by ${event.actor_name}` : "";
  if (event.kind === "generated") return `Generated${who}`;
  if (event.kind === "printed") {
    const what = event.doc === "note" ? "Note" : `Slip ${event.slip_line}`;
    const warned = event.gate_code && event.gate_code !== "paid" ? " (printed with a warning)" : "";
    // A print made with a QR is labelled by its paper: original, duplicate copy n or replacement original.
    const paper = papers.get(event.id);
    const label = paper ? paperKindWords(paper.kind, paper.duplicate_no).en : copyLabel(event.copy_no);
    return `${what} printed${who}: ${label}${paper?.reason ? ` (${paper.reason})` : ""}${warned}`;
  }
  if (event.kind === "invoice_changed") return `Zoho invoice changed: ${event.detail}`;
  if (event.kind === "order_changed") return `Order changed: ${event.detail}`;
  return event.detail;
}

/**
 * Which items were handed over at the godown on a QR scan (each round, and an administrator's reopenings), the
 * reopen button, and every scan of this note's papers.
 */
function HandoverList({ view, orderNo, readOnly, onView }: { view: DeliveryNoteView; orderNo: string; readOnly: boolean; onView: (next: DeliveryNoteView) => void }) {
  const [reopening, setReopening] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const lines = view.note ? view.note.snapshot.items.length : 0;
  const reopens = new Map(view.reopens.map((row) => [row.handover_id, row]));
  const rounds = (line: number) => view.handovers.filter((row) => row.slip_line === line);
  const current = (line: number) => rounds(line).find((row) => !reopens.has(row.id)) ?? null;
  const done = (view.note?.snapshot.items ?? []).filter((item) => current(item.line)).length;
  const deliveredByHandover = view.scans.some((scan) => scan.order_delivered);

  const reopen = async (line: number) => {
    setBusy(true);
    try {
      const result = await reopenDeliveryHandover({ data: { orderNo, line, reason } });
      onView(result.view);
      setReopening(null);
      setReason("");
      toast.success(`Item ${line} reopened`, {
        description: result.orderStatus === "Delivered"
          ? "The order is still marked Delivered, here and in Zoho. If the goods did not go, change the order's status and Zoho's delivery yourself."
          : "Its original can hand it over again.",
        duration: 12_000,
      });
    } catch (cause) {
      toast.error("Could not reopen the item", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <p className="text-xs font-bold uppercase tracking-wider text-slate">Handed over at the godown ({done} of {lines})</p>
      {deliveredByHandover && (
        <p className="text-xs font-semibold text-emerald-800">
          The handover of the last item marked this order Delivered{(() => {
            const scan = view.scans.find((row) => row.order_delivered);
            return scan ? ` (${istDateTime(scan.occurred_at)}, by ${scan.actor_name})` : "";
          })()}.
        </p>
      )}
      <ul className="space-y-1.5 text-xs text-charcoal">
        {(view.note?.snapshot.items ?? []).map((item) => {
          const row = current(item.line);
          const history = rounds(item.line).filter((round) => reopens.has(round.id));
          return (
            <li key={item.line} className="break-words">
              <div className="flex items-start gap-1.5">
                {row ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-700" /> : <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate" />}
                <span className="min-w-0">
                  <span className="font-semibold">Slip {item.line}</span> {item.name}:{" "}
                  {row
                    ? `${istDateTime(row.handed_over_at)} by ${scannerLabel({ actor_name: row.actor_name, actor_role: row.actor_role, branch_name: row.branch_name, device_registered: row.device_registered, device_label: row.device_label })}${row.round > 1 ? `, round ${row.round}` : ""}${row.gate_source === "last_reading" ? ". Zoho could not be read then; checked on the last reading" : ""}`
                    : "not handed over yet"}
                  {row && !readOnly && reopening !== item.line && (
                    <button type="button" className="ml-1.5 font-semibold text-danger hover:underline" onClick={() => { setReopening(item.line); setReason(""); }}>Reopen</button>
                  )}
                </span>
              </div>
              {history.map((round) => (
                <p key={round.id} className="ml-5 text-slate">
                  Round {round.round}: handed over {istDateTime(round.handed_over_at)} by {round.actor_name}; reopened {istDateTime(reopens.get(round.id)!.reopened_at)} by {reopens.get(round.id)!.actor_name}: {reopens.get(round.id)!.reason}
                </p>
              ))}
              {reopening === item.line && (
                <div className="ml-5 mt-1 flex flex-wrap items-center gap-1.5">
                  <Input aria-label={`Why item ${item.line} is reopened`} value={reason} maxLength={300} onChange={(event) => setReason(event.target.value)}
                    placeholder="Reason, for example: pressed by mistake, goods still in godown" className="h-8 min-w-0 flex-1 text-xs sm:max-w-sm" />
                  <Button size="sm" className="h-8 bg-danger text-white hover:bg-danger/90" disabled={busy || reason.trim().length < 3} onClick={() => void reopen(item.line)}>Reopen item {item.line}</Button>
                  <Button size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => setReopening(null)}>Back</Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {view.scans.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer font-semibold text-navy">QR scans ({view.scans.length}{view.scans.some((scan) => scanIsRefusal(scan.result)) ? `, ${view.scans.filter((scan) => scanIsRefusal(scan.result)).length} refused` : ""})</summary>
          <ul className="mt-1 space-y-1 text-charcoal">
            {view.scans.slice(0, 50).map((scan) => (
              <li key={scan.id} className={cn("break-words", scanIsRefusal(scan.result) && "text-red-800")}>
                <span className="text-slate">{istDateTime(scan.occurred_at)}</span> · {scannedPaperLabel(scan)} · {scanResultLabel(scan.result)}
                {scan.lines.length > 0 ? ` (item${scan.lines.length === 1 ? "" : "s"} ${scan.lines.join(", ")})` : ""}{scan.order_delivered ? " · order marked Delivered" : ""} · {scannerLabel(scan)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * The order's delivery note on the admin order page: why it cannot be generated yet, or the note, its
 * warnings and who generated and printed it. Whatever this shows, the database decides again on the press.
 * readOnly (the sales order is void in Zoho): only a note already made shows, with its warnings, and nothing to press.
 */
export function DeliveryNotePanel({ orderNo, className = "", readOnly = false }: { orderNo: string; className?: string; readOnly?: boolean }) {
  const [view, setView] = useState<DeliveryNoteView | null>(null);
  const [failed, setFailed] = useState("");
  const [busy, setBusy] = useState<"" | "check" | "generate" | "stop">("");
  const [stopping, setStopping] = useState(false);
  const [reason, setReason] = useState("");

  // Opening the page adds no Zoho call; Check again and Generate read Zoho now.
  const check = useCallback(async (fresh: boolean) => {
    if (STATIC_DATA_MODE) return;
    setBusy("check");
    try {
      setView(await getDeliveryNote({ data: { orderNo, fresh } }));
      setFailed("");
    } catch (cause) {
      setFailed(cause instanceof Error ? cause.message : "Could not check the payment");
    } finally {
      setBusy("");
    }
  }, [orderNo]);

  useEffect(() => { void check(false); }, [check]);

  const changeStop = async (stopped: boolean) => {
    setBusy("stop");
    try {
      setView(await setDeliveryStop({ data: { orderNo, stopped, reason } }));
      setStopping(false);
      setReason("");
      toast.success(stopped ? "Delivery stopped" : "Stop lifted");
    } catch (cause) {
      toast.error("Could not change the stop", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy("");
    }
  };

  const generate = async () => {
    setBusy("generate");
    try {
      const result = await generateDeliveryNote({ data: { orderNo } });
      setView(result.view);
      setFailed("");
      if (result.issued && result.view.note) toast.success(`Delivery note ${result.view.note.note_no} generated`);
      else if (!result.view.note) toast.error("The delivery note was not generated", { description: gateWords(result.view.state).title });
    } catch (cause) {
      toast.error("Could not generate the delivery note", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy("");
    }
  };

  if (STATIC_DATA_MODE) {
    if (readOnly) return null;
    return (
      <Panel title="Delivery note and slips" className={className}>
        <p className="text-sm text-slate">Delivery notes need the live database, so they are not available in this demo.</p>
      </Panel>
    );
  }

  const state = view?.state;
  const note = view?.note ?? null;
  const words = state ? gateWords(state) : null;
  const warnings = note && state ? paperWarnings(state) : [];
  const papersByEvent = new Map((view?.papers ?? []).map((paper) => [paper.print_event_id, paper]));
  if (readOnly && !note) return null;
  const recheck = readOnly ? null : (
    <Button size="sm" variant="outline" disabled={busy !== ""} onClick={() => void check(true)}>
      <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", busy === "check" && "animate-spin")} /> Check again
    </Button>
  );

  const stopControl = state && !readOnly && (
    <div className="space-y-2 border-t border-border pt-3">
      {stopping ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input aria-label={state.stopped ? "Why the stop is lifted" : "Why delivery is stopped"} value={reason} maxLength={300} onChange={(event) => setReason(event.target.value)}
            placeholder={state.stopped ? "Why the stop is lifted" : "Reason, for example refunded on 3 Nov"} className="h-8 min-w-0 flex-1 text-xs sm:max-w-sm" />
          <Button size="sm" className={state.stopped ? "bg-navy text-white hover:bg-navy/90" : "bg-danger text-white hover:bg-danger/90"} disabled={busy !== "" || reason.trim().length < 3} onClick={() => void changeStop(!state.stopped)}>
            {state.stopped ? "Lift the stop" : "Stop delivery"}
          </Button>
          <Button size="sm" variant="outline" disabled={busy !== ""} onClick={() => setStopping(false)}>Back</Button>
        </div>
      ) : (
        <button type="button" className="text-xs font-semibold text-danger hover:underline" onClick={() => setStopping(true)}>
          {state.stopped ? "Lift the stop on this delivery" : "Stop delivery (refund or dispute)"}
        </button>
      )}
    </div>
  );

  return (
    <Panel title="Delivery note and slips" className={className}>
      {!view && !failed && <p className="text-sm text-slate">Reading the order…</p>}
      {!view && failed && (
        <div className="space-y-2">
          <p className="text-sm text-danger">{failed}</p>
          {recheck}
        </div>
      )}

      {state && words && !note && (
        <div className="space-y-3">
          <div className={cn("rounded-md border p-3 text-sm", TONES[words.tone])}>
            <p className="flex items-center gap-1.5 font-bold">
              {words.tone === "ok" ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : words.tone === "wait" ? <Clock className="h-4 w-4 shrink-0" /> : <AlertTriangle className="h-4 w-4 shrink-0" />}
              {words.title}
            </p>
            <p className="mt-1">{words.detail}</p>
          </div>
          {state.code === "partly_paid" && (
            <dl className="grid grid-cols-3 gap-2 text-sm">
              <div className="rounded-md border border-border p-2"><dt className="text-xs text-slate">Order total</dt><dd className="font-bold text-navy">{inrPrecise(Number(state.order_total))}</dd></div>
              <div className="rounded-md border border-border p-2"><dt className="text-xs text-slate">Amount paid</dt><dd className="font-bold text-emerald-800">{inrPrecise(Number(state.paid))}</dd></div>
              <div className="rounded-md border border-amber-300 bg-amber-50 p-2"><dt className="text-xs text-amber-900">Balance due</dt><dd className="font-bold text-amber-900">{inrPrecise(Number(state.balance))}</dd></div>
            </dl>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {state.allowed && (
              <Button size="sm" className="bg-navy text-white hover:bg-navy/90" disabled={busy !== ""} onClick={() => void generate()}>
                <FileCheck2 className="mr-1.5 h-4 w-4" /> {busy === "generate" ? "Generating…" : "Generate delivery note"}
              </Button>
            )}
            {recheck}
            {["unpaid", "partly_paid", "website_behind", "zoho_has_payment", "payment_mismatch"].includes(state.code) && (
              <Link to="/admin/payments" search={true} className="text-xs font-semibold text-gold hover:underline">Payments & Matching</Link>
            )}
          </div>
          <p className="text-[11px] text-slate">{view!.fresh ? `Zoho Books read ${istDateTime(view!.checkedAt)}` : "From what the website last read from Zoho. Generate and Check again read Zoho now."}</p>
          {stopControl}
        </div>
      )}

      {state && words && note && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-lg font-extrabold text-navy">{note.note_no}</p>
              <p className="text-xs text-slate">Generated {istDateTime(note.generated_at)} by {note.generated_by_name}</p>
              <p className="text-xs text-slate">Invoice {note.invoice_number}</p>
            </div>
            <Button size="sm" className="bg-navy text-white hover:bg-navy/90" asChild>
              <Link to="/admin/delivery-note/$orderNo" params={{ orderNo }}><Printer className="mr-1.5 h-4 w-4" /> Open to print</Link>
            </Button>
          </div>
          {warnings.length > 0 ? (
            <div className="rounded-md border-2 border-red-300 bg-red-50 p-3 text-sm text-red-900">
              {warnings.map((warning) => <p key={warning} className="font-bold">{warning}</p>)}
              <p className="mt-1">{words.detail}</p>
            </div>
          ) : (
            <p className="flex items-center gap-1.5 text-sm font-semibold text-emerald-800"><CheckCircle2 className="h-4 w-4" /> {view!.fresh ? `Still paid in full as of ${istDateTime(view!.checkedAt)}.` : "Paid in full when the website last read Zoho. Printing reads Zoho again."}</p>
          )}
          {recheck}
          {stopControl}
          <HandoverList view={view!} orderNo={orderNo} readOnly={readOnly} onView={setView} />
          {view!.events.length > 0 && (
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-slate">History</p>
              <ul className="mt-1 space-y-1 text-xs text-charcoal">
                {view!.events.slice(0, 30).map((event) => (
                  <li key={event.id} className="break-words"><span className="text-slate">{istDateTime(event.occurred_at)}</span> · {eventText(event, papersByEvent)}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
