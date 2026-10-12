import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Inbox } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel, StatusBadge } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";

export const Route = createFileRoute("/admin/enquiries")({
  head: () => ({
    meta: [{ title: "Customer Enquiries | Shami Admin" }, { name: "robots", content: "noindex" }],
  }),
  component: AdminEnquiries,
});

type Enquiry = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  message: string;
  recipient_email: string;
  status: string;
  email_sent: boolean;
  email_delivery_status: string;
  metadata: Json | null;
  created_at: string;
};

function AdminEnquiries() {
  const [rows, setRows] = useState<Enquiry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void supabase
      .from("contact_enquiries")
      .select("*")
      .order("created_at", { ascending: false })
      .then(
        ({
          data,
          error: queryError,
        }: {
          data: Enquiry[] | null;
          error: { message: string } | null;
        }) => {
          if (!active) return;
          if (queryError) setError(queryError.message);
          else setRows(data ?? []);
          setLoading(false);
        },
      );
    return () => {
      active = false;
    };
  }, []);

  return (
    <PanelLayout
      items={adminNav}
      tone="admin"
      title="Customer Enquiries"
      subtitle="Product availability, bulk and supply requests"
    >
      <Panel title={`Requests (${rows.length})`}>
        {loading ? (
          <p className="py-8 text-center text-sm text-slate">Loading requests…</p>
        ) : error ? (
          <p role="alert" className="py-8 text-center text-sm text-danger">
            Could not load enquiries: {error}
          </p>
        ) : rows.length === 0 ? (
          <div className="grid justify-items-center gap-2 py-12 text-center">
            <Inbox className="h-8 w-8 text-slate" />
            <p className="font-semibold text-navy">No customer enquiries yet</p>
            <p className="text-sm text-slate">
              Requests sent from the storefront will appear here.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b text-xs uppercase text-slate">
                  <th className="p-3">Request</th>
                  <th className="p-3">Customer</th>
                  <th className="p-3">Received</th>
                  <th className="p-3">Email delivery</th>
                  <th className="p-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-border/60">
                    <td className="p-3">
                      <Link
                        to="/admin/enquiries/$id"
                        params={{ id: row.id }}
                        className="font-semibold text-gold hover:underline"
                      >
                        {getMetadata(row.metadata)?.["request_type"] === "product_configuration"
                          ? "Product availability"
                          : "General enquiry"}
                      </Link>
                      <p className="mt-1 max-w-sm truncate text-xs text-slate">{row.message}</p>
                    </td>
                    <td className="p-3">
                      <p className="font-medium text-navy">{row.name}</p>
                      <a
                        className="text-xs text-slate hover:text-gold"
                        href={`mailto:${row.email}`}
                      >
                        {row.email}
                      </a>
                    </td>
                    <td className="p-3 text-slate">
                      {new Date(row.created_at).toLocaleString("en-IN")}
                    </td>
                    <td className="p-3">
                      <StatusBadge
                        status={row.email_sent ? "Provider accepted" : row.email_delivery_status}
                      />
                    </td>
                    <td className="p-3">
                      <StatusBadge status={row.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-4 text-xs text-slate">
          These requests are stored for admin follow-up. Email status reflects provider acceptance;
          it does not guarantee inbox delivery.
        </p>
      </Panel>
    </PanelLayout>
  );
}

function getMetadata(value: Json | null) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
