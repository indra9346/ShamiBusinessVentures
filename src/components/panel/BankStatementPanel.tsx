import { useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, FileSpreadsheet, Loader2 } from "lucide-react";
import { Panel } from "@/components/panel/widgets";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { inrPrecise } from "@/lib/data";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { AWAITING_PAYMENT, PAYMENT_EXPIRED } from "@/lib/payment-hold";
import { matchStatement, parseCsv, statementCredits, type StatementMatch } from "@/lib/bank-statement";
import { readXlsxRows } from "@/lib/xlsx-read";
import { pushOrderToZohoInBackground, useApp } from "@/lib/store";
import { placeEndedCheckout, reviewUpiPayment } from "@/lib/upi-store";
import type { UpiSubmission } from "@/lib/upi-pay";
import { cn } from "@/lib/utils";

/**
 * Admin, on UPI & Bank Payments (12 Nov 2026, owner): upload the company bank statement; every credit's UTR and amount
 * is read and matched with the UTRs customers and channel partners sent, and with checkouts of the same amount. Nothing
 * is confirmed by the upload: each match waits for Confirm, which runs the same steps as Confirm paid (or places an ended
 * checkout again), with all their checks. The file stays in this browser.
 */
export function BankStatementPanel({ submissions }: { submissions: UpiSubmission[] }) {
  const { paymentHolds, user, confirmPayment, refreshHeldCheckouts } = useApp();
  const [reading, setReading] = useState(false);
  const [problem, setProblem] = useState("");
  const [fileName, setFileName] = useState("");
  const [matches, setMatches] = useState<StatementMatch[] | null>(null);
  const [done, setDone] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);

  const read = async (file: File) => {
    setReading(true); setProblem(""); setMatches(null); setDone({}); setFileName(file.name);
    try {
      const lower = file.name.toLowerCase();
      if (lower.endsWith(".xls")) throw new Error("This is an old Excel file (.xls). Open it in Excel and save it as .xlsx or CSV, or download the statement as CSV.");
      if (lower.endsWith(".pdf")) throw new Error("A PDF cannot be read. Download the statement as Excel (.xlsx) or CSV.");
      const rows = lower.endsWith(".xlsx") ? await readXlsxRows(await file.arrayBuffer()) : parseCsv(await file.text());
      const { credits, problem: why } = statementCredits(rows);
      if (why) { setProblem(why); return; }
      const recorded = STATIC_DATA_MODE ? [] : ((await supabase.from("payments").select("txn_ref").eq("status", "Paid").order("created_at", { ascending: false }).limit(3000)).data ?? [])
        .map((row) => String(row.txn_ref ?? "")).filter(Boolean);
      const checkouts = paymentHolds
        .filter((hold) => hold.status === AWAITING_PAYMENT || hold.status === PAYMENT_EXPIRED)
        .map((hold) => ({
          orderNo: hold.orderNo, amount: hold.amount, status: hold.status, createdAt: hold.createdAt, method: hold.method ?? "UPI",
          hasUtr: submissions.some((s) => s.orderNo === hold.orderNo && (s.status === "submitted" || s.status === "confirmed")),
        }));
      setMatches(matchStatement(credits, submissions, checkouts, recorded));
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Could not read the file");
    } finally {
      setReading(false);
    }
  };

  const note = `Checked against bank statement ${fileName}${user?.name ? ` by ${user.name}` : ""}`.slice(0, 200);
  const confirmOne = async (index: number, match: StatementMatch) => {
    setBusy(index);
    try {
      if (match.kind === "utr") {
        if (match.late) await placeEndedCheckout(match.orderNo, match.utr, null, note);
        else await reviewUpiPayment(match.orderNo, "confirmed", match.utr, note);
      } else if (match.kind === "amount") {
        if (match.late) await placeEndedCheckout(match.orderNo, match.ref, match.method, note);
        else if (!(await confirmPayment(match.orderNo, match.credit.amount, match.ref, undefined, match.method))) throw new Error("The payment could not be recorded");
      } else return;
      pushOrderToZohoInBackground(match.orderNo);
      void refreshHeldCheckouts([match.orderNo]);
      setDone((current) => ({ ...current, [index]: match.orderNo }));
    } catch (cause) {
      toast.error(`Could not confirm ${"orderNo" in match ? match.orderNo : ""}`, { description: cause instanceof Error ? cause.message : undefined });
      throw cause;
    } finally {
      setBusy(null);
    }
  };
  const confirmAll = async () => {
    if (!matches) return;
    let count = 0;
    for (const [index, match] of matches.entries()) {
      if (match.kind !== "utr" || done[index]) continue;
      try { await confirmOne(index, match); count += 1; } catch { break; }
    }
    if (count) toast.success(count === 1 ? "1 payment confirmed" : `${count} payments confirmed`);
  };

  const utrCount = matches?.filter((m, i) => m.kind === "utr" && !done[i]).length ?? 0;
  const summary = matches && {
    credits: matches.length,
    utr: matches.filter((m) => m.kind === "utr").length,
    amount: matches.filter((m) => m.kind === "amount").length,
    none: matches.filter((m) => m.kind === "none" || m.kind === "several" || m.kind === "amount_differs").length,
  };
  return (
    <div id="bank-statement" className="scroll-mt-36">
      <Panel title="Match with a bank statement" className="mb-6">
        <p className="mb-3 text-xs text-slate">Download the company account's statement from the bank (Excel .xlsx or CSV) and choose it here. The website reads each credit's UTR and amount and finds the order it belongs to. Nothing is confirmed until you press Confirm. The file stays on this computer.</p>
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-navy bg-white px-3 py-2 text-sm font-semibold text-navy hover:bg-navy hover:text-white">
          <FileSpreadsheet className="h-4 w-4" /> Choose statement file
          <input type="file" accept=".csv,.xlsx,.xls,.pdf,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only"
            onChange={(event) => { const file = event.target.files?.[0]; if (file) void read(file); event.target.value = ""; }} />
        </label>
        {reading && <p className="mt-3 flex items-center gap-2 text-sm text-slate"><Loader2 className="h-4 w-4 animate-spin" /> Reading the statement…</p>}
        {problem && <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{problem}</p>}
        {summary && (
          <>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-navy">
                <span>{`${summary.credits} credits read from ${fileName}`}</span> · <span>{`${summary.utr} match a UTR`}</span> · <span>{`${summary.amount} match an amount only`}</span> · <span>{`${summary.none} need you`}</span>
              </p>
              {utrCount > 0 && <Button size="sm" className="bg-emerald-600 text-white hover:bg-emerald-700" disabled={busy !== null} onClick={() => void confirmAll()}>{`Confirm all UTR matches (${utrCount})`}</Button>}
            </div>
            <ul className="mt-3 divide-y divide-border text-sm">
              {matches!.map((match, index) => (
                <li key={`${match.credit.row}-${index}`} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 py-2">
                  <div className="min-w-0 flex-1 basis-60">
                    <p className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-semibold tabular-nums text-navy">{inrPrecise(match.credit.amount)}</span>
                      <span className="text-xs text-slate">{match.credit.date}</span>
                      {match.credit.refs[0] && <span className="break-all font-mono text-xs text-slate" data-no-translate>{match.credit.refs.join(", ")}</span>}
                    </p>
                    <p className="break-words text-[11px] text-slate" data-no-translate>{match.credit.text.slice(0, 140)}</p>
                    <p className={cn("mt-0.5 text-xs font-semibold", match.kind === "utr" ? "text-emerald-700" : match.kind === "amount" ? "text-amber-800" : "text-slate")}>
                      {done[index] ? `Confirmed for ${done[index]}`
                        : match.kind === "utr" ? `UTR ${match.utr} sent for ${match.orderNo}${match.late ? " (after its time ran out: confirming places it again)" : ""}`
                        : match.kind === "amount_differs" ? `UTR ${match.utr} was sent for ${match.orderNo}, but that order is ${inrPrecise(match.expected)}. Check it.`
                        : match.kind === "amount" ? `Same amount as ${match.orderNo}, which has no UTR. Check the name before recording it.`
                        : match.kind === "several" ? `Same amount as ${match.orderNos.join(", ")}. Check which one.`
                        : match.kind === "already" ? "Already recorded as a payment"
                        : "No order matches this credit"}
                    </p>
                  </div>
                  {!done[index] && (match.kind === "utr" || match.kind === "amount") && (
                    <Button size="sm" variant={match.kind === "utr" ? "default" : "outline"} className={match.kind === "utr" ? "bg-emerald-600 text-white hover:bg-emerald-700" : ""}
                      disabled={busy !== null} onClick={() => void confirmOne(index, match).then(() => toast.success(`${match.orderNo} confirmed`), () => undefined)}>
                      {busy === index ? "Confirming…" : match.kind === "utr" ? "Confirm" : `Record for ${match.orderNo}`}
                    </Button>
                  )}
                  {done[index] && <CheckCircle2 className="h-5 w-5 text-emerald-600" aria-label="Confirmed" />}
                </li>
              ))}
            </ul>
          </>
        )}
      </Panel>
    </div>
  );
}
