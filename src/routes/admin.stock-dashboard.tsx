import { createFileRoute } from "@tanstack/react-router";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { StockDashboard } from "@/components/stock/StockDashboard";
import { adminNav } from "@/lib/panel-nav";

export const Route = createFileRoute("/admin/stock-dashboard")({
  head: () => ({ meta: [{ title: "Daily Stock | Shami Admin" }, { name: "robots", content: "noindex" }] }),
  component: Page,
});

function Page() {
  return (
    <PanelLayout items={adminNav} tone="admin" title="Daily stock" subtitle="Per item and batch / lot: opening, sales, undelivered and physical stock, with Zoho's on-hand">
      <StockDashboard />
    </PanelLayout>
  );
}
