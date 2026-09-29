import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { AlertTriangle, Boxes, Package, PackageX } from "lucide-react";
import { toast } from "sonner";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel, StatCard, StatusBadge } from "@/components/panel/widgets";
import { vendorNav } from "@/lib/panel-nav";
import { useApp, useVendorScope } from "@/lib/store";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import type { Product } from "@/lib/data";

export const Route = createFileRoute("/vendor/inventory")({
  head: () => ({
    meta: [
      { title: "Inventory | Shami Vendor Panel" },
      { name: "description", content: "Track stock levels and reorder alerts for your products." },
      { property: "og:title", content: "Vendor Inventory | Shami" },
      { property: "og:description", content: "Stock management console for Shami marketplace vendors." },
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

  const filtered = useMemo(
    () => vendorProducts.filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase())),
    [vendorProducts, q],
  );

  const outOfStock = vendorProducts.filter((p) => p.stock === 0);
  const lowStock = vendorProducts.filter((p) => p.stock > 0 && p.stock < REORDER_LEVEL);
  const healthy = vendorProducts.filter((p) => p.stock >= REORDER_LEVEL);

  const restockAll = () => {
    lowStock.forEach((p) => updateProduct(p.id, { stock: REORDER_LEVEL + 100 }));
    toast.success(`Restocked ${lowStock.length} low-stock product${lowStock.length === 1 ? "" : "s"}`);
  };

  return (
    <PanelLayout items={vendorNav} tone="vendor" title="Inventory" subtitle="Stock levels and reorder alerts">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total SKUs" value={String(vendorProducts.length)} icon={Package} highlight />
        <StatCard label="Healthy Stock" value={String(healthy.length)} icon={Boxes} />
        <StatCard label="Low Stock" value={String(lowStock.length)} icon={AlertTriangle} />
        <StatCard label="Out of Stock" value={String(outOfStock.length)} icon={PackageX} />
      </div>

      {lowStock.length > 0 && (
        <Panel title="Reorder Alerts" className="mt-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-slate">{lowStock.length} product{lowStock.length === 1 ? "" : "s"} below the {REORDER_LEVEL}-unit reorder level.</p>
            <Button size="sm" className="bg-navy text-white hover:bg-navy/90" onClick={restockAll}>
              Restock All Low Stock
            </Button>
          </div>
          <DataTable
            columns={["Product", "SKU", "Stock", "Status"]}
            rows={lowStock.map((p) => [
              <span className="font-semibold text-navy">{p.name}</span>,
              p.sku,
              p.stock,
              <StatusBadge status="Low Stock" />,
            ])}
          />
        </Panel>
      )}

      <Panel
        title="All Stock"
        className="mt-6"
        action={<Input placeholder="Search product" value={q} onChange={(e) => setQ(e.target.value)} className="h-9 w-56" />}
      >
        <DataTable
          columns={["Product", "SKU", "Category", "Stock", "Reserved", "Status", "Actions"]}
          rows={filtered.map((p) => [
            <span className="font-semibold text-navy">{p.name}</span>,
            p.sku,
            p.category,
            p.stock,
            p.reserved,
            <StatusBadge status={p.stock === 0 ? "Cancelled" : p.stock < REORDER_LEVEL ? "Low Stock" : "active"} />,
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
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
            <Input type="number" value={stockValue} onChange={(e) => setStockValue(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStockDialog(null)}>Cancel</Button>
            <Button
              className="bg-navy text-white hover:bg-navy/90"
              onClick={() => {
                if (!stockDialog) return;
                const val = Number(stockValue);
                if (Number.isNaN(val) || val < 0) {
                  toast.error("Enter a valid stock quantity");
                  return;
                }
                updateProduct(stockDialog.id, { stock: val });
                toast.success(`Stock for ${stockDialog.name} updated to ${val}`);
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
