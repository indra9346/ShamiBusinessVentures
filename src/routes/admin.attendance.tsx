import { createFileRoute } from "@tanstack/react-router";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { AttendanceManager } from "@/components/attendance/AttendanceManager";
import { adminNav } from "@/lib/panel-nav";

export const Route = createFileRoute("/admin/attendance")({
  head: () => ({ meta: [{ title: "Attendance | Grain Bazar Admin" }, { name: "robots", content: "noindex" }] }),
  component: AdminAttendance,
});

/** Head office attendance desk: every godown's day, approvals, register, employees and geofences. */
function AdminAttendance() {
  return (
    <PanelLayout items={adminNav} tone="admin" title="Attendance" subtitle="Godown employees: selfie check-in at the godown, leave requests and approvals">
      <AttendanceManager viewer="admin" />
    </PanelLayout>
  );
}
