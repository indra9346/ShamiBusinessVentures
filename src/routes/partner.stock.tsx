import { createFileRoute } from "@tanstack/react-router";
import { ComingToGodown } from "@/components/batches/ComingToGodown";
import { GodownTransfers } from "@/components/batches/GodownTransfers";
import { usePartner } from "@/components/partners/PartnerLayout";
import { PartnerStockIndents } from "@/components/partners/StockIndents";

export const Route = createFileRoute("/partner/stock")({
  head: () => ({ meta: [{ title: "Stock & indents | Grain Bazar Partner" }, { name: "robots", content: "noindex" }] }),
  component: Page,
});

/** Stock on its way to the godown, transfers to receive, and stock requests (indents) to head office. */
function Page() {
  const { me } = usePartner();
  return (
    <>
      <GodownTransfers />
      <ComingToGodown branchId={me.branchId} />
      <PartnerStockIndents branchId={me.branchId} godown={me.godown} partnerName={me.name} />
    </>
  );
}
