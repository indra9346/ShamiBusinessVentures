import { createFileRoute } from "@tanstack/react-router";
import { PartnerLayout } from "@/components/partners/PartnerLayout";

/** The channel partner panel: a side menu like the admin's around every /partner page (owner, 16 Nov 2026). */
export const Route = createFileRoute("/partner")({
  component: PartnerLayout,
});
