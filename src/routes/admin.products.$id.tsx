import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel, StatusBadge } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { inr } from "@/lib/data";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

export const Route = createFileRoute("/admin/products/$id")({
  head: ({ params }) => ({
    meta: [
      { title: `Product ${params.id} | Shami Business Ventures Admin` },
      { name: "description", content: `Full catalogue detail, pricing, stock and reviews for product ${params.id}.` },
      { property: "og:title", content: `Product Detail | Shami Admin` },
      { property: "og:description", content: "Product pricing, stock, reviews and order history." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminProductDetail,
  notFoundComponent: () => (
    <PanelLayout items={adminNav} tone="admin" title="Product Not Found" subtitle="We could not find this product">
      <Panel title="404">
        <p className="text-sm text-slate">The product you are looking for does not exist.</p>
        <Link to="/admin/products" className="mt-3 inline-block text-sm font-semibold text-gold">Back to Products</Link>
      </Panel>
    </PanelLayout>
  ),
});

function AdminProductDetail() {
  const { id } = Route.useParams();
  const { products, reviews, orders, updateProduct } = useApp();
  const product = products.find((p) => p.id === id);

  const [stockOpen, setStockOpen] = useState(false);
  const [stockValue, setStockValue] = useState("");
  const [priceOpen, setPriceOpen] = useState(false);
  const [priceValue, setPriceValue] = useState("");

  if (!product) {
    return (
      <PanelLayout items={adminNav} tone="admin" title="Product Not Found" subtitle="We could not find this product">
        <Panel title="404">
          <p className="text-sm text-slate">Product id "{id}" was not found.</p>
          <Link to="/admin/products" className="mt-3 inline-block text-sm font-semibold text-gold">Back to Products</Link>
        </Panel>
      </PanelLayout>
    );
  }

  const productReviews = reviews.filter((r) => r.productId === product.id);
  const productOrders = orders.filter((o) => o.items.some((i) => i.product.id === product.id));
  const disc = Math.round(((product.mrp - product.price) / product.mrp) * 100);

  return (
    <PanelLayout items={adminNav} tone="admin" title={product.name} subtitle={product.sku}>
      <Link to="/admin/products" className="mb-4 inline-block text-sm font-semibold text-navy hover:text-gold">← Back to Products</Link>

      <div className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
        <Panel title="Gallery">
          <img src={product.image} alt={product.name} className="h-64 w-full rounded-lg border border-border object-cover" />
          <div className="mt-3 grid grid-cols-3 gap-2">
            {[0, 1, 2].map((i) => (
              <img key={i} src={product.image} alt={`${product.name} thumb ${i + 1}`} className="h-20 w-full rounded-md border border-border object-cover" />
            ))}
          </div>
        </Panel>

        <div className="space-y-6">
          <Panel title="Overview">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <StatusBadge status={product.status} />
              <StatusBadge status={product.active ? "active" : "blocked"} />
            </div>
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div className="flex justify-between"><dt className="text-slate">Brand</dt><dd className="font-medium text-navy">{product.brand}</dd></div>
              <div className="flex justify-between"><dt className="text-slate">Category</dt><dd className="font-medium text-navy">{product.category}</dd></div>
              <div className="flex justify-between"><dt className="text-slate">Subcategory</dt><dd className="font-medium text-navy">{product.subcategory}</dd></div>
              <div className="flex justify-between"><dt className="text-slate">Vendor</dt><dd className="font-medium text-navy">{product.vendor}</dd></div>
              <div className="flex justify-between"><dt className="text-slate">Created</dt><dd className="font-medium text-navy">{product.created}</dd></div>
              <div className="flex justify-between"><dt className="text-slate">Updated</dt><dd className="font-medium text-navy">{product.updated}</dd></div>
            </dl>
          </Panel>

          <div className="grid gap-6 sm:grid-cols-2">
            <Panel
              title="Pricing"
              action={<Button size="sm" variant="outline" onClick={() => { setPriceValue(String(product.price)); setPriceOpen(true); }}>Edit Price</Button>}
            >
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between"><dt className="text-slate">MRP</dt><dd className="font-medium text-navy">{inr(product.mrp)}</dd></div>
                <div className="flex justify-between"><dt className="text-slate">Sale Price</dt><dd className="font-medium text-navy">{inr(product.price)}</dd></div>
                <div className="flex justify-between"><dt className="text-slate">Discount</dt><dd className="font-medium text-navy">{disc}%</dd></div>
                <div className="flex justify-between"><dt className="text-slate">GST</dt><dd className="font-medium text-navy">{product.gst}%</dd></div>
              </dl>
            </Panel>
            <Panel
              title="Stock"
              action={<Button size="sm" variant="outline" onClick={() => { setStockValue(String(product.stock)); setStockOpen(true); }}>Edit Stock</Button>}
            >
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between"><dt className="text-slate">In Stock</dt><dd className="font-medium text-navy">{product.stock}</dd></div>
                <div className="flex justify-between"><dt className="text-slate">Reserved</dt><dd className="font-medium text-navy">{product.reserved}</dd></div>
                <div className="flex justify-between"><dt className="text-slate">Sold</dt><dd className="font-medium text-navy">{product.sold}</dd></div>
                <div className="flex justify-between"><dt className="text-slate">Rating</dt><dd className="font-medium text-navy">{product.rating}★ ({product.reviews})</dd></div>
              </dl>
            </Panel>
          </div>

          <Panel title="Specifications">
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              {product.specs.map((s) => (
                <div key={s.label} className="flex justify-between"><dt className="text-slate">{s.label}</dt><dd className="font-medium text-navy">{s.value}</dd></div>
              ))}
            </dl>
          </Panel>
        </div>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Panel title={`Reviews (${productReviews.length})`}>
          {productReviews.length === 0 ? (
            <p className="text-sm text-slate">No reviews for this product yet.</p>
          ) : (
            <div className="space-y-3">
              {productReviews.slice(0, 6).map((r) => (
                <div key={r.id} className="rounded-md border border-border p-3">
                  <div className="flex items-center justify-between">
                    <p className="font-semibold text-navy">{r.customer}</p>
                    <span className="text-xs text-gold">{r.rating}★</span>
                  </div>
                  <p className="text-xs font-medium text-slate">{r.title}</p>
                  <p className="mt-1 text-sm text-charcoal">{r.body}</p>
                </div>
              ))}
            </div>
          )}
        </Panel>
        <Panel title={`Order History (${productOrders.length})`}>
          <DataTable
            columns={["Order", "Date", "Customer", "Qty", "Status"]}
            rows={productOrders.slice(0, 8).map((o) => {
              const line = o.items.find((i) => i.product.id === product.id)!;
              return [
                <Link to="/admin/orders/$id" params={{ id: o.id }} className="font-semibold text-navy hover:text-gold">{o.id}</Link>,
                o.date,
                o.customer,
                line.qty,
                <StatusBadge status={o.status} />,
              ];
            })}
          />
        </Panel>
      </div>

      <Dialog open={stockOpen} onOpenChange={setStockOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Update Stock</DialogTitle></DialogHeader>
          <div><Label>New Stock Quantity</Label><Input type="number" value={stockValue} onChange={(e) => setStockValue(e.target.value)} /></div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStockOpen(false)}>Cancel</Button>
            <Button onClick={() => { updateProduct(product.id, { stock: Number(stockValue) || 0 }); toast.success(`Stock updated to ${stockValue}`); setStockOpen(false); }}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={priceOpen} onOpenChange={setPriceOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Update Price</DialogTitle></DialogHeader>
          <div><Label>New Sale Price</Label><Input type="number" value={priceValue} onChange={(e) => setPriceValue(e.target.value)} /></div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPriceOpen(false)}>Cancel</Button>
            <Button onClick={() => { updateProduct(product.id, { price: Number(priceValue) || product.price }); toast.success(`Price updated to ${inr(Number(priceValue))}`); setPriceOpen(false); }}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PanelLayout>
  );
}
