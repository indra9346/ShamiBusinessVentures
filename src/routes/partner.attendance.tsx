import { createFileRoute } from "@tanstack/react-router";
import { AttendanceManager } from "@/components/attendance/AttendanceManager";
import { usePartner } from "@/components/partners/PartnerLayout";
import { StockCountLog } from "@/components/stock/StockCountLog";

export const Route = createFileRoute("/partner/attendance")({
  head: () => ({ meta: [{ title: "Godown Attendance | Grain Bazar Partner" }, { name: "robots", content: "noindex" }] }),
  component: PartnerAttendance,
});

/** The channel partner's attendance desk for their godown: today, approvals (with head office), register; stock counts. */
function PartnerAttendance() {
  const { me } = usePartner();
  return (
    <div className="space-y-10">
      <AttendanceManager viewer="partner" partnerBranchId={me.branchId} />
      <StockCountLog godowns={[{ id: me.branchId, name: me.godown }]} />
    </div>
  );
}
