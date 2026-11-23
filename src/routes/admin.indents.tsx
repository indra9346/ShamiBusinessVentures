import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, ClipboardList, Download, Eye, Inbox, RefreshCw, XCircle } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { FilterNote, Panel, scrollToSection, StatCard } from "@/components/panel/widgets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { adminNav } from "@/lib/panel-nav";
import { useBranches } from "@/lib/branches";
import { downloadXlsx } from "@/lib/xlsx";
import {
  filterIndents, indentCounts, indentStatusLabel, indentWorkbook, INDENT_STATUSES, type Indent, type IndentFilter, type IndentStatus,
} from "@/lib/indents";
import { loadIndents, setIndentStatus } from "@/lib/indents-store";
import { IndentLines, IndentStatusBadge, indentDate, indentTime } from "@/components/partners/StockIndents";
import { todayInIndia } from "@/lib/follow-ups";

export const Route = createFileRoute("/admin/indents")({
  head: () => ({ meta: [{ title: "Order book from channel partners | Shami Admin" }, { name: "robots", content: "noindex" }] }),
  component: AdminIndents,
});

const fieldClass = "h-9 rounded-md border border-border bg-white px-2 text-sm";

/**
 * Admin: every stock requirement (indent) the godowns' channel partners have sent, newest first (owner, 13 Nov 2026).
 * Head office moves each one New -> Seen -> Arranged, or Cancelled, with a note the partner sees. A request never
 * changes stock, orders or Zoho: arranging the goods is done as usual (a transfer, a purchase), and the status says so.
 */
function AdminIndents() {
  const { branches } = useBranches();
  const [indents, setIndents] = useState<Indent[] | null>(null);
  const [failed, setFailed] = useState("");
  const [filter, setFilter] = useState<IndentFilter>({ status: "open", branchId: "all", search: "" });
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setIndents(await loadIndents());
      setFailed("");
    } catch (cause) {
      setFailed(cause instanceof Error ? cause.message : "Could not load the order book");
      setIndents((current) => current ?? []);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => void reload(), 60_000);
    return () => window.clearInterval(timer);
  }, [reload]);

  const all = indents ?? [];
  const counts = indentCounts(all);
  const shown = useMemo(() => filterIndents(all, filter), [all, filter]);
  const openStatus = (status: IndentFilter["status"]) => {
    setFilter((current) => ({ ...current, status }));
    scrollToSection("order-book");
  };
  const download = () => {
    if (!shown.length) { toast.message("Nothing to download for these filters"); return; }
    downloadXlsx(`Order-book-channel-partners-${todayInIndia()}.xlsx`, indentWorkbook(shown));
  };
  const filterLabel = filter.status === "open" ? "Open (New and Seen)" : filter.status === "all" ? "" : indentStatusLabel(filter.status);

  return (
    <PanelLayout items={adminNav} tone="admin" title="Order book from channel partners" subtitle="Stock the godowns' channel partners have asked for, and where each request stands">
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard onClick={() => openStatus("new")} label="New" value={String(counts.new)} icon={Inbox} highlight={counts.new > 0} description="Not looked at yet" />
        <StatCard onClick={() => openStatus("seen")} label="Seen" value={String(counts.seen)} icon={Eye} description="Being arranged" />
        <StatCard onClick={() => openStatus("arranged")} label="Arranged" value={String(counts.arranged)} icon={CheckCircle2} />
        <StatCard onClick={() => openStatus("cancelled")} label="Cancelled" value={String(counts.cancelled)} icon={XCircle} />
      </div>

      <div id="order-book" className="scroll-mt-36">
        <Panel
          title={`Requests (${shown.length})`}
          action={(
            <div className="flex flex-wrap items-center gap-2">
              <Input aria-label="Search requests" placeholder="Search product, partner, request no." value={filter.search} className="h-9 w-56" onChange={(event) => setFilter((current) => ({ ...current, search: event.target.value }))} />
              <select aria-label="Status" className={fieldClass} value={filter.status} onChange={(event) => setFilter((current) => ({ ...current, status: event.target.value as IndentFilter["status"] }))}>
                <option value="open">Open (New and Seen)</option>
                <option value="all">All</option>
                {INDENT_STATUSES.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}
              </select>
              <select aria-label="Godown" className={fieldClass} value={filter.branchId} onChange={(event) => setFilter((current) => ({ ...current, branchId: event.target.value }))}>
                <option value="all">All godowns</option>
                {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
              </select>
              <Button variant="outline" size="sm" className="h-9" onClick={download}><Download className="mr-1.5 h-3.5 w-3.5" />Download Excel</Button>
              <Button variant="ghost" size="sm" className="h-9" disabled={loading} onClick={() => void reload()} aria-label="Refresh"><RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} /></Button>
            </div>
          )}
        >
          {filterLabel && <FilterNote label={filterLabel} onClear={() => setFilter((current) => ({ ...current, status: "all" }))} />}
          {indents === null ? <p className="text-sm text-slate">Loading…</p>
            : failed ? <p className="text-sm font-semibold text-danger">{failed}</p>
            : shown.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-slate"><ClipboardList className="h-4 w-4" />{all.length ? "No request matches these filters." : "No channel partner has sent a stock requirement yet."}</p>
            ) : (
              <ul className="space-y-4">
                {shown.map((indent) => <IndentCard key={indent.id} indent={indent} onChanged={reload} />)}
              </ul>
            )}
        </Panel>
      </div>
    </PanelLayout>
  );
}

function IndentCard({ indent, onChanged }: { indent: Indent; onChanged: () => Promise<void> }) {
  const [status, setStatus] = useState<IndentStatus>(indent.status);
  const [note, setNote] = useState(indent.statusNote);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState(false);
  useEffect(() => { setStatus(indent.status); setNote(indent.statusNote); }, [indent.status, indent.statusNote]);
  const changed = status !== indent.status || note.trim() !== indent.statusNote;
  const save = async () => {
    setSaving(true);
    try {
      await setIndentStatus(indent.indentNo, status, note);
      toast.success(`${indent.indentNo}: ${indentStatusLabel(status)}`);
      await onChanged();
    } catch (cause) {
      toast.error("Could not change the status", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setSaving(false);
    }
  };
  return (
    <li className="rounded-lg border border-border bg-card p-3 sm:p-4">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="font-mono text-sm font-bold text-navy">{indent.indentNo}</span>
            <span className="text-sm font-semibold text-charcoal">{indent.godown}</span>
          </p>
          <p className="text-xs text-slate">
            <span>{indent.partnerName || "Channel partner"}</span><span className="mx-1">·</span><span>{indentTime(indent.createdAt)}</span>
            {indent.neededBy && <><span className="mx-1">·</span><span className="font-semibold text-charcoal">{`Needed by ${indentDate(indent.neededBy)}`}</span></>}
          </p>
        </div>
        <IndentStatusBadge status={indent.status} />
      </div>
      <IndentLines indent={indent} />
      {indent.notes && <p className="mt-2 whitespace-pre-line text-sm text-charcoal"><span className="font-semibold">Partner's notes: </span><span>{indent.notes}</span></p>}
      {indent.statusChangedAt && (
        <p className="mt-1 text-xs text-slate">
          <span>{`Last change: ${indentStatusLabel(indent.status)} by ${indent.statusChangedByName || "—"}, ${indentTime(indent.statusChangedAt)}`}</span>
          {indent.statusNote && <span className="block text-charcoal">{indent.statusNote}</span>}
        </p>
      )}
      <div className="mt-3 grid gap-2 sm:grid-cols-[160px_minmax(0,1fr)_auto] sm:items-end">
        <label className="grid gap-1 text-xs font-semibold text-charcoal">
          <span>Status</span>
          <select className={`${fieldClass} h-10 w-full text-base sm:text-sm`} value={status} onChange={(event) => setStatus(event.target.value as IndentStatus)}>
            {INDENT_STATUSES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-xs font-semibold text-charcoal">
          <span>Note for the partner (optional)</span>
          <Input value={note} maxLength={500} className="h-10 bg-white text-base sm:text-sm" placeholder="For example: lorry leaves Friday" onChange={(event) => setNote(event.target.value)} />
        </label>
        <Button className="h-10 bg-navy text-white" disabled={!changed || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</Button>
      </div>
      {indent.events.length > 0 && (
        <div className="mt-2">
          <button type="button" className="text-xs font-semibold text-gold hover:underline" onClick={() => setHistory((open) => !open)}>{history ? "Hide history" : `History (${indent.events.length})`}</button>
          {history && (
            <ol className="mt-1 space-y-0.5 text-xs text-slate">
              {indent.events.map((event, index) => (
                <li key={index}>
                  <span>{indentTime(event.at)}</span><span className="mx-1">·</span>
                  <span className="font-semibold text-charcoal">{event.event === "raised" ? "Sent" : indentStatusLabel(event.event)}</span><span className="mx-1">·</span>
                  <span>{event.byName || "—"}</span>
                  {event.note && <><span className="mx-1">·</span><span>{event.note}</span></>}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </li>
  );
}
