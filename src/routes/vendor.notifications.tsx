import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Bell, BellRing, CheckCheck } from "lucide-react";
import { toast } from "sonner";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel, StatCard, StatusBadge } from "@/components/panel/widgets";
import { Button } from "@/components/ui/button";
import { vendorNav } from "@/lib/panel-nav";
import { notificationTarget } from "@/lib/notification-target";
import { useApp } from "@/lib/store";

export const Route = createFileRoute("/vendor/notifications")({
  head: () => ({
    meta: [
      { title: "Notifications | Shami Vendor Panel" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: VendorNotifications,
});

function VendorNotifications() {
  const { notifications, markRead, markAllRead, user, orders } = useApp();
  const navigate = useNavigate();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const vendorNotifications = useMemo(
    () => notifications.filter((item) => item.role === "vendor" || !item.role),
    [notifications],
  );
  const visibleNotifications = unreadOnly
    ? vendorNotifications.filter((item) => !item.read)
    : vendorNotifications;
  const unreadCount = vendorNotifications.filter((item) => !item.read).length;

  return (
    <PanelLayout items={vendorNav} tone="vendor" title="Notifications" subtitle="Live updates for your store">
      <div className="mb-6 grid gap-4 sm:grid-cols-2">
        <StatCard label="All Notifications" value={String(vendorNotifications.length)} icon={Bell} />
        <StatCard label="Unread" value={String(unreadCount)} icon={BellRing} highlight={unreadCount > 0} />
      </div>
      <Panel
        title={`Store updates (${visibleNotifications.length})`}
        action={
          <div className="flex flex-wrap gap-2">
            <Button variant={unreadOnly ? "outline" : "default"} size="sm" onClick={() => setUnreadOnly((value) => !value)}>
              {unreadOnly ? "Show all" : "Unread only"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={unreadCount === 0}
              onClick={() => void markAllRead().then((ok) => { if (ok) toast.success("Notifications marked as read"); })}
            >
              <CheckCheck className="mr-1 h-3.5 w-3.5" /> Mark all read
            </Button>
          </div>
        }
      >
        {visibleNotifications.length === 0 ? (
          <div className="grid min-h-40 place-items-center text-center">
            <div>
              <p className="font-semibold text-navy">{unreadOnly ? "You’re all caught up" : "No store updates yet"}</p>
              <p className="mt-1 text-sm text-slate">New order, inventory, and return updates will appear here.</p>
            </div>
          </div>
        ) : (
          <ul className="grid gap-3">
            {visibleNotifications.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={`flex w-full items-start justify-between gap-4 rounded-lg border p-4 text-left transition-colors hover:border-gold/50 ${item.read ? "border-border bg-card" : "border-gold/40 bg-ivory"}`}
                  onClick={() => {
                    void markRead(item.id);
                    navigate({ to: notificationTarget(item, "vendor", user, orders) as never });
                  }}
                >
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-navy">{item.title}</span>
                      <StatusBadge status={item.type} />
                    </span>
                    <span className="mt-1 block text-sm text-slate">{item.body}</span>
                    <span className="mt-2 block text-xs text-slate/80">{item.time}</span>
                  </span>
                  {!item.read && <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-gold" aria-label="Unread" />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </PanelLayout>
  );
}
