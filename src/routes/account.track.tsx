import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { CheckCircle2, Circle, PhoneCall, Truck } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel, StatusBadge } from "@/components/panel/widgets";
import { accountNav } from "@/lib/account-nav";
import { orderStages } from "@/lib/data";
import { useApp } from "@/lib/store";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/account/track")({
  head: () => ({
    meta: [
      { title: "Track Order | Shami Business Ventures" },
      { name: "description", content: "Track the live status and courier details of your Shami orders." },
      { property: "og:title", content: "Track Order | Shami" },
      { property: "og:description", content: "Live order tracking with delivery stage timeline." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AccountTrack,
});

const couriers = ["ShamiXpress Freight", "BlueDart Surface", "Delhivery Business", "Ekart Logistics"];

function AccountTrack() {
  const { user, orders } = useApp();
  const myOrders = useMemo(() => {
    const base = user ? orders.filter((o) => o.email === user.email) : orders;
    return base.length ? base : orders;
  }, [orders, user]);
  const active = myOrders.filter((o) => o.status !== "Cancelled");
  const [selected, setSelected] = useState(active[0]?.id ?? "");
  const order = myOrders.find((o) => o.id === selected) ?? active[0];
  const currentIdx = order ? orderStages.indexOf(order.status) : -1;
  const courier = order ? couriers[order.id.charCodeAt(order.id.length - 1) % couriers.length] : couriers[0];

  return (
    <PanelLayout items={accountNav} tone="customer" title="Track Orders" subtitle="Live status of your shipments">
      <Panel
        title="Select an Order"
        action={
          <Select value={order?.id ?? ""} onValueChange={setSelected}>
            <SelectTrigger className="h-9 w-56"><SelectValue placeholder="Select order" /></SelectTrigger>
            <SelectContent>
              {active.map((o) => (
                <SelectItem key={o.id} value={o.id}>{o.id}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      >
        {!order ? (
          <p className="text-sm text-slate">No orders available to track.</p>
        ) : (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-semibold text-navy">{order.id}</p>
                <p className="text-xs text-slate">Placed on {order.date} · {order.items.length} item(s)</p>
              </div>
              <StatusBadge status={order.status} />
            </div>

            {order.status === "Cancelled" ? (
              <p className="text-sm text-danger">This order was cancelled and is no longer being tracked.</p>
            ) : (
              <ol className="space-y-4">
                {orderStages.map((s, i) => (
                  <li key={s} className="flex gap-3">
                    {i <= currentIdx ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-gold" />
                    ) : (
                      <Circle className="mt-0.5 h-4 w-4 shrink-0 text-border" />
                    )}
                    <div className="min-w-0">
                      <p className={cn("text-sm font-semibold", i <= currentIdx ? "text-navy" : "text-slate")}>{s}</p>
                      <p className="text-xs text-slate">{i <= currentIdx ? order.date : "Pending"}</p>
                    </div>
                  </li>
                ))}
              </ol>
            )}

            <div className="rounded-lg border border-border bg-ivory p-4">
              <p className="flex items-center gap-2 text-sm font-semibold text-navy">
                <Truck className="h-4 w-4 text-gold" /> Courier: {courier}
              </p>
              <p className="mt-1 flex items-center gap-2 text-sm text-slate">
                <PhoneCall className="h-4 w-4 text-gold" /> Support: +91 1800 202 4040
              </p>
              <p className="mt-1 text-xs text-slate">Delivering to {order.address}, {order.city}, {order.state} {order.pin}</p>
            </div>
          </div>
        )}
      </Panel>
    </PanelLayout>
  );
}
