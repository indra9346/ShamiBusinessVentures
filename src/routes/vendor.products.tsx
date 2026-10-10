import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Package, PackagePlus, PackageX, TrendingUp } from "lucide-react";
import { toast } from "sonner";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel, StatCard, StatusBadge } from "@/components/panel/widgets";
import { Pager } from "@/components/panel/pager";
import { vendorNav } from "@/lib/panel-nav";
import { inr } from "@/lib/data";
import { useApp, useVendorScope } from "@/lib/store";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import type { Product } from "@/lib/data";

export const Route = createFileRoute("/vendor/products")({
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search["q"] === "string" ? { q: search["q"] } : {}),
  }),
  head: () => ({
    meta: [
      { title: "My Products | Shami Vendor Panel" },
      { name: "description", content: "Manage your product catalogue, stock and pricing." },
      { property: "og:title", content: "My Products | Shami Vendor" },
      { property: "og:description", content: "Catalogue management for Shami marketplace vendors." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: VendorProducts,
});

const PAGE_SIZE = 10;

function VendorProducts() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (pathname !== "/vendor/products" && pathname !== "/vendor/products/") {
    return <Outlet />;
  }
  return <VendorProductsPanel />;
}

function VendorProductsPanel() {
  const routeSearch = Route.useSearch();
  const { updateProduct, deleteProduct, duplicateProduct, categories } = useApp();
  const { vendorProducts } = useVendorScope();
  const [q, setQ] = useState(routeSearch.q ?? "");
  const [category, setCategory] = useState("all");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState("created-desc");
  const [page, setPage] = useState(1);

  useEffect(() => {
    setQ(routeSearch.q ?? "");
    setPage(1);
  }, [routeSearch.q]);

  const [editing, setEditing] = useState<Product | null>(null);
  const [editForm, setEditForm] = useState<Partial<Product>>({});
  const [stockDialog, setStockDialog] = useState<Product | null>(null);
  const [stockValue, setStockValue] = useState("");

  const filtered = useMemo(() => {
    let list = vendorProducts.filter((p) => {
      const s = q.trim().toLowerCase();
      const matchesQ = !s || `${p.name} ${p.sku} ${p.category}`.toLowerCase().includes(s);
      const matchesCat = category === "all" || p.category === category;
      const matchesStatus = status === "all" || p.status === status;
      return matchesQ && matchesCat && matchesStatus;
    });
    list = [...list].sort((a, b) => {
      if (sort === "created-desc") return b.created.localeCompare(a.created);
      if (sort === "created-asc") return a.created.localeCompare(b.created);
      if (sort === "price-desc") return b.price - a.price;
      if (sort === "price-asc") return a.price - b.price;
      if (sort === "stock-asc") return a.stock - b.stock;
      return 0;
    });
    return list;
  }, [vendorProducts, q, category, status, sort]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pages);
  const rows = filtered.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);

  const total = vendorProducts.length;
  const active = vendorProducts.filter((p) => p.active).length;
  const outOfStock = vendorProducts.filter((p) => p.stock === 0).length;
  const totalSold = vendorProducts.reduce((s, p) => s + p.sold, 0);

  return (
    <PanelLayout items={vendorNav} tone="vendor" title="My Products" subtitle="Manage your vendor catalogue">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total Products" value={String(total)} icon={Package} highlight />
        <StatCard label="Active Products" value={String(active)} icon={Package} />
        <StatCard label="Out of Stock" value={String(outOfStock)} icon={PackageX} />
        <StatCard label="Units Sold" value={String(totalSold)} icon={TrendingUp} />
      </div>

      <Panel
        title="All Products"
        className="mt-6"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="Search name or SKU"
              value={q}
              onChange={(e) => { setQ(e.target.value); setPage(1); }}
              className="h-9 w-56"
            />
            <Select value={category} onValueChange={(v) => { setCategory(v); setPage(1); }}>
              <SelectTrigger className="h-9 w-36"><SelectValue placeholder="Category" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Categories</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c.name} value={c.name}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
              <SelectTrigger className="h-9 w-32"><SelectValue placeholder="Status" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sort} onValueChange={setSort}>
              <SelectTrigger className="h-9 w-40"><SelectValue placeholder="Sort" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="created-desc">Newest First</SelectItem>
                <SelectItem value="created-asc">Oldest First</SelectItem>
                <SelectItem value="price-desc">Price: High to Low</SelectItem>
                <SelectItem value="price-asc">Price: Low to High</SelectItem>
                <SelectItem value="stock-asc">Stock: Low to High</SelectItem>
              </SelectContent>
            </Select>
            <Link to="/vendor/products/add">
              <Button size="sm" className="bg-navy text-white hover:bg-navy/90">
                <PackagePlus className="mr-1.5 h-4 w-4" /> Add Product
              </Button>
            </Link>
          </div>
        }
      >
        <DataTable
          columns={["Image", "Name", "SKU", "Category", "Price", "MRP", "Discount", "Stock", "Sold", "Rating", "Status", "Active", "Created", "Actions"]}
          rows={rows.map((p) => {
            const discount = Math.round(((p.mrp - p.price) / p.mrp) * 100);
            return [
              <img src={p.image} alt={p.name} loading="lazy" width={800} height={800} className="h-10 w-10 rounded-md object-cover" />,
              <span className="font-semibold text-navy">{p.name}</span>,
              p.sku,
              p.category,
              inr(p.price),
              <span className="text-slate line-through">{inr(p.mrp)}</span>,
              `${discount}%`,
              p.stock,
              p.sold,
              `${p.rating} ★`,
              <StatusBadge status={p.status} />,
              <Switch
                checked={p.active}
                onCheckedChange={async (v) => { if (await updateProduct(p.id, { active: v })) toast.success(v ? `${p.name} saved and submitted for admin review` : `${p.name} disabled and submitted for admin review`); }}
              />,
              p.created,
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setEditing(p);
                    setEditForm(p);
                  }}
                >
                  Edit
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setStockDialog(p);
                    setStockValue(String(p.stock));
                  }}
                >
                  Stock
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void duplicateProduct(p.id).then((ok) => { if (ok) toast.success(`${p.name} duplicated`); });
                  }}
                >
                  Duplicate
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" size="sm">Delete</Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete {p.name}?</AlertDialogTitle>
                      <AlertDialogDescription>This will permanently remove the product from your catalogue.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => { void deleteProduct(p.id).then((ok) => { if (ok) toast.success(`${p.name} deleted`); }); }}
                      >
                        Confirm Delete
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>,
            ];
          })}
        />
        <Pager page={pageSafe} pages={pages} onPage={setPage} total={filtered.length} />
      </Panel>

      <Dialog open={!!editing} onOpenChange={(v) => !v && setEditing(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Product</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label>Name</Label>
                <Input value={editForm.name ?? ""} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <div className="flex items-center justify-between">
                    <Label>Price (₹)</Label>
                    <span className="text-[11px] font-medium text-slate">🔒 Admin only</span>
                  </div>
                  <Input
                    type="number"
                    value={editForm.price ?? 0}
                    disabled
                    className="bg-muted cursor-not-allowed opacity-75"
                    title="Price editing is restricted to Admin"
                  />
                </div>
                <div className="grid gap-1.5">
                  <div className="flex items-center justify-between">
                    <Label>MRP (₹)</Label>
                    <span className="text-[11px] font-medium text-slate">🔒 Admin only</span>
                  </div>
                  <Input
                    type="number"
                    value={editForm.mrp ?? 0}
                    disabled
                    className="bg-muted cursor-not-allowed opacity-75"
                    title="MRP editing is restricted to Admin"
                  />
                </div>
              </div>
              <p className="text-xs text-slate">
                Note: Cost and selling price modifications are restricted to Platform Administrators. Contact admin to request price changes.
              </p>
              <div className="grid gap-1.5">
                <Label>Description</Label>
                <Textarea value={editForm.description ?? ""} onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button
              className="bg-navy text-white hover:bg-navy/90"
              onClick={async () => {
                if (!editing) return;
                if (!editForm.name) {
                  toast.error("Name is required");
                  return;
                }
                // Do not allow vendor to overwrite price or mrp
                const { price: _p, mrp: _m, purchasePrice: _cost, ...safeVendorPatch } = editForm;
                if (await updateProduct(editing.id, safeVendorPatch)) { toast.success(`${editForm.name} saved and submitted for admin review`); setEditing(null); }
              }}
            >
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!stockDialog} onOpenChange={(v) => !v && setStockDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Update Stock — {stockDialog?.name}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label>New stock quantity</Label>
            <Input type="number" value={stockValue} onChange={(e) => setStockValue(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStockDialog(null)}>Cancel</Button>
            <Button
              className="bg-navy text-white hover:bg-navy/90"
              onClick={async () => {
                if (!stockDialog) return;
                const val = Number(stockValue);
                if (Number.isNaN(val) || val < 0) {
                  toast.error("Enter a valid stock quantity");
                  return;
                }
                if (!await updateProduct(stockDialog.id, { stock: val })) return;
                toast.success(`Stock for ${stockDialog.name} updated; product submitted for admin review`);
                setStockDialog(null);
              }}
            >
              Update Stock
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PanelLayout>
  );
}
