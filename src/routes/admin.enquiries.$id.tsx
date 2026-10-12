import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel, StatusBadge } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";

export const Route = createFileRoute("/admin/enquiries/$id")({
  head: ({ params }) => ({
    meta: [{ title: `Enquiry ${params.id} | Shami Admin` }, { name: "robots", content: "noindex" }],
  }),
  component: AdminEnquiryDetail,
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
  updated_at: string;
};

function AdminEnquiryDetail() {
  const { id } = Route.useParams();
  const [row, setRow] = useState<Enquiry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const metadata = getMetadata(row?.metadata ?? null);
  useEffect(() => {
    let active = true;
    void supabase
      .from("contact_enquiries")
      .select("*")
      .eq("id", id)
      .maybeSingle()
      .then(
        ({
          data,
          error: queryError,
        }: {
          data: Enquiry | null;
          error: { message: string } | null;
        }) => {
          if (!active) return;
          if (queryError) setError(queryError.message);
          else setRow(data);
          setLoading(false);
        },
      );
    return () => {
      active = false;
    };
  }, [id]);

  const setStatus = async (status: string) => {
    if (!row) return;
    setSaving(true);
    const { error: updateError } = await supabase
      .from("contact_enquiries")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", row.id);
    setSaving(false);
    if (updateError) {
      toast.error("Could not update request", { description: updateError.message });
      return;
    }
    setRow({ ...row, status });
    toast.success(`Request marked ${status.replaceAll("_", " ")}`);
  };

  const retryEmail = async () => {
    if (!row || row.email_sent || row.email_delivery_status === "sending") return;
    setSaving(true);
    const { error: resetError } = await supabase
      .from("contact_enquiries")
      .update({ email_delivery_status: "pending" })
      .eq("id", row.id)
      .in("email_delivery_status", ["pending", "failed"]);
    if (resetError) {
      setSaving(false);
      toast.error("Could not prepare email retry", { description: resetError.message });
      return;
    }
    const { data, error: sendError } = await supabase.functions.invoke("send-enquiry", {
      body: { enquiry_id: row.id },
    });
    const { data: refreshed, error: refreshError } = await supabase
      .from("contact_enquiries")
      .select("*")
      .eq("id", row.id)
      .maybeSingle();
    setSaving(false);
    if (refreshed) setRow(refreshed);
    if (sendError || data?.emailSent !== true) {
      toast.error("Email was not confirmed", {
        description:
          sendError?.message ??
          refreshError?.message ??
          "Check the email service configuration and try again.",
      });
      return;
    }
    toast.success("Email provider accepted the enquiry");
  };

  return (
    <PanelLayout
      items={adminNav}
      tone="admin"
      title={row?.name ?? "Customer Enquiry"}
      subtitle={row?.email ?? "Review and respond to this request"}
    >
      <Link
        to="/admin/enquiries"
        className="mb-4 inline-block text-sm font-semibold text-navy hover:text-gold"
      >
        ← Back to enquiries
      </Link>
      {loading ? (
        <Panel title="Loading">
          <p className="text-sm text-slate">Loading request…</p>
        </Panel>
      ) : error ? (
        <Panel title="Could not load request">
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        </Panel>
      ) : !row ? (
        <Panel title="Request not found">
          <p className="text-sm text-slate">
            This enquiry may have been removed or its link is invalid.
          </p>
        </Panel>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
          <Panel
            title={
              metadata?.["request_type"] === "product_configuration"
                ? "Product availability request"
                : "Customer message"
            }
          >
            <dl className="grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-slate">Customer</dt>
                <dd className="font-semibold text-navy">{row.name}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate">Received</dt>
                <dd className="text-navy">{new Date(row.created_at).toLocaleString("en-IN")}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate">Email</dt>
                <dd>
                  <a className="text-gold hover:underline" href={`mailto:${row.email}`}>
                    {row.email}
                  </a>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate">Phone</dt>
                <dd>
                  {row.phone ? (
                    <a className="text-gold hover:underline" href={`tel:${row.phone}`}>
                      {row.phone}
                    </a>
                  ) : (
                    "Not provided"
                  )}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs text-slate">Request details</dt>
                <dd className="mt-1 whitespace-pre-wrap rounded-md bg-ivory p-4 text-navy">
                  {row.message}
                </dd>
              </div>
              {metadata &&
                Object.entries(metadata)
                  .filter(([key, value]) => value != null && key !== "request_type")
                  .map(([key, value]) => (
                    <div key={key}>
                      <dt className="text-xs capitalize text-slate">{key.replaceAll("_", " ")}</dt>
                      <dd className="text-navy">{String(value)}</dd>
                    </div>
                  ))}
            </dl>
          </Panel>
          <Panel title="Follow-up">
            <div className="space-y-3 text-sm">
              <p>
                Email provider:{" "}
                <StatusBadge status={row.email_sent ? "Accepted" : row.email_delivery_status} />
              </p>
              <p>
                Status: <StatusBadge status={row.status} />
              </p>
              <p className="text-xs text-slate">Official recipient: {row.recipient_email}</p>
              <a
                href={`mailto:${row.email}?subject=${encodeURIComponent("Re: Shami Business Ventures enquiry")}`}
              >
                <Button className="w-full">Reply to customer</Button>
              </a>
              {!row.email_sent && row.email_delivery_status !== "sending" && (
                <Button
                  variant="outline"
                  className="w-full"
                  disabled={saving}
                  onClick={() => void retryEmail()}
                >
                  Retry official email
                </Button>
              )}
              <div className="grid gap-2">
                <Button
                  variant="outline"
                  disabled={saving || row.status === "in_progress"}
                  onClick={() => void setStatus("in_progress")}
                >
                  Mark in progress
                </Button>
                <Button
                  variant="outline"
                  disabled={saving || row.status === "resolved"}
                  onClick={() => void setStatus("resolved")}
                >
                  Mark resolved
                </Button>
                <Button
                  variant="outline"
                  disabled={saving || row.status === "new"}
                  onClick={() => void setStatus("new")}
                >
                  Reopen
                </Button>
              </div>
              {!row.email_sent && (
                <p className="text-xs text-amber-700">
                  Email status: {row.email_delivery_status}. No provider acceptance is recorded. Use
                  Reply to customer or contact {row.recipient_email} directly to follow up.
                </p>
              )}
            </div>
          </Panel>
        </div>
      )}
    </PanelLayout>
  );
}

function getMetadata(value: Json | null) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
