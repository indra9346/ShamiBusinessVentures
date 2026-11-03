import { useEffect, useState, type ReactNode } from "react";
import { Phone } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { inrPrecise } from "@/lib/data";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { orderPaymentNotice } from "@/lib/delivery-notes";

type InvoiceFigures = { status: string; total: number | null; balance: number | null };

/**
 * On the customer's own order page: how much of a part-paid order is paid and what is still due, above
 * the usual way to pay (children). When our records disagree, no amount can be trusted, so the customer
 * is asked to call rather than offered a payment for the wrong amount.
 */
export function PartPaymentNotice({ orderNo, total, paid, paymentStatus, orderStatus, children }: {
  orderNo: string; total: number; paid: number; paymentStatus: string; orderStatus: string; children: ReactNode;
}) {
  const [invoice, setInvoice] = useState<InvoiceFigures | null>(null);
  const [loaded, setLoaded] = useState(STATIC_DATA_MODE);

  useEffect(() => {
    if (STATIC_DATA_MODE) return;
    let active = true;
    void supabase.from("zoho_order_invoices").select("status,total,balance").eq("order_no", orderNo).maybeSingle().then(({ data }) => {
      if (!active) return;
      setInvoice(data ? { status: data.status, total: data.total === null ? null : Number(data.total), balance: data.balance === null ? null : Number(data.balance) } : null);
      setLoaded(true);
    }, () => {
      // Offline: the usual way to pay still shows, as it did before this notice.
      if (active) setLoaded(true);
    });
    return () => { active = false; };
  }, [orderNo]);

  const notice = orderPaymentNotice({ total, paid, paymentStatus, orderStatus, invoice });
  if (notice?.kind === "check") {
    return (
      <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-left text-sm text-amber-900">
        <p className="font-bold">Please call us about this order's payment</p>
        <p className="mt-1">Our payment records for this order need checking. Please do not pay again before speaking to us.</p>
        <a href="tel:+919845966288" className="mt-2 inline-flex items-center gap-1 font-semibold underline"><Phone className="h-3.5 w-3.5" /> +91 98459 66288</a>
      </div>
    );
  }
  return (
    <>
      {notice?.kind === "part" && (
        <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-left text-sm text-amber-900">
          <p className="font-bold">This order is partly paid</p>
          <dl className="mt-2 grid max-w-md grid-cols-2 gap-2">
            <div><dt className="text-xs">Amount paid</dt><dd className="text-lg font-extrabold">{inrPrecise(notice.paid)}</dd></div>
            <div><dt className="text-xs">Balance due</dt><dd className="text-lg font-extrabold">{inrPrecise(notice.balance)}</dd></div>
          </dl>
          <p className="mt-2">Please complete the payment. We can issue your delivery note and release your order only after the full invoice amount is paid.</p>
          <a href="tel:+919845966288" className="mt-2 inline-flex items-center gap-1 font-semibold underline"><Phone className="h-3.5 w-3.5" /> Need help? Call +91 98459 66288</a>
        </div>
      )}
      {loaded && children}
    </>
  );
}
