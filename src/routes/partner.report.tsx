import { createFileRoute } from "@tanstack/react-router";
import { MyPartnerReport } from "@/components/partners/MyPartnerReport";
import { usePartner } from "@/components/partners/PartnerLayout";

export const Route = createFileRoute("/partner/report")({
  head: () => ({ meta: [{ title: "Sales report | Grain Bazar Partner" }, { name: "robots", content: "noindex" }] }),
  component: Page,
});

/** The partner's own sales report for any dates, with the Excel download. */
function Page() {
  const { me } = usePartner();
  return <MyPartnerReport partnerName={me.name} />;
}
