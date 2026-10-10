import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Package } from "lucide-react";
import { toast } from "sonner";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel, StatCard, StatusBadge } from "@/components/panel/widgets";
import { Pager } from "@/components/panel/pager";
import { accountNav } from "@/lib/account-nav";
import { canCancelOrder, inr, orderStages, type OrderStatus } from "@/lib/data";
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

export const Route = createFileRoute("/account/orders")({
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search["q"] === "string" ? { q: search["q"] } : {}),
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
  const { user, orders, updateOrderStatus, addToCart } = useApp();
  const [q, setQ] = useState(routeSearch.q ?? "");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState("date-desc");
  const [page, setPage] = useState(1);

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
      const matchesStatus = status === "all" || o.status === status;
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
                <Link to="/account/orders/$id" params={{ id: o.id }}>
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
