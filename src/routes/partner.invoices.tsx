import { createFileRoute } from "@tanstack/react-router";
import { PartnerInvoices } from "@/components/partners/PartnerInvoices";
import { usePartner } from "@/components/partners/PartnerLayout";

export const Route = createFileRoute("/partner/invoices")({
  head: () => ({ meta: [{ title: "Customer invoices | Grain Bazar Partner" }, { name: "robots", content: "noindex" }] }),
  component: Page,
});

/** Invoices of the godown's orders, with the partner's signature. */
function Page() {
  const { me } = usePartner();
  return <PartnerInvoices signaturePath={me.signaturePath} />;
}
