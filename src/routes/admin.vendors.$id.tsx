import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Boxes, IndianRupee, Package, Percent } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel, StatCard, StatusBadge } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { getVendorPaidSales, inr } from "@/lib/data";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/admin/vendors/$id")({
  head: ({ params }) => ({
    meta: [
      { title: `Vendor ${params.id} | Shami Business Ventures Admin` },
      { name: "description", content: `Business profile, products, orders and payouts for vendor ${params.id}.` },
      { property: "og:title", content: "Vendor Profile | Shami Admin" },
      { property: "og:description", content: "Full vendor profile, KYC and performance history." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminVendorDetail,
});

function AdminVendorDetail() {
  const { id } = Route.useParams();
  const { vendors, products, orders, reviews, setVendorStatus } = useApp();
  const [kycDocuments, setKycDocuments] = useState<Array<{ id: string; document_type: string; object_path: string; status: string; admin_notes: string | null; created_at: string }>>([]);
  const [kycNotes, setKycNotes] = useState<Record<string, string>>({});
  const [kycLoading, setKycLoading] = useState(true);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [payoutRows, setPayoutRows] = useState<Array<{ id: string; date: string; amount: number; method: string; status: string }>>([]);
  const vendor = vendors.find((v) => v.id === id);

  useEffect(() => {
    let active = true;
    let revision = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let connectedOnce = false;
    const load = async () => {
      const requestRevision = ++revision;
      const [kyc, payouts] = await Promise.all([
        supabase.from("vendor_kyc_documents").select("id,document_type,object_path,status,admin_notes,created_at").eq("vendor_id", id).order("created_at", { ascending: false }),
        supabase.from("vendor_payout_requests").select("id,requested_at,amount,method,status").eq("vendor_id", id).order("requested_at", { ascending: false }),
      ]);
      if (!active || requestRevision !== revision) return;
      if (kyc.error) toast.error("Could not load vendor verification documents", { description: kyc.error.message });
      else setKycDocuments(kyc.data ?? []);
      if (payouts.error) toast.error("Could not load vendor payouts", { description: payouts.error.message });
      else setPayoutRows((payouts.data ?? []).map((row) => ({ id: row.id, date: new Date(row.requested_at).toLocaleDateString("en-IN"), amount: Number(row.amount), method: row.method, status: row.status })));
      setKycLoading(false);
    };
    const refreshSoon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 100);
    };
    void load();
    const channel = supabase.channel(`admin-vendor-detail-${id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "vendor_kyc_documents", filter: `vendor_id=eq.${id}` }, refreshSoon)
      .on("postgres_changes", { event: "*", schema: "public", table: "vendor_payout_requests", filter: `vendor_id=eq.${id}` }, refreshSoon)
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          if (connectedOnce) refreshSoon();
          connectedOnce = true;
        }
      });
    return () => {
      active = false;
      ++revision;
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [id]);

  const reviewDocument = async (documentId: string, status: "Approved" | "Rejected") => {
    setReviewingId(documentId);
    const { data, error } = await supabase.rpc("admin_review_vendor_kyc", { _id: documentId, _status: status, _notes: kycNotes[documentId] ?? "" });
    setReviewingId(null);
    if (error || !data) { toast.error("Could not update document review", { description: error?.message ?? "Document not found." }); return; }
    setKycDocuments((rows) => rows.map((row) => row.id === documentId ? { ...row, status, admin_notes: kycNotes[documentId]?.trim() || null } : row));
    toast.success(`Document ${status.toLowerCase()}`);
  };

  const openDocument = async (path: string) => {
    const { data, error } = await supabase.storage.from("vendor-kyc").createSignedUrl(path, 60);
    if (error || !data?.signedUrl) { toast.error("Could not open this document", { description: error?.message }); return; }
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  };

  if (!vendor) {
    return (
      <PanelLayout items={adminNav} tone="admin" title="Vendor Not Found" subtitle="We could not find this vendor">
        <Panel title="404">
          <p className="text-sm text-slate">Vendor id "{id}" was not found.</p>
          <Link to="/admin/vendors" className="mt-3 inline-block text-sm font-semibold text-gold">Back to Vendors</Link>
        </Panel>
      </PanelLayout>
    );
  }

  const vProducts = products.filter((p) => p.vendorId === vendor.id);
  const vOrders = orders.filter((o) => o.items.some((it) => it.vendorId === vendor.id));
  const vReviews = reviews.filter((r) => r.vendorId === vendor.id && r.status === "Published");
  const vPayouts = payoutRows;
  const vendorSales = getVendorPaidSales(vOrders, vendor.id);
  const vendorRating = vReviews.length ? vReviews.reduce((sum, review) => sum + review.rating, 0) / vReviews.length : 0;

  return (
    <PanelLayout items={adminNav} tone="admin" title={vendor.business} subtitle={`${vendor.owner} · ${vendor.city}`}>
      <Link to="/admin/vendors" className="mb-4 inline-block text-sm font-semibold text-navy hover:text-gold">← Back to Vendors</Link>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total Sales" value={inr(vendorSales)} icon={IndianRupee} highlight />
        <StatCard label="Products Listed" value={String(vProducts.length)} icon={Boxes} />
        <StatCard label="Total Orders" value={String(vOrders.length)} icon={Package} />
        <StatCard label="Commission Rate" value={`${vendor.commission}%`} icon={Percent} />
      </div>

      <Panel
        title="Business Profile"
        className="mt-6"
        action={
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={vendor.status === "approved" || vendor.status === "active"}
              onClick={() => {
                void setVendorStatus(vendor.id, "approved").then((ok) => { if (ok) toast.success(`${vendor.business} approved`); });
              }}
            >
              Approve
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={vendor.status === "suspended"}
              onClick={() => {
                void setVendorStatus(vendor.id, "suspended").then((ok) => { if (ok) toast.success(`${vendor.business} suspended`); });
              }}
            >
              Suspend
            </Button>
          </div>
        }
      >
        <div className="grid gap-2 text-sm sm:grid-cols-3">
          <p><span className="text-slate">Email:</span> <span className="font-medium text-navy">{vendor.email}</span></p>
          <p><span className="text-slate">Phone:</span> <span className="font-medium text-navy">{vendor.phone}</span></p>
          <p><span className="text-slate">GST:</span> <span className="font-medium text-navy">{vendor.gst}</span></p>
          <p><span className="text-slate">City:</span> <span className="font-medium text-navy">{vendor.city || "—"}</span></p>
          <p className="sm:col-span-2"><span className="text-slate">Business address:</span> <span className="font-medium text-navy">{vendor.businessAddress || "—"}</span></p>
          <p><span className="text-slate">Bank:</span> <span className="font-medium text-navy">{vendor.bank}</span></p>
          <p><span className="text-slate">Rating:</span> <span className="font-medium text-navy">{vendorRating.toFixed(1)} / 5</span></p>
          <p><span className="text-slate">Joined:</span> <span className="font-medium text-navy">{vendor.joined}</span></p>
          <p><span className="text-slate">Status:</span> <StatusBadge status={vendor.status} /></p>
        </div>
      </Panel>

      <div className="mt-6">
        <Tabs defaultValue="products">
          <TabsList>
            <TabsTrigger value="products">Products</TabsTrigger>
            <TabsTrigger value="orders">Orders</TabsTrigger>
            <TabsTrigger value="kyc">KYC Documents</TabsTrigger>
            <TabsTrigger value="payouts">Payouts</TabsTrigger>
            <TabsTrigger value="reviews">Reviews</TabsTrigger>
          </TabsList>

          <TabsContent value="products">
            <Panel>
              <DataTable
                columns={["Product", "Category", "SKU", "Price", "Stock", "Status"]}
                rows={vProducts.map((p) => [
                  <Link to="/admin/products/$id" params={{ id: p.id }} className="font-semibold text-navy hover:text-gold">{p.name}</Link>,
                  p.category, p.sku, inr(p.price), p.stock, <StatusBadge status={p.status} />,
                ])}
              />
            </Panel>
          </TabsContent>

          <TabsContent value="kyc">
            <Panel title="Vendor verification documents">
              {kycLoading ? <p className="py-8 text-sm text-slate">Loading documents…</p> : kycDocuments.length === 0 ? <p className="py-8 text-sm text-slate">This vendor has not submitted verification documents.</p> : <div className="space-y-4">
                {kycDocuments.map((document) => <div key={document.id} className="rounded-lg border border-border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div><p className="font-semibold capitalize text-navy">{document.document_type.replaceAll("_", " ")}</p><p className="text-xs text-slate">Submitted {new Date(document.created_at).toLocaleString("en-IN")}</p></div>
                    <StatusBadge status={document.status} />
                  </div>
                  {document.admin_notes && <p className="mt-2 text-sm text-charcoal">Previous note: {document.admin_notes}</p>}
                  <Textarea className="mt-3" rows={2} maxLength={2000} placeholder="Optional note for the vendor" value={kycNotes[document.id] ?? document.admin_notes ?? ""} onChange={(event) => setKycNotes((notes) => ({ ...notes, [document.id]: event.target.value }))} />
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button variant="outline" onClick={() => void openDocument(document.object_path)}>Open private document</Button>
                    <Button disabled={reviewingId === document.id} className="bg-navy text-white" onClick={() => void reviewDocument(document.id, "Approved")}>{reviewingId === document.id ? "Saving…" : "Approve"}</Button>
                    <Button disabled={reviewingId === document.id} variant="destructive" onClick={() => void reviewDocument(document.id, "Rejected")}>Reject</Button>
                  </div>
                </div>)}
              </div>}
            </Panel>
          </TabsContent>

          <TabsContent value="orders">
            <Panel>
              <DataTable
                columns={["Order", "Date", "Customer", "Amount", "Status"]}
                rows={vOrders.slice(0, 25).map((o) => [
                  <Link to="/admin/orders/$id" params={{ id: o.id }} className="font-semibold text-navy hover:text-gold">{o.id}</Link>,
                  o.date, o.customer, inr(o.amount), <StatusBadge status={o.status} />,
                ])}
              />
            </Panel>
          </TabsContent>

          <TabsContent value="payouts">
            <Panel>
              <DataTable
                columns={["Payout ID", "Date", "Amount", "Method", "Status"]}
                rows={vPayouts.map((p) => [p.id, p.date, inr(p.amount), p.method, <StatusBadge status={p.status} />])}
              />
            </Panel>
          </TabsContent>

          <TabsContent value="reviews">
            <Panel>
              {vReviews.length === 0 ? (
                <p className="text-sm text-slate">No reviews for this vendor yet.</p>
              ) : (
                <div className="space-y-3">
                  {vReviews.slice(0, 12).map((r) => (
                    <div key={r.id} className="rounded-md border border-border p-3">
                      <div className="flex items-center justify-between">
                        <p className="font-semibold text-navy">{r.product}</p>
                        <span className="text-xs text-gold">{r.rating}★</span>
                      </div>
                      <p className="mt-1 text-sm text-charcoal">{r.body}</p>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </TabsContent>
        </Tabs>
      </div>
    </PanelLayout>
  );
}
