import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Bell, BellRing, CheckCheck, Mail, Send, Trash2 } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel, StatCard, StatusBadge } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const Route = createFileRoute("/admin/notifications")({
  head: () => ({
    meta: [
      { title: "Notifications | Shami Business Ventures Admin" },
      { name: "description", content: "Platform alerts, broadcast messages and notification channel settings." },
      { property: "og:title", content: "Notifications | Shami Admin" },
      { property: "og:description", content: "Alert centre for the marketplace control panel." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminNotifications,
});

function AdminNotifications() {
  const { notifications, markRead, markAllRead, deleteNotification } = useApp();
  const [role, setRole] = useState("All");
  const [type, setType] = useState("All");
  const [broadcast, setBroadcast] = useState({ audience: "All Vendors", subject: "", message: "" });
  const [channels, setChannels] = useState({ email: true, sms: true, whatsapp: false, push: true });

  const list = useMemo(
    () =>
      notifications.filter(
        (n) => (role === "All" || n.role === role.toLowerCase()) && (type === "All" || n.type === type),
      ),
    [notifications, role, type],
  );

  const stats = useMemo(
    () => ({
      total: notifications.length,
      unread: notifications.filter((n) => !n.read).length,
      admin: notifications.filter((n) => n.role === "admin").length,
      vendor: notifications.filter((n) => n.role === "vendor").length,
    }),
    [notifications],
  );

  const types = useMemo(() => ["All", ...new Set(notifications.map((n) => n.type))], [notifications]);

  const send = () => {
    if (!broadcast.subject.trim() || broadcast.message.trim().length < 5) {
      toast.error("Add a subject and a message of at least 5 characters");
      return;
    }
    toast.success(`Broadcast sent to ${broadcast.audience}`);
    setBroadcast((b) => ({ ...b, subject: "", message: "" }));
  };

  return (
    <PanelLayout items={adminNav} tone="admin" title="Notifications" subtitle="Platform alerts and broadcasts">
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total Alerts" value={String(stats.total)} icon={Bell} />
        <StatCard label="Unread" value={String(stats.unread)} icon={BellRing} highlight />
        <StatCard label="Admin Alerts" value={String(stats.admin)} icon={Mail} />
        <StatCard label="Vendor Alerts" value={String(stats.vendor)} icon={Mail} />
      </div>

      <Tabs defaultValue="inbox">
        <TabsList className="mb-4 flex-wrap">
          <TabsTrigger value="inbox">Inbox</TabsTrigger>
          <TabsTrigger value="broadcast">Broadcast</TabsTrigger>
          <TabsTrigger value="channels">Channels</TabsTrigger>
        </TabsList>

        <TabsContent value="inbox">
          <Panel
            title={`Alerts (${list.length})`}
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  markAllRead();
                  toast.success("All notifications marked as read");
                }}
              >
                <CheckCheck className="mr-1 h-3.5 w-3.5" /> Mark all read
              </Button>
            }
          >
            <div className="mb-4 flex flex-wrap gap-3">
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["All", "Admin", "Vendor", "Customer"].map((r) => (
                    <SelectItem key={r} value={r}>{r}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {types.map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {list.length === 0 ? (
              <div className="grid place-items-center gap-2 py-14 text-center">
                <p className="text-sm font-semibold text-navy">No notifications match these filters</p>
                <p className="text-xs text-slate">Try a different role or alert type.</p>
              </div>
            ) : (
              <ul className="grid gap-3">
                {list.map((n) => (
                  <li
                    key={n.id}
                    className={`grid gap-2 rounded-lg border p-4 transition-colors sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center ${
                      n.read ? "border-border bg-card" : "border-gold/40 bg-ivory"
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-bold text-navy">{n.title}</p>
                        <StatusBadge status={n.type} />
                        <span className="text-[11px] font-semibold text-slate uppercase">{n.role}</span>
                      </div>
                      <p className="mt-1 text-sm text-charcoal">{n.body}</p>
                      <p className="mt-1 text-xs text-slate">{n.time}</p>
                    </div>
                    <div className="flex gap-2">
                      {!n.read && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            markRead(n.id);
                            toast.success("Marked as read");
                          }}
                        >
                          Mark read
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          deleteNotification(n.id);
                          toast.success("Notification deleted");
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </TabsContent>

        <TabsContent value="broadcast">
          <Panel title="Send Broadcast">
            <div className="grid gap-4 xl:max-w-2xl">
              <div className="grid gap-1.5">
                <Label>Audience</Label>
                <Select value={broadcast.audience} onValueChange={(v) => setBroadcast((b) => ({ ...b, audience: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {["All Vendors", "All Customers", "All Users", "Pending KYC Vendors"].map((a) => (
                      <SelectItem key={a} value={a}>{a}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label>Subject</Label>
                <Input value={broadcast.subject} onChange={(e) => setBroadcast((b) => ({ ...b, subject: e.target.value }))} placeholder="Festive dispatch schedule" />
              </div>
              <div className="grid gap-1.5">
                <Label>Message</Label>
                <Textarea rows={5} value={broadcast.message} onChange={(e) => setBroadcast((b) => ({ ...b, message: e.target.value }))} placeholder="Dispatch cut-off for the festive week is 6 PM IST…" />
              </div>
              <Button className="bg-navy text-white hover:bg-navy/90 sm:w-fit" onClick={send}>
                <Send className="mr-1 h-4 w-4" /> Send Broadcast
              </Button>
            </div>
          </Panel>
        </TabsContent>

        <TabsContent value="channels">
          <Panel title="Delivery Channels">
            <div className="grid gap-3 xl:max-w-2xl">
              {(
                [
                  ["email", "Email notifications", "Order confirmations, invoices and payout advices"],
                  ["sms", "SMS alerts", "Dispatch and delivery updates to Indian mobile numbers"],
                  ["whatsapp", "WhatsApp Business", "Order tracking messages via WhatsApp API"],
                  ["push", "Web push", "Real-time alerts inside vendor and admin panels"],
                ] as const
              ).map(([key, label, desc]) => (
                <div key={key} className="flex items-center justify-between gap-4 rounded-md border border-border p-4">
                  <div>
                    <p className="text-sm font-bold text-navy">{label}</p>
                    <p className="text-xs text-slate">{desc}</p>
                  </div>
                  <Switch
                    checked={channels[key]}
                    onCheckedChange={(v) => {
                      setChannels((c) => ({ ...c, [key]: v }));
                      toast.success(`${label} ${v ? "enabled" : "disabled"}`);
                    }}
                  />
                </div>
              ))}
            </div>
          </Panel>
        </TabsContent>
      </Tabs>
    </PanelLayout>
  );
}
