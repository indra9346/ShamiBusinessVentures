import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Download, FileText, IndianRupee, Receipt } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel, scrollToSection, StatCard, StatusBadge } from "@/components/panel/widgets";
import { accountNav } from "@/lib/account-nav";
import { inr } from "@/lib/data";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { downloadCSV } from "@/lib/export-utils";
import { orderBelongsToUser } from "@/lib/account-identity";
import { supabase } from "@/integrations/supabase/client";
import { InvoicePreviewButton } from "@/components/site/InvoicePreviewDialog";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { customerInvoiceVisible } from "@/lib/invoice-visibility";
import { issuedZohoNumber, type ZohoInvoiceCopy } from "@/lib/invoice-lines";
import { useCustomerWaitingOrders } from "@/components/batches/OrderItemBatches";
import { preorderText } from "@/lib/preorder";

export const Route = createFileRoute("/account/invoices")({
  head: () => ({
    meta: [
      { title: "Invoices | Shami Business Ventures" },
      {
        name: "description",
        content: "Download GST invoices for every order placed on Shami Business Ventures.",
      },
      { property: "og:title", content: "My Invoices | Shami" },
      { property: "og:description", content: "GST-compliant invoices for all your orders." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AccountInvoices,
});

function AccountInvoices() {
  const { user, orders } = useApp();
  // Only orders whose invoice the customer may see: paid in full and confirmed by the office (owner, 11 Nov 2026), the
  // same rule as the order page and the channel partner's list.
  const list = orders.filter((order) => orderBelongsToUser(order, user) && customerInvoiceVisible({ orderStatus: order.status, payment: order.payment }));
  // Orders waiting for pre-order goods (14 Nov 2026): their tax invoice and pickup QR are made when the goods arrive.
  const waitingGoods = useCustomerWaitingOrders(list.filter((o) => o.dbOrderId).map((o) => o.dbOrderId as string));
  const orderNos = list.map((order) => order.id).join(",");
  // The invoice number is Zoho Books' own, never one made up here; an order Zoho has not invoiced yet shows none.
  const [zohoNumbers, setZohoNumbers] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    if (STATIC_DATA_MODE || !orderNos) return;
    let active = true;
    void supabase.from("zoho_order_invoices").select("order_no,invoice_number,status").in("order_no", orderNos.split(",")).then(({ data, error }) => {
      if (!active || error) return;
      const numbers = new Map<string, string>();
      for (const row of data ?? []) {
        const number = issuedZohoNumber(row as ZohoInvoiceCopy);
        if (number) numbers.set(row.order_no, number);
      }
      setZohoNumbers(numbers);
    });
    return () => { active = false; };
  }, [orderNos]);
  const total = list.reduce((s, o) => s + o.amount, 0);
  const gst = list.reduce((s, o) => s + o.tax, 0);

  const handleExportAll = () => {
    downloadCSV(
      "Invoices_Summary",
      [
        "Invoice No",
        "Order ID",
        "Date",
        "Total Amount (INR)",
        "GST Paid (INR)",
        "Payment Status",
        "Payment Method",
      ],
      list.map((o) => [
        zohoNumbers.get(o.id) ?? "",
        o.id,
        o.date,
        o.amount,
        o.tax,
        o.payment,
        o.method,
      ]),
    );
  };

  return (
    <PanelLayout
      items={accountNav}
      tone="customer"
      title="Invoices"
      subtitle="GST invoices for your orders"
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard onClick={() => scrollToSection("invoice-history")} label="Total Invoices" value={String(list.length)} icon={FileText} highlight />
        <StatCard onClick={() => scrollToSection("invoice-history")} label="Invoiced Value" value={inr(total)} icon={IndianRupee} />
        <StatCard onClick={() => scrollToSection("invoice-history")} label="GST Paid" value={inr(gst)} icon={Receipt} />
      </div>

      <Panel
        id="invoice-history"
        title="Invoice History"
        className="mt-6"
        action={
          <Button variant="outline" size="sm" onClick={handleExportAll}>
            <Download className="mr-1.5 h-3.5 w-3.5" /> Export All (CSV)
          </Button>
        }
      >
        <p className="mb-3 text-xs text-slate">An order's invoice, with its delivery QR, appears here once your payment is confirmed.</p>
        <DataTable
          empty="No invoices yet"
          columns={["Invoice No", "Order", "Date", "Amount", "GST", "Payment", "Actions"]}
          rows={list.map((o) => [
            zohoNumbers.get(o.id)
              ? <span className="font-semibold text-navy">{zohoNumbers.get(o.id)}</span>
              : o.dbOrderId && waitingGoods.has(o.dbOrderId)
                ? <span className="block max-w-[16rem] text-xs text-amber-800">{preorderText.invoiceLater(o.amount.toFixed(2))}</span>
                : <span className="text-xs text-slate">Being issued</span>,
            <Link
              to="/account/orders/$id"
              params={{ id: o.id }}
              className="font-semibold text-navy hover:text-gold"
            >
              {o.id}
            </Link>,
            o.date,
            inr(o.amount),
            inr(o.tax),
            <StatusBadge status={o.payment} />,
            // Only the tax invoice: while Zoho is issuing it there is nothing to download yet.
            zohoNumbers.get(o.id) ? <InvoicePreviewButton order={o} size="sm" label="View / Download" /> : <span className="text-xs text-slate">Soon</span>,
          ])}
        />
      </Panel>
    </PanelLayout>
  );
}
