import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Minus, Plus, ShoppingCart } from "lucide-react";
import { showCartNotification } from "@/components/site/CartFloatingNotification";
import { useApp } from "@/lib/store";
import type { Product } from "@/lib/data";

export function AddToCartPicker({
  product,
  initialQty = 1,
}: {
  product: Product;
  initialQty?: number;
}) {
  const { addToCart, cart } = useApp();
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState(Math.max(1, initialQty));
  const inCart = cart.find((line) => line.id === product.id)?.qty ?? 0;
  const bagWeight = Number.parseFloat(product.weight.replace(/[^\d.]/g, "")) || 0;
  const unit = product.weight.toLowerCase().includes("kg") ? "kg" : "bags";
  const selectedWeight = bagWeight * qty;

  if (!open) {
    return (
      <button
        type="button"
        disabled={product.stock === 0}
        onClick={() => {
          setQty(Math.max(1, initialQty));
          setOpen(true);
        }}
        className="flex w-full items-center justify-center gap-1.5 rounded-md bg-navy px-3 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-midnight disabled:opacity-40"
      >
        <ShoppingCart className="h-3.5 w-3.5" /> Add to Cart
      </button>
    );
  }

  return (
    <div
      className="w-full rounded-xl border border-border bg-card p-3 shadow-card"
      aria-label={`Choose quantity for ${product.name}`}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-bold text-success">
          {inCart} {inCart === 1 ? "bag" : "bags"} in cart
        </p>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs font-semibold text-danger hover:underline"
        >
          Close
        </button>
      </div>
      <div className="mt-3 grid grid-cols-5 gap-1.5">
        {Array.from({ length: 10 }, (_, i) => i + 1).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setQty(value)}
            aria-pressed={qty === value}
            className={`rounded-md border py-2 text-sm font-bold ${qty === value ? "border-gold bg-ivory text-navy" : "border-border text-charcoal hover:border-gold"}`}
          >
            {value}
          </button>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          aria-label="Decrease quantity"
          onClick={() => setQty((value) => Math.max(1, value - 1))}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-success text-white hover:bg-success/90"
        >
          <Minus className="h-4 w-4" />
        </button>
        <input
          aria-label="Number of bags"
          type="number"
          min={1}
          max={product.stock || undefined}
          value={qty}
          onChange={(event) =>
            setQty(
              Math.max(1, Math.min(product.stock || Infinity, Number(event.target.value) || 1)),
            )
          }
          className="h-10 min-w-0 flex-1 rounded-md border border-border bg-background text-center font-bold text-navy"
        />
        <button
          type="button"
          aria-label="Increase quantity"
          onClick={() => setQty((value) => Math.min(product.stock || Infinity, value + 1))}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-success text-white hover:bg-success/90"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
      <p className="mt-2 text-xs text-slate">
        {product.weight} per bag · {selectedWeight || qty} {unit} total
      </p>
      <button
        type="button"
        onClick={() => {
          addToCart(product.id, qty);
          showCartNotification(
            "Added to cart",
            `${qty} ${qty === 1 ? "bag" : "bags"} · ${selectedWeight || qty} ${unit}`,
            "add",
            product.image,
          );
          setOpen(false);
        }}
        className="mt-2 w-full rounded-md bg-gold py-2.5 text-sm font-bold text-midnight hover:bg-gold-light"
      >
        Add {qty} {qty === 1 ? "bag" : "bags"} to cart
      </button>
      {inCart > 0 && (
        <Link
          to="/cart"
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-md bg-success py-2.5 text-sm font-bold text-white hover:bg-success/90"
        >
          <ShoppingCart className="h-4 w-4" /> Go to cart
        </Link>
      )}
    </div>
  );
}
