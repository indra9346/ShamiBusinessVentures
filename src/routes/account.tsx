import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  Bell,
  Gift,
  Heart,
  Package,
  ShoppingCart,
  Sparkles,
  Star,
  Truck,
  Wallet,
} from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel, StatCard, StatusBadge } from "@/components/panel/widgets";
import { accountNav } from "@/lib/account-nav";
import { inr, isStorefrontProduct, orderStages } from "@/lib/data";
import { useApp } from "@/lib/store";
import { orderBelongsToUser } from "@/lib/account-identity";
import { notificationBelongsToUser } from "@/lib/account-identity";

export const Route = createFileRoute("/account")({
  head: () => ({
    meta: [
      { title: "My Account | Shami Business Ventures" },
      {
        name: "description",
        content: "Track orders, manage addresses, reviews and invoices in your Shami account.",
      },
      { property: "og:title", content: "My Account | Shami" },
      {
        property: "og:description",
        content: "Orders, tracking, wishlist, addresses and invoices.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: Account,
});

function Account() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const {
    user,
    orders,
    addresses,
    reviews,
    wishlist,
    products,
    cartItems,
    coupons,
    notifications,
  } = useApp();
  if (pathname !== "/account" && pathname !== "/account/") {
    return <Outlet />;
  }

  const ordersList = orders.filter((order) => orderBelongsToUser(order, user));
  const active = ordersList[0];
  const stageIndex = active
    ? orderStages.indexOf(active.status as (typeof orderStages)[number])
    : -1;
  const totalSpend = ordersList.reduce((s, o) => s + o.amount, 0);
  const activeDeliveries = ordersList.filter(
    (o) => o.status !== "Delivered" && o.status !== "Cancelled",
  ).length;
  const myReviews = user
    ? reviews.filter((r) => r.customerId === user.email || r.customer === user.name)
    : reviews.slice(0, 3);
  const wishItems = products
    .filter((p) => wishlist.includes(p.id) && isStorefrontProduct(p))
    .slice(0, 4);
  const myNotifs = notifications
    .filter((n) => n.role === "customer" && notificationBelongsToUser(n, user, orders))
    .slice(0, 4);
  const recommended = products
    .filter((p) => p.tags.includes("recommended") && isStorefrontProduct(p))
    .slice(0, 4);
  const activeCoupons = coupons.filter((c) => c.status === "Active").slice(0, 3);

  return (
    <PanelLayout
      items={accountNav}
      tone="customer"
      title="My Dashboard"
      subtitle={`Welcome back, ${user?.name ?? "Guest"}`}
    >
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total Orders" value={String(ordersList.length)} icon={Package} />
        <StatCard label="Total Spend" value={inr(totalSpend)} icon={Wallet} highlight />
        <StatCard label="Active Deliveries" value={String(activeDeliveries)} icon={Truck} />
        <StatCard label="Wishlist Items" value={String(wishlist.length)} icon={Heart} />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Panel title="Recent Orders">
          {ordersList.length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-sm font-medium text-slate">You don’t have any orders yet.</p>
              <Link
                to="/shop"
                className="mt-2 inline-block text-sm font-semibold text-gold hover:underline"
              >
                Browse products
              </Link>
            </div>
          ) : (
            <DataTable
              columns={["Order", "Date", "Vendor", "Amount", "Payment", "Status", "Actions"]}
              rows={ordersList.slice(0, 6).map((o) => [
                <span className="font-semibold text-navy">{o.id}</span>,
                o.date,
                o.items[0]?.vendor ?? "—",
                inr(o.amount),
                <StatusBadge status={o.payment} />,
                <StatusBadge status={o.status} />,
                <span className="flex gap-2 text-xs font-semibold">
                  <Link
                    to="/account/orders/$id"
                    params={{ id: o.id }}
                    className="text-navy hover:text-gold"
                  >
                    View
                  </Link>
                  <Link to="/account/invoices" className="text-navy hover:text-gold">
                    Invoice
                  </Link>
                </span>,
              ])}
            />
          )}
        </Panel>

        <Panel title={active ? `Tracking ${active.id}` : "Tracking"}>
          {active ? (
            <ol className="space-y-4">
              {orderStages.map((s, i) => (
                <li key={s} className="flex gap-3">
                  <span
                    className={
                      i <= stageIndex
                        ? "mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-gold"
                        : "mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-border"
                    }
                  />
                  <div className="min-w-0">
                    <p
                      className={
                        i <= stageIndex ? "text-sm font-semibold text-navy" : "text-sm text-slate"
                      }
                    >
                      {s}
                    </p>
                    <p className="text-xs text-slate">
                      {i <= stageIndex ? active.date : "Pending"}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-slate">No active orders to track.</p>
          )}
        </Panel>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Panel
          title="Saved Addresses"
          action={
            <Link
              to="/account/addresses"
              className="text-xs font-semibold text-navy hover:text-gold"
            >
              Manage
            </Link>
          }
        >
          <div className="space-y-3">
            {addresses.length === 0 && (
              <p className="text-sm text-slate">No addresses saved yet.</p>
            )}
            {addresses.map((a) => (
              <div key={a.id} className="rounded-lg border border-border p-4">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-bold tracking-wider text-gold uppercase">{a.label}</p>
                  {a.default && <StatusBadge status="Active" />}
                </div>
                <p className="mt-1 font-semibold text-navy">
                  {a.name} · {a.phone}
                </p>
                <p className="text-sm text-slate">
                  {a.line}, {a.city}, {a.state} {a.pin}
                </p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel
          title="My Reviews"
          action={
            <Link to="/account/reviews" className="text-xs font-semibold text-navy hover:text-gold">
              View all
            </Link>
          }
        >
          <div className="space-y-4">
            {myReviews.length === 0 && (
              <p className="text-sm text-slate">You haven't written any reviews yet.</p>
            )}
            {myReviews.slice(0, 3).map((r) => (
              <div key={r.id} className="border-b border-border pb-4 last:border-0 last:pb-0">
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1 text-xs font-bold text-gold">
                    <Star className="h-3 w-3 fill-gold" /> {r.rating}
                  </span>
                  <p className="truncate font-semibold text-navy">{r.product}</p>
                </div>
                <p className="mt-1 text-sm text-charcoal">{r.body}</p>
                <p className="mt-1 text-xs text-slate">{r.date}</p>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Panel
          title="Wishlist Preview"
          action={
            <Link to="/wishlist" className="text-xs font-semibold text-navy hover:text-gold">
              View all
            </Link>
          }
        >
          {wishItems.length === 0 ? (
            <p className="text-sm text-slate">Your wishlist is empty.</p>
          ) : (
            <div className="space-y-3">
              {wishItems.map((p) => (
                <Link
                  key={p.id}
                  to="/product/$id"
                  params={{ id: p.id }}
                  className="flex items-center gap-3"
                >
                  <img src={p.image} alt={p.name} className="h-10 w-10 rounded-md object-cover" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-navy">{p.name}</p>
                    <p className="text-xs text-slate">{inr(p.price)}</p>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </Panel>

        <Panel
          title="Cart Preview"
          action={
            <Link to="/cart" className="text-xs font-semibold text-navy hover:text-gold">
              View cart
            </Link>
          }
        >
          {cartItems.length === 0 ? (
            <p className="text-sm text-slate">Your cart is empty.</p>
          ) : (
            <div className="space-y-3">
              {cartItems.slice(0, 4).map(({ product, qty }) => (
                <div key={product.id} className="flex items-center gap-3">
                  <ShoppingCart className="h-4 w-4 shrink-0 text-gold" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-navy">{product.name}</p>
                    <p className="text-xs text-slate">
                      Qty {qty} · {inr(product.price * qty)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Active Coupons">
          <div className="space-y-3">
            {activeCoupons.map((c) => (
              <div key={c.code} className="flex items-center gap-3">
                <Gift className="h-4 w-4 shrink-0 text-gold" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-navy">{c.code}</p>
                  <p className="text-xs text-slate">
                    {c.value} off · min {inr(c.min)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Panel title="Recommended for you">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {recommended.map((p) => (
              <Link
                key={p.id}
                to="/product/$id"
                params={{ id: p.id }}
                className="rounded-lg border border-border p-2 text-center hover:border-gold"
              >
                <img
                  src={p.image}
                  alt={p.name}
                  className="mx-auto h-14 w-14 rounded-md object-cover"
                />
                <p className="mt-2 line-clamp-2 text-xs font-medium text-navy">{p.name}</p>
                <p className="text-xs font-semibold text-gold">{inr(p.price)}</p>
              </Link>
            ))}
          </div>
        </Panel>

        <Panel
          title="Notifications"
          action={
            <Link
              to="/account/notifications"
              className="text-xs font-semibold text-navy hover:text-gold"
            >
              View all
            </Link>
          }
        >
          <div className="space-y-3">
            {myNotifs.length === 0 && <p className="text-sm text-slate">No notifications yet.</p>}
            {myNotifs.map((n) => (
              <div key={n.id} className="flex items-start gap-3">
                <Bell className="mt-0.5 h-4 w-4 shrink-0 text-gold" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-navy">{n.title}</p>
                  <p className="text-xs text-slate">{n.body}</p>
                  <p className="text-[11px] text-slate">{n.time}</p>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="mt-6">
        <Panel
          title="Account Information"
          action={
            <Link to="/account/profile" className="text-xs font-semibold text-navy hover:text-gold">
              Edit profile
            </Link>
          }
        >
          <dl className="grid gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-slate uppercase">Name</dt>
              <dd className="font-semibold text-navy">{user?.name ?? "Guest User"}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate uppercase">Email</dt>
              <dd className="font-semibold text-navy">{user?.email ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate uppercase">Phone</dt>
              <dd className="font-semibold text-navy">{user?.phone ?? "—"}</dd>
            </div>
          </dl>
        </Panel>
      </div>

      <div className="mt-6 rounded-lg border border-dashed border-gold/40 bg-ivory p-5 text-sm text-charcoal">
        <p className="flex items-center gap-2 font-semibold text-navy">
          <Sparkles className="h-4 w-4 text-gold" /> Tip
        </p>
        <p className="mt-1">
          Sign in with your Shami account to see your personal order history and saved details here.
        </p>
      </div>
    </PanelLayout>
  );
}
