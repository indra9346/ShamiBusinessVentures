import { createFileRoute } from "@tanstack/react-router";
import { StockDashboard } from "@/components/stock/StockDashboard";

export const Route = createFileRoute("/partner/stock-dashboard")({
  head: () => ({ meta: [{ title: "Daily stock | Grain Bazar Partner" }, { name: "robots", content: "noindex" }] }),
  component: Page,
});

/** The partner's own godown only: the server decides it from the login. */
function Page() {
  return <StockDashboard partner />;
}
