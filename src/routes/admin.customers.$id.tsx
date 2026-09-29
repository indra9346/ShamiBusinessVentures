import { createFileRoute, Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel, StatusBadge } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { inr } from "@/lib/data";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const Route = createFileRoute("/admin/customers/$id")({
  head: ({ params }) => ({
    meta: [
      { title: `Customer ${params.id} | Shami Business Ventures Admin` },
      { name: "description", content: `Profile, orders, addresses and activity for customer ${params.id}.` },
      { property: "og:title", content: "Customer Profile | Shami Admin" },
      { property: "og:description", content: "Full customer profile and activity history." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminCustomerDetail,
  notFoundComponent: () => (
    <PanelLayout items={adminNav} tone="admin" title="Customer Not Found" subtitle="We could not find this customer">
      <Panel title="404">
        <p className="text-sm text-slate">The customer you are looking for does not exist.</p>
        <Link to="/admin/customers" className="mt-3 inline-block text-sm font-semibold text-gold">Back to Customers</Link>
      </Panel>
    </PanelLayout>
  ),
});

function AdminCustomerDetail() {
  const { id } = Route.useParams();
  const { customers, orders, reviews, addresses, products, setCustomerStatus } = useApp();
  const customer = customers.find((c) => c.id === id);

  if (!customer) {
    return (
      <PanelLayout items={adminNav} tone="admin" title="Customer Not Found" subtitle="We could not find this customer">
        <Panel title="404">
          <p className="text-sm text-slate">Customer id "{id}" was not found.</p>
          <Link to="/admin/customers" className="mt-3 inline-block text-sm font-semibold text-gold">Back to Customers</Link>
        </Panel>
      </PanelLayout>
    );
  }

  const custOrders = orders.filter((o) => o.customerId === customer.id);
  const custReviews = reviews.filter((r) => r.customerId === customer.id);
  const wishlist = products.slice(0, 4);

  return (
    <PanelLayout items={adminNav} tone="admin" title={customer.name} subtitle={customer.email}>
      <Link to="/admin/customers" className="mb-4 inline-block text-sm font-semibold text-navy hover:text-gold">← Back to Customers</Link>

      <Panel
        title="Profile"
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const next = customer.status === "blocked" ? "active" : "blocked";
              setCustomerStatus(customer.id, next);
              toast.success(`${customer.name} ${next === "blocked" ? "blocked" : "unblocked"}`);
            }}
          >
            {customer.status === "blocked" ? "Unblock Customer" : "Block Customer"}
          </Button>
        }
      >
        <div className="flex flex-wrap items-center gap-4">
          <span className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-navy/10 text-lg font-bold text-navy">{customer.avatar}</span>
          <div className="grid flex-1 gap-1 text-sm sm:grid-cols-3">
            <p><span className="text-slate">Phone:</span> <span className="font-medium text-navy">{customer.phone}</span></p>
            <p><span className="text-slate">Location:</span> <span className="font-medium text-navy">{customer.city}, {customer.state}</span></p>
            <p><span className="text-slate">Joined:</span> <span className="font-medium text-navy">{customer.joined}</span></p>
            <p><span className="text-slate">Orders:</span> <span className="font-medium text-navy">{customer.orders}</span></p>
            <p><span className="text-slate">Spend:</span> <span className="font-medium text-navy">{inr(customer.spend)}</span></p>
            <p><span className="text-slate">Status:</span> <StatusBadge status={customer.status} /></p>
          </div>
        </div>
      </Panel>

      <div className="mt-6">
        <Tabs defaultValue="orders">
          <TabsList>
            <TabsTrigger value="orders">Orders</TabsTrigger>
            <TabsTrigger value="payments">Payments</TabsTrigger>
            <TabsTrigger value="addresses">Addresses</TabsTrigger>
            <TabsTrigger value="wishlist">Wishlist</TabsTrigger>
            <TabsTrigger value="reviews">Reviews</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>

          <TabsContent value="orders">
            <Panel>
              <DataTable
                columns={["Order", "Date", "Items", "Amount", "Status"]}
                rows={custOrders.map((o) => [
                  <Link to="/admin/orders/$id" params={{ id: o.id }} className="font-semibold text-navy hover:text-gold">{o.id}</Link>,
                  o.date, o.items.length, inr(o.amount), <StatusBadge status={o.status} />,
                ])}
              />
            </Panel>
          </TabsContent>

          <TabsContent value="payments">
            <Panel>
              <DataTable
                columns={["Order", "Txn", "Method", "Amount", "Status"]}
                rows={custOrders.map((o) => [o.id, o.txn, o.method, inr(o.amount), <StatusBadge status={o.payment} />])}
              />
            </Panel>
          </TabsContent>

          <TabsContent value="addresses">
            <Panel>
              <DataTable
                columns={["Label", "Line", "City", "State", "PIN"]}
                rows={addresses.map((a) => [a.label, a.line, a.city, a.state, a.pin])}
              />
            </Panel>
          </TabsContent>

          <TabsContent value="wishlist">
            <Panel>
              <DataTable
                columns={["Product", "Category", "Price"]}
                rows={wishlist.map((p) => [p.name, p.category, inr(p.price)])}
              />
            </Panel>
          </TabsContent>

          <TabsContent value="reviews">
            <Panel>
              {custReviews.length === 0 ? (
                <p className="text-sm text-slate">No reviews submitted by this customer.</p>
              ) : (
                <div className="space-y-3">
                  {custReviews.map((r) => (
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

          <TabsContent value="activity">
            <Panel>
              <div className="space-y-3">
                {custOrders.slice(0, 8).map((o) => (
                  <div key={o.id} className="flex items-center justify-between border-b border-border/70 pb-2 text-sm last:border-0">
                    <p className="text-charcoal">Placed order {o.id} worth {inr(o.amount)}</p>
                    <span className="text-xs text-slate">{o.date}</span>
                  </div>
                ))}
              </div>
            </Panel>
          </TabsContent>
        </Tabs>
      </div>
    </PanelLayout>
  );
}
