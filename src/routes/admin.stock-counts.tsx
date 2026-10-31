import { createFileRoute } from "@tanstack/react-router";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { StockCountLog } from "@/components/stock/StockCountLog";
import { adminNav } from "@/lib/panel-nav";
import { useBranches } from "@/lib/branches";

export const Route = createFileRoute("/admin/stock-counts")({
  head: () => ({ meta: [{ title: "Stock Counts | Grain Bazar Admin" }, { name: "robots", content: "noindex" }] }),
  component: AdminStockCounts,
});

/** Head office: every stock count made by godown staff, with big changes highlighted. */
function AdminStockCounts() {
  const { branches } = useBranches();
  const godowns = branches.filter((branch) => !branch.vendorId).map((branch) => ({ id: branch.id, name: branch.name }));
  return (
    <PanelLayout items={adminNav} tone="admin" title="Stock Counts" subtitle="Godown stock updated by godown staff, synced to Zoho and the website">
      <StockCountLog godowns={godowns} />
    </PanelLayout>
  );
}
