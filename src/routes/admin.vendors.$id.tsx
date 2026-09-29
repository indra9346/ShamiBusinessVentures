import { createFileRoute, Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Boxes, IndianRupee, Package, Percent } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel, StatCard, StatusBadge } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { inr, payouts } from "@/lib/data";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

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
  const vendor = vendors.find((v) => v.id === id);

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
  const vReviews = reviews.filter((r) => r.vendorId === vendor.id);
  const vPayouts = payouts.filter((p) => p.vendorId === vendor.id);

  return (
    <PanelLayout items={adminNav} tone="admin" title={vendor.business} subtitle={`${vendor.owner} · ${vendor.city}`}>
      <Link to="/admin/vendors" className="mb-4 inline-block text-sm font-semibold text-navy hover:text-gold">← Back to Vendors</Link>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total Sales" value={inr(vendor.sales)} icon={IndianRupee} highlight />
        <StatCard label="Products Listed" value={String(vProducts.length)} icon={Boxes} />
        <StatCard label="Orders Fulfilled" value={String(vOrders.length)} icon={Package} />
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
              disabled={vendor.status === "approved"}
              onClick={() => {
                setVendorStatus(vendor.id, "approved");
                toast.success(`${vendor.business} approved`);
              }}
            >
              Approve
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={vendor.status === "suspended"}
              onClick={() => {
                setVendorStatus(vendor.id, "suspended");
                toast.success(`${vendor.business} suspended`);
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
          <p><span className="text-slate">Bank:</span> <span className="font-medium text-navy">{vendor.bank}</span></p>
          <p><span className="text-slate">Rating:</span> <span className="font-medium text-navy">{vendor.rating} / 5</span></p>
          <p><span className="text-slate">Joined:</span> <span className="font-medium text-navy">{vendor.joined}</span></p>
          <p><span className="text-slate">Status:</span> <StatusBadge status={vendor.status} /></p>
        </div>
      </Panel>

      <div className="mt-6">
        <Tabs defaultValue="products">
          <TabsList>
            <TabsTrigger value="products">Products</TabsTrigger>
            <TabsTrigger value="orders">Orders</TabsTrigger>
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