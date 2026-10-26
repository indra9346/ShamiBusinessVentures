import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Boxes,
  Download,
  ImagePlus,
  Minus,
  Package,
  PackageX,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel, StatCard, StatusBadge } from "@/components/panel/widgets";
import { Pager } from "@/components/panel/pager";
import { adminNav } from "@/lib/panel-nav";
import { DEFAULT_MAX_PURCHASE_QUANTITY, DEFAULT_PRICING_DISPLAY_MODE, getMaxPurchaseQuantity, getPricingDisplayMode, inr, isZohoMirrorProduct, storeCategorySeed, type PricingDisplayMode, type Product } from "@/lib/data";
import { PricingDisplayModeToggle } from "@/components/panel/PricingDisplayModeToggle";
import {
  ProductTradeFields,
  emptyTradeFields,
  productPatchFromFields,
  tradeFieldsFromProduct,
  validateTradeFields,
  type TradeFieldsState,
} from "@/components/panel/ProductTradeFields";
import { useApp } from "@/lib/store";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { hiddenReason, shownOnStorefront, storefrontPatch } from "@/lib/storefront-visibility";
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
import { uploadCatalogImage } from "@/lib/catalog-images";
import { defaultGstForCategory, loadTaxSettings } from "@/lib/business-rules";
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

/** Shows a product's created stamp as a date; older rows store epoch milliseconds. */
function formatCreated(value: string | undefined) {
  if (!value) return "—";
  const date = /^\d{11,}$/.test(value) ? new Date(Number(value)) : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

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

function ProductThumbnail({ src, name }: { src?: string; name: string }) {
  const [failed, setFailed] = useState(!src);
  useEffect(() => setFailed(!src), [src]);
  return (
    <div
      className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-card text-gold"
      role="img"
      aria-label={`${name} product image`}
    >
      {!failed && src ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          className="h-full w-full object-contain p-0.5"
          onError={() => setFailed(true)}
        />
      ) : (
        <Package className="h-5 w-5" aria-hidden="true" />
      )}
    </div>
  );
}

function emptyForm(
  defaultCategory = "Rice",
  defaultSubcategory = "Raw Rice",
  defaultVendorId = "",
) {
  return {
    name: "",
    description: "",
    category: defaultCategory,
    subcategory: defaultSubcategory,
    vendorId: defaultVendorId,
    mrp: "",
    price: "",
    gst: "5",
    stock: "",
    maxPurchaseQuantity: String(DEFAULT_MAX_PURCHASE_QUANTITY),
    weight: "1 unit",
    minimumStock: "30",
    warehouseStock: "",
    requiredStock: "",
    image: "",
    status: "approved" as "approved" | "pending" | "rejected",
    pricingDisplayMode: DEFAULT_PRICING_DISPLAY_MODE as PricingDisplayMode,
  };
}

/** GST % must be a finite number from 0 to 100; anything else (negative, blank, NaN) is rejected. */
function parseGstPercent(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const gst = Number(trimmed);
  return Number.isFinite(gst) && gst >= 0 && gst <= 100 ? gst : null;
}

/** Keeps a GST text input within 0–100 while typing (strips "-", clamps above 100). */
function sanitizeGstInput(raw: string): string {
  const cleaned = raw.replace(/[^\d.]/g, "");
  if (!cleaned) return "";
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return "";
  return n > 100 ? "100" : cleaned;
}

function AdminProducts() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (pathname !== "/admin/products" && pathname !== "/admin/products/") {
    return <Outlet />;
  }
  return <AdminProductsPanel />;
}

function AdminProductsPanel() {
  const {
    products,
    categories,
    vendors,
    addProduct,
    updateProduct,
    addCategory,
    updateCategory,
    deleteProduct,
    getFIFOCost,
  } = useApp();
  const categoryChoices = categories.map((c) => ({ name: c.name, subs: c.grades }));
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("all");
  const [vendorId, setVendorId] = useState("all");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState("created-desc");
  const [showZoho, setShowZoho] = useState(false);
  const [page, setPage] = useState(1);

  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState(
    emptyForm(categoryChoices[0]?.name, categoryChoices[0]?.subs[0], vendors[0]?.id),
  );
  const [trade, setTrade] = useState<TradeFieldsState>(() => emptyTradeFields(categoryChoices[0]?.name ?? "Rice"));
  const [editTrade, setEditTrade] = useState<TradeFieldsState>(() => emptyTradeFields("Rice"));
  const NEW_CATEGORY = "__new_category__";
  const NEW_SUBCATEGORY = "__new_subcategory__";
  const [newCategory, setNewCategory] = useState<{ name: string; sub: string } | null>(null);
  const [newSub, setNewSub] = useState<string | null>(null);
  const [creatingCategory, setCreatingCategory] = useState(false);
  // A closing select moves focus back on its own; once it has, move it to the new name field.
  const [focusRequest, setFocusRequest] = useState<{ id: string } | null>(null);
  useEffect(() => {
    if (!focusRequest) return;
    const timer = window.setTimeout(() => document.getElementById(focusRequest.id)?.focus(), 80);
    return () => window.clearTimeout(timer);
  }, [focusRequest]);
  const chooseCategory = (v: string, sub?: string) => {
    setForm((current) => ({
      ...current,
      category: v,
      subcategory: sub ?? categoryChoices.find((c) => c.name === v)?.subs[0] ?? v,
    }));
    setTrade((current) => current.basisRate
      ? current
      : { ...emptyTradeFields(v), brand: current.brand, manufacturer: current.manufacturer, hsn: current.hsn });
    void loadTaxSettings()
      .then((settings) => {
        const gst = defaultGstForCategory(settings, v);
        setForm((current) =>
          current.category === v ? { ...current, gst: String(gst) } : current,
        );
      })
      .catch((error: unknown) =>
        toast.error("Could not load GST defaults", {
          description:
            error instanceof Error
              ? error.message
              : "Using the current product rate.",
        }),
      );
  };
  const createCategory = async () => {
    if (!newCategory) return;
    const name = newCategory.name.trim().replace(/\s+/g, " ");
    const sub = newCategory.sub.trim().replace(/\s+/g, " ") || name;
    if (!name) { toast.error("Enter a category name"); return; }
    const existing = categories.find((c) => c.name.trim().toLowerCase() === name.toLowerCase());
    if (existing) {
      // Same name already exists: select it (and add the subcategory if it is new) instead of duplicating.
      const hasSub = existing.grades.some((g) => g.trim().toLowerCase() === sub.toLowerCase());
      if (!hasSub && newCategory.sub.trim()) {
        setCreatingCategory(true);
        const ok = await updateCategory(existing.id, { grades: [...existing.grades, sub] }).finally(() => setCreatingCategory(false));
        if (!ok) return;
      }
      chooseCategory(existing.name, existing.grades.find((g) => g.trim().toLowerCase() === sub.toLowerCase()) ?? (newCategory.sub.trim() ? sub : existing.grades[0]));
      toast.info(`“${existing.name}” already exists, selected it`);
      setNewCategory(null);
      return;
    }
    setCreatingCategory(true);
    try {
      const image = form.image || categories.find((c) => c.image)?.image || storeCategorySeed[0]!.image;
      const ok = await addCategory({ name, tagline: `${name} products`, image, grades: [sub], enabled: true });
      if (!ok) return;
      chooseCategory(name, sub);
      setNewCategory(null);
      toast.success(`Category “${name}” created`, { description: "Change its image and tagline anytime in Admin → Categories." });
    } catch (error) {
      toast.error("Could not create this category", { description: error instanceof Error ? error.message : "Please retry." });
    } finally {
      setCreatingCategory(false);
    }
  };
  const createSubcategory = async () => {
    const name = (newSub ?? "").trim().replace(/\s+/g, " ");
    if (!name) { toast.error("Enter a subcategory name"); return; }
    const current = categories.find((c) => c.name === form.category);
    if (!current) { toast.error("Choose a category first"); return; }
    const existing = current.grades.find((g) => g.trim().toLowerCase() === name.toLowerCase());
    if (existing) {
      setForm((f) => ({ ...f, subcategory: existing }));
      setNewSub(null);
      return;
    }
    setCreatingCategory(true);
    try {
      const ok = await updateCategory(current.id, { grades: [...current.grades, name] });
      if (!ok) return;
      setForm((f) => ({ ...f, subcategory: name }));
      setNewSub(null);
      toast.success(`Subcategory “${name}” added to ${current.name}`);
    } catch (error) {
      toast.error("Could not add this subcategory", { description: error instanceof Error ? error.message : "Please retry." });
    } finally {
      setCreatingCategory(false);
    }
  };
  const brandChoices = useMemo(
    () => [...new Set(products.map((p) => p.brand?.trim()).filter((b): b is string => !!b))].sort(),
    [products],
  );
  const manufacturerChoices = useMemo(
    () => [...new Set(products.map((p) => p.manufacturer?.trim()).filter((m): m is string => !!m))].sort(),
    [products],
  );
  useEffect(() => {
    if (!form.vendorId && vendors.length > 0)
      setForm((current) => ({ ...current, vendorId: vendors[0]!.id }));
  }, [form.vendorId, vendors]);

  const [quickOpen, setQuickOpen] = useState(false);
  const [quickForm, setQuickForm] = useState({ name: "", qty: "", price: "", maxPurchaseQuantity: String(DEFAULT_MAX_PURCHASE_QUANTITY), image: "" });
  const [quickImageUploading, setQuickImageUploading] = useState(false);

  const [editing, setEditing] = useState<Product | null>(null);
  const [editForm, setEditForm] = useState({
    name: "",
    description: "",
    mrp: "",
    price: "",
    gst: "",
    stock: "",
    weight: "",
    image: "",
    maxPurchaseQuantity: String(DEFAULT_MAX_PURCHASE_QUANTITY),
    minimumStock: "",
    warehouseStock: "",
    requiredStock: "",
    status: "approved" as "approved" | "pending" | "rejected",
    pricingDisplayMode: DEFAULT_PRICING_DISPLAY_MODE as PricingDisplayMode,
  });
  const [imageUploading, setImageUploading] = useState(false);
  const [editImageUploading, setEditImageUploading] = useState(false);

  const uploadProductImage = async (
    event: ChangeEvent<HTMLInputElement>,
    editingProduct = false,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const setUploading = editingProduct ? setEditImageUploading : setImageUploading;
    setUploading(true);
    try {
      const image = await uploadCatalogImage(file, "products");
      if (editingProduct) setEditForm((current) => ({ ...current, image }));
      else setForm((current) => ({ ...current, image }));
      toast.success("Product image uploaded");
    } catch (error) {
      toast.error("Could not upload the product image", {
        description: error instanceof Error ? error.message : "Try again.",
      });
    } finally {
      setUploading(false);
      event.target.value = "";
    }
  };

  const uploadQuickProductImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setQuickImageUploading(true);
    try {
      const image = await uploadCatalogImage(file, "products");
      setQuickForm((current) => ({ ...current, image }));
      toast.success("Product image uploaded");
    } catch (error) {
      toast.error("Could not upload the product image", {
        description: error instanceof Error ? error.message : "Try again.",
      });
    } finally {
      setQuickImageUploading(false);
      event.target.value = "";
    }
  };

  const [stockEditing, setStockEditing] = useState<Product | null>(null);
  const [stockValue, setStockValue] = useState("");

  const zohoCount = useMemo(() => products.filter(isZohoMirrorProduct).length, [products]);
  // Zoho Commerce imports duplicate app SKUs with stale stock; hide them unless asked for.
  const scoped = useMemo(
    () => (showZoho ? products : products.filter((p) => !isZohoMirrorProduct(p))),
    [products, showZoho],
  );

  const filtered = useMemo(() => {
    let list = scoped.filter((p) => {
      const s = q.trim().toLowerCase();
      const matchesQ = !s || p.name.toLowerCase().includes(s) || p.sku.toLowerCase().includes(s);
      const matchesCat = category === "all" || p.category === category;
      const matchesVendor = vendorId === "all" || p.vendorId === vendorId;
      const matchesStatus = status === "all"
        || (status === "shown" ? shownOnStorefront(p) : status === "hidden" ? !shownOnStorefront(p) : p.status === status);
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
  }, [scoped, q, category, vendorId, status, sort]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pages);
  const rows = filtered.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);

  const lowStock = scoped.filter((p) => p.stock > 0 && p.stock < 30).length;
  const outStock = scoped.filter((p) => p.stock === 0).length;

  const submitQuickAdd = async () => {
    if (!quickForm.name.trim() || !quickForm.qty) {
      toast.error("Enter item name and quantity");
      return;
    }
    const qty = Number(quickForm.qty);
    if (!Number.isFinite(qty) || qty < 0) {
      toast.error("Enter a valid quantity");
      return;
    }
    const price = quickForm.price.trim() ? Number(quickForm.price) : 0;
    if (!Number.isFinite(price) || price < 0) {
      toast.error("Enter a valid non-negative price");
      return;
    }
    const maxPurchaseQuantity = Number(quickForm.maxPurchaseQuantity);
    if (!Number.isSafeInteger(maxPurchaseQuantity) || maxPurchaseQuantity < 1 || maxPurchaseQuantity > 100000) {
      toast.error("Set the maximum customer purchase quantity to a whole number from 1 to 100,000");
      return;
    }
    const vendor = vendors[0];
    if (!vendor) {
      toast.error("Create or approve a vendor profile before assigning products");
      return;
    }
    const dateStr = new Date().toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
    const item: Product = {
      id: `P-${crypto.randomUUID()}`,
      name: quickForm.name.trim(),
      sku: `SBV-SU-${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
      brand: "Shami Select",
      vendor: vendor.business,
      vendorId: vendor.id,
      category: "Sugar",
      subcategory: "S1 Sugar",
      image: quickForm.image.trim(),
      mrp: price,
      price,
      gst: 5,
      rating: 0,
      reviews: 0,
      stock: qty,
      maxPurchaseQuantity,
      reserved: 0,
      sold: 0,
      weight: "1 unit",
      status: price > 0 && quickForm.image.trim() ? "approved" : "pending",
      active: price > 0 && Boolean(quickForm.image.trim()),
      tags: [],
      description: "Manually added by admin.",
      specs: [{ label: "Brand", value: "Shami Select" }],
      created: dateStr,
      updated: dateStr,
    };
    if (!(await addProduct(item))) return;
    if (item.active) toast.success(`${item.name} added with ${qty} units`);
    else toast.success(`${item.name} saved as a draft; add an image and price before publishing`);
    setQuickForm({ name: "", qty: "", price: "", maxPurchaseQuantity: String(DEFAULT_MAX_PURCHASE_QUANTITY), image: "" });
    setQuickOpen(false);
  };

  const submitAdd = async () => {
    const tradeError = validateTradeFields(trade);
    if (tradeError) {
      toast.error(tradeError);
      return;
    }
    if (!form.name.trim() || !form.price) {
      toast.error("Please fill the product name and selling price");
      return;
    }
    if (!form.image.trim()) {
      toast.error("Choose a product image before saving");
      return;
    }
    if (imageUploading) {
      toast.error("Wait for the product image upload to finish");
      return;
    }
    const price = Number(form.price);
    // Retail price (MRP) is optional, as in Zoho; blank means the selling price.
    const mrp = form.mrp.trim() ? Number(form.mrp) : price;
    const stock = Number(form.stock || 0);
    if (!Number.isFinite(mrp) || mrp <= 0 || !Number.isFinite(price) || price <= 0 || price > mrp) {
      toast.error("Enter valid prices; selling price must not exceed MRP");
      return;
    }
    const maxPurchaseQuantity = Number(form.maxPurchaseQuantity);
    if (!Number.isSafeInteger(maxPurchaseQuantity) || maxPurchaseQuantity < 1 || maxPurchaseQuantity > 100000) {
      toast.error("Set the maximum customer purchase quantity to a whole number from 1 to 100,000");
      return;
    }
    const gst = parseGstPercent(form.gst);
    if (gst === null) {
      toast.error("Enter a GST rate between 0% and 100%");
      return;
    }
    if (!Number.isFinite(stock) || stock < 0) {
      toast.error("Enter a valid non-negative stock quantity");
      return;
    }
    const vendor = vendors.find((v) => v.id === form.vendorId);
    if (!vendor) {
      toast.error("Choose an existing vendor profile before creating this product");
      return;
    }
    const id = `P-${crypto.randomUUID()}`;
    const tradePatch = productPatchFromFields(trade);
    const product: Product = {
      id,
      name: form.name,
      sku: `SBV-${form.category.slice(0, 2).toUpperCase()}-${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
      brand: tradePatch.brand,
      vendor: vendor.business,
      vendorId: vendor.id,
      category: form.category,
      subcategory: form.subcategory || form.category,
      image: form.image.trim(),
      mrp,
      price,
      pricingDisplayMode: form.pricingDisplayMode,
      gst,
      rating: 4.2,
      reviews: 0,
      stock,
      maxPurchaseQuantity,
      warehouseStock: Number(form.warehouseStock || form.stock) || 0,
      requiredStock: Number(form.requiredStock) || 0,
      minimumStock: Number(form.minimumStock) || 0,
      reserved: 0,
      sold: 0,
      weight: form.weight.trim() || "1 unit",
      status: form.status,
      active: true,
      tags: [],
      description: form.description.trim(),
      specs: [{ label: "Brand", value: tradePatch.brand }],
      ...(tradePatch.ratePricing ? { ratePricing: tradePatch.ratePricing } : {}),
      ...(tradePatch.manufacturer ? { manufacturer: tradePatch.manufacturer } : {}),
      ...(tradePatch.unit ? { unit: tradePatch.unit } : {}),
      ...(tradePatch.hsn ? { hsn: tradePatch.hsn } : {}),
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
    if (!(await addProduct(product))) return;
    toast.success(`${product.name} added to catalogue`);
    setAddOpen(false);
    setForm(emptyForm(categoryChoices[0]?.name, categoryChoices[0]?.subs[0], vendors[0]?.id));
    setTrade(emptyTradeFields(categoryChoices[0]?.name ?? "Rice"));
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
        "Max Purchase Units",
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
        getMaxPurchaseQuantity(p),
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
        <StatCard label="Total Products" value={String(scoped.length)} icon={Package} highlight />
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
                {categoryChoices.map((c) => (
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
              <SelectTrigger className="h-9 w-40">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="shown">Shown on store</SelectItem>
                <SelectItem value="hidden">Hidden from store</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
              </SelectContent>
            </Select>
            {zohoCount > 0 && (
              <label className="flex h-9 items-center gap-2 rounded-md border border-input px-3 text-xs text-slate">
                <Switch
                  checked={showZoho}
                  aria-label="Show Zoho-imported items"
                  onCheckedChange={(v) => {
                    setShowZoho(v);
                    setPage(1);
                  }}
                />
                Show Zoho-imported items ({zohoCount})
              </label>
            )}
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
                      <Label>Max customer purchase</Label>
                      <Input
                        type="number"
                        min={1}
                        max={100000}
                        step={1}
                        value={quickForm.maxPurchaseQuantity}
                        onChange={(e) => setQuickForm({ ...quickForm, maxPurchaseQuantity: e.target.value })}
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
                  <div>
                    <Label>Product image</Label>
                    <label className="mt-1 inline-flex cursor-pointer items-center gap-2 rounded-md border border-dashed p-3 text-sm font-medium text-navy hover:bg-ivory">
                      <ImagePlus className="h-4 w-4" />
                      {quickImageUploading ? "Uploading…" : quickForm.image ? "Choose a different image" : "Browse local files"}
                      <input
                        className="sr-only"
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
                        disabled={quickImageUploading}
                        onChange={(event) => void uploadQuickProductImage(event)}
                      />
                    </label>
                    {quickForm.image && <img src={quickForm.image} alt="Product preview" className="mt-2 h-20 w-20 rounded-md border object-cover" />}
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setQuickOpen(false)}>
                    Cancel
                  </Button>
                  <Button disabled={quickImageUploading} onClick={submitQuickAdd}>Save Item</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <Dialog open={addOpen} onOpenChange={setAddOpen}>
              <DialogTrigger asChild>
                <Button size="sm">Add Product</Button>
              </DialogTrigger>
              <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
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
                  <div>
                    <Label>Description</Label>
                    <Textarea
                      rows={3}
                      value={form.description}
                      onChange={(e) => setForm({ ...form, description: e.target.value })}
                      placeholder="Quality, packaging, usage. Shown on the product page and sent to Zoho."
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>Category</Label>
                      <Select
                        value={form.category}
                        onValueChange={(v) => {
                          if (v === NEW_CATEGORY) {
                            setFocusRequest({ id: "new-category-name" });
                            setNewCategory({ name: "", sub: "" });
                            return;
                          }
                          setNewCategory(null);
                          chooseCategory(v);
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {categoryChoices.map((c) => (
                            <SelectItem key={c.name} value={c.name}>
                              {c.name}
                            </SelectItem>
                          ))}
                          <SelectItem value={NEW_CATEGORY} className="font-semibold text-navy">
                            + New category…
                          </SelectItem>
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
                  {newCategory && (
                    <div className="space-y-2 rounded-md border border-gold/50 bg-ivory/60 p-3">
                      <p className="text-sm font-semibold text-navy">New category</p>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <Label className="text-xs">Category name</Label>
                          <Input
                            id="new-category-name"
                            placeholder="e.g. Pulses"
                            value={newCategory.name}
                            onChange={(e) => setNewCategory({ ...newCategory, name: e.target.value })}
                            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void createCategory(); } }}
                          />
                        </div>
                        <div>
                          <Label className="text-xs">First subcategory</Label>
                          <Input
                            placeholder="e.g. Toor Dal (optional)"
                            value={newCategory.sub}
                            onChange={(e) => setNewCategory({ ...newCategory, sub: e.target.value })}
                            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void createCategory(); } }}
                          />
                        </div>
                      </div>
                      <div className="flex justify-end gap-2">
                        <Button type="button" size="sm" variant="outline" onClick={() => setNewCategory(null)}>Cancel</Button>
                        <Button type="button" size="sm" className="bg-navy text-white hover:bg-navy/90" disabled={creatingCategory} onClick={() => void createCategory()}>
                          {creatingCategory ? "Creating…" : "Create category"}
                        </Button>
                      </div>
                    </div>
                  )}
                  <div>
                    <Label>Subcategory</Label>
                    <Select
                      value={form.subcategory}
                      onValueChange={(v) => {
                        if (v === NEW_SUBCATEGORY) { setFocusRequest({ id: "new-subcategory-name" }); setNewSub(""); return; }
                        setNewSub(null);
                        setForm({ ...form, subcategory: v });
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Choose subcategory" />
                      </SelectTrigger>
                      <SelectContent>
                        {(categoryChoices.find((c) => c.name === form.category)?.subs ?? []).map(
                          (subcategory) => (
                            <SelectItem key={subcategory} value={subcategory}>
                              {subcategory}
                            </SelectItem>
                          ),
                        )}
                        <SelectItem value={NEW_SUBCATEGORY} className="font-semibold text-navy">
                          + New subcategory…
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    {newSub !== null && (
                      <div className="mt-2 flex gap-2">
                        <Input
                          id="new-subcategory-name"
                          placeholder={`New subcategory in ${form.category}`}
                          value={newSub}
                          onChange={(e) => setNewSub(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void createSubcategory(); } }}
                        />
                        <Button type="button" size="sm" variant="outline" onClick={() => setNewSub(null)}>Cancel</Button>
                        <Button type="button" size="sm" className="bg-navy text-white hover:bg-navy/90" disabled={creatingCategory} onClick={() => void createSubcategory()}>
                          Add
                        </Button>
                      </div>
                    )}
                  </div>
                  <ProductTradeFields
                    value={trade}
                    onChange={setTrade}
                    onPrice={(price, packSize) => setForm((current) => ({ ...current, price: String(price), weight: packSize }))}
                    brands={brandChoices}
                    manufacturers={manufacturerChoices}
                  />
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <Label>Selling price (₹)</Label>
                      <Input
                        type="number"
                        value={form.price}
                        readOnly={trade.useRate}
                        title={trade.useRate ? "Worked out from the rate above" : undefined}
                        onChange={(e) => setForm({ ...form, price: e.target.value })}
                      />
                    </div>
                    <div>
                      <Label>Retail price / MRP (₹, optional)</Label>
                      <Input
                        type="number"
                        value={form.mrp}
                        placeholder={form.price || "Same as selling price"}
                        onChange={(e) => setForm({ ...form, mrp: e.target.value })}
                      />
                    </div>
                    <div>
                      <Label>GST %</Label>
                      <Input
                        type="number"
                        inputMode="decimal"
                        min={0}
                        max={100}
                        step="0.01"
                        value={form.gst}
                        onChange={(e) => setForm({ ...form, gst: sanitizeGstInput(e.target.value) })}
                        onKeyDown={(e) => { if (e.key === "-" || e.key === "e" || e.key === "E") e.preventDefault(); }}
                        onWheel={(e) => e.currentTarget.blur()}
                      />
                    </div>
                  </div>
                  <PricingDisplayModeToggle
                    id="add-pricing-display-mode"
                    value={form.pricingDisplayMode}
                    onChange={(pricingDisplayMode) => setForm({ ...form, pricingDisplayMode })}
                    mrp={Number(form.mrp)}
                    price={Number(form.price)}
                  />
                  <div>
                    <Label>Weight / Capacity</Label>
                    <Input
                      value={form.weight}
                      onChange={(e) => setForm({ ...form, weight: e.target.value })}
                      placeholder="e.g. 25 kg bag"
                    />
                  </div>
                  <div>
                    <Label>Product Image</Label>
                    <Input
                      value={form.image}
                      onChange={(e) => setForm({ ...form, image: e.target.value })}
                      placeholder="Paste an image URL or browse local files"
                    />
                    <label className="mt-2 inline-flex cursor-pointer items-center gap-2 text-sm font-medium text-navy hover:text-gold">
                      <ImagePlus className="h-4 w-4" />{" "}
                      {imageUploading ? "Uploading…" : "Browse local files"}
                      <input
                        className="sr-only"
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
                        disabled={imageUploading}
                        onChange={(event) => void uploadProductImage(event)}
                      />
                    </label>
                    {form.image && (
                      <img
                        src={form.image}
                        alt="Product preview"
                        className="mt-2 h-24 w-24 rounded-md border object-cover"
                      />
                    )}
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
                  <div>
                    <Label>Maximum customer purchase quantity</Label>
                    <Input
                      type="number"
                      min={1}
                      max={100000}
                      step={1}
                      value={form.maxPurchaseQuantity}
                      onChange={(e) => setForm({ ...form, maxPurchaseQuantity: e.target.value })}
                    />
                    <p className="mt-1 text-xs text-slate">Customers can purchase from 1 up to this amount, limited by available stock.</p>
                  </div>
                  <div>
                    <Label>Approval Status</Label>
                    <Select
                      value={form.status}
                      onValueChange={(v) =>
                        setForm({ ...form, status: v as "approved" | "pending" | "rejected" })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select status" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="approved">Approved (Live on storefront)</SelectItem>
                        <SelectItem value="pending">Pending review</SelectItem>
                        <SelectItem value="rejected">Rejected (Hidden)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setAddOpen(false)}>
                    Cancel
                  </Button>
                  <Button disabled={imageUploading} onClick={submitAdd}>Save Product</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        }
      >
        <DataTable
          minWidth={900}
          columns={["Product", "Category / Vendor", "Price", "Stock", "Storefront / Approval", "Created", "Actions"]}
          columnClassNames={[
            "w-[32%] min-w-[220px]",
            "min-w-[120px]",
            "whitespace-nowrap",
            "whitespace-nowrap",
            "w-[130px]",
            "whitespace-nowrap",
            "sticky right-0 z-[1] whitespace-nowrap bg-card text-right shadow-[-8px_0_12px_-10px_rgba(60,45,20,0.25)]",
          ]}
          rows={rows.map((p) => {
            const lowAt = p.minimumStock ?? 30;
            const zoho = isZohoMirrorProduct(p);
            const fifo = getFIFOCost(p.id);
            return [
              <div className="flex min-w-0 items-center gap-3">
                <ProductThumbnail src={p.image} name={p.name} />
                <div className="min-w-0">
                  <Link
                    to="/admin/products/$id"
                    params={{ id: p.id }}
                    title={p.name}
                    className="line-clamp-2 font-semibold leading-snug text-navy hover:text-gold"
                  >
                    {p.name}
                  </Link>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-slate">
                    {p.sku}
                    {p.weight && <span className="font-sans"> · {p.weight}</span>}
                  </p>
                </div>
              </div>,
              <div className="min-w-0 leading-snug">
                <p className="truncate font-medium text-charcoal">{p.category || "—"}</p>
                <p className="truncate text-xs text-slate">{p.vendor || "—"}</p>
                {zoho && (
                  <span className="mt-1 inline-flex rounded-full border border-navy/15 bg-navy/6 px-2 py-0.5 text-[10px] font-semibold text-navy">
                    Read-only · from Zoho
                  </span>
                )}
              </div>,
              <div className="leading-snug">
                <p className="font-bold tabular-nums text-navy">{inr(p.price)}</p>
                {p.mrp > p.price && <p className="text-xs tabular-nums text-slate line-through">{inr(p.mrp)}</p>}
                {fifo > 0 && <p className="text-[11px] tabular-nums text-slate">FIFO {inr(fifo)}</p>}
              </div>,
              <div className="leading-snug">
                <div className="flex items-center gap-2">
                  <span className="text-base font-bold tabular-nums text-navy">{p.stock}</span>
                  {p.stock === 0 ? (
                    <StatusBadge status="Out of Stock" />
                  ) : p.stock < lowAt ? (
                    <StatusBadge status="Low Stock" />
                  ) : (
                    <StatusBadge status="Available" />
                  )}
                </div>
                <p className="mt-0.5 text-[11px] tabular-nums text-slate">
                  WH {p.warehouseStock ?? p.stock} · Req {p.requiredStock ?? 0}
                </p>
                <p className="text-[11px] tabular-nums text-slate">
                  Min {lowAt} · Max/order {getMaxPurchaseQuantity(p)}
                </p>
              </div>,
              zoho ? (
                <div className="flex flex-col items-start gap-1 text-xs text-slate">
                  <StatusBadge status={p.status} />
                  {p.active ? "Active in Zoho" : "Inactive in Zoho"}
                </div>
              ) : <div className="flex flex-col items-start gap-1.5">
                <label className="flex items-center gap-2 text-xs font-semibold">
                  <Switch
                    checked={shownOnStorefront(p)}
                    aria-label={`Show ${p.name} on the storefront`}
                    onCheckedChange={async (show) => {
                      const patch = storefrontPatch(p, show);
                      if (patch && await updateProduct(p.id, patch))
                        toast.success(show ? `${p.name} is now shown on the storefront` : `${p.name} is hidden from the storefront`);
                    }}
                  />
                  <span className={shownOnStorefront(p) ? "text-emerald-700" : "text-slate"}>
                    {shownOnStorefront(p) ? "Shown on store" : "Hidden"}
                  </span>
                </label>
                {!shownOnStorefront(p) && <span className="text-[11px] text-slate">{hiddenReason(p)}</span>}
                <Select
                  value={p.status}
                  onValueChange={async (v) => {
                    if (
                      await updateProduct(p.id, { status: v as "approved" | "pending" | "rejected" })
                    ) {
                      toast.success(`${p.name} marked as ${v}`);
                    }
                  }}
                >
                  <SelectTrigger className="h-8 w-[118px] text-xs" aria-label={`Approval for ${p.name}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="approved">Approved</SelectItem>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="rejected">Rejected</SelectItem>
                  </SelectContent>
                </Select>
              </div>,
              <span className="text-xs text-slate">{formatCreated(p.created)}</span>,
              zoho ? (
                <span className="text-xs text-slate" title="Imported from Zoho Commerce; edit it in Zoho">
                  Read-only
                </span>
              ) : <div className="inline-flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  title="Edit"
                  aria-label={`Edit ${p.name}`}
                  onClick={() => {
                    setEditing(p);
                    setEditTrade(tradeFieldsFromProduct(p));
                    setEditForm({
                      name: p.name,
                      description: p.description ?? "",
                      mrp: String(p.mrp),
                      price: String(p.price),
                      gst: String(p.gst),
                      stock: String(p.stock),
                      weight: p.weight,
                      image: p.image,
                      maxPurchaseQuantity: String(getMaxPurchaseQuantity(p)),
                      minimumStock: String(p.minimumStock ?? 30),
                      warehouseStock: String(p.warehouseStock ?? p.stock),
                      requiredStock: String(p.requiredStock ?? 0),
                      status: p.status,
                      pricingDisplayMode: getPricingDisplayMode(p),
                    });
                  }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  title="Update stock"
                  aria-label={`Update stock for ${p.name}`}
                  onClick={() => {
                    setStockEditing(p);
                    setStockValue(String(p.stock));
                  }}
                >
                  <Boxes className="h-3.5 w-3.5" />
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 text-danger hover:text-danger"
                      title="Delete"
                      aria-label={`Delete ${p.name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
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
                          void deleteProduct(p.id).then((ok) => {
                            if (ok) toast.success(`${p.name} deleted`);
                          });
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
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="pr-6 leading-snug">Edit {editing?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Name</Label>
              <Input
                value={editForm.name}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
              />
            </div>
            <div>
              <Label>Description</Label>
              <Textarea
                rows={3}
                value={editForm.description}
                onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                placeholder="Quality, packaging, usage. Shown on the product page and sent to Zoho."
              />
            </div>
            <ProductTradeFields
              value={editTrade}
              onChange={setEditTrade}
              onPrice={(price, packSize) => setEditForm((current) => ({ ...current, price: String(price), weight: packSize }))}
              brands={brandChoices}
              manufacturers={manufacturerChoices}
            />
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Selling price (₹)</Label>
                <Input
                  type="number"
                  value={editForm.price}
                  readOnly={editTrade.useRate}
                  title={editTrade.useRate ? "Worked out from the rate above" : undefined}
                  onChange={(e) => setEditForm({ ...editForm, price: e.target.value })}
                />
              </div>
              <div>
                <Label>Retail price / MRP (₹, optional)</Label>
                <Input
                  type="number"
                  value={editForm.mrp}
                  placeholder={editForm.price || "Same as selling price"}
                  onChange={(e) => setEditForm({ ...editForm, mrp: e.target.value })}
                />
              </div>
              <div>
                <Label>GST %</Label>
                <Input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={100}
                  step="0.01"
                  value={editForm.gst}
                  onChange={(e) => setEditForm({ ...editForm, gst: sanitizeGstInput(e.target.value) })}
                  onKeyDown={(e) => { if (e.key === "-" || e.key === "e" || e.key === "E") e.preventDefault(); }}
                  onWheel={(e) => e.currentTarget.blur()}
                />
              </div>
            </div>
            <PricingDisplayModeToggle
              id="edit-pricing-display-mode"
              value={editForm.pricingDisplayMode}
              onChange={(pricingDisplayMode) => setEditForm({ ...editForm, pricingDisplayMode })}
              mrp={Number(editForm.mrp)}
              price={Number(editForm.price)}
            />
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
                <label className="mt-2 inline-flex cursor-pointer items-center gap-2 text-sm font-medium text-navy hover:text-gold">
                  <ImagePlus className="h-4 w-4" />{" "}
                  {editImageUploading ? "Uploading…" : "Browse local files"}
                  <input
                    className="sr-only"
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
                    disabled={editImageUploading}
                    onChange={(event) => void uploadProductImage(event, true)}
                  />
                </label>
                {editForm.image && (
                  <img
                    src={editForm.image}
                    alt="Product preview"
                    className="mt-2 h-24 w-24 rounded-md border object-cover"
                  />
                )}
              </div>
            </div>
            <div>
              <Label>Maximum customer purchase quantity</Label>
              <Input
                type="number"
                min={1}
                max={100000}
                step={1}
                value={editForm.maxPurchaseQuantity}
                onChange={(e) => setEditForm({ ...editForm, maxPurchaseQuantity: e.target.value })}
              />
              <p className="mt-1 text-xs text-slate">Minimum is always 1. The effective maximum also respects available stock.</p>
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
              <div>
                <Label>Approval Status</Label>
                <Select
                  value={editForm.status}
                  onValueChange={(v) =>
                    setEditForm({ ...editForm, status: v as "approved" | "pending" | "rejected" })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="approved">Approved (Live on storefront)</SelectItem>
                    <SelectItem value="pending">Pending review</SelectItem>
                    <SelectItem value="rejected">Rejected (Hidden)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              className="mr-auto text-xs text-slate"
              onClick={async () => {
                if (!editing) return;
                try {
                  const { inspectZohoProductSync } = await import("@/lib/zoho-commerce.functions");
                  const report = JSON.parse(await inspectZohoProductSync({ data: { productId: editing.id } })) as {
                    app?: Record<string, unknown>; zoho?: Record<string, unknown>; decision?: string; link?: unknown;
                  };
                  if (!report.app || !report.zoho) {
                    toast.info("This product is not linked to a Zoho item yet");
                    return;
                  }
                  const fields = ["price", "minimumStock", "name", "sku", "active"] as const;
                  const lines = fields.map((field) => `${field}: here ${String(report.app?.[field])} · Zoho ${String(report.zoho?.[field])}`);
                  toast.info(`Zoho comparison · next sync: ${report.decision === "zoho" ? "take Zoho's values" : report.decision === "app" ? "send Grain Bazar's values" : "already the same"}`, {
                    description: lines.join("\n"),
                    duration: 15000,
                  });
                } catch (cause) {
                  toast.error("Could not compare with Zoho", { description: cause instanceof Error ? cause.message : undefined });
                }
              }}
            >
              Compare with Zoho
            </Button>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              onClick={async () => {
                if (!editing) return;
                const maxPurchaseQuantity = Number(editForm.maxPurchaseQuantity);
                if (!Number.isSafeInteger(maxPurchaseQuantity) || maxPurchaseQuantity < 1 || maxPurchaseQuantity > 100000) {
                  toast.error("Set the maximum customer purchase quantity to a whole number from 1 to 100,000");
                  return;
                }
                const gst = parseGstPercent(editForm.gst);
                if (gst === null) {
                  toast.error("Enter a GST rate between 0% and 100%");
                  return;
                }
                const tradeError = validateTradeFields(editTrade);
                if (tradeError) {
                  toast.error(tradeError);
                  return;
                }
                const price = Number(editForm.price);
                const mrp = editForm.mrp.trim() ? Number(editForm.mrp) : price;
                if (!Number.isFinite(mrp) || mrp <= 0 || !Number.isFinite(price) || price <= 0 || price > mrp) {
                  toast.error("Enter valid prices; selling price must not exceed MRP");
                  return;
                }
                const tradePatch = productPatchFromFields(editTrade);
                const saved = await updateProduct(editing.id, {
                  ...tradePatch,
                  name: editForm.name,
                  description: editForm.description.trim(),
                  mrp,
                  price,
                  gst,
                  stock: Number(editForm.stock),
                  weight: editForm.weight,
                  image: editForm.image,
                  maxPurchaseQuantity,
                  minimumStock: Number(editForm.minimumStock),
                  warehouseStock: Number(editForm.warehouseStock),
                  requiredStock: Number(editForm.requiredStock),
                  status: editForm.status,
                  pricingDisplayMode: editForm.pricingDisplayMode,
                });
                if (saved) {
                  toast.success(`${editForm.name} updated`);
                  setEditing(null);
                }
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
              onClick={async () => {
                if (!stockEditing) return;
                if (!(await updateProduct(stockEditing.id, { stock: Number(stockValue) || 0 })))
                  return;
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
