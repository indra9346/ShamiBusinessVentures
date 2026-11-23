import { createFileRoute } from "@tanstack/react-router";
import { Panel } from "@/components/panel/widgets";
import { usePartner } from "@/components/partners/PartnerLayout";
import { PartnerLeaderboard, usePartnerData } from "@/components/partners/PartnerWidgets";
import { monthLabel } from "@/lib/partners";

export const Route = createFileRoute("/partner/leaderboard")({
  head: () => ({ meta: [{ title: "Leaderboard | Grain Bazar Partner" }, { name: "robots", content: "noindex" }] }),
  component: Page,
});

/** Where the partner stands among all channel partners this month. */
function Page() {
  const { me, month } = usePartner();
  const { leaders } = usePartnerData(month);
  return (
    <Panel title={`Leaderboard · ${monthLabel(month)}`}>
      <PartnerLeaderboard leaders={leaders} highlightPartnerId={me.id} />
    </Panel>
  );
}
