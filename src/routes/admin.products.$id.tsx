import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel, StatusBadge } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { getPricingDisplayMode, inr, type PricingDisplayMode } from "@/lib/data";
import { shownOnStorefront, storefrontPatch } from "@/lib/storefront-visibility";
import { PricingDisplayModeToggle } from "@/components/panel/PricingDisplayModeToggle";
import { GodownPricesPanel } from "@/components/panel/GodownPricesPanel";
import { ProductCodePicker } from "@/components/panel/ProductCodePicker";
import { duplicatesToConfirm } from "@/lib/product-code-rules";
import { isZohoMirrorProduct } from "@/lib/data";
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
  const { products, reviews, orders, categories, updateProduct, updateCategory, setProductCode } = useApp();
  const product = products.find((p) => p.id === id);

  const [stockOpen, setStockOpen] = useState(false);
  const [stockValue, setStockValue] = useState("");
  const [priceOpen, setPriceOpen] = useState(false);
  const [priceValue, setPriceValue] = useState("");
  const [pricingModeValue, setPricingModeValue] = useState<PricingDisplayMode>("strike_through");
  const [codeOpen, setCodeOpen] = useState(false);
  const [codeDraft, setCodeDraft] = useState({ productCode: "", name: "", description: "", subcategory: "", image: "" });
  // The product as the dialog opened: what the admin changed is measured from here, because the live copy can move meanwhile.
  const [codeOpenedAs, setCodeOpenedAs] = useState(codeDraft);
  const [codeBox, setCodeBox] = useState("");
  const [codeDuplicateOk, setCodeDuplicateOk] = useState(false);
  const [codeSaving, setCodeSaving] = useState(false);
  const openCode = () => {
    if (!product) return;
    const opened = { productCode: product.productCode ?? "", name: product.name, description: product.description ?? "", subcategory: product.subcategory, image: product.image };
    setCodeDraft(opened);
    setCodeOpenedAs(opened);
    setCodeDuplicateOk(false);
    setCodeOpen(true);
  };
  // The Product Codes page links here to give this product a code.
  const productLoaded = !!product;
  useEffect(() => {
    if (productLoaded && window.location.hash === "#product-code" && !isZohoMirrorProduct(product!)) openCode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productLoaded]);

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
  const disc = product.mrp > 0 ? Math.round(((product.mrp - product.price) / product.mrp) * 100) : 0;
  const pricingMode = getPricingDisplayMode(product);

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
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <StatusBadge status={product.status} />
                <StatusBadge status={product.active ? "active" : "blocked"} />
              </div>
              <div className="flex items-center gap-2">
                {product.status !== "approved" && (
                  <Button
                    size="sm"
                    className="bg-emerald-600 hover:bg-emerald-700 text-white"
                    onClick={async () => {
                      if (await updateProduct(product.id, { status: "approved", active: true })) {
                        toast.success(`${product.name} approved and live on storefront`);
                      }
                    }}
                  >
                    Approve & Publish
                  </Button>
                )}
                {product.status === "approved" && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-amber-700 hover:bg-amber-50"
                    onClick={async () => {
                      if (await updateProduct(product.id, { status: "rejected" })) {
                        toast.success(`${product.name} rejected / delisted from storefront`);
                      }
                    }}
                  >
                    Reject / Delist
                  </Button>
                )}
                {product.status === "approved" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      const show = !shownOnStorefront(product);
                      const patch = storefrontPatch(product, show);
                      if (patch && await updateProduct(product.id, patch)) {
                        toast.success(show ? `${product.name} is now shown on the storefront` : `${product.name} is hidden from the storefront`);
                      }
                    }}
                  >
                    {shownOnStorefront(product) ? "Hide from storefront" : "Show on storefront"}
                  </Button>
                )}
              </div>
            </div>
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div className="flex items-center justify-between gap-2 sm:col-span-2">
                <dt className="text-slate">Product code</dt>
                <dd className="flex items-center gap-2 font-medium text-navy">
                  {product.productCode
                    ? <span className="rounded bg-navy px-2 py-0.5 font-mono text-xs font-bold text-white">{product.productCode}</span>
                    : <span className="text-slate">None yet</span>}
                  {!isZohoMirrorProduct(product) && <Button size="sm" variant="outline" onClick={openCode}>{product.productCode ? "Change" : "Set code"}</Button>}
                </dd>
              </div>
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
              action={<Button size="sm" variant="outline" onClick={() => { setPriceValue(String(product.price)); setPricingModeValue(pricingMode); setPriceOpen(true); }}>Edit Price</Button>}
            >
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between"><dt className="text-slate">MRP</dt><dd className="font-medium text-navy">{inr(product.mrp)}</dd></div>
                <div className="flex justify-between"><dt className="text-slate">Sale Price</dt><dd className="font-medium text-navy">{inr(product.price)}</dd></div>
                <div className="flex justify-between"><dt className="text-slate">Discount</dt><dd className="font-medium text-navy">{disc}%</dd></div>
                <div className="flex justify-between"><dt className="text-slate">GST</dt><dd className="font-medium text-navy">{product.gst}%</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-slate">Storefront Display</dt><dd className="text-right font-medium text-navy">{pricingMode === "mrp_only" ? "Direct MRP Only" : "Discounted with Strikethrough"}</dd></div>
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
        <GodownPricesPanel productId={product.id} basePrice={product.price} status={product.status} active={product.active} />
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

      <Dialog open={codeOpen} onOpenChange={setCodeOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader><DialogTitle className="pr-6 leading-snug">Product code: {product.name}</DialogTitle></DialogHeader>
          <ProductCodePicker
            mode="edit"
            category={product.category}
            value={codeDraft.productCode}
            onSelect={(fill) => setCodeDraft((current) => ({ ...current, productCode: fill.code }))}
            onClear={() => { setCodeDraft((current) => ({ ...current, productCode: "" })); setCodeDuplicateOk(false); }}
            onBoxChange={setCodeBox}
            original={{ code: codeOpenedAs.productCode, subcategory: codeOpenedAs.subcategory, pack: product }}
            current={codeDraft}
            onUse={(patch) => setCodeDraft((current) => ({ ...current, ...patch }))}
            pack={product}
            excludeProductId={product.id}
            subcategories={categories.find((c) => c.name === product.category)?.grades ?? []}
            duplicateOk={codeDuplicateOk}
            onDuplicateOk={setCodeDuplicateOk}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCodeOpen(false)}>Cancel</Button>
            <Button
              disabled={codeSaving}
              onClick={async () => {
                if (codeBox && codeBox !== codeDraft.productCode) {
                  toast.error(`“${codeBox}” in the code box is not a code you can use`, { description: "Correct it, or clear the box to go on." });
                  return;
                }
                const originalCode = codeOpenedAs.productCode;
                if (!codeDuplicateOk && duplicatesToConfirm(products, codeDraft.productCode, product, product.id, { code: originalCode, pack: product }).length > 0) {
                  toast.error(`An active product already has code ${codeDraft.productCode} in this pack size`, { description: "Look at the warning, and tick it if you do want both." });
                  return;
                }
                const codeChanged = codeDraft.productCode !== originalCode;
                const taken = {
                  ...(codeDraft.name !== codeOpenedAs.name ? { name: codeDraft.name } : {}),
                  ...(codeDraft.description !== codeOpenedAs.description ? { description: codeDraft.description } : {}),
                  ...(codeDraft.subcategory !== codeOpenedAs.subcategory ? { subcategory: codeDraft.subcategory } : {}),
                  ...(codeDraft.image !== codeOpenedAs.image ? { image: codeDraft.image } : {}),
                };
                if (!codeChanged && Object.keys(taken).length === 0) { setCodeOpen(false); return; }
                setCodeSaving(true);
                try {
                  // Only what the admin chose changes. A code alone is written by itself: name, image, SKU and Zoho aren't touched.
                  if (Object.keys(taken).length > 0 && !(await updateProduct(product.id, taken))) return;
                  if (codeChanged && !(await setProductCode(product.id, codeDraft.productCode || undefined))) return;
                  const category = categories.find((c) => c.name.trim().toLowerCase() === product.category.trim().toLowerCase());
                  const sub = codeDraft.subcategory.trim();
                  if (taken.subcategory && category && sub && !category.grades.some((g) => g.trim().toLowerCase() === sub.toLowerCase())) {
                    if (!(await updateCategory(category.id, { grades: [...category.grades, sub] })))
                      toast.warning(`Saved, but “${sub}” was not added to ${category.name}`, { description: "Add it under Admin → Categories." });
                  }
                  toast.success(!codeChanged ? `${product.name} updated` : codeDraft.productCode ? `${product.name} now carries code ${codeDraft.productCode}` : `Code removed from ${product.name}`);
                  setCodeOpen(false);
                } finally {
                  setCodeSaving(false);
                }
              }}
            >
              {codeSaving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={stockOpen} onOpenChange={setStockOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Update Stock</DialogTitle></DialogHeader>
          <div><Label>New Stock Quantity</Label><Input type="number" value={stockValue} onChange={(e) => setStockValue(e.target.value)} /></div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStockOpen(false)}>Cancel</Button>
            <Button onClick={async () => { if (await updateProduct(product.id, { stock: Number(stockValue) || 0 })) { toast.success(`Stock updated to ${stockValue}`); setStockOpen(false); } }}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={priceOpen} onOpenChange={setPriceOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Update Price</DialogTitle></DialogHeader>
          <div><Label>New Sale Price</Label><Input type="number" value={priceValue} onChange={(e) => setPriceValue(e.target.value)} /></div>
          <PricingDisplayModeToggle
            id="detail-pricing-display-mode"
            value={pricingModeValue}
            onChange={setPricingModeValue}
            mrp={product.mrp}
            price={Number(priceValue) || product.price}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setPriceOpen(false)}>Cancel</Button>
            <Button onClick={async () => { const nextPrice = Number(priceValue) || product.price; if (await updateProduct(product.id, { price: nextPrice, pricingDisplayMode: pricingModeValue })) { toast.success(`Price updated to ${inr(nextPrice)}`); setPriceOpen(false); } }}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PanelLayout>
  );
}
