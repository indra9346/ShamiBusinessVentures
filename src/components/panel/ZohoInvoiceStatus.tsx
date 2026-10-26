import { useCallback, useEffect, useState } from "react";
import { FileText, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { inrPrecise } from "@/lib/data";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type InvoiceRow = Database["public"]["Tables"]["zoho_order_invoices"]["Row"];

/** How each invoice state reads, for staff and for the customer / vendor. */
const STATES: Record<string, { label: string; tone: string; note?: string; publicNote?: string }> = {
  sent: { label: "Issued · unpaid", tone: "bg-amber-100 text-amber-800" },
  overdue: { label: "Overdue", tone: "bg-red-100 text-red-700" },
  partially_paid: { label: "Partly paid", tone: "bg-amber-100 text-amber-800" },
  paid: { label: "Paid", tone: "bg-emerald-100 text-emerald-800" },
  void: {
    label: "Cancelled (voided in Zoho)", tone: "bg-red-100 text-red-700",
    note: "A new invoice is created only after you approve it.",
    publicNote: "This invoice was cancelled. A new invoice will be issued after review.",
  },
  deleted: {
    label: "Cancelled (deleted in Zoho)", tone: "bg-red-100 text-red-700",
    note: "A new invoice is created only after you approve it.",
    publicNote: "This invoice was cancelled. A new invoice will be issued after review.",
  },
  awaiting_approval: {
    label: "Awaiting admin approval", tone: "bg-slate-100 text-slate-700",
    note: "This order has no Zoho invoice. Approve one to create it in Zoho Books.",
    publicNote: "The invoice will be issued after review.",
  },
};

/**
 * The order's official Zoho Books invoice (number, status, amounts), the same for admins, the
 * customer and the order's vendors. Admins can approve a new invoice after one was voided or
 * deleted in Zoho, and refresh it from Zoho.
 */
export function ZohoInvoiceStatus({ orderNo, audience, className }: { orderNo: string; audience: "admin" | "customer" | "vendor"; className?: string }) {
  const [row, setRow] = useState<InvoiceRow | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<"" | "approve" | "refresh">("");

  const load = useCallback(async () => {
    if (STATIC_DATA_MODE) { setLoaded(true); return; }
    const { data } = await supabase.from("zoho_order_invoices").select("*").eq("order_no", orderNo).maybeSingle();
    setRow((data as InvoiceRow | null) ?? null);
    setLoaded(true);
  }, [orderNo]);

  useEffect(() => {
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const syncNow = async () => {
    const { syncSingleOrderToZoho } = await import("@/lib/zoho-commerce.functions");
    await syncSingleOrderToZoho({ data: { orderNo } });
  };

  const approve = async () => {
    setBusy("approve");
    try {
      const { error } = await supabase.rpc("request_zoho_invoice_approval", { _order_no: orderNo });
      if (error) throw new Error(error.message);
      await syncNow();
      toast.success("Approved: the new invoice was created in Zoho Books");
    } catch (cause) {
      toast.error("Could not create the new invoice", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy("");
      void load();
    }
  };

  const refresh = async () => {
    setBusy("refresh");
    try {
      await syncNow();
    } catch (cause) {
      toast.error("Could not refresh the invoice from Zoho", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy("");
      void load();
    }
  };

  if (!loaded) return null;
  const status = row?.status ?? "none";
  const state = STATES[status];
  const isAdmin = audience === "admin";
  if (!row || status === "none") {
    if (!isAdmin) return null;
  }
  const canApprove = isAdmin && ["void", "deleted", "awaiting_approval"].includes(status) && !row?.admin_approved;

  return (
    <div className={cn("rounded-lg border border-border bg-card p-3 text-sm", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate">
          <FileText className="h-3.5 w-3.5" /> Tax invoice (Zoho Books)
        </span>
        <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", state?.tone ?? "bg-slate-100 text-slate-700")}>
          {state?.label ?? "Not invoiced yet"}
        </span>
      </div>
      {row?.invoice_number && (
        <p className="mt-2 font-semibold text-navy">
          {row.invoice_number}
          {row.total !== null && <span className="ml-2 font-normal text-slate">{inrPrecise(Number(row.total))}</span>}
          {status === "partially_paid" && row.balance !== null && (
            <span className="ml-2 font-normal text-amber-700">· {inrPrecise(Number(row.balance))} due</span>
          )}
        </p>
      )}
      {(isAdmin ? state?.note : state?.publicNote) && (
        <p className="mt-1 text-xs text-slate">{isAdmin ? state?.note : state?.publicNote}</p>
      )}
      {isAdmin && row?.last_event && (
        <p className="mt-1 text-[11px] text-slate">
          Last update: {row.last_event} · {new Date(row.updated_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
          {row.auto_attempts > 0 && ` · invoices created: ${row.auto_attempts}`}
        </p>
      )}
      {isAdmin && (
        <div className="mt-2 flex flex-wrap gap-2">
          {canApprove && (
            <Button size="sm" className="bg-navy text-white hover:bg-navy/90" disabled={busy !== ""} onClick={() => void approve()}>
              {busy === "approve" ? "Creating…" : "Approve new Zoho invoice"}
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={busy !== ""} onClick={() => void refresh()}>
            <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", busy === "refresh" && "animate-spin")} /> Refresh from Zoho
          </Button>
        </div>
      )}
    </div>
  );
}
