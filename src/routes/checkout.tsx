import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import { Check, CreditCard } from "lucide-react";
import { toast } from "sonner";
import { SiteLayout, Breadcrumbs } from "@/components/site/SiteLayout";
import { inr } from "@/lib/data";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/checkout")({
  validateSearch: z.object({ productId: z.string().optional() }),
  head: () => ({
    meta: [
      { title: "Secure Checkout | Shami Business Ventures" },
      {
        name: "description",
        content: "Complete your order with UPI, cards, net banking or cash on delivery.",
      },
      { property: "og:title", content: "Secure Checkout | Shami" },
      {
        property: "og:description",
        content: "Address, delivery, payment and order review in one flow.",
      },
    ],
  }),
  component: Checkout,
});

const steps = ["Address", "Delivery", "Payment", "Review", "Confirmation"];
const methods = ["UPI", "Credit Card", "Debit Card", "Net Banking", "Cash on Delivery"];

function Checkout() {
  const { user, hydrated, cartItems, products, clearCart, addresses, addAddress, placeOrder, coupons } =
    useApp();
  const { productId } = Route.useSearch();
  const navigate = useNavigate();
  useEffect(() => {
    if (hydrated && !user)
      void navigate({ to: "/login", search: { next: "/checkout", productId }, replace: true });
  }, [hydrated, user, navigate, productId]);
  const [step, setStep] = useState(0);
  const [addr, setAddr] = useState(addresses[0]?.id ?? "");
  const [addressFormOpen, setAddressFormOpen] = useState(addresses.length === 0);
  const [addressForm, setAddressForm] = useState({
    label: "Home",
    name: user?.name ?? "",
    phone: user?.phone ?? "",
    line: "",
    city: "",
    state: "Karnataka",
    pin: "",
    landmark: "",
  });
  const [ship, setShip] = useState("Standard");
  const [method, setMethod] = useState("UPI");
  const [couponCode, setCouponCode] = useState("");
  const [placedId, setPlacedId] = useState<string | null>(null);
  useEffect(() => {
    if (addresses.length > 0) setAddressFormOpen(false);
    if (addr && !addresses.some((address) => address.id === addr)) {
      setAddr(addresses[0]?.id ?? "");
    } else if (!addr && addresses.length > 0) {
      setAddr(addresses[0]!.id);
    }
  }, [addresses, addr]);
  const selectedProduct = productId ? products.find((p) => p.id === productId) : undefined;
  const checkoutItems = productId
    ? cartItems.filter((line) => line.product.id === productId)
    : cartItems;
  const subtotal = checkoutItems.reduce((sum, line) => sum + line.product.price * line.qty, 0);
  const shipCost = ship === "Express" ? 650 : subtotal > 10000 ? 0 : 250;
  const tax = Math.round(subtotal * 0.05);
  const appliedCoupon = coupons.find((c) => c.code === couponCode);
  const discount = appliedCoupon
    ? Math.min(
        appliedCoupon.max,
        appliedCoupon.type === "Percentage"
          ? Math.round((subtotal * parseFloat(appliedCoupon.value)) / 100)
          : parseFloat(appliedCoupon.value.replace(/[^0-9.]/g, "")),
      )
    : 0;
  const total = subtotal + shipCost + tax - discount;

  if (!hydrated || !user) {
    return (
      <SiteLayout>
        <div className="mx-auto max-w-xl px-6 py-20 text-center">
          <h1 className="text-2xl font-bold text-navy">Sign in to continue</h1>
          <p className="mt-2 text-sm text-slate">Your cart will be saved while you sign in.</p>
          <Link
            to="/login"
            search={{ next: "/checkout", productId }}
            className="mt-5 inline-flex rounded-md bg-gold px-6 py-3 text-sm font-bold text-midnight"
          >
            Continue to login
          </Link>
        </div>
      </SiteLayout>
    );
  }

  const goNext = () => {
    if (step === 0 && !addr) {
      toast.error("Please select or add a delivery address");
      return;
    }
    if (step === 3) {
      if (checkoutItems.length === 0) {
        toast.error("Your cart is empty");
        return;
      }
      const order = placeOrder({
        lines: checkoutItems,
        method,
        payment: method === "Cash on Delivery" ? "COD" : "Paid",
        ...(appliedCoupon ? { coupon: appliedCoupon.code } : {}),
      });
      clearCart();
      setPlacedId(order.id);
      toast.success("Order placed", { description: `${order.id} confirmed` });
      setStep(step + 1);
      return;
    }
    setStep(step + 1);
  };

  const saveAddress = () => {
    const phoneDigits = addressForm.phone.replace(/\D/g, "");
    if (
      !addressForm.name.trim() ||
      phoneDigits.length < 10 ||
      !addressForm.line.trim() ||
      !addressForm.city.trim() ||
      !/^\d{6}$/.test(addressForm.pin.trim())
    ) {
      toast.error("Enter your name, valid phone, full address, city and 6-digit PIN code");
      return;
    }
    const id = `A${Date.now()}`;
    addAddress({
      id,
      label: addressForm.label.trim() || "Delivery",
      name: addressForm.name.trim(),
      phone: addressForm.phone.trim(),
      line: addressForm.line.trim(),
      city: addressForm.city.trim(),
      state: addressForm.state.trim(),
      pin: addressForm.pin.trim(),
      landmark: addressForm.landmark.trim(),
      default: addresses.length === 0,
    });
    setAddr(id);
    setAddressFormOpen(false);
    toast.success("Delivery address saved");
  };

  const selectedAddress = addresses.find((a) => a.id === addr);

  return (
    <SiteLayout>
      <div className="border-b border-border bg-ivory">
        <div className="mx-auto max-w-7xl px-6 py-8">
          <Breadcrumbs items={[{ label: "Cart", to: "/cart" }, { label: "Checkout" }]} />
          <h1 className="mt-3 text-3xl font-bold text-navy">
            {selectedProduct ? `${selectedProduct.name} — CHECKOUT` : "Checkout"}
          </h1>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-6 py-10">
        <ol className="mb-10 flex flex-wrap gap-x-6 gap-y-3">
          {steps.map((s, i) => (
            <li key={s} className="flex items-center gap-2 text-sm">
              <span
                className={cn(
                  "grid h-7 w-7 place-items-center rounded-full text-xs font-bold",
                  i < step
                    ? "bg-gold text-midnight"
                    : i === step
                      ? "bg-navy text-white"
                      : "bg-muted text-slate",
                )}
              >
                {i < step ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <span className={cn("font-semibold", i === step ? "text-navy" : "text-slate")}>
                {s}
              </span>
            </li>
          ))}
        </ol>

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="rounded-lg border border-border bg-card p-6 shadow-card">
            {step === 0 && (
              <>
                <h2 className="text-lg font-bold text-navy">Delivery Address</h2>
                <div className="mt-5 space-y-3">
                  {addresses.length === 0 && !addressFormOpen && (
                    <p className="rounded-lg border border-dashed border-border p-4 text-sm text-slate">
                      You have no saved delivery addresses. Add your address to continue.
                    </p>
                  )}
                  {addresses.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => setAddr(a.id)}
                      className={cn(
                        "w-full rounded-lg border p-4 text-left transition-colors",
                        addr === a.id ? "border-gold bg-ivory" : "border-border hover:border-gold",
                      )}
                    >
                      <p className="text-xs font-bold tracking-wider text-gold uppercase">
                        {a.label}
                      </p>
                      <p className="mt-1 font-semibold text-navy">
                        {a.name} · {a.phone}
                      </p>
                      <p className="text-sm text-slate">
                        {a.line}, {a.city}, {a.state} {a.pin} ({a.landmark})
                      </p>
                    </button>
                  ))}
                  {!addressFormOpen && (
                    <button type="button" onClick={() => setAddressFormOpen(true)} className="text-sm font-semibold text-navy hover:text-gold">
                      + Add new address
                    </button>
                  )}
                  {addressFormOpen && (
                    <div className="rounded-lg border border-border bg-ivory p-4">
                      <h3 className="font-semibold text-navy">Add your delivery address</h3>
                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        {([
                          ["label", "Address label (Home, Shop, etc.)"],
                          ["name", "Recipient name *"],
                          ["phone", "Phone number *"],
                          ["line", "Street / building address *"],
                          ["city", "City *"],
                          ["state", "State"],
                          ["pin", "6-digit PIN code *"],
                          ["landmark", "Landmark (optional)"],
                        ] as const).map(([key, label]) => (
                          <label key={key} className="text-xs font-medium text-slate">
                            {label}
                            <input
                              value={addressForm[key]}
                              onChange={(event) => setAddressForm((form) => ({ ...form, [key]: event.target.value }))}
                              inputMode={key === "phone" || key === "pin" ? "numeric" : undefined}
                              maxLength={key === "pin" ? 6 : undefined}
                              className="mt-1 h-10 w-full rounded-md border border-border bg-card px-3 text-sm text-navy outline-none focus:border-gold"
                            />
                          </label>
                        ))}
                      </div>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <button type="button" onClick={saveAddress} className="rounded-md bg-navy px-4 py-2 text-sm font-semibold text-white">Save address</button>
                        {addresses.length > 0 && (
                          <button type="button" onClick={() => setAddressFormOpen(false)} className="rounded-md border border-border px-4 py-2 text-sm font-semibold text-navy">Cancel</button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}

            {step === 1 && (
              <>
                <h2 className="text-lg font-bold text-navy">Delivery Option</h2>
                <div className="mt-5 space-y-3">
                  {[
                    ["Standard", "2–4 business days", subtotal > 10000 ? "Free" : inr(250)],
                    ["Express", "Next business day", inr(650)],
                  ].map(([name, desc, cost]) => (
                    <button
                      key={name}
                      onClick={() => setShip(name!)}
                      className={cn(
                        "flex w-full items-center justify-between rounded-lg border p-4 text-left",
                        ship === name ? "border-gold bg-ivory" : "border-border hover:border-gold",
                      )}
                    >
                      <span>
                        <span className="block font-semibold text-navy">{name} Freight</span>
                        <span className="text-sm text-slate">{desc}</span>
                      </span>
                      <span className="font-bold text-gold">{cost}</span>
                    </button>
                  ))}
                </div>
              </>
            )}

            {step === 2 && (
              <>
                <h2 className="text-lg font-bold text-navy">Payment Method</h2>
                <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  {methods.map((m) => (
                    <button
                      key={m}
                      onClick={() => setMethod(m)}
                      className={cn(
                        "flex items-center gap-3 rounded-lg border p-4 text-sm font-semibold",
                        method === m
                          ? "border-gold bg-ivory text-navy"
                          : "border-border text-slate hover:border-gold",
                      )}
                    >
                      <CreditCard className="h-4 w-4 text-gold" /> {m}
                    </button>
                  ))}
                </div>
                <div className="mt-5">
                  <label className="mb-1.5 block text-xs font-semibold text-charcoal">
                    Have a coupon?
                  </label>
                  <input
                    value={couponCode}
                    onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
                    placeholder="Coupon code (optional)"
                    className="h-10 w-full max-w-xs rounded-md border border-border px-3 text-sm"
                  />
                </div>
              </>
            )}

            {step === 3 && (
              <>
                <h2 className="text-lg font-bold text-navy">Order Review</h2>
                <div className="mt-5 space-y-3">
                  {cartItems.map(({ product, qty }) => (
                    <div
                      key={product.id}
                      className="flex items-center gap-3 border-b border-border pb-3 last:border-0"
                    >
                      <img
                        src={product.image}
                        alt={product.name}
                        loading="lazy"
                        width={800}
                        height={800}
                        className="h-14 w-14 rounded-md object-cover"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-navy">{product.name}</p>
                        <p className="text-xs text-slate">
                          {product.vendor} · Qty {qty}
                        </p>
                      </div>
                      <p className="font-semibold text-navy">{inr(product.price * qty)}</p>
                    </div>
                  ))}
                </div>
                <dl className="mt-5 space-y-1.5 text-sm text-slate">
                  <div>Address: {selectedAddress?.line}</div>
                  <div>Delivery: {ship} Freight</div>
                  <div>Payment: {method}</div>
                  {appliedCoupon && <div>Coupon: {appliedCoupon.code}</div>}
                </dl>
              </>
            )}

            {step === 4 && (
              <div className="py-6 text-center">
                <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-success/10 text-success">
                  <Check className="h-7 w-7" />
                </span>
                <h2 className="mt-5 text-xl font-bold text-navy">Order Confirmed</h2>
                <p className="mt-2 text-sm text-slate">
                  Order ID <span className="font-bold text-gold">{placedId}</span> · Payment{" "}
                  {method === "Cash on Delivery" ? "pending (COD)" : "successful"} · Estimated
                  delivery in {ship === "Express" ? "1 day" : "2–4 days"}
                </p>
                <div className="mt-6 flex flex-wrap justify-center gap-3">
                  {placedId && (
                    <Link
                      to="/account/orders/$id"
                      params={{ id: placedId }}
                      className="rounded-md bg-navy px-6 py-3 text-sm font-semibold text-white hover:bg-midnight"
                    >
                      View Order
                    </Link>
                  )}
                  <Link
                    to="/shop"
                    className="rounded-md border border-navy px-6 py-3 text-sm font-semibold text-navy hover:bg-navy hover:text-white"
                  >
                    Continue Shopping
                  </Link>
                </div>
              </div>
            )}

            {step < 4 && (
              <div className="mt-8 flex justify-between">
                <button
                  onClick={() => setStep(Math.max(0, step - 1))}
                  className="rounded-md border border-navy px-5 py-2.5 text-sm font-semibold text-navy transition-colors hover:bg-navy hover:text-white"
                >
                  Back
                </button>
                <button
                  onClick={goNext}
                  className="rounded-md bg-gold px-6 py-2.5 text-sm font-bold text-midnight transition-colors hover:bg-gold-light"
                >
                  {step === 3 ? "Place Order" : "Continue"}
                </button>
              </div>
            )}
          </div>

          <aside className="h-max rounded-lg border border-border bg-card p-6 shadow-card">
            <h2 className="text-sm font-bold tracking-wide text-navy uppercase">Summary</h2>
            <div className="mt-4 space-y-2.5 text-sm">
              {[
                ["Subtotal", inr(subtotal)],
                ["Delivery", shipCost === 0 ? "Free" : inr(shipCost)],
                ["GST (5%)", inr(tax)],
                ...(discount > 0 ? [["Coupon discount", `- ${inr(discount)}`]] : []),
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between">
                  <span className="text-slate">{k}</span>
                  <span className="font-semibold text-navy">{v}</span>
                </div>
              ))}
              <div className="hairline-gold my-2" />
              <div className="flex justify-between text-base font-bold text-navy">
                <span>Total</span>
                <span>{inr(total)}</span>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </SiteLayout>
  );
}
