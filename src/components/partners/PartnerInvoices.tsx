import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { FileText, PenLine, RefreshCw } from "lucide-react";
import { Panel } from "@/components/panel/widgets";
import { ListFilters } from "@/components/panel/ListFilters";
import { InvoicePreviewDialog } from "@/components/site/InvoicePreviewDialog";
import { useSignaturePreview } from "@/components/panel/GodownSignatureField";
import { supabase } from "@/integrations/supabase/client";
import { inrPrecise, type Order } from "@/lib/data";
import { istToday } from "@/lib/godown-report";
import type { InvoiceFacts } from "@/lib/invoice-lines";
import { partnerInvoiceOrder, partnerInvoiceRows, partnerInvoiceVisible, paymentLabel, type PartnerInvoiceRow } from "@/lib/partner-invoices";
import { partnerOrderInvoice } from "@/lib/partner-confirm";
import { orderToneClass } from "@/lib/order-status-tone";
import { cn } from "@/lib/utils";
import { ORDER_FILTERS, PAYMENT_FILTERS, filterCounts, matchesOrderFilter, matchesPaymentFilter, matchesSearch } from "@/lib/list-search";

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const monthStartOf = (date: string) => `${date.slice(0, 8)}01`;
const placedLabel = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * The channel partner's customer invoices: the orders of their godown placed while they run it, each as the
 * customer's own copy (signed with the partner's signature) to view, download or print. Their signature is
 * shown read-only: only the office changes it.
 */
export function PartnerInvoices({ signaturePath }: { signaturePath: string | null }) {
  const today = istToday();
  const [from, setFrom] = useState(monthStartOf(today));
  const [to, setTo] = useState(today);
  const [rows, setRows] = useState<PartnerInvoiceRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState("");
  const [shown, setShown] = useState<{ order: Order; facts: InvoiceFacts } | null>(null);
  const [signature] = useSignaturePreview(signaturePath);
  // Search and filters (owner, 11 Nov 2026): order number, invoice number or customer; order status; payment.
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [payment, setPayment] = useState("all");
  const found = useMemo(() => (rows ?? []).filter((row) => matchesSearch([row.order_no, row.invoice_number, row.customer_name, row.order_status, paymentLabel(row.payment_status)], query)), [rows, query]);
  const shownRows = useMemo(() => found.filter((row) => matchesOrderFilter(row.order_status, status) && matchesPaymentFilter(row.payment_status, payment)), [found, status, payment]);
  const statusCounts = useMemo(() => filterCounts(found.filter((row) => matchesPaymentFilter(row.payment_status, payment)), ORDER_FILTERS.map((item) => item.key), (row, key) => matchesOrderFilter(row.order_status, key)), [found, payment]);
  const paymentCounts = useMemo(() => filterCounts(found.filter((row) => matchesOrderFilter(row.order_status, status)), PAYMENT_FILTERS.map((item) => item.key), (row, key) => matchesPaymentFilter(row.payment_status, key)), [found, status]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.rpc("partner_invoice_orders", { _from: from, _to: to });
      if (error) throw new Error(error.message);
      setRows(partnerInvoiceRows(data));
    } catch (cause) {
      toast.error("Could not load your invoices", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setLoading(false);
    }
  }, [from, to]);
  useEffect(() => { void load(); }, [load]);

  const open = async (orderNo: string) => {
    setOpening(orderNo);
    try {
      const { data, error } = await supabase.rpc("partner_invoice_order", { _order_no: orderNo });
      if (error) throw new Error(error.message);
      setShown(partnerInvoiceOrder(data));
    } catch (cause) {
      toast.error("Could not open the invoice", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setOpening("");
    }
  };

  return (
    <Panel id="customer-invoices" title="Customer invoices">
      <div className="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-border bg-ivory/40 p-2 text-xs">
        <span className="flex items-center gap-1.5 font-semibold text-navy"><PenLine className="h-3.5 w-3.5" />Your signature on these invoices</span>
        {signature ? <img src={signature} alt="Your signature" className="h-10 max-w-[150px] rounded border border-border bg-white object-contain p-0.5" />
          : <span className="text-slate">{signaturePath ? "Loading…" : "Not added yet: the invoices print the godown's signature or a blank signature line."}</span>}
        <span className="basis-full text-slate">Only the Grain Bazar office adds or changes it. Ask them if it is missing or wrong.</span>
      </div>

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-xs font-semibold text-slate">From
          <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} className="h-9 rounded-md border border-input bg-white px-2 text-sm text-charcoal" />
        </label>
        <label className="grid gap-1 text-xs font-semibold text-slate">To
          <input type="date" value={to} min={from} max={today} onChange={(e) => e.target.value && setTo(e.target.value)} className="h-9 rounded-md border border-input bg-white px-2 text-sm text-charcoal" />
        </label>
        {[
          { label: "Today", from: today, to: today },
          { label: "Last 7 days", from: addDays(today, -6), to: today },
          { label: "This month", from: monthStartOf(today), to: today },
        ].map((preset) => (
          <button key={preset.label} type="button" onClick={() => { setFrom(preset.from); setTo(preset.to); }}
            className={cn("h-9 rounded-md border px-3 text-sm", from === preset.from && to === preset.to ? "border-navy bg-navy text-white" : "border-border bg-white text-navy hover:border-gold")}>
            {preset.label}
          </button>
        ))}
        <button type="button" onClick={() => void load()} disabled={loading} className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-white px-3 text-sm text-navy hover:border-gold">
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />Refresh
        </button>
      </div>
      <p className="mb-3 text-xs text-slate">Orders of your godown placed while you run it. The customer gets the same copy, with the same delivery QR, once the order is paid and confirmed.</p>

      {rows !== null && rows.length > 0 && (
        <ListFilters query={query} onQuery={setQuery} placeholder="Search order no., invoice no. or customer" shown={shownRows.length} total={rows.length}
          groups={[
            { label: "Order status", choices: ORDER_FILTERS, value: status, onChange: setStatus, counts: statusCounts },
            { label: "Payment", choices: PAYMENT_FILTERS, value: payment, onChange: setPayment, counts: paymentCounts },
          ]} />
      )}
      {rows === null ? <p className="text-sm text-slate">Loading…</p>
        : !rows.length ? <p className="py-6 text-center text-sm text-slate">No orders in this period.</p>
        : !shownRows.length ? <p className="py-6 text-center text-sm text-slate">No orders match. Clear the search or pick another filter.</p>
        : (
          <ul className="space-y-2">
            {shownRows.map((row) => (
              // Tinted by the order's status, as in every portal: pending yellow, confirmed green, cancelled red.
              <li key={row.order_no} className={cn("flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card p-3", orderToneClass(row.order_status, "tile"))}>
                <div className="min-w-0">
                  <p className="font-mono text-sm font-semibold text-navy">{row.order_no}{row.invoice_number ? <span className="ml-2 font-sans text-xs font-normal text-slate">Invoice {row.invoice_number}</span> : null}</p>
                  <p className="truncate text-sm text-charcoal">{row.customer_name || "Customer"}</p>
                  <p className="text-xs text-slate">{placedLabel(row.placed_at)} · {row.order_status} · {paymentLabel(row.payment_status)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="text-sm font-bold text-navy tabular-nums">{inrPrecise(row.total)}</span>
                  {partnerInvoiceVisible(row) ? (
                    <button type="button" disabled={opening === row.order_no} onClick={() => void open(row.order_no)}
                      className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-white px-3 text-sm text-navy hover:border-gold disabled:opacity-60">
                      <FileText className="h-4 w-4" />{opening === row.order_no ? "Opening…" : "View / Download"}
                    </button>
                  ) : <span className="max-w-[16rem] text-right text-xs text-charcoal">{partnerOrderInvoice({ ...row, invoice_mine: true }).words}</span>}
                </div>
                {/* Confirmed and paid, but Zoho Books has not numbered the tax invoice yet: say what opens meanwhile. */}
                {partnerInvoiceVisible(row) && !row.invoice_number && (
                  <p className="basis-full text-[11px] text-slate">{partnerOrderInvoice({ ...row, invoice_mine: true }).words}</p>
                )}
              </li>
            ))}
          </ul>
        )}

      {shown && (
        <InvoicePreviewDialog order={shown.order} facts={shown.facts} open onOpenChange={(next) => { if (!next) setShown(null); }} />
      )}
    </Panel>
  );
}
