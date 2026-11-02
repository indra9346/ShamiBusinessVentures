import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Package } from "lucide-react";
import { toast } from "sonner";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel, StatCard, StatusBadge } from "@/components/panel/widgets";
import { Pager } from "@/components/panel/pager";
import { accountNav } from "@/lib/account-nav";
import { canCancelOrder, inr, inrPrecise, orderStages, type OrderStatus } from "@/lib/data";
import { AWAITING_PAYMENT, clockText, holdSecondsLeft, PAYMENT_EXPIRED } from "@/lib/payment-hold";
import { useServerNow } from "@/lib/server-clock";
import { useApp } from "@/lib/store";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { showCartNotification } from "@/components/site/CartFloatingNotification";
import { orderBelongsToUser } from "@/lib/account-identity";
import { UNCHECKED_UTR_NOTE, isBankMethod, methodLabel } from "@/lib/payment-rules";
import { useUpiPayments } from "@/lib/upi-store";
import { supabase } from "@/integrations/supabase/client";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { ReorderButton } from "@/components/site/ReorderButton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { matchesOrderStatus, OPEN_ORDERS, orderStatusFilter } from "@/lib/panel-filters";

export const Route = createFileRoute("/account/orders")({
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search["q"] === "string" ? { q: search["q"] } : {}),
    ...(typeof search["status"] === "string" ? { status: search["status"] } : {}),
  }),
  head: () => ({
    meta: [
      { title: "My Orders | Shami Business Ventures" },
      { name: "description", content: "View your full order history, statuses and invoices." },
      { property: "og:title", content: "My Orders | Shami" },
      { property: "og:description", content: "Search, filter and manage your past orders." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AccountOrders,
});

const PAGE_SIZE = 10;

function AccountOrders() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const routeSearch = Route.useSearch();
  const { user, orders, updateOrderStatus, addToCart, paymentHolds } = useApp();
  const unpaid = paymentHolds.filter((hold) => hold.status === AWAITING_PAYMENT);
  const now = useServerNow();
  const { submissions } = useUpiPayments();
  // A checkout whose time is up ends now (stock back, Reorder on offer), not at the next scheduled sweep.
  const anyOver = unpaid.some((hold) => holdSecondsLeft(hold.holdUntil, now) === 0 && !submissions.some((item) => item.orderNo === hold.orderNo && item.status === "submitted"));
  const lastSweep = useRef(0);
  useEffect(() => {
    if (STATIC_DATA_MODE || !anyOver || now - lastSweep.current < 15000) return;
    lastSweep.current = now;
    void supabase.rpc("expire_payment_holds").then(() => undefined);
  }, [anyOver, now]);
  // Checkouts that were not paid, for the last 30 days: the customer can order the same items again.
  const notPlaced = paymentHolds
    .filter((hold) => hold.status === PAYMENT_EXPIRED && now - Date.parse(hold.createdAt) < 30 * 86_400_000)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 10);
  const [q, setQ] = useState(routeSearch.q ?? "");
  const [status, setStatus] = useState(() => orderStatusFilter(routeSearch.status, [...orderStages, "Cancelled"]));
  const [sort, setSort] = useState("date-desc");
  const [page, setPage] = useState(1);

  // A link can change the filter while this list stays open (the sidebar's Orders, "Show all").
  useEffect(() => {
    setStatus(orderStatusFilter(routeSearch.status, [...orderStages, "Cancelled"]));
    setPage(1);
  }, [routeSearch.status]);

  useEffect(() => {
    setQ(routeSearch.q ?? "");
    setPage(1);
  }, [routeSearch.q]);

  const myOrders = useMemo(
    () => orders.filter((order) => orderBelongsToUser(order, user)),
    [orders, user],
  );

  const filtered = useMemo(() => {
    let list = myOrders.filter((o) => {
      const s = q.trim().toLowerCase();
      const matchesQ =
        !s ||
        `${o.id} ${o.status} ${o.items.map((i) => `${i.product.name} ${i.product.sku}`).join(" ")}`.toLowerCase().includes(s);
      const matchesStatus = matchesOrderStatus(o.status, status);
      return matchesQ && matchesStatus;
    });
    list = [...list].sort((a, b) => {
      if (sort === "date-desc") return b.id.localeCompare(a.id);
      if (sort === "date-asc") return a.id.localeCompare(b.id);
      if (sort === "amount-desc") return b.amount - a.amount;
      return a.amount - b.amount;
    });
    return list;
  }, [myOrders, q, status, sort]);

  if (pathname !== "/account/orders" && pathname !== "/account/orders/") {
    return <Outlet />;
  }

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pages);
  const rows = filtered.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);

  const delivered = myOrders.filter((o) => o.status === "Delivered").length;
  const active = myOrders.filter(
    (o) => o.status !== "Delivered" && o.status !== "Cancelled",
  ).length;

  return (
    <PanelLayout
      items={accountNav}
      tone="customer"
      title="My Orders"
      subtitle="Your complete order history"
    >
      {unpaid.length > 0 && (
        <Panel title="Waiting for payment" className="mb-6">
          <p className="mb-3 text-sm text-slate">These are not orders yet: each is placed when its payment is confirmed. Unpaid ones end on their own and nothing is due.</p>
          <ul className="divide-y divide-border">
            {unpaid.map((hold) => {
              const left = holdSecondsLeft(hold.holdUntil, now);
              const byBank = isBankMethod(hold.method);
              const utrSent = submissions.some((item) => item.orderNo === hold.orderNo && item.status === "submitted");
              return (
                <li key={hold.orderNo} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                  <div>
                    <p className="font-semibold text-navy">{hold.orderNo}</p>
                    <p className="text-xs text-slate">{inrPrecise(hold.amount)} · {methodLabel(hold.method ?? "UPI")} · {utrSent
                      ? "checking the payment"
                      : left === 0 ? "time is up"
                      : byBank ? `enter UTR within ${clockText(left)}` : `pay within ${clockText(left)}`}</p>
                  </div>
                  <Link to="/account/orders/$id" params={{ id: hold.orderNo }} search={true} className="rounded-md bg-gold px-4 py-2 text-sm font-bold text-midnight hover:bg-gold-light">{utrSent || left === 0 ? "View" : byBank ? "Enter UTR" : "Pay now"}</Link>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}
      {notPlaced.length > 0 && (
        <Panel title="Not placed" className="mb-6">
          <p className="mb-3 text-sm text-slate">These checkouts were not placed. Nothing is due unless a line below says so. Reorder puts the same items back in your cart, at today's prices and stock.</p>
          <ul className="divide-y divide-border">
            {notPlaced.map((hold) => (
              <li key={hold.orderNo} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <Link to="/account/orders/$id" params={{ id: hold.orderNo }} search={true} className="font-semibold text-navy hover:text-gold">{hold.orderNo}</Link>
                  <p className="text-xs text-slate">{inrPrecise(hold.amount)} · {hold.lines.map((line) => `${line.name ?? line.productId} × ${line.qty}`).join(", ")}</p>
                  {submissions.some((item) => item.orderNo === hold.orderNo && item.status === "rejected" && item.note === UNCHECKED_UTR_NOTE) && (
                    <p className="mt-0.5 text-xs font-semibold text-amber-800">{`Do not pay again: send UTR ${submissions.find((item) => item.orderNo === hold.orderNo)?.utr} on the reorder, or call us.`}</p>
                  )}
                </div>
                <ReorderButton lines={hold.lines} />
              </li>
            ))}
          </ul>
        </Panel>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Total Orders" value={String(myOrders.length)} icon={Package} highlight />
        <StatCard label="Active" value={String(active)} icon={Package} />
        <StatCard label="Delivered" value={String(delivered)} icon={Package} />
      </div>

      <Panel
        title="All Orders"
        className="mt-6"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="Search order or product"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
              className="h-9 w-52"
            />
            <Select
              value={status}
              onValueChange={(v) => {
                setStatus(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="h-9 w-40">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value={OPEN_ORDERS}>All pending</SelectItem>
                {[...orderStages, "Cancelled"].map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={sort} onValueChange={setSort}>
              <SelectTrigger className="h-9 w-44">
                <SelectValue placeholder="Sort" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="date-desc">Newest First</SelectItem>
                <SelectItem value="date-asc">Oldest First</SelectItem>
                <SelectItem value="amount-desc">Amount: High to Low</SelectItem>
                <SelectItem value="amount-asc">Amount: Low to High</SelectItem>
              </SelectContent>
            </Select>
          </div>
        }
      >
        {myOrders.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-sm font-medium text-slate">
              No orders are linked to this account yet.
            </p>
            <Link
              to="/shop"
              className="mt-2 inline-block text-sm font-semibold text-gold hover:underline"
            >
              Browse products
            </Link>
          </div>
        ) : (
          <DataTable
            columns={["Order", "Date", "Items", "Amount", "Payment", "Status", "Actions"]}
            rows={rows.map((o) => [
              <Link
                to="/account/orders/$id"
                search={true}
                params={{ id: o.id }}
                className="font-semibold text-navy hover:text-gold"
              >
                {o.id}
              </Link>,
              o.date,
              `${o.items.length} item${o.items.length > 1 ? "s" : ""}`,
              inr(o.amount),
              <StatusBadge status={o.payment} />,
              <StatusBadge status={o.status} />,
              <div className="flex flex-wrap items-center gap-1.5">
                <Link to="/account/orders/$id" params={{ id: o.id }} search={true}>
                  <Button variant="outline" size="sm">
                    View
                  </Button>
                </Link>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    o.items.forEach((it) => addToCart(it.product.id, it.qty));
                    showCartNotification("Added to cart", `${o.items.length} item(s) from ${o.id}`);
                  }}
                >
                  Reorder
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!canCancelOrder(o, "customer")}
                      title={!canCancelOrder(o, "customer") && ((o.paidAmount ?? 0) > 0 || o.payment === "Paid" || o.payment === "Partially Paid")
                        ? "A verified refund must be completed before cancellation."
                        : undefined}
                    >
                      Cancel
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Cancel order {o.id}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        {canCancelOrder(o, "customer")
                          ? "This will mark the order as cancelled and restore its available inventory."
                          : o.vendorStatuses?.some((fulfillment) => !["Placed", "Payment Confirmed", "Cancelled"].includes(fulfillment.status))
                            ? "A vendor has started fulfilment. Contact support if you need help cancelling this order."
                            : "Paid orders cannot be cancelled until a verified refund is completed. Contact support if you need help."}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Back</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={async () => {
                          if (await updateOrderStatus(o.id, "Cancelled" as OrderStatus)) toast.success(`Order ${o.id} cancelled`);
                        }}
                      >
                        Confirm Cancel
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>,
            ])}
          />
        )}
        {myOrders.length > 0 && (
          <Pager page={pageSafe} pages={pages} onPage={setPage} total={filtered.length} />
        )}
      </Panel>
    </PanelLayout>
  );
}
