import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Minus, Plus, ShoppingCart } from "lucide-react";
import { toast } from "sonner";
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
  const [typedQty, setTypedQty] = useState(String(Math.max(1, initialQty)));
  const [keypadEntryStarted, setKeypadEntryStarted] = useState(false);
  const inCart = cart.find((line) => line.id === product.id)?.qty ?? 0;
  const availableStock = Math.max(0, Math.floor((Number(product.stock) || 0) - (Number(product.reserved) || 0)));
  const bagWeight = Number.parseFloat(product.weight.replace(/[^\d.]/g, "")) || 0;
  const unit = product.weight.toLowerCase().includes("kg") ? "kg" : "bags";
  const selectedWeight = bagWeight * qty;

  const handleManualQtyChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const raw = event.target.value;
    if (raw === "") {
      setKeypadEntryStarted(true);
      setTypedQty("");
      return;
    }
    if (!/^\d+$/.test(raw)) {
      return;
    }
    const num = Number(raw);
    if (!Number.isSafeInteger(num)) {
      toast.error("Enter a smaller whole number");
      return;
    }
    setKeypadEntryStarted(true);
    setTypedQty(raw);
    setQty(num);
  };

  const handleManualQtyBlur = () => {
    const num = parseInt(typedQty, 10);
    if (!typedQty || isNaN(num) || num < 1) {
      setQty(1);
      setTypedQty("1");
    } else {
      setQty(num);
      setTypedQty(String(num));
    }
    setKeypadEntryStarted(false);
  };

  const appendKeypadDigit = (digit: number) => {
    const prefix = keypadEntryStarted ? typedQty : "";
    const candidate = `${prefix}${digit}`.replace(/^0+(?=\d)/, "");
    const nextQty = Number(candidate);
    if (!Number.isSafeInteger(nextQty)) {
      toast.error("Enter a smaller whole number");
      return;
    }
    setKeypadEntryStarted(true);
    setTypedQty(candidate);
    setQty(nextQty);
  };

  if (!open) {
    return (
      <button
        type="button"
        disabled={availableStock === 0}
        onClick={() => {
          const initial = Math.max(1, initialQty);
          setQty(initial);
          setTypedQty(String(initial));
          setKeypadEntryStarted(false);
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
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => appendKeypadDigit(value)}
            aria-pressed={Number(typedQty) === value}
            className={`rounded-md border py-2 text-sm font-bold ${Number(typedQty) === value ? "border-gold bg-ivory text-navy" : "border-border text-charcoal hover:border-gold"}`}
          >
            {value}
          </button>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          aria-label="Decrease quantity"
          onClick={() => {
            const next = Math.max(1, qty - 1);
            setQty(next);
            setTypedQty(String(next));
            setKeypadEntryStarted(false);
          }}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-success text-white hover:bg-success/90"
        >
          <Minus className="h-4 w-4" />
        </button>
        <input
          aria-label="Number of bags"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          value={typedQty}
          onChange={handleManualQtyChange}
          onBlur={handleManualQtyBlur}
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              (e.target as HTMLInputElement).blur();
            }
          }}
          title={`Enter a positive whole number. ${availableStock} units are available.`}
          className="h-10 min-w-0 flex-1 rounded-md border border-border bg-background text-center font-bold text-navy focus:border-gold focus:outline-none"
        />
        <button
          type="button"
          aria-label="Increase quantity"
          onClick={() => {
            const next = Math.min(availableStock || 1, qty + 1);
            setQty(next);
            setTypedQty(String(next));
            setKeypadEntryStarted(false);
          }}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-success text-white hover:bg-success/90"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
      <p className="mt-1 text-[11px] text-slate">Tap keypad digits in sequence or type a whole number. {availableStock} units are available.</p>
      {Number(typedQty) > availableStock && (
        <p role="alert" className="mt-1 text-xs font-medium text-danger">
          Only {availableStock} units are available. Reduce the quantity to add this item to your cart.
        </p>
      )}
      <p className="mt-2 text-xs text-slate">
        {product.weight} per bag · {selectedWeight || qty} {unit} total
      </p>
      <button
        type="button"
        disabled={availableStock === 0 || !/^\d+$/.test(typedQty) || Number(typedQty) < 1 || Number(typedQty) > availableStock}
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
        className="mt-2 w-full rounded-md bg-gold py-2.5 text-sm font-bold text-midnight hover:bg-gold-light disabled:cursor-not-allowed disabled:opacity-50"
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
