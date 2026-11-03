import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, Clock, FileCheck2, Printer, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Panel } from "@/components/panel/widgets";
import { Button } from "@/components/ui/button";
import { inrPrecise } from "@/lib/data";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { copyLabel, gateWords, istDateTime, paperWarnings, type DeliveryNoteEvent, type DeliveryNoteView } from "@/lib/delivery-notes";
import { generateDeliveryNote, getDeliveryNote, setDeliveryStop } from "@/lib/delivery-notes.functions";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const TONES = {
  ok: "border-emerald-200 bg-emerald-50 text-emerald-900",
  wait: "border-amber-200 bg-amber-50 text-amber-900",
  stop: "border-red-200 bg-red-50 text-red-900",
};

function eventText(event: DeliveryNoteEvent) {
  const who = event.actor_name ? ` by ${event.actor_name}` : "";
  if (event.kind === "generated") return `Generated${who}`;
  if (event.kind === "printed") {
    const what = event.doc === "note" ? "Note" : `Slip ${event.slip_line}`;
    const warned = event.gate_code && event.gate_code !== "paid" ? " (printed with a warning)" : "";
    return `${what} printed${who}: ${copyLabel(event.copy_no)}${warned}`;
  }
  if (event.kind === "invoice_changed") return `Zoho invoice changed: ${event.detail}`;
  if (event.kind === "order_changed") return `Order changed: ${event.detail}`;
  return event.detail;
}

/**
 * The order's delivery note on the admin order page: why it cannot be generated yet, or the note, its
 * warnings and who generated and printed it. Whatever this shows, the database decides again on the press.
 */
export function DeliveryNotePanel({ orderNo, className = "" }: { orderNo: string; className?: string }) {
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
  const recheck = (
    <Button size="sm" variant="outline" disabled={busy !== ""} onClick={() => void check(true)}>
      <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", busy === "check" && "animate-spin")} /> Check again
    </Button>
  );

  const stopControl = state && (
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
          {view!.events.length > 0 && (
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-slate">History</p>
              <ul className="mt-1 space-y-1 text-xs text-charcoal">
                {view!.events.slice(0, 30).map((event) => (
                  <li key={event.id} className="break-words"><span className="text-slate">{istDateTime(event.occurred_at)}</span> · {eventText(event)}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
