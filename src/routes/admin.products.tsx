import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Boxes, Download, Minus, Package, PackageX, Plus } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel, StatCard, StatusBadge } from "@/components/panel/widgets";
import { Pager } from "@/components/panel/pager";
import { adminNav } from "@/lib/panel-nav";
import { categories, inr, vendors, type Product } from "@/lib/data";
import { useApp } from "@/lib/store";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { downloadCSV } from "@/lib/export-utils";
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

export const Route = createFileRoute("/admin/products")({
  head: () => ({
    meta: [
      { title: "Products | Shami Business Ventures Admin" },
      {
        name: "description",
        content: "Manage the full product catalogue across all vendors on the platform.",
      },
      { property: "og:title", content: "Product Catalogue | Shami Admin" },
      { property: "og:description", content: "Add, edit, price and stock every listed product." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminProducts,
});

const PAGE_SIZE = 10;

function emptyForm() {
  return {
    name: "",
    category: categories[0]!.name,
    vendorId: vendors[0]!.id,
    mrp: "",
    price: "",
    gst: "5",
    stock: "",
    weight: "1 unit",
    minimumStock: "30",
    warehouseStock: "",
    requiredStock: "",
    image: "",
  };
}

function AdminProducts() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (pathname !== "/admin/products" && pathname !== "/admin/products/") {
    return <Outlet />;
  }
  return <AdminProductsPanel />;
}

function AdminProductsPanel() {
  const { products, addProduct, updateProduct, deleteProduct, duplicateProduct, getFIFOCost } =
    useApp();
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("all");
  const [vendorId, setVendorId] = useState("all");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState("created-desc");
  const [page, setPage] = useState(1);

  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState(emptyForm());

  const [quickOpen, setQuickOpen] = useState(false);
  const [quickForm, setQuickForm] = useState({ name: "", qty: "", price: "" });

  const [editing, setEditing] = useState<Product | null>(null);
  const [editForm, setEditForm] = useState({
    name: "",
    mrp: "",
    price: "",
    gst: "",
    stock: "",
    weight: "",
    image: "",
    minimumStock: "",
    warehouseStock: "",
    requiredStock: "",
  });

  const [stockEditing, setStockEditing] = useState<Product | null>(null);
  const [stockValue, setStockValue] = useState("");

  const filtered = useMemo(() => {
    let list = products.filter((p) => {
      const s = q.trim().toLowerCase();
      const matchesQ = !s || p.name.toLowerCase().includes(s) || p.sku.toLowerCase().includes(s);
      const matchesCat = category === "all" || p.category === category;
      const matchesVendor = vendorId === "all" || p.vendorId === vendorId;
      const matchesStatus = status === "all" || p.status === status;
      return matchesQ && matchesCat && matchesVendor && matchesStatus;
    });
    list = [...list].sort((a, b) => {
      if (sort === "created-desc") return b.created.localeCompare(a.created);
      if (sort === "price-desc") return b.price - a.price;
      if (sort === "price-asc") return a.price - b.price;
      if (sort === "stock-asc") return a.stock - b.stock;
      return 0;
    });
    return list;
  }, [products, q, category, vendorId, status, sort]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pages);
  const rows = filtered.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);

  const lowStock = products.filter((p) => p.stock > 0 && p.stock < 30).length;
  const outStock = products.filter((p) => p.stock === 0).length;

  const submitQuickAdd = () => {
    if (!quickForm.name.trim() || !quickForm.qty) {
      toast.error("Enter item name and quantity");
      return;
    }
    const qty = Number(quickForm.qty);
    if (Number.isNaN(qty) || qty < 0) {
      toast.error("Enter a valid quantity");
      return;
    }
    const price = Number(quickForm.price) || 0;
    const vendor = vendors[0]!;
    const stamp = Date.now().toString().slice(-6);
    const dateStr = new Date().toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
    const item: Product = {
      id: `P${stamp}`,
      name: quickForm.name.trim(),
      sku: `SBV-SU-${stamp}`,
      brand: "Shami Select",
      vendor: vendor.business,
      vendorId: vendor.id,
      category: "Sugar",
      subcategory: "S1 Sugar",
      image: products[0]!.image,
      mrp: price,
      price,
      gst: 5,
      rating: 0,
      reviews: 0,
      stock: qty,
      reserved: 0,
      sold: 0,
      weight: "1 unit",
      status: "approved",
      active: true,
      tags: [],
      description: "Manually added by admin.",
      specs: [{ label: "Brand", value: "Shami Select" }],
      created: dateStr,
      updated: dateStr,
    };
    addProduct(item);
    toast.success(`${item.name} added with ${qty} units`);
    setQuickForm({ name: "", qty: "", price: "" });
    setQuickOpen(false);
  };

  const submitAdd = () => {
    if (!form.name.trim() || !form.mrp || !form.price) {
      toast.error("Please fill product name, MRP and price");
      return;
    }
    const vendor = vendors.find((v) => v.id === form.vendorId)!;
    const id = `P${Date.now().toString().slice(-6)}`;
    const product: Product = {
      id,
      name: form.name,
      sku: `SBV-${form.category.slice(0, 2).toUpperCase()}-${Date.now().toString().slice(-4)}`,
      brand: "Shami Select",
      vendor: vendor.business,
      vendorId: vendor.id,
      category: form.category,
      subcategory: categories.find((c) => c.name === form.category)?.subs[0] ?? form.category,
      image: form.image.trim() || products[0]!.image,
      mrp: Number(form.mrp),
      price: Number(form.price),
      gst: Number(form.gst),
      rating: 4.2,
      reviews: 0,
      stock: Number(form.stock) || 0,
      warehouseStock: Number(form.warehouseStock || form.stock) || 0,
      requiredStock: Number(form.requiredStock) || 0,
      minimumStock: Number(form.minimumStock) || 0,
      reserved: 0,
      sold: 0,
      weight: form.weight.trim() || "1 unit",
      status: "pending",
      active: true,
      tags: [],
      description: "Newly added product pending catalogue review.",
      specs: [{ label: "Brand", value: "Shami Select" }],
      created: new Date().toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      }),
      updated: new Date().toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      }),
    };
    addProduct(product);
    toast.success(`${product.name} added to catalogue`);
    setAddOpen(false);
    setForm(emptyForm());
  };

  const handleExportProducts = () => {
    downloadCSV(
      "Products_Catalogue",
      [
        "Product ID",
        "Product Name",
        "SKU",
        "Category",
        "Subcategory",
        "Vendor",
        "MRP (INR)",
        "Selling Price (INR)",
        "GST (%)",
        "Stock Units",
        "Units Sold",
        "Rating",
        "Status",
      ],
      filtered.map((p) => [
        p.id,
        p.name,
        p.sku,
        p.category,
        p.subcategory,
        p.vendor,
        p.mrp,
        p.price,
        `${p.gst}%`,
        p.stock,
        p.sold,
        p.rating,
        p.status,
      ]),
    );
  };

  return (
    <PanelLayout
      items={adminNav}
      tone="admin"
      title="Products"
      subtitle="Marketplace-wide catalogue"
    >
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total Products" value={String(products.length)} icon={Package} highlight />
        <StatCard label="Low Stock" value={String(lowStock)} icon={AlertTriangle} />
        <StatCard label="Out of Stock" value={String(outStock)} icon={PackageX} />
        <StatCard label="Total Vendors" value={String(vendors.length)} icon={Boxes} />
      </div>

      <Panel
        title="Catalogue"
        className="mt-6"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportProducts}
              className="h-9 hover:border-gold hover:text-gold transition-colors"
            >
              <Download className="mr-1.5 h-3.5 w-3.5" /> Export CSV
            </Button>
            <Input
              placeholder="Search name or SKU"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
              className="h-9 w-52"
            />
            <Select
              value={category}
              onValueChange={(v) => {
                setCategory(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="h-9 w-36">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Categories</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c.name} value={c.name}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={vendorId}
              onValueChange={(v) => {
                setVendorId(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="h-9 w-40">
                <SelectValue placeholder="Vendor" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Vendors</SelectItem>
                {vendors.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.business}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={status}
              onValueChange={(v) => {
                setStatus(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="h-9 w-32">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sort} onValueChange={setSort}>
              <SelectTrigger className="h-9 w-40">
                <SelectValue placeholder="Sort" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="created-desc">Newest First</SelectItem>
                <SelectItem value="price-desc">Price: High to Low</SelectItem>
                <SelectItem value="price-asc">Price: Low to High</SelectItem>
                <SelectItem value="stock-asc">Stock: Low to High</SelectItem>
              </SelectContent>
            </Select>
            <Dialog open={quickOpen} onOpenChange={setQuickOpen}>
              <DialogTrigger asChild>
                <Button size="sm" variant="outline">
                  Add Item Manually
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add Item Manually</DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                  <div>
                    <Label>Item Name</Label>
                    <Input
                      value={quickForm.name}
                      onChange={(e) => setQuickForm({ ...quickForm, name: e.target.value })}
                      placeholder="e.g. S1 Sugar 50kg Bag"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>Quantity</Label>
                      <Input
                        type="number"
                        min={0}
                        value={quickForm.qty}
                        onChange={(e) => setQuickForm({ ...quickForm, qty: e.target.value })}
                      />
                    </div>
                    <div>
                      <Label>Price (optional)</Label>
                      <Input
                        type="number"
                        min={0}
                        value={quickForm.price}
                        onChange={(e) => setQuickForm({ ...quickForm, price: e.target.value })}
                      />
                    </div>
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setQuickOpen(false)}>
                    Cancel
                  </Button>
                  <Button onClick={submitQuickAdd}>Save Item</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <Dialog open={addOpen} onOpenChange={setAddOpen}>
              <DialogTrigger asChild>
                <Button size="sm">Add Product</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add Product</DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                  <div>
                    <Label>Name</Label>
                    <Input
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>Category</Label>
                      <Select
                        value={form.category}
                        onValueChange={(v) => setForm({ ...form, category: v })}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {categories.map((c) => (
                            <SelectItem key={c.name} value={c.name}>
                              {c.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label>Vendor</Label>
                      <Select
                        value={form.vendorId}
                        onValueChange={(v) => setForm({ ...form, vendorId: v })}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {vendors.map((v) => (
                            <SelectItem key={v.id} value={v.id}>
                              {v.business}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <Label>MRP</Label>
                      <Input
                        type="number"
                        value={form.mrp}
                        onChange={(e) => setForm({ ...form, mrp: e.target.value })}
                      />
                    </div>
                    <div>
                      <Label>Price</Label>
                      <Input
                        type="number"
                        value={form.price}
                        onChange={(e) => setForm({ ...form, price: e.target.value })}
                      />
                    </div>
                    <div>
                      <Label>GST %</Label>
                      <Input
                        type="number"
                        value={form.gst}
                        onChange={(e) => setForm({ ...form, gst: e.target.value })}
                      />
                    </div>
                  </div>
                  <div>
                    <Label>Weight / Capacity</Label>
                    <Input
                      value={form.weight}
                      onChange={(e) => setForm({ ...form, weight: e.target.value })}
                      placeholder="e.g. 25 kg bag"
                    />
                  </div>
                  <div>
                    <Label>Product Image URL</Label>
                    <Input
                      value={form.image}
                      onChange={(e) => setForm({ ...form, image: e.target.value })}
                      placeholder="Paste image URL (optional)"
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <Label>Available Stock</Label>
                      <Input
                        type="number"
                        min={0}
                        value={form.stock}
                        onChange={(e) => setForm({ ...form, stock: e.target.value })}
                      />
                    </div>
                    <div>
                      <Label>Warehouse Stock</Label>
                      <Input
                        type="number"
                        min={0}
                        value={form.warehouseStock}
                        onChange={(e) => setForm({ ...form, warehouseStock: e.target.value })}
                      />
                    </div>
                    <div>
                      <Label>Required Stock</Label>
                      <Input
                        type="number"
                        min={0}
                        value={form.requiredStock}
                        onChange={(e) => setForm({ ...form, requiredStock: e.target.value })}
                      />
                    </div>
                  </div>
                  <div>
                    <Label>Minimum Stock Alert Level</Label>
                    <Input
                      type="number"
                      min={0}
                      value={form.minimumStock}
                      onChange={(e) => setForm({ ...form, minimumStock: e.target.value })}
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setAddOpen(false)}>
                    Cancel
                  </Button>
                  <Button onClick={submitAdd}>Save Product</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        }
      >
        <DataTable
          columns={[
            "Product",
            "SKU",
            "Category",
            "Vendor",
            "Weight / Capacity",
            "MRP",
            "Price",
            "FIFO Cost",
            "Stock",
            "Warehouse",
            "Required",
            "Min Stock",
            "Availability",
            "Rating",
            "Approval",
            "Active",
            "Created",
            "Actions",
          ]}
          rows={rows.map((p) => {
            return [
              <div className="flex items-center gap-3">
                <img
                  src={p.image}
                  alt={p.name}
                  className="h-10 w-10 rounded-md border border-border object-cover"
                />
                <Link
                  to="/admin/products/$id"
                  params={{ id: p.id }}
                  className="font-medium text-navy hover:text-gold"
                >
                  {p.name}
                </Link>
              </div>,
              p.sku,
              p.category,
              p.vendor,
              p.weight,
              inr(p.mrp),
              inr(p.price),
              <span className="font-mono text-xs font-semibold text-slate">
                {inr(getFIFOCost(p.id))}
              </span>,
              <div className="flex items-center gap-1.5">
                <span>{p.stock}</span>
                {p.stock === 0 ? (
                  <StatusBadge status="Out of Stock" />
                ) : p.stock < (p.minimumStock ?? 30) ? (
                  <StatusBadge status="Low Stock" />
                ) : null}
              </div>,
              p.warehouseStock ?? p.stock,
              p.requiredStock ?? 0,
              p.minimumStock ?? 30,
              <StatusBadge status={p.stock > 0 ? "Available" : "Out of Stock"} />,
              `${p.rating}★ (${p.reviews})`,
              <StatusBadge status={p.status} />,
              <Switch
                checked={p.active}
                onCheckedChange={(v) => {
                  updateProduct(p.id, { active: v });
                  toast.success(`${p.name} ${v ? "enabled" : "disabled"}`);
                }}
              />,
              p.created,
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setEditing(p);
                    setEditForm({
                      name: p.name,
                      mrp: String(p.mrp),
                      price: String(p.price),
                      gst: String(p.gst),
                      stock: String(p.stock),
                      weight: p.weight,
                      image: p.image,
                      minimumStock: String(p.minimumStock ?? 30),
                      warehouseStock: String(p.warehouseStock ?? p.stock),
                      requiredStock: String(p.requiredStock ?? 0),
                    });
                  }}
                >
                  Edit
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setStockEditing(p);
                    setStockValue(String(p.stock));
                  }}
                >
                  Stock
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    duplicateProduct(p.id);
                    toast.success(`${p.name} duplicated`);
                  }}
                >
                  Duplicate
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" size="sm">
                      Delete
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete {p.name}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This will permanently remove the product from the catalogue.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => {
                          deleteProduct(p.id);
                          toast.success(`${p.name} deleted`);
                        }}
                      >
                        Delete
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit {editing?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Name</Label>
              <Input
                value={editForm.name}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>MRP</Label>
                <Input
                  type="number"
                  value={editForm.mrp}
                  onChange={(e) => setEditForm({ ...editForm, mrp: e.target.value })}
                />
              </div>
              <div>
                <Label>Price</Label>
                <Input
                  type="number"
                  value={editForm.price}
                  onChange={(e) => setEditForm({ ...editForm, price: e.target.value })}
                />
              </div>
              <div>
                <Label>GST %</Label>
                <Input
                  type="number"
                  value={editForm.gst}
                  onChange={(e) => setEditForm({ ...editForm, gst: e.target.value })}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Weight / Capacity</Label>
                <Input
                  value={editForm.weight}
                  onChange={(e) => setEditForm({ ...editForm, weight: e.target.value })}
                />
              </div>
              <div>
                <Label>Product Image URL</Label>
                <Input
                  value={editForm.image}
                  onChange={(e) => setEditForm({ ...editForm, image: e.target.value })}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Available Stock</Label>
                <Input
                  type="number"
                  min={0}
                  value={editForm.stock}
                  onChange={(e) => setEditForm({ ...editForm, stock: e.target.value })}
                />
              </div>
              <div>
                <Label>Warehouse Stock</Label>
                <Input
                  type="number"
                  min={0}
                  value={editForm.warehouseStock}
                  onChange={(e) => setEditForm({ ...editForm, warehouseStock: e.target.value })}
                />
              </div>
              <div>
                <Label>Required Stock</Label>
                <Input
                  type="number"
                  min={0}
                  value={editForm.requiredStock}
                  onChange={(e) => setEditForm({ ...editForm, requiredStock: e.target.value })}
                />
              </div>
              <div>
                <Label>Minimum Stock Alert</Label>
                <Input
                  type="number"
                  min={0}
                  value={editForm.minimumStock}
                  onChange={(e) => setEditForm({ ...editForm, minimumStock: e.target.value })}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!editing) return;
                updateProduct(editing.id, {
                  name: editForm.name,
                  mrp: Number(editForm.mrp),
                  price: Number(editForm.price),
                  gst: Number(editForm.gst),
                  stock: Number(editForm.stock),
                  weight: editForm.weight,
                  image: editForm.image,
                  minimumStock: Number(editForm.minimumStock),
                  warehouseStock: Number(editForm.warehouseStock),
                  requiredStock: Number(editForm.requiredStock),
                });
                toast.success(`${editForm.name} updated`);
                setEditing(null);
              }}
            >
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!stockEditing} onOpenChange={(v) => !v && setStockEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Update Stock — {stockEditing?.name}</DialogTitle>
          </DialogHeader>
          <div>
            <Label>New Stock Quantity</Label>
            <div className="mt-1 flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Decrease stock by one"
                onClick={() =>
                  setStockValue((value) => String(Math.max(0, (Number(value) || 0) - 1)))
                }
              >
                <Minus className="h-4 w-4" />
              </Button>
              <Input
                type="number"
                min={0}
                value={stockValue}
                onChange={(e) => setStockValue(e.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Increase stock by one"
                onClick={() => setStockValue((value) => String((Number(value) || 0) + 1))}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStockEditing(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!stockEditing) return;
                updateProduct(stockEditing.id, { stock: Number(stockValue) || 0 });
                toast.success(`Stock for ${stockEditing.name} updated to ${stockValue}`);
                setStockEditing(null);
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
