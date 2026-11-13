import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { FileCheck2, Package } from "lucide-react";
import { toast } from "sonner";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { CancelCheckoutButton } from "@/components/site/CancelCheckoutButton";
import { CheckoutItems } from "@/components/site/CheckoutItems";
import { FilterNote, Panel, scrollToSection, StatCard, StatusBadge } from "@/components/panel/widgets";
import { ResizableTable } from "@/hooks/use-column-resize";
import { cn } from "@/lib/utils";
import { orderToneClass, TONE_CLASSES } from "@/lib/order-status-tone";
import { customerInvoiceVisible } from "@/lib/invoice-visibility";
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
import { REFUNDED_UTR_NOTE, REUSED_UTR_NOTE, UNCHECKED_UTR_NOTE, isBankMethod } from "@/lib/payment-rules";
import { useUpiPayments } from "@/lib/upi-store";
import { supabase } from "@/integrations/supabase/client";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { ReorderButton } from "@/components/site/ReorderButton";
import { SendUtrForm, UpiIdPay, UpiUtrForm } from "@/components/site/UpiIdPay";
import { BankUtrForm } from "@/components/site/BankTransferPay";
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
import { compareOrdersByDate, matchesOrderStatus, OPEN_ORDERS, orderStatusFilter } from "@/lib/panel-filters";

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
  const navigate = Route.useNavigate();
  const { user, orders, updateOrderStatus, addToCart, paymentHolds, products, refreshHeldCheckouts } = useApp();
  const unpaid = paymentHolds.filter((hold) => hold.status === AWAITING_PAYMENT);
  const now = useServerNow();
  const { submissions, settings: upiSettings } = useUpiPayments();
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

  // The cards open the list below with just those orders. resetScroll: the page stays here to scroll to the list.
  const showOrders = (next: string) => {
    setQ("");
    setStatus(next);
    setPage(1);
    void navigate({ search: next === "all" ? {} : { status: next }, resetScroll: false });
  };
  const openList = (next: string) => {
    showOrders(next);
    scrollToSection("my-orders");
  };

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
      if (sort === "date-desc") return compareOrdersByDate(a, b, true);
      if (sort === "date-asc") return compareOrdersByDate(a, b, false);
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
          <p className="mb-3 text-sm text-slate">Your order is placed as soon as we receive the payment. If it is not paid in time, it is cancelled on its own and you pay nothing.</p>
          <ul className="space-y-3">
            {unpaid.map((hold) => {
              const left = holdSecondsLeft(hold.holdUntil, now);
              const byBank = isBankMethod(hold.method);
              const utrSent = submissions.some((item) => item.orderNo === hold.orderNo && item.status === "submitted");
              const method = byBank ? `${hold.method ?? "NEFT"} bank transfer` : "UPI";
              const moneyCame = Boolean(hold.moneySeenAt);
              const state = moneyCame
                ? { tone: "bg-emerald-50 text-emerald-900", title: "Payment received", text: "Our bank shows your payment. Our team is confirming it; your order is placed as soon as they do. Please do not pay again." }
                : utrSent
                ? { tone: "bg-sky-50 text-sky-900", title: "Checking your payment", text: "We have your UTR and are matching it with our bank. Your order is placed as soon as the money shows. Nothing more to do." }
                : left === 0
                  ? { tone: "bg-slate-100 text-charcoal", title: "Time to pay is over", text: "It will be cancelled on its own and you pay nothing. If money already left your account, call us with the UTR." }
                  : byBank
                    ? { tone: "bg-amber-50 text-amber-950", title: "Waiting for your bank transfer", text: `Transfer ${inrPrecise(hold.amount)} by ${hold.method ?? "NEFT"}, then enter the UTR within ${clockText(left)}.` }
                    : { tone: "bg-amber-50 text-amber-950", title: "Waiting for your payment", text: `Pay ${inrPrecise(hold.amount)} by UPI within ${clockText(left)}.` };
              return (
                // Not paid yet: yellow, like every pending order (owner, 11 Nov 2026).
                <li key={hold.orderNo} className={cn("rounded-lg border p-3 sm:p-4", TONE_CLASSES.pending.tile)}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <CheckoutItems lines={hold.lines} products={products} className="min-w-0 flex-1" />
                    <div className="text-right">
                      <p className="text-base font-extrabold text-navy">{inrPrecise(hold.amount)}</p>
                      <p className="text-xs text-slate">{method}</p>
                    </div>
                  </div>
                  <div className={`mt-3 rounded-md px-3 py-2 text-xs ${state.tone}`}>
                    <p className="font-bold">{state.title}</p>
                    <p className="mt-0.5">{state.text}</p>
                  </div>
                  {/* Added 11 Nov 2026 (owner): pay by our UPI ID from any UPI app and send the UTR right here. */}
                  {!utrSent && !moneyCame && left > 0 && (
                    <div className="mt-3 space-y-3">
                      {!byBank && upiSettings?.vpa && (
                        <UpiIdPay orderNo={hold.orderNo} vpa={upiSettings.vpa} payeeName={upiSettings.payeeName} amount={hold.amount}
                          onKept={() => void refreshHeldCheckouts([hold.orderNo])} />
                      )}
                      {byBank
                        ? <BankUtrForm orderNo={hold.orderNo} amount={hold.amount} method={hold.method ?? "NEFT"} customer={user?.name ?? ""} submission={submissions.find((item) => item.orderNo === hold.orderNo)} />
                        : <UpiUtrForm orderNo={hold.orderNo} amount={hold.amount} customer={user?.name ?? ""} submission={submissions.find((item) => item.orderNo === hold.orderNo)} />}
                    </div>
                  )}
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                    <p className="text-[11px] text-slate">{`Order no. ${hold.orderNo}`}</p>
                    <div className="flex flex-wrap items-center gap-3">
                      {!utrSent && !moneyCame && left > 0 && <CancelCheckoutButton orderNo={hold.orderNo} byBank={byBank} small />}
                      <Link to="/account/orders/$id" params={{ id: hold.orderNo }} search={true} className="rounded-md bg-gold px-4 py-2 text-sm font-bold text-midnight hover:bg-gold-light">{utrSent || moneyCame || left === 0 ? "View details" : byBank ? "Enter UTR" : "Pay now"}</Link>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}
      {notPlaced.length > 0 && (
        <Panel title="Not placed" className="mb-6">
          <p className="mb-3 text-sm text-slate">These were not paid, so they were not placed and you owe nothing (unless a line below says otherwise). Tap Reorder to buy the same items again at today's price.</p>
          <ul className="space-y-2">
            {notPlaced.map((hold) => (
              // Never placed: red, like a cancelled order.
              <li key={hold.orderNo} className={cn("flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2.5", TONE_CLASSES.closed.tile)}>
                <div className="min-w-0">
                  <Link to="/account/orders/$id" params={{ id: hold.orderNo }} search={true} className="font-semibold text-navy hover:text-gold">{hold.orderNo}</Link>
                  <p className="text-xs text-slate">{inrPrecise(hold.amount)}</p>
                  <CheckoutItems lines={hold.lines} products={products} max={2} className="mt-1.5" />
                  {(() => {
                    // Added 12 Nov 2026 (owner): paid after the time ran out, or offline: send the UTR for an admin to check.
                    const sent = submissions.find((item) => item.orderNo === hold.orderNo);
                    if (sent?.status === "submitted") return <p className="mt-1 text-xs font-semibold text-sky-800">{`Checking UTR ${sent.utr} with our bank. If the money came, we place this order and tell you.`}</p>;
                    const settled = sent && (sent.note === REFUNDED_UTR_NOTE || REUSED_UTR_NOTE.test(sent.note ?? "") || sent.note === UNCHECKED_UTR_NOTE);
                    const recent = Date.now() - Date.parse(hold.createdAt) < 15 * 86_400_000;
                    if (settled || !recent || hold.moneySeenAt) return null;
                    return (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs font-semibold text-gold">Paid already? Send the UTR</summary>
                        <SendUtrForm className="mt-2" orderNo={hold.orderNo} defaultMethod={hold.method ?? "UPI"} title="Paid already? Send the UTR"
                          help="If you paid after the time ran out, send the UTR from your UPI app or bank. We check it with our bank, and if the money came we place this order and tell you." />
                      </details>
                    );
                  })()}
                  {submissions.some((item) => item.orderNo === hold.orderNo && item.status === "rejected" && item.note === UNCHECKED_UTR_NOTE) && (
                    <p className="mt-0.5 text-xs font-semibold text-amber-800">{`Do not pay again: send UTR ${submissions.find((item) => item.orderNo === hold.orderNo)?.utr} on the reorder, or call us.`}</p>
                  )}
                </div>
                {/* While a UTR sent after the time ran out is being checked, a reorder would ask them to pay twice. */}
                {!submissions.some((item) => item.orderNo === hold.orderNo && item.status === "submitted") && <ReorderButton lines={hold.lines} />}
              </li>
            ))}
          </ul>
        </Panel>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard onClick={() => openList("all")} label="Total Orders" value={String(myOrders.length)} icon={Package} highlight />
        <StatCard onClick={() => openList(OPEN_ORDERS)} label="Active" value={String(active)} icon={Package} />
        <StatCard onClick={() => openList("Delivered")} label="Delivered" value={String(delivered)} icon={Package} />
      </div>

      <Panel
        id="my-orders"
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
        {status !== "all" && <FilterNote label={status === OPEN_ORDERS ? "All pending" : status} onClear={() => showOrders("all")} />}
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
        ) : rows.length === 0 ? (
          <div className="grid place-items-center gap-2 py-14 text-center">
            <p className="text-sm font-semibold text-navy">No records found</p>
            <p className="text-xs text-slate">No orders match this search or filter.</p>
          </div>
        ) : (
          // Each row tinted by its status (owner, 11 Nov 2026): pending yellow, confirmed green, cancelled red.
          <div className="overflow-x-auto">
            <ResizableTable tableId="account-orders" className="w-full text-sm" style={{ minWidth: 640 }}>
              <thead>
                <tr className="border-b border-border text-left">
                  {["Order", "Date", "Items", "Amount", "Payment", "Status", "Actions"].map((column) => (
                    <th key={column} className="px-3 py-3 text-[11px] font-bold tracking-wider text-slate uppercase">{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.id} className={cn("border-b border-border/70 transition-colors last:border-0", orderToneClass(o.status, "row") || "hover:bg-ivory")}>
                    <td className="px-3 py-3.5 align-middle text-charcoal">
                      <Link
                        to="/account/orders/$id"
                        search={true}
                        params={{ id: o.id }}
                        className="font-semibold text-navy hover:text-gold"
                      >
                        {o.id}
                      </Link>
                      {/* Paid and confirmed: the invoice and its delivery QR are on the order's page. */}
                      {customerInvoiceVisible({ orderStatus: o.status, payment: o.payment }) && (
                        <Link to="/account/orders/$id" params={{ id: o.id }} search={true}
                          className={cn("mt-1 flex w-fit items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold", TONE_CLASSES.confirmed.badge)}>
                          <FileCheck2 className="h-3 w-3" />Invoice &amp; QR
                        </Link>
                      )}
                    </td>
                    <td className="px-3 py-3.5 align-middle text-charcoal">{o.date}</td>
                    <td className="px-3 py-3.5 align-middle text-charcoal">{`${o.items.length} item${o.items.length > 1 ? "s" : ""}`}</td>
                    <td className="px-3 py-3.5 align-middle text-charcoal">{inr(o.amount)}</td>
                    <td className="px-3 py-3.5 align-middle text-charcoal"><StatusBadge status={o.payment} /></td>
                    <td className="px-3 py-3.5 align-middle text-charcoal"><StatusBadge status={o.status} /></td>
                    <td className="px-3 py-3.5 align-middle text-charcoal">
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
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </ResizableTable>
          </div>
        )}
        {myOrders.length > 0 && (
          <Pager page={pageSafe} pages={pages} onPage={setPage} total={filtered.length} />
        )}
      </Panel>
    </PanelLayout>
  );
}
