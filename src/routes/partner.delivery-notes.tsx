import { createFileRoute } from "@tanstack/react-router";
import { ReleasedDeliveryNotes } from "@/components/panel/DeliveryNotePanel";
import { usePartner } from "@/components/partners/PartnerLayout";
import { ScanQrCard } from "@/components/partners/ScanQrCard";

export const Route = createFileRoute("/partner/delivery-notes")({
  head: () => ({ meta: [{ title: "Delivery notes | Grain Bazar Partner" }, { name: "robots", content: "noindex" }] }),
  component: Page,
});

/** The delivery notes released at the godown, with the items still to go, and the QR scanner. */
function Page() {
  const { me } = usePartner();
  return (
    <>
      <ScanQrCard godown={me.godown} />
      <ReleasedDeliveryNotes />
    </>
  );
}
