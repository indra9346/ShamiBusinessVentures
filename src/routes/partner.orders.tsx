import { createFileRoute } from "@tanstack/react-router";
import { PartnerOrdersToConfirm } from "@/components/partners/PartnerOrdersToConfirm";

export const Route = createFileRoute("/partner/orders")({
  head: () => ({ meta: [{ title: "Orders to confirm | Grain Bazar Partner" }, { name: "robots", content: "noindex" }] }),
  component: Page,
});

/** Paid orders of the godown waiting for the partner to confirm them. */
function Page() {
  return <PartnerOrdersToConfirm />;
}
