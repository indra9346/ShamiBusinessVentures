import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Minus, Plus, ShoppingCart } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { showCartNotification } from "@/components/site/CartFloatingNotification";
import { useApp } from "@/lib/store";
import { getAvailablePurchaseQuantity, getMaxPurchaseQuantity, type Product } from "@/lib/data";
import { setCartPreview } from "@/lib/cart-preview";
import { addedLineSplit, dayLabel, preorderBy, preorderText } from "@/lib/preorder";

export function AddToCartPicker({
  product,
  initialQty = 1,
  compact = false,
}: {
  product: Product;
  initialQty?: number;
  /**
   * Dense product-grid mode: smaller trigger, and the quantity keypad opens in a
   * centred pop-up instead of expanding inside the card (keeps every card the same height).
   */
  compact?: boolean;
}) {
  const { addToCart, cart } = useApp();
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState(Math.max(1, initialQty));
  const [typedQty, setTypedQty] = useState(String(Math.max(1, initialQty)));
  const [keypadEntryStarted, setKeypadEntryStarted] = useState(false);
  const inCart = cart.find((line) => line.id === product.id)?.qty ?? 0;
  const readyStock = Math.max(
    0,
    Math.floor((Number(product.stock) || 0) - (Number(product.reserved) || 0)),
  );
  // Pre-order units (14 Nov 2026) can be bought too, after the ready ones.
  const arriving = Math.max(0, Number(product.incoming) || 0);
  const availableStock = readyStock + arriving;
  // Of the units this adds (on top of what the cart holds already), how many are ready and how many arrive later.
  const split = addedLineSplit(inCart, qty, readyStock);
  // The date the line's arriving units reach the godown by: the lots are taken earliest first.
  const arrivingBy = dayLabel(preorderBy(product.incomingDetail, addedLineSplit(0, inCart + qty, readyStock).preorder, product.incomingBy ?? null));
  const purchaseLimit = getAvailablePurchaseQuantity(product);
  const configuredMax = getMaxPurchaseQuantity(product);
  const bagWeight = Number.parseFloat(product.weight.replace(/[^\d.]/g, "")) || 0;
  const unit = product.weight.toLowerCase().includes("kg") ? "kg" : "bags";
  const selectedWeight = bagWeight * qty;

  // While the keypad is open, the cart bar shows the cart as it will be after "Add".
  const validQty = /^\d+$/.test(typedQty) && qty >= 1 && qty <= purchaseLimit ? qty : 0;
  useEffect(() => {
    if (!open) return;
    setCartPreview(validQty > 0 ? { product, qty: validQty } : null);
  }, [open, product, validQty]);
  useEffect(() => {
    if (!open) return;
    return () => setCartPreview(null);
  }, [open]);

  useEffect(() => {
    setQty((current) => Math.min(Math.max(1, current), purchaseLimit || 1));
    setTypedQty((current) =>
      /^\d+$/.test(current)
        ? String(Math.min(Math.max(1, Number(current) || 1), purchaseLimit || 1))
        : current,
    );
    setKeypadEntryStarted(false);
  }, [purchaseLimit]);

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
      // Above the limit: quietly cap it; the note under the keypad says why.
      const clamped = Math.min(num, purchaseLimit || 1);
      setQty(clamped);
      setTypedQty(String(clamped));
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

  const trigger = (
    <button
      type="button"
      disabled={availableStock === 0}
      onClick={() => {
        const initial = Math.min(Math.max(1, initialQty), purchaseLimit || 1);
        setQty(initial);
        setTypedQty(String(initial));
        setKeypadEntryStarted(false);
        setOpen(true);
      }}
      className={
        compact
          ? "flex h-9 w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-navy px-2 text-[11px] sm:text-xs font-semibold text-white transition-colors hover:bg-midnight active:scale-[0.98] disabled:opacity-40"
          : "flex w-full items-center justify-center gap-1.5 rounded-md bg-navy px-3 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-midnight disabled:opacity-40"
      }
      aria-label={compact && inCart > 0 ? `Add · ${inCart} in cart` : undefined}
    >
      {/* Compact cards keep one line: the bags already in the cart show as a badge on the cart icon. */}
      <span className="relative shrink-0">
        <ShoppingCart className="h-3.5 w-3.5" />
        {compact && inCart > 0 && (
          <span className="absolute -top-2 -right-2.5 grid h-4 min-w-4 place-items-center rounded-full bg-gold px-1 text-[9px] font-bold leading-none text-midnight ring-1 ring-navy">
            {inCart > 99 ? "99+" : inCart}
          </span>
        )}
      </span>
      <span className={compact && inCart > 0 ? "ml-1.5" : undefined}>{compact ? "Add" : "Add to Cart"}</span>
    </button>
  );

  if (!open) return trigger;

  const panel = (
    <div
      className={
        compact ? "w-full min-w-0" : "w-full min-w-0 rounded-xl border border-border bg-card p-3 shadow-card"
      }
      aria-label={`Choose quantity for ${product.name}`}
    >
      {!compact && (
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
      )}
      <div className={compact ? "grid grid-cols-5 gap-1.5" : "mt-3 grid grid-cols-5 gap-1.5"}>
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => appendKeypadDigit(value)}
            aria-pressed={Number(typedQty) === value}
            className={`min-h-9 rounded-md border py-2 text-sm font-bold ${Number(typedQty) === value ? "border-gold bg-ivory text-navy" : "border-border text-charcoal hover:border-gold"}`}
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
          size={1}
          className="h-10 w-0 min-w-0 flex-1 rounded-md border border-border bg-background text-center font-bold text-navy focus:border-gold focus:outline-none"
        />
        <button
          type="button"
          aria-label="Increase quantity"
          disabled={qty >= purchaseLimit}
          onClick={() => {
            const next = Math.min(purchaseLimit || 1, qty + 1);
            setQty(next);
            setTypedQty(String(next));
            setKeypadEntryStarted(false);
          }}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-success text-white hover:bg-success/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
      {arriving > 0 ? (
        // Arriving units are not in the godown yet: never "in stock" (review fix).
        <p className="mt-1 text-[11px] text-slate">
          {preorderText.pickHint(purchaseLimit, configuredMax, readyStock, arriving, dayLabel(preorderBy(product.incomingDetail, arriving, product.incomingBy ?? null)))}
        </p>
      ) : (
        <p className="mt-1 text-[11px] text-slate">
          Tap keypad digits in sequence or type a whole number. Choose 1–{purchaseLimit} units
          (configured maximum {configuredMax}; {availableStock} in stock).
        </p>
      )}
      {Number(typedQty) > purchaseLimit && (
        <p role="alert" className="mt-1 text-xs font-medium text-danger">
          {purchaseLimit < availableStock
            ? `The maximum purchase for this product is ${purchaseLimit} units.`
            : arriving > 0
              ? preorderText.pickTooMany(availableStock, readyStock, arriving)
              : `Only ${availableStock} units are available in stock.`}{" "}
          Reduce the quantity to add this item to your cart.
        </p>
      )}
      <p className="mt-2 text-xs text-slate">
        {product.weight} per bag · {selectedWeight || qty} {unit} total
      </p>
      {split.preorder > 0 && arriving > 0 && (
        <p className="mt-1 text-xs font-semibold text-amber-800">
          {split.ready > 0 ? preorderText.cartSplit(split.ready, split.preorder, arrivingBy) : preorderText.allArriving(split.preorder, arrivingBy)}
        </p>
      )}
      <button
        type="button"
        disabled={
          purchaseLimit === 0 ||
          !/^\d+$/.test(typedQty) ||
          Number(typedQty) < 1 ||
          Number(typedQty) > purchaseLimit
        }
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

  if (!compact) return panel;

  return (
    <>
      {trigger}
      <Dialog open={open} onOpenChange={setOpen}>
        {/* On phones the keypad sits low, like a phone keypad, just above the live cart bar. */}
        <DialogContent className="max-w-[calc(100vw-2rem)] grid-cols-[minmax(0,1fr)] gap-3 rounded-xl p-4 max-sm:top-auto max-sm:translate-y-0 max-sm:bottom-[calc(5.25rem+env(safe-area-inset-bottom))] sm:max-w-sm sm:p-5">
          <DialogHeader className="min-w-0 space-y-0.5 pr-7 text-left">
            <DialogTitle className="line-clamp-2 text-sm font-bold leading-snug text-navy">
              {product.name}
            </DialogTitle>
            <DialogDescription className="text-xs">
              <span className="font-semibold text-success">
                {inCart} {inCart === 1 ? "bag" : "bags"} in cart
              </span>
              {" · "}
              {product.weight} per bag
            </DialogDescription>
          </DialogHeader>
          {panel}
        </DialogContent>
      </Dialog>
    </>
  );
}
