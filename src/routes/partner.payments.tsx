import { createFileRoute } from "@tanstack/react-router";
import { PartnerPaymentsPanel } from "@/components/panel/PartnerPaymentsPanel";

export const Route = createFileRoute("/partner/payments")({
  head: () => ({ meta: [{ title: "Customer payments | Grain Bazar Partner" }, { name: "robots", content: "noindex" }] }),
  component: Page,
});

/** The godown's checkouts waiting for payment: send a customer's UTR, check the bank and approve it. */
function Page() {
  return <PartnerPaymentsPanel />;
}
