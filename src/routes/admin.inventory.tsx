import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Boxes,
  Download,
  IndianRupee,
  Layers,
  PackageCheck,
  PackagePlus,
  PackageX,
  Percent,
  TriangleAlert,
} from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel, StatCard, StatusBadge } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { inr, type Product, type PurchaseBatch } from "@/lib/data";
import { useApp } from "@/lib/store";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
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
} from "@/components/ui/dialog";
import { downloadCSV } from "@/lib/export-utils";

export const Route = createFileRoute("/admin/inventory")({
  head: () => ({
    meta: [
      { title: "Inventory Costing (FIFO) | Shami Admin" },
      {
        name: "description",
        content: "FIFO inventory costing, purchase batches, stock levels and valuation.",
      },
      { property: "og:title", content: "Inventory Costing (FIFO) | Shami Admin" },
      { property: "og:description", content: "FIFO inventory costing and valuation platform." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminInventory,
});

const REORDER = 30;
const PAGE_SIZE = 10;

function stockStatus(stock: number, minimum = REORDER) {
  if (stock <= 0) return "Out of Stock";
  if (stock < minimum) return "Low Stock";
  return "In Stock";
}

function AdminInventory() {
  const {
    products,
    batches,
    orders,
    addBatch,
    updateProduct,
    getFIFOCost,
    getInventoryValuation,
    getAverageSellingPrice,
  } = useApp();
  const recentDemand = useMemo(() => {
    const recentCutoff = new Date();
    recentCutoff.setDate(recentCutoff.getDate() - 30);
    const totals = new Map<string, number>();
    for (const order of orders) {
      const orderDate = new Date(order.date);
      if (
        Number.isNaN(orderDate.getTime()) ||
        orderDate < recentCutoff ||
        order.status === "Cancelled"
      )
        continue;
      for (const line of order.items)
        totals.set(line.product.id, (totals.get(line.product.id) ?? 0) + line.qty);
    }
    return totals;
  }, [orders]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("All");
  const [sort, setSort] = useState("stock-asc");
  const [page, setPage] = useState(1);

  // Update Stock Dialog
  const [target, setTarget] = useState<string | null>(null);
  const [newStock, setNewStock] = useState("");

  // View FIFO Batches Dialog
  const [batchViewProduct, setBatchViewProduct] = useState<Product | null>(null);

  // Add Purchase Batch Dialog
  const [addBatchOpen, setAddBatchOpen] = useState(false);
  const [batchForm, setBatchForm] = useState({
    productId: products[0]?.id ?? "",
    batchCode: "",
    quantity: "",
    unitCost: "",
    purchaseDate: new Date().toISOString().split("T")[0]!,
    warehouse: "Warehouse 1 - Belagavi APMC",
  });

  const stats = useMemo(() => {
    const inStock = products.filter(
      (p) => stockStatus(p.stock, p.minimumStock ?? REORDER) === "In Stock",
    ).length;
    const low = products.filter(
      (p) => stockStatus(p.stock, p.minimumStock ?? REORDER) === "Low Stock",
    ).length;
    const out = products.filter(
      (p) => stockStatus(p.stock, p.minimumStock ?? REORDER) === "Out of Stock",
    ).length;

    // Actual FIFO Inventory Valuation: sum of each layer's remaining quantity * unit purchase price
    const fifoTotalValuation = products.reduce((acc, p) => {
      const val = getInventoryValuation(p.id);
      return acc + val.totalValue;
    }, 0);

    // Average gross margin across catalog (Selling Price vs FIFO Cost)
    const marginSum = products.reduce((acc, p) => {
      const fifoCost = getFIFOCost(p.id);
      const avgPrice = getAverageSellingPrice(p);
      const margin = avgPrice > 0 ? ((avgPrice - fifoCost) / avgPrice) * 100 : 0;
      return acc + margin;
    }, 0);
    const avgMargin = products.length > 0 ? Math.round(marginSum / products.length) : 0;

    return { total: products.length, inStock, low, out, fifoTotalValuation, avgMargin };
  }, [products, getFIFOCost, getInventoryValuation, getAverageSellingPrice]);

  const filtered = useMemo(() => {
    let list = products.filter((p) => {
      const matchSearch =
        p.name.toLowerCase().includes(search.toLowerCase()) ||
        p.sku.toLowerCase().includes(search.toLowerCase());
      const matchFilter =
        filter === "All" || stockStatus(p.stock, p.minimumStock ?? REORDER) === filter;
      return matchSearch && matchFilter;
    });
    list = [...list].sort((a, b) => {
      if (sort === "stock-asc") return a.stock - b.stock;
      if (sort === "stock-desc") return b.stock - a.stock;
      if (sort === "name") return a.name.localeCompare(b.name);
      return 0;
    });
    return list;
  }, [products, search, filter, sort]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageItems = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const targetProduct = products.find((p) => p.id === target);

  const openUpdate = (id: string, stock: number) => {
    setTarget(id);
    setNewStock(String(stock));
  };

  const saveStock = () => {
    const val = Number(newStock);
    if (!targetProduct || Number.isNaN(val) || val < 0) {
      toast.error("Enter a valid stock quantity");
      return;
    }
    updateProduct(targetProduct.id, { stock: val });
    toast.success(`Stock for ${targetProduct.name} updated to ${val} units`);
    setTarget(null);
  };

  const handleSavePurchaseBatch = () => {
    const p = products.find((x) => x.id === batchForm.productId);
    if (!p) {
      toast.error("Select a valid product");
      return;
    }
    const qty = Number(batchForm.quantity);
    const cost = Number(batchForm.unitCost);
    if (!qty || qty <= 0) {
      toast.error("Enter a valid batch quantity");
      return;
    }
    if (!cost || cost <= 0) {
      toast.error("Enter a valid purchase cost per unit");
      return;
    }

    const batchCode =
      batchForm.batchCode.trim() ||
      `LOT-${p.sku.replace("SBV-", "")}-${Date.now().toString().slice(-4)}`;

    addBatch({
      batchCode,
      productId: p.id,
      productName: p.name,
      vendor: p.vendor,
      vendorId: p.vendorId,
      purchaseDate: batchForm.purchaseDate,
      quantity: qty,
      remainingQty: qty,
      unitCost: cost,
      warehouse: batchForm.warehouse,
      status: "Active",
    });

    toast.success(`Recorded Purchase Batch ${batchCode}: ${qty} units @ ${inr(cost)}`);
    setAddBatchOpen(false);
    setBatchForm({
      productId: products[0]?.id ?? "",
      batchCode: "",
      quantity: "",
      unitCost: "",
      purchaseDate: new Date().toISOString().split("T")[0]!,
      warehouse: "Warehouse 1 - Belagavi APMC",
    });
  };

  const handleExportInventory = () => {
    downloadCSV(
      "Inventory_FIFO_Valuation_Report",
      [
        "Product ID",
        "Product Name",
        "SKU",
        "Category",
        "Vendor",
        "Stock Units",
        "Stock Status",
        "FIFO Unit Cost (INR)",
        "Avg Selling Price (INR)",
        "FIFO Valuation (INR)",
      ],
      filtered.map((p) => {
        const fifoCost = getFIFOCost(p.id);
        const avgSellingPrice = getAverageSellingPrice(p);
        const valuation = getInventoryValuation(p.id);
        return [
          p.id,
          p.name,
          p.sku,
          p.category,
          p.vendor,
          p.stock,
          stockStatus(p.stock),
          fifoCost,
          avgSellingPrice,
          valuation.totalValue,
        ];
      }),
    );
  };

  return (
    <PanelLayout
      items={adminNav}
      tone="admin"
      title="Inventory Costing (FIFO)"
      subtitle="FIFO batch valuation and stock ledger"
    >
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Total SKUs" value={String(stats.total)} icon={Boxes} />
        <StatCard label="In Stock" value={String(stats.inStock)} icon={PackageCheck} />
        <StatCard label="Low Stock" value={String(stats.low)} icon={TriangleAlert} highlight />
        <StatCard
          label="FIFO Valuation"
          value={inr(stats.fifoTotalValuation)}
          icon={IndianRupee}
          highlight
        />
        <StatCard label="Avg. Gross Margin" value={`${stats.avgMargin}%`} icon={Percent} />
      </div>

      <Panel
        title="Product Stock & FIFO Costing"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              className="bg-navy text-white hover:bg-navy/90"
              onClick={() => setAddBatchOpen(true)}
            >
              <PackagePlus className="mr-1.5 h-4 w-4" /> Add Purchase Batch
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportInventory}
              className="h-9 hover:border-gold hover:text-gold transition-colors"
            >
              <Download className="mr-1.5 h-3.5 w-3.5" /> Export CSV
            </Button>
            <Input
              placeholder="Search by name or SKU"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="h-9 w-52"
            />
            <Select
              value={filter}
              onValueChange={(v) => {
                setFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="h-9 w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="All">All Status</SelectItem>
                <SelectItem value="In Stock">In Stock</SelectItem>
                <SelectItem value="Low Stock">Low Stock</SelectItem>
                <SelectItem value="Out of Stock">Out of Stock</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sort} onValueChange={setSort}>
              <SelectTrigger className="h-9 w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stock-asc">Stock: Low to High</SelectItem>
                <SelectItem value="stock-desc">Stock: High to Low</SelectItem>
                <SelectItem value="name">Name A-Z</SelectItem>
              </SelectContent>
            </Select>
          </div>
        }
      >
        <DataTable
          columns={[
            "Product",
            "SKU",
            "Stock",
            "Min Stock",
            "Avg / Day",
            "15 Day Need",
            "20 Day Need",
            "Suggested Purchase",
            "FIFO Unit Cost",
            "Avg. Selling Price",
            "FIFO Inventory Value",
            "Status",
            "Actions",
          ]}
          rows={pageItems.map((p) => {
            const fifoCost = getFIFOCost(p.id);
            const avgSellingPrice = getAverageSellingPrice(p);
            const valuation = getInventoryValuation(p.id);
            const activeLayers = batches.filter(
              (b) => b.productId === p.id && b.remainingQty > 0,
            ).length;
            const dailyDemand = (recentDemand.get(p.id) ?? 0) / 30;
            const need15 = Math.ceil(dailyDemand * 15);
            const need20 = Math.ceil(dailyDemand * 20);
            const minimum = p.minimumStock ?? REORDER;
            const suggestedPurchase = Math.max(0, Math.max(need15, minimum) - p.stock);

            return [
              <div>
                <span className="font-semibold text-navy">{p.name}</span>
                <p className="text-xs text-slate">{p.vendor}</p>
              </div>,
              <span className="font-mono text-xs text-slate">{p.sku}</span>,
              <span className="font-medium text-navy">{p.stock}</span>,
              <span className={p.stock < minimum ? "font-semibold text-amber-700" : "text-slate"}>
                {minimum}
              </span>,
              <span>{dailyDemand.toFixed(1)}</span>,
              <span>{need15}</span>,
              <span>{need20}</span>,
              <span
                className={
                  suggestedPurchase > 0 ? "font-semibold text-amber-700" : "text-emerald-700"
                }
              >
                {suggestedPurchase}
              </span>,
              <div>
                <span className="font-semibold text-charcoal">{inr(fifoCost)}</span>
                <p className="text-[11px] text-slate">
                  {activeLayers} active batch layer{activeLayers !== 1 ? "s" : ""}
                </p>
              </div>,
              <span className="font-medium text-navy">{inr(avgSellingPrice)}</span>,
              <span className="font-semibold text-gold">{inr(valuation.totalValue)}</span>,
              <StatusBadge status={stockStatus(p.stock, minimum)} />,
              <div className="flex flex-wrap items-center gap-1.5">
                <Button size="sm" variant="outline" onClick={() => openUpdate(p.id, p.stock)}>
                  Stock
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-navy hover:border-gold hover:text-gold"
                  onClick={() => setBatchViewProduct(p)}
                >
                  <Layers className="mr-1 h-3.5 w-3.5" /> FIFO Batches
                </Button>
              </div>,
            ];
          })}
        />
        <div className="mt-4 flex items-center justify-between text-xs text-slate">
          <span>
            Page {page} of {totalPages} · {filtered.length} products
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      </Panel>

      {/* Update Stock Dialog */}
      <Dialog open={!!target} onOpenChange={(o) => !o && setTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Update Stock — {targetProduct?.name}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-1.5 py-2">
            <Label>New Stock Quantity</Label>
            <Input
              type="number"
              min={0}
              value={newStock}
              onChange={(e) => setNewStock(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)}>
              Cancel
            </Button>
            <Button className="bg-navy text-white hover:bg-navy/90" onClick={saveStock}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* FIFO Batches Detail Dialog */}
      <Dialog open={!!batchViewProduct} onOpenChange={(o) => !o && setBatchViewProduct(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Layers className="h-5 w-5 text-gold" />
              FIFO Purchase Layers — {batchViewProduct?.name}
            </DialogTitle>
          </DialogHeader>
          {batchViewProduct && (
            <div className="space-y-4 py-2">
              <div className="grid grid-cols-3 gap-3 rounded-lg border border-border bg-panel p-3 text-xs">
                <div>
                  <span className="text-slate">Total Available Units:</span>{" "}
                  <strong className="text-navy">{batchViewProduct.stock}</strong>
                </div>
                <div>
                  <span className="text-slate">Next FIFO Unit Cost:</span>{" "}
                  <strong className="text-navy">{inr(getFIFOCost(batchViewProduct.id))}</strong>
                </div>
                <div>
                  <span className="text-slate">Total Layer Valuation:</span>{" "}
                  <strong className="text-gold">
                    {inr(getInventoryValuation(batchViewProduct.id).totalValue)}
                  </strong>
                </div>
              </div>

              <div className="max-h-72 overflow-y-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-border bg-muted/40 font-semibold text-slate uppercase">
                    <tr>
                      <th className="p-2">Batch Code</th>
                      <th className="p-2">Purchase Date</th>
                      <th className="p-2">Initial Qty</th>
                      <th className="p-2">Remaining Qty</th>
                      <th className="p-2">Unit Purchase Cost</th>
                      <th className="p-2">Layer Value</th>
                      <th className="p-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batches
                      .filter((b) => b.productId === batchViewProduct.id)
                      .sort(
                        (a, b) =>
                          new Date(a.purchaseDate).getTime() - new Date(b.purchaseDate).getTime(),
                      )
                      .map((b) => (
                        <tr
                          key={b.id}
                          className="border-b border-border/60 last:border-0 hover:bg-muted/20"
                        >
                          <td className="p-2 font-mono font-semibold text-navy">{b.batchCode}</td>
                          <td className="p-2 text-slate">{b.purchaseDate}</td>
                          <td className="p-2 text-charcoal">{b.quantity}</td>
                          <td className="p-2 font-bold text-navy">{b.remainingQty}</td>
                          <td className="p-2 text-charcoal">{inr(b.unitCost)}</td>
                          <td className="p-2 font-semibold text-gold">
                            {inr(b.remainingQty * b.unitCost)}
                          </td>
                          <td className="p-2">
                            <span
                              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                                b.remainingQty > 0
                                  ? "bg-emerald-100 text-emerald-800"
                                  : "bg-slate-100 text-slate-600"
                              }`}
                            >
                              {b.remainingQty > 0 ? "In FIFO Queue" : "Depleted"}
                            </span>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setBatchViewProduct(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Purchase Batch Dialog */}
      <Dialog open={addBatchOpen} onOpenChange={setAddBatchOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Record Purchase Batch (FIFO Layer)</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-2 text-sm">
            <div className="grid gap-1.5">
              <Label>Product</Label>
              <Select
                value={batchForm.productId}
                onValueChange={(id) => setBatchForm((f) => ({ ...f, productId: id }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select product" />
                </SelectTrigger>
                <SelectContent className="max-h-60">
                  {products.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} ({p.sku})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>Quantity (Units)</Label>
                <Input
                  type="number"
                  min={1}
                  placeholder="e.g. 50"
                  value={batchForm.quantity}
                  onChange={(e) => setBatchForm((f) => ({ ...f, quantity: e.target.value }))}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>Purchase Cost/Unit (₹)</Label>
                <Input
                  type="number"
                  min={1}
                  placeholder="e.g. 2100"
                  value={batchForm.unitCost}
                  onChange={(e) => setBatchForm((f) => ({ ...f, unitCost: e.target.value }))}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>Batch / Lot Code</Label>
                <Input
                  placeholder="Optional auto-generated"
                  value={batchForm.batchCode}
                  onChange={(e) => setBatchForm((f) => ({ ...f, batchCode: e.target.value }))}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>Purchase Date</Label>
                <Input
                  type="date"
                  value={batchForm.purchaseDate}
                  onChange={(e) => setBatchForm((f) => ({ ...f, purchaseDate: e.target.value }))}
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>Warehouse / Location</Label>
              <Input
                value={batchForm.warehouse}
                onChange={(e) => setBatchForm((f) => ({ ...f, warehouse: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddBatchOpen(false)}>
              Cancel
            </Button>
            <Button
              className="bg-navy text-white hover:bg-navy/90"
              onClick={handleSavePurchaseBatch}
            >
              Save Batch
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PanelLayout>
  );
}
