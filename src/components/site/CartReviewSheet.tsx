import { useEffect, useRef, useState } from "react";
import { Minus, Plus, Trash2, X } from "lucide-react";
import { getAvailablePurchaseQuantity, inrPrecise, type Product } from "@/lib/data";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

const KEYS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0];

/**
 * Cart review before checkout: every product in a sideways strip (quantity, price, − / +), and a
 * keypad below it for typing an exact quantity for the selected product. Every change goes
 * straight into the cart, so the cart bar underneath shows the new totals as the customer edits.
 */
export function CartReviewSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { cartItems, setQty, removeFromCart } = useApp();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const stripRef = useRef<HTMLDivElement>(null);

  const selected = cartItems.find((line) => line.product.id === selectedId) ?? cartItems[0];

  useEffect(() => {
    if (!open) return;
    setSelectedId(cartItems[0]?.product.id ?? null);
    setTyped("");
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
    // Only when the sheet opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The sheet closes itself once the cart is empty.
  useEffect(() => {
    if (open && cartItems.length === 0) onClose();
  }, [open, cartItems.length, onClose]);

  if (!open || !selected) return null;

  const limitFor = (product: Product) => getAvailablePurchaseQuantity(product);
  const select = (id: string) => {
    setSelectedId(id);
    setTyped("");
  };
  const change = (product: Product, qty: number) => {
    if (qty < 1) {
      removeFromCart(product.id);
      return;
    }
    setQty(product.id, Math.min(qty, Math.max(1, limitFor(product))));
  };
  const typeDigit = (digit: number) => {
    const next = `${typed}${digit}`.replace(/^0+(?=\d)/, "");
    const qty = Number(next);
    if (!Number.isSafeInteger(qty)) return;
    setTyped(next);
    if (qty >= 1) change(selected.product, qty);
  };

  return (
    <>
      <button
        type="button"
        aria-label="Close cart review"
        onClick={onClose}
        className="fixed inset-0 z-[55] cursor-default bg-stone-900/50 backdrop-blur-[2px] animate-in fade-in-0"
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Review your cart"
        className="fixed inset-x-0 z-[56] mx-auto w-full max-w-lg px-3 animate-in slide-in-from-bottom-4 fade-in-0"
        style={{ bottom: "calc(5.25rem + env(safe-area-inset-bottom))" }}
      >
        {/* Products, side by side; scrolls sideways when there are many */}
        <div className="rounded-xl border border-gold/40 bg-card p-3 shadow-lg">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-bold text-navy">
              Review your cart · {cartItems.length} {cartItems.length === 1 ? "product" : "products"}
            </p>
            <button type="button" onClick={onClose} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-full text-stone-500 hover:bg-stone-100">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div ref={stripRef} className="-mx-1 flex snap-x snap-mandatory gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]">
            {cartItems.map(({ product, qty }) => {
              const active = product.id === selected.product.id;
              const limit = limitFor(product);
              return (
                <div
                  key={product.id}
                  role="button"
                  tabIndex={0}
                  aria-pressed={active}
                  onClick={() => select(product.id)}
                  onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") select(product.id); }}
                  className={cn(
                    "flex w-36 shrink-0 snap-start flex-col gap-1 rounded-lg border bg-background p-2 text-left transition-colors",
                    active ? "border-gold ring-2 ring-gold/40" : "border-border hover:border-gold/60",
                  )}
                >
                  <div className="flex items-start gap-1.5">
                    <img src={product.image} alt="" className="h-10 w-10 shrink-0 rounded object-contain bg-stone-50" loading="lazy" />
                    <p className="line-clamp-2 text-[11px] font-semibold leading-snug text-navy">{product.name}</p>
                  </div>
                  <p className="text-[10px] text-stone-500">{product.weight} · {inrPrecise(product.price)} each</p>
                  <p className="text-sm font-extrabold tabular-nums text-stone-900">{inrPrecise(product.price * qty)}</p>
                  <div className="flex items-center justify-between gap-1" onClick={(event) => event.stopPropagation()}>
                    <button
                      type="button"
                      aria-label={qty === 1 ? `Remove ${product.name}` : `One less ${product.name}`}
                      onClick={() => { select(product.id); change(product, qty - 1); }}
                      className="grid h-8 w-8 place-items-center rounded-md bg-success text-white hover:bg-success/90"
                    >
                      {qty === 1 ? <Trash2 className="h-3.5 w-3.5" /> : <Minus className="h-3.5 w-3.5" />}
                    </button>
                    <QtyInput
                      value={qty}
                      max={limit}
                      label={`Quantity of ${product.name}`}
                      onFocus={() => select(product.id)}
                      onCommit={(next) => change(product, next)}
                    />
                    <button
                      type="button"
                      aria-label={`One more ${product.name}`}
                      disabled={qty >= limit}
                      onClick={() => { select(product.id); change(product, qty + 1); }}
                      className="grid h-8 w-8 place-items-center rounded-md bg-success text-white hover:bg-success/90 disabled:opacity-40"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Keypad for the selected product, with a gap below the strip */}
        <div className="mt-3 rounded-xl border border-border bg-card p-3 shadow-lg">
          <p className="truncate text-xs font-semibold text-navy">
            Quantity for {selected.product.name}
          </p>
          <div className="mt-2 grid grid-cols-5 gap-1.5">
            {KEYS.map((digit) => (
              <button
                key={digit}
                type="button"
                onClick={() => typeDigit(digit)}
                className="min-h-9 rounded-md border border-border py-1.5 text-sm font-bold text-charcoal hover:border-gold"
              >
                {digit}
              </button>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setTyped("")}
              className="h-9 rounded-md border border-border px-3 text-xs font-semibold text-slate hover:border-gold"
            >
              Clear
            </button>
            <div className="h-9 flex-1 rounded-md border border-border bg-background text-center text-base font-bold leading-9 tabular-nums text-navy">
              {typed || selected.qty}
            </div>
            <span className="text-[11px] text-slate">max {limitFor(selected.product)}</span>
          </div>
        </div>
      </section>
    </>
  );
}

/**
 * A quantity box that can be typed into (digits only). A valid number is applied as it is
 * typed, capped at the product's purchase limit; leaving it blank or 0 restores the last value.
 */
function QtyInput({ value, max, label, onCommit, onFocus }: {
  value: number;
  max: number;
  label: string;
  onCommit: (qty: number) => void;
  onFocus?: () => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <input
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      aria-label={label}
      value={draft}
      onFocus={(event) => {
        onFocus?.();
        // Select after the click settles, so typing replaces the number instead of adding to it.
        const field = event.currentTarget;
        window.requestAnimationFrame(() => field.select());
      }}
      onChange={(event) => {
        const digits = event.target.value.replace(/\D/g, "").slice(0, 6);
        const next = Number(digits);
        if (!digits || next < 1) { setDraft(digits); return; }
        // Above the purchase limit: show and apply the limit at once.
        const capped = Math.min(next, Math.max(1, max));
        setDraft(String(capped));
        onCommit(capped);
      }}
      onBlur={() => {
        const next = Number(draft);
        if (!draft || next < 1) setDraft(String(value));
        else if (next > max) setDraft(String(Math.max(1, max)));
      }}
      onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
      className="h-8 w-12 rounded-md border border-border bg-background text-center text-sm font-bold tabular-nums text-navy focus:border-gold focus:outline-none focus:ring-2 focus:ring-gold/40"
    />
  );
}
