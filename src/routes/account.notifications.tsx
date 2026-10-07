import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Bell, BellRing, CheckCheck } from "lucide-react";
import { toast } from "sonner";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel, StatCard } from "@/components/panel/widgets";
import { accountNav } from "@/lib/account-nav";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { notificationTarget } from "@/lib/notification-target";
import { notificationBelongsToUser } from "@/lib/account-identity";

export const Route = createFileRoute("/account/notifications")({
  head: () => ({
    meta: [
      { title: "Notifications | Shami Business Ventures" },
      {
        name: "description",
        content: "Order updates, offers and delivery alerts on your Shami account.",
      },
      { property: "og:title", content: "Notifications | Shami" },
      { property: "og:description", content: "All alerts for your orders and offers." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AccountNotifications,
});

function AccountNotifications() {
  const { notifications, markRead, markAllRead, user, orders } = useApp();
  const navigate = useNavigate();
  const mine = notifications.filter(
    (n) => n.role === "customer" && notificationBelongsToUser(n, user, orders),
  );
  const unread = mine.filter((n) => !n.read).length;

  return (
    <PanelLayout
      items={accountNav}
      tone="customer"
      title="Notifications"
      subtitle="Updates on your orders and offers"
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Total Notifications" value={String(mine.length)} icon={Bell} highlight />
        <StatCard label="Unread" value={String(unread)} icon={BellRing} />
        <StatCard label="Read" value={String(mine.length - unread)} icon={CheckCheck} />
      </div>

      <Panel
        title="All Notifications"
        className="mt-6"
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              markAllRead();
              toast.success("All notifications marked as read");
            }}
          >
            Mark All Read
          </Button>
        }
      >
        <div className="space-y-3">
          {mine.map((n) => (
            <div
              key={n.id}
              role="button"
              tabIndex={0}
              onClick={() => {
                markRead(n.id);
                navigate({ to: notificationTarget(n, "customer", user, orders) as never });
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  markRead(n.id);
                  navigate({ to: notificationTarget(n, "customer", user, orders) as never });
                }
              }}
              className={`flex cursor-pointer flex-wrap items-start justify-between gap-3 rounded-lg border p-4 transition-colors hover:bg-ivory ${n.read ? "border-border" : "border-gold/40 bg-gold/5"}`}
            >
              <div className="min-w-0">
                <p className="font-semibold text-navy">{n.title}</p>
                <p className="mt-1 text-sm text-slate">{n.body}</p>
                <p className="mt-1 text-xs text-slate">{n.time}</p>
              </div>
              {!n.read && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={(event) => {
                    event.stopPropagation();
                    markRead(n.id);
                    toast.success("Marked as read");
                  }}
                >
                  Mark Read
                </Button>
              )}
            </div>
          ))}
        </div>
      </Panel>
    </PanelLayout>
  );
}
