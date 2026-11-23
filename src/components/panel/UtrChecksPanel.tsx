import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { CheckCircle2, ShieldAlert, ShieldCheck, UserX } from "lucide-react";
import { Panel } from "@/components/panel/widgets";
import { Button } from "@/components/ui/button";
import { inrPrecise } from "@/lib/data";
import { loadUtrChecks, reviewUtrConflict } from "@/lib/upi-store";
import { accountsInGroup, EMPTY_UTR_CHECKS, maskPhone, openUtrGroups, otherOrdersSharingUtr, UTR_SOURCE_LABEL, type UtrChecks, type UtrConflictGroup } from "@/lib/utr-checks";
import { cn } from "@/lib/utils";

/*
 * Admin → UPI & Bank Payments → "UTR checks": one transfer seen on two or more orders or accounts (a UTR sent, an earlier
 * UTR, a refused try, a recorded payment, a bank SMS), accounts whose UTRs keep being refused (paused for an hour after
 * 5), and the latest refused tries. Read from admin_utr_conflicts every minute and after every change here.
 */

const istTime = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
/** The same event upi-store sends after every change. */
const CHANGED = "gb-upi-changed";

/** The UTR checks, kept current. Shared by the panel and the badges in "Payments to check". */
export function useUtrChecks() {
  const [checks, setChecks] = useState<UtrChecks>(EMPTY_UTR_CHECKS);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      setChecks(await loadUtrChecks());
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read the UTR checks");
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 60_000);
    const onChange = () => void refresh();
    window.addEventListener(CHANGED, onChange);
    window.addEventListener("focus", onChange);
    return () => {
      clearInterval(timer);
      window.removeEventListener(CHANGED, onChange);
      window.removeEventListener("focus", onChange);
    };
  }, [refresh]);
  return { checks, error, refresh };
}

/** Red line under a waiting UTR that also appears on another order. */
export function SameUtrBadge({ orderNo, checks }: { orderNo: string; checks: UtrChecks }) {
  const others = otherOrdersSharingUtr(orderNo, checks);
  if (!others.length) return null;
  return (
    <a href="#utr-checks" className="mt-1.5 flex items-start gap-1 rounded-md bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-800 hover:underline">
      <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0" />
      <span>{`Same UTR also on ${others.join(", ")}`}</span>
    </a>
  );
}

function GroupCard({ group, onReviewed }: { group: UtrConflictGroup; onReviewed: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const accounts = accountsInGroup(group);
  const markReviewed = async () => {
    const note = window.prompt(`What did you find or do about UTR …${group.key.slice(-6)}? For example: called the second customer, a typing mistake.`, "");
    if (!note?.trim()) return;
    setBusy(true);
    try {
      await reviewUtrConflict(group.key, note.trim());
      await onReviewed();
      toast.success("Marked as checked", { description: "It comes back if anything new happens with this UTR." });
    } catch (cause) {
      toast.error("Could not save", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className={cn("rounded-lg border p-3", group.reviewed ? "border-border bg-card" : group.severity === "high" ? "border-red-300 bg-red-50/60" : "border-amber-300 bg-amber-50/60")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="font-mono font-bold tracking-wider text-navy">{`UTR …${group.key}`}</span>
            {group.reviewed
              ? <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-emerald-800">Checked</span>
              : group.severity === "high"
                ? <span className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold uppercase text-white">Different accounts</span>
                : <span className="rounded bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold uppercase text-white">Same account, more orders</span>}
          </p>
          <p className="mt-0.5 flex flex-wrap gap-x-1.5 text-xs text-slate">
            <span>{`${group.accounts} account(s) · ${group.orders} order(s) · last seen ${istTime(group.last_at)}`}</span>
          </p>
          {accounts.length > 0 && (
            <p className="mt-1 flex flex-wrap gap-1.5 text-xs">
              {accounts.map((account) => (
                <span key={account.userId} className="rounded-full border border-border bg-white px-2 py-0.5">
                  {account.who}{account.phone ? ` ${account.phone}` : ""}{` · ${account.records}`}
                </span>
              ))}
            </p>
          )}
          {group.reviewed && group.review_note && <p className="mt-1 text-xs text-emerald-800">{`Checked: ${group.review_note}`}</p>}
        </div>
        {!group.reviewed && (
          <Button size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => void markReviewed()}>
            <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> Mark as checked
          </Button>
        )}
      </div>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-xs">
          <thead><tr className="text-[10px] font-bold uppercase tracking-wider text-slate">
            <th className="py-1 pr-2">When</th><th className="py-1 pr-2">What</th><th className="py-1 pr-2">Order</th><th className="py-1 pr-2">Customer</th><th className="py-1 pr-2 text-right">Amount</th><th className="py-1">Result</th>
          </tr></thead>
          <tbody>
            {group.items.map((item, index) => (
              <tr key={index} className="border-t border-border/60 align-top">
                <td className="whitespace-nowrap py-1 pr-2 text-slate">{istTime(item.at)}</td>
                <td className={cn("py-1 pr-2 font-semibold", item.source === "tried" ? "text-red-700" : "text-navy")}>{UTR_SOURCE_LABEL[item.source]}</td>
                <td className="py-1 pr-2 font-mono">
                  {item.order_no ? <Link to="/admin/orders/$id" params={{ id: item.order_no }} className="text-navy hover:text-gold">{item.order_no}</Link> : "—"}
                </td>
                <td className="py-1 pr-2">{item.who || "—"}{item.phone ? <span className="text-slate">{` ${maskPhone(item.phone)}`}</span> : null}</td>
                <td className="py-1 pr-2 text-right tabular-nums">{item.amount !== null ? inrPrecise(Number(item.amount)) : "—"}</td>
                <td className="py-1 text-slate">{[item.state, item.detail].filter(Boolean).join(" · ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </li>
  );
}

export function UtrChecksPanel({ checks, error, onChange }: { checks: UtrChecks; error: string; onChange: () => Promise<void> }) {
  const [showChecked, setShowChecked] = useState(false);
  const open = openUtrGroups(checks);
  const checked = checks.groups.filter((group) => group.reviewed);
  const pausedNow = checks.accounts.filter((account) => account.paused_now);
  const highOpen = open.filter((group) => group.severity === "high").length;
  return (
    <Panel id="utr-checks" title="UTR checks" className="mb-6 scroll-mt-36">
      <p className="mb-3 text-xs text-slate">
        Every UTR customers send is recorded, also the ones refused. The same transfer on two or more orders or accounts is listed here, written any way (spaces, bank letters). An account whose UTRs are refused 5 times in an hour is paused for that hour.
      </p>
      {error ? <p className="text-sm text-amber-800">{error}</p> : (
        <>
          <div className="mb-3 flex flex-wrap gap-2 text-xs">
            <span className={cn("rounded-full px-3 py-1 font-semibold", highOpen ? "bg-red-600 text-white" : "bg-muted text-slate")}>{`Same UTR, different accounts: ${highOpen}`}</span>
            <span className={cn("rounded-full px-3 py-1 font-semibold", open.length - highOpen ? "bg-amber-500 text-white" : "bg-muted text-slate")}>{`Same account, more orders: ${open.length - highOpen}`}</span>
            <span className={cn("rounded-full px-3 py-1 font-semibold", pausedNow.length ? "bg-red-100 text-red-800" : "bg-muted text-slate")}>{`Paused now: ${pausedNow.length}`}</span>
            <span className="rounded-full bg-muted px-3 py-1 font-semibold text-slate">{`Refused tries, 7 days: ${checks.tries.length}`}</span>
          </div>
          {open.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-emerald-800"><ShieldCheck className="h-4 w-4" /> No UTR is on more than one order right now.</p>
          ) : (
            <ul className="space-y-3">{open.map((group) => <GroupCard key={group.key} group={group} onReviewed={onChange} />)}</ul>
          )}
          {checks.accounts.length > 0 && (
            <div className="mt-4">
              <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate">Accounts with refused UTRs, last 24 hours</h3>
              <ul className="flex flex-wrap gap-2 text-xs">
                {checks.accounts.map((account) => (
                  <li key={account.user_id} className={cn("flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5", account.paused_now ? "border-red-300 bg-red-50 text-red-900" : "border-border")}>
                    <UserX className="h-3.5 w-3.5" />
                    <span className="font-semibold">{account.who || "Unknown"}</span>
                    {account.phone && <span className="text-slate">{maskPhone(account.phone)}</span>}
                    <span>{account.paused_now ? `· ${account.refused} refused, paused` : `· ${account.refused} refused`}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {checks.tries.length > 0 && (
            <details className="mt-4">
              <summary className="cursor-pointer text-xs font-bold uppercase tracking-wider text-slate">Latest refused tries</summary>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[560px] text-left text-xs">
                  <thead><tr className="text-[10px] font-bold uppercase tracking-wider text-slate">
                    <th className="py-1 pr-2">When</th><th className="py-1 pr-2">Order</th><th className="py-1 pr-2">Customer</th><th className="py-1 pr-2">UTR</th><th className="py-1">Why</th>
                  </tr></thead>
                  <tbody>
                    {checks.tries.map((attempt, index) => (
                      <tr key={index} className="border-t border-border/60 align-top">
                        <td className="whitespace-nowrap py-1 pr-2 text-slate">{istTime(attempt.at)}</td>
                        <td className="py-1 pr-2 font-mono">{attempt.order_no}</td>
                        <td className="py-1 pr-2">{attempt.who || "—"}</td>
                        <td className="py-1 pr-2 font-mono">{attempt.ref}</td>
                        <td className="py-1 text-slate">{attempt.outcome === "blocked" ? "Paused: too many refused UTRs" : attempt.reason ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
          {checked.length > 0 && (
            <div className="mt-4">
              <button type="button" className="text-xs font-semibold text-gold hover:underline" onClick={() => setShowChecked((value) => !value)}>
                {showChecked ? "Hide checked UTRs" : `Show checked UTRs (${checked.length})`}
              </button>
              {showChecked && <ul className="mt-2 space-y-3">{checked.map((group) => <GroupCard key={group.key} group={group} onReviewed={onChange} />)}</ul>}
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
