import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Download, FileText, IndianRupee, Receipt } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel, StatCard, StatusBadge } from "@/components/panel/widgets";
import { accountNav } from "@/lib/account-nav";
import { inr } from "@/lib/data";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { downloadCSV, downloadInvoice } from "@/lib/export-utils";
import { orderBelongsToUser } from "@/lib/account-identity";
import { supabase } from "@/integrations/supabase/client";

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
  const [invoicePrefix, setInvoicePrefix] = useState("INV-");
  useEffect(() => {
    let active = true;
    void supabase.from("settings").select("value").eq("key", "tax").eq("is_public", true).maybeSingle().then(({ data, error }) => {
      if (!active || error) return;
      const value = data?.value && typeof data.value === "object" && !Array.isArray(data.value)
        ? data.value as Record<string, unknown>
        : {};
      const prefix = value["invoice_prefix"];
      if (typeof prefix === "string" && prefix.trim()) setInvoicePrefix(prefix.trim());
    });
    return () => { active = false; };
  }, []);
  const list = orders.filter((order) => orderBelongsToUser(order, user));
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
        `${invoicePrefix}${o.id.replace(/[^0-9]/g, "") || o.id}`,
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
        <StatCard label="Total Invoices" value={String(list.length)} icon={FileText} highlight />
        <StatCard label="Invoiced Value" value={inr(total)} icon={IndianRupee} />
        <StatCard label="GST Paid" value={inr(gst)} icon={Receipt} />
      </div>

      <Panel
        title="Invoice History"
        className="mt-6"
        action={
          <Button variant="outline" size="sm" onClick={handleExportAll}>
            <Download className="mr-1.5 h-3.5 w-3.5" /> Export All (CSV)
          </Button>
        }
      >
        <DataTable
          columns={["Invoice No", "Order", "Date", "Amount", "GST", "Payment", "Actions"]}
          rows={list.map((o) => [
            <span className="font-semibold text-navy">{invoicePrefix}{o.id.replace(/[^0-9]/g, "") || o.id}</span>,
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
            <Button
              variant="outline"
              size="sm"
              onClick={() => downloadInvoice(o, undefined, invoicePrefix)}
              className="hover:border-gold hover:text-gold transition-colors"
            >
              <Download className="mr-1.5 h-3.5 w-3.5" /> Download
            </Button>,
          ])}
        />
      </Panel>
    </PanelLayout>
  );
}
