import { createFileRoute, Link } from "@tanstack/react-router";
import { Minus, Plus, ShoppingBag, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { SiteLayout, Breadcrumbs } from "@/components/site/SiteLayout";
import { inr, type Product } from "@/lib/data";
import { useApp } from "@/lib/store";
import { Input } from "@/components/ui/input";
import { showCartNotification } from "@/components/site/CartFloatingNotification";

export const Route = createFileRoute("/cart")({
  head: () => ({
    meta: [
      { title: "Your Cart | Shami Business Ventures" },
      { name: "description", content: "Review your sugar and grocery cart, apply coupons and proceed to checkout." },
      { property: "og:title", content: "Your Cart | Shami" },
      { property: "og:description", content: "Review items, apply coupons and checkout securely." },
    ],
  }),
  component: Cart,
});

function Cart() {
  const { cartItems, setQty, removeFromCart, subtotal, coupons, clearCart } = useApp();
  const [coupon, setCoupon] = useState("");
  const [applied, setApplied] = useState<string | null>(null);
  const delivery = subtotal > 10000 || subtotal === 0 ? 0 : 250;
  const tax = Math.round(subtotal * 0.05);
  const appliedCoupon = applied ? coupons.find((c) => c.code === applied) : undefined;
  const discount = appliedCoupon
    ? Math.min(appliedCoupon.max, appliedCoupon.type === "Percentage" ? Math.round((subtotal * parseFloat(appliedCoupon.value)) / 100) : parseFloat(appliedCoupon.value.replace(/[^0-9.]/g, "")))
    : 0;
  const total = subtotal + delivery + tax - discount;

  const applyCoupon = () => {
    const code = coupon.trim().toUpperCase();
    const found = coupons.find((c) => c.code === code);
    if (!found) {
      toast.error("Invalid coupon code");
      return;
    }
    if (found.status !== "Active") {
      toast.error(`Coupon ${code} is ${found.status.toLowerCase()}`);
      return;
    }
    if (subtotal < found.min) {
      toast.error(`Minimum order value of ${inr(found.min)} required for ${code}`);
      return;
    }
    setApplied(code);
    toast.success("Coupon applied", { description: `${code} — ${found.value} off` });
  };

  return (
    <SiteLayout>
      <div className="border-b border-border bg-ivory">
        <div className="mx-auto max-w-7xl px-6 py-8">
          <Breadcrumbs items={[{ label: "Cart" }]} />
          <h1 className="mt-3 text-3xl font-bold text-navy">Shopping Cart</h1>
        </div>
      </div>

      {cartItems.length === 0 ? (
        <div className="mx-auto grid max-w-md place-items-center gap-3 px-6 py-24 text-center">
          <ShoppingBag className="h-10 w-10 text-gold" />
          <p className="text-lg font-bold text-navy">Your cart is empty</p>
          <p className="text-sm text-slate">Browse the catalogue and add sugar, rice, oils or pulses.</p>
          <Link to="/shop" className="mt-3 rounded-md bg-navy px-6 py-3 text-sm font-semibold text-white hover:bg-midnight">
            Continue Shopping
          </Link>
        </div>
      ) : (
        <div className="mx-auto grid max-w-7xl gap-8 px-6 py-10 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-4">
            {cartItems.map(({ product, qty }) => (
              <div key={product.id} className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 shadow-card sm:flex-row">
                <img src={product.image} alt={product.name} loading="lazy" width={800} height={800} className="h-24 w-24 shrink-0 rounded-md object-cover" />
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] tracking-wider text-slate uppercase">{product.vendor}</p>
                  <Link to="/product/$id" params={{ id: product.id }} className="font-semibold text-navy hover:text-gold">
                    {product.name}
                  </Link>
                  <p className="mt-1 text-xs text-slate">
                    {product.weight} · MRP <span className="line-through">{inr(product.mrp)}</span> ·{" "}
                    <span className="font-semibold text-gold">Save {inr(product.mrp - product.price)}</span>
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <CartQuantityControl
                      product={product}
                      qty={qty}
                      onUpdateQty={(newQty) => setQty(product.id, newQty)}
                    />
                    <button
                      onClick={() => {
                        removeFromCart(product.id);
                        showCartNotification("Item removed", product.name, "remove", product.image);
                      }}
                      className="flex items-center gap-1.5 text-xs font-semibold text-danger hover:underline"
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Remove
                    </button>
                  </div>
                </div>
                <p className="text-lg font-bold text-navy">{inr(product.price * qty)}</p>
              </div>
            ))}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Link to="/shop" className="inline-block text-sm font-semibold text-navy hover:text-gold">
                ← Continue shopping
              </Link>
              <button
                onClick={() => {
                  clearCart();
                  showCartNotification("Cart cleared", undefined, "remove");
                }}
                className="text-sm font-semibold text-danger hover:underline"
              >
                Clear cart
              </button>
            </div>
          </div>

          <aside className="h-max rounded-lg border border-border bg-card p-6 shadow-card lg:sticky lg:top-40">
            <h2 className="text-sm font-bold tracking-wide text-navy uppercase">Order Summary</h2>
            <div className="mt-5 space-y-3 text-sm">
              <Row label="Subtotal" value={inr(subtotal)} />
              <Row label="Delivery charges" value={delivery === 0 ? "Free" : inr(delivery)} />
              <Row label="GST (5%)" value={inr(tax)} />
              {discount > 0 && <Row label={`Coupon discount (${applied})`} value={`- ${inr(discount)}`} gold />}
              <div className="hairline-gold my-2" />
              <div className="flex justify-between text-base font-bold text-navy">
                <span>Grand total</span>
                <span>{inr(total)}</span>
              </div>
            </div>

            <div className="mt-5 flex gap-2">
              <Input value={coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase())} placeholder="Coupon code" className="h-10" />
              <button
                onClick={applyCoupon}
                className="rounded-md bg-navy px-4 text-xs font-semibold text-white hover:bg-midnight"
              >
                Apply
              </button>
            </div>

            <Link
              to="/checkout"
              className="mt-5 block rounded-md bg-gold py-3.5 text-center text-sm font-bold text-midnight transition-colors hover:bg-gold-light"
            >
              Proceed to Checkout
            </Link>
          </aside>
        </div>
      )}
    </SiteLayout>
  );
}

function Row({ label, value, gold }: { label: string; value: string; gold?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="text-slate">{label}</span>
      <span className={gold ? "font-semibold text-gold" : "font-semibold text-navy"}>{value}</span>
    </div>
  );
}

function CartQuantityControl({
  product,
  qty,
  onUpdateQty,
}: {
  product: Product;
  qty: number;
  onUpdateQty: (newQty: number) => void;
}) {
  const [val, setVal] = useState(String(qty));

  useEffect(() => {
    setVal(String(qty));
  }, [qty]);

  const commitValue = (valueToCommit: string) => {
    const digitsOnly = valueToCommit.replace(/\D/g, "");
    const parsed = parseInt(digitsOnly, 10);

    if (isNaN(parsed) || parsed < 1) {
      toast.info("Minimum quantity is 1");
      setVal("1");
      onUpdateQty(1);
      return;
    }

    if (product.stock && parsed > product.stock) {
      toast.error(`Only ${product.stock} units available in stock`);
      setVal(String(product.stock));
      onUpdateQty(product.stock);
      return;
    }

    setVal(String(parsed));
    onUpdateQty(parsed);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    if (raw === "") {
      setVal("");
      return;
    }
    const digitsOnly = raw.replace(/\D/g, "");
    if (!digitsOnly) {
      setVal("");
      return;
    }

    const num = parseInt(digitsOnly, 10);
    if (product.stock && num > product.stock) {
      toast.error(`Only ${product.stock} units available in stock`);
      setVal(String(product.stock));
      onUpdateQty(product.stock);
      return;
    }

    setVal(digitsOnly);
    if (num > 0) {
      onUpdateQty(num);
    }
  };

  const handleBlur = () => {
    commitValue(val);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.currentTarget.blur();
    }
  };

  const handleDecrease = () => {
    if (qty <= 1) {
      toast.info("Minimum quantity is 1");
      return;
    }
    const next = qty - 1;
    setVal(String(next));
    onUpdateQty(next);
  };

  const handleIncrease = () => {
    if (product.stock && qty >= product.stock) {
      toast.error(`Maximum available stock is ${product.stock}`);
      return;
    }
    const next = qty + 1;
    setVal(String(next));
    onUpdateQty(next);
  };

  return (
    <div className="flex items-center rounded-md border border-border bg-card shadow-xs">
      <button
        type="button"
        onClick={handleDecrease}
        disabled={qty <= 1}
        className="p-2 text-navy hover:text-gold transition-colors disabled:cursor-not-allowed disabled:opacity-40"
        aria-label={`Decrease quantity of ${product.name}`}
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        value={val}
        onChange={handleInputChange}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        className="h-8 w-12 border-x border-border bg-transparent text-center text-sm font-semibold text-navy focus:bg-white focus:outline-none focus:ring-1 focus:ring-gold"
        aria-label={`Quantity for ${product.name}`}
      />
      <button
        type="button"
        onClick={handleIncrease}
        disabled={!!product.stock && qty >= product.stock}
        className="p-2 text-navy hover:text-gold transition-colors disabled:cursor-not-allowed disabled:opacity-40"
        aria-label={`Increase quantity of ${product.name}`}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

