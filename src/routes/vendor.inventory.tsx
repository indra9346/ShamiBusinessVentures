import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { AlertTriangle, Boxes, Package, PackageX } from "lucide-react";
import { toast } from "sonner";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, FilterNote, Panel, scrollToSection, StatCard, StatusBadge } from "@/components/panel/widgets";
import { vendorNav } from "@/lib/panel-nav";
import { matchesVendorStock } from "@/lib/panel-filters";
import { useApp, useVendorScope } from "@/lib/store";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import type { Product } from "@/lib/data";

export const Route = createFileRoute("/vendor/inventory")({
  head: () => ({
    meta: [
      { title: "Inventory | Grain Bazar Vendor Panel" },
      { name: "description", content: "Track stock levels and reorder alerts for your products." },
      { property: "og:title", content: "Vendor Inventory | Grain Bazar" },
      { property: "og:description", content: "Stock management console for Grain Bazar marketplace vendors." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: VendorInventory,
});

const REORDER_LEVEL = 30;

function VendorInventory() {
  const { updateProduct } = useApp();
  const { vendorProducts } = useVendorScope();
  const [q, setQ] = useState("");
  const [stockDialog, setStockDialog] = useState<Product | null>(null);
  const [stockValue, setStockValue] = useState("");
  // The cards open the All Stock list with just the products they count.
  const [view, setView] = useState("all");
  const openList = (next: string) => {
    setQ("");
    setView(next);
    scrollToSection("all-stock");
  };

  const countedAs = (card: string) => vendorProducts.filter((p) => matchesVendorStock(p.stock, p.minimumStock ?? REORDER_LEVEL, card));
  const filtered = useMemo(
    () => vendorProducts.filter((p) => `${p.name} ${p.sku} ${p.category}`.toLowerCase().includes(q.trim().toLowerCase()) && matchesVendorStock(p.stock, p.minimumStock ?? REORDER_LEVEL, view)),
    [vendorProducts, q, view],
  );

  const outOfStock = countedAs("out");
  const lowStock = countedAs("low").sort((a, b) => a.stock - b.stock || a.name.localeCompare(b.name));
  const healthy = countedAs("healthy");

  return (
    <PanelLayout items={vendorNav} tone="vendor" title="Inventory" subtitle="Stock levels and reorder alerts">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard onClick={() => openList("all")} label="Total SKUs" value={String(vendorProducts.length)} icon={Package} highlight />
        <StatCard onClick={() => openList("healthy")} label="Healthy Stock" value={String(healthy.length)} icon={Boxes} />
        <StatCard onClick={() => openList("low")} label="Low Stock" value={String(lowStock.length)} icon={AlertTriangle} />
        <StatCard onClick={() => openList("out")} label="Out of Stock" value={String(outOfStock.length)} icon={PackageX} />
      </div>

      {lowStock.length > 0 && (
        <Panel title="Reorder Alerts" className="mt-6">
          <p className="mb-4 text-sm text-slate">{lowStock.length} product{lowStock.length === 1 ? "" : "s"} are out of stock or below their individual reorder level. Update each item with a verified stock count.</p>
          <DataTable
            columns={["Product", "SKU", "Stock", "Status"]}
            rows={lowStock.map((p) => [
              <span className="font-semibold text-navy">{p.name}</span>,
              p.sku,
              `${p.stock} / ${p.minimumStock ?? REORDER_LEVEL}`,
              <StatusBadge status={p.stock <= 0 ? "Out of Stock" : "Low Stock"} />,
            ])}
          />
        </Panel>
      )}

      <Panel
        id="all-stock"
        title="All Stock"
        className="mt-6"
        action={<Input placeholder="Search name, SKU, or category" aria-label="Search inventory by product name, SKU, or category" value={q} onChange={(e) => setQ(e.target.value)} className="h-9 w-56" />}
      >
        {view !== "all" && <FilterNote label={view === "healthy" ? "Healthy Stock" : view === "low" ? "Low Stock" : "Out of Stock"} onClear={() => setView("all")} />}
        <DataTable
          columns={["Product", "SKU", "Category", "Stock", "Reserved", "Status", "Actions"]}
          rows={filtered.map((p) => [
            <span className="font-semibold text-navy">{p.name}</span>,
            p.sku,
            p.category,
            p.stock,
            p.reserved,
            <StatusBadge status={p.stock <= 0 ? "Out of Stock" : p.stock < (p.minimumStock ?? REORDER_LEVEL) ? "Low Stock" : "active"} />,
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                setStockDialog(p);
                setStockValue(String(p.stock));
              }}
            >
              Update Stock
            </Button>,
          ])}
        />
      </Panel>

      <Dialog open={!!stockDialog} onOpenChange={(v) => !v && setStockDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Update Stock — {stockDialog?.name}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label>New stock quantity</Label>
            <Input type="number" min="0" step="1" value={stockValue} onChange={(e) => setStockValue(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStockDialog(null)}>Cancel</Button>
            <Button
              className="bg-navy text-white hover:bg-navy/90"
              onClick={async () => {
                if (!stockDialog) return;
                const val = Number(stockValue);
                if (!Number.isInteger(val) || val < 0) {
                  toast.error("Enter a whole-number stock quantity of zero or more");
                  return;
                }
                if (!await updateProduct(stockDialog.id, { stock: val })) return;
                toast.success(`Stock for ${stockDialog.name} updated`, { description: "The product stays live; Zoho gets the new stock too." });
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
