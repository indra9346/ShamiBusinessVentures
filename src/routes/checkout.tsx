import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { pageHead, SITE_NAME } from "@/lib/seo";
import { useEffect, useState } from "react";
import { z } from "zod";
import { Check, CreditCard } from "lucide-react";
import { toast } from "sonner";
import { SiteLayout, Breadcrumbs } from "@/components/site/SiteLayout";
import { inr, inrPrecise } from "@/lib/data";
import { couponDiscount, lineGst } from "@/lib/pricing";
import { useApp } from "@/lib/store";
import { PickupPointCard } from "@/components/site/PickupPointCard";
import { usePickupSettings } from "@/lib/pickup-points";
import { branchDeliveryFee, branchForPin, defaultBranchOf, useBranches, useShopperPin } from "@/lib/branches";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { UseMyLocationButton, type CapturedLocation } from "@/components/site/UseMyLocationButton";
import { PickContactButton } from "@/components/site/PickContactButton";
import { HeldCheckoutPay } from "@/components/site/HeldCheckoutPay";
import { NotInYourArea } from "@/components/site/NotInYourArea";
import { isOutsideServiceArea } from "@/lib/godown-rules";
import { useUpiPayments } from "@/lib/upi-store";
import { settingsProblem } from "@/lib/upi-pay";
import { businessDetailsProblem, normaliseGstin } from "@/lib/gstin";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";

const ADDRESS_AUTOCOMPLETE: Record<string, string> = {
  label: "off", name: "name", phone: "tel-national", line: "street-address",
  city: "address-level2", state: "address-level1", pin: "postal-code", landmark: "off",
};

export const Route = createFileRoute("/checkout")({
  validateSearch: z.object({ productId: z.string().optional(), coupon: z.string().optional() }),
  head: () => pageHead({ title: `Secure Checkout | ${SITE_NAME}`, description: "Choose your address, delivery and payment, and place your order.", path: "/checkout", noindex: true }),
  component: Checkout,
});

const steps = ["Address", "Delivery", "Payment", "Review", "Pay"];
const methods = ["UPI", "Credit Card", "Debit Card", "Net Banking"];
const defaultShipping = { freeAbove: 10000, standard: 250, express: 650 };

function Checkout() {
  const {
    user,
    hydrated,
    authReady,
    cart,
    cartItems,
    products,
    productCatalogStatus,
    clearCart,
    removeFromCart,
    addresses,
    addAddress,
    placeOrder,
    coupons,
    orders,
  } = useApp();
  const { productId, coupon: cartCoupon } = Route.useSearch();
  const navigate = useNavigate();
  useEffect(() => {
    // Wait until the saved sign-in has been read, or a refresh would bounce signed-in customers.
    if (hydrated && authReady && !user)
      void navigate({ to: "/login", search: { next: "/checkout", productId }, replace: true });
  }, [hydrated, authReady, user, navigate, productId]);
  const [step, setStep] = useState(0);
  const [addr, setAddr] = useState(addresses[0]?.id ?? "");
  // The customer's default address is used automatically; the list and form open only on request.
  const [changingAddress, setChangingAddress] = useState(false);
  const [addressFormOpen, setAddressFormOpen] = useState(addresses.length === 0);
  useEffect(() => {
    if (!addr && addresses.length > 0)
      setAddr(addresses.find((address) => address.default)?.id ?? addresses[0]!.id);
    if (addresses.length > 0) setAddressFormOpen(false);
  }, [addresses, addr]);
  const [addressPoint, setAddressPoint] = useState<{ latitude: number; longitude: number; locationAccuracy: number; locatedAt: string } | null>(null);
  const fillFromLocation = (location: CapturedLocation) => {
    setAddressForm((f) => ({
      ...f,
      line: location.line || f.line,
      city: location.city || f.city,
      state: location.state || f.state,
      pin: location.pin || f.pin,
      landmark: location.landmark || f.landmark,
    }));
    setAddressPoint({ latitude: location.latitude, longitude: location.longitude, locationAccuracy: location.accuracy, locatedAt: location.capturedAt });
  };
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
  useEffect(() => {
    if (user?.name || user?.phone) {
      setAddressForm((prev) => ({
        ...prev,
        name: prev.name || user.name || "",
        phone: prev.phone || user.phone || "",
      }));
    }
  }, [user?.name, user?.phone]);
  const [ship, setShip] = useState<"Pickup" | "Delivery">("Pickup");
  const [method, setMethod] = useState("UPI");
  // A coupon applied on the cart page carries over.
  const [couponCode, setCouponCode] = useState(cartCoupon?.trim().toUpperCase() ?? "");
  // Buying for a business (B2B): GSTIN + legal name go on the order, its Zoho invoice and the e-invoice.
  const [isBusiness, setIsBusiness] = useState(false);
  const [bizGstin, setBizGstin] = useState("");
  const [bizName, setBizName] = useState("");
  const [bizTouched, setBizTouched] = useState(false);
  useEffect(() => {
    // A customer who bought for their business before gets their GSTIN and legal name filled in.
    if (STATIC_DATA_MODE || !user?.id) return;
    let active = true;
    void supabase.from("profiles").select("gstin,company").eq("id", user.id).maybeSingle().then(({ data }) => {
      if (!active || !data?.gstin) return;
      setBizGstin(data.gstin);
      setBizName(data.company ?? "");
      setIsBusiness(true);
    });
    return () => { active = false; };
  }, [user?.id]);
  const [placedId, setPlacedId] = useState<string | null>(null);
  const [placedOrders, setPlacedOrders] = useState<{ id: string; amount: number; holdUntil: string | null }[]>([]);
  // Every held checkout from this visit has been paid and is now an order.
  const allPaid = placedOrders.length > 0 && placedOrders.every((placed) => orders.some((order) => order.id === placed.id));
  // Direct UPI to the company's own account (no gateway fee), when the admin has switched it on.
  const { settings: upiSettings } = useUpiPayments();
  const directUpi = upiSettings && upiSettings.enabled && !settingsProblem(upiSettings) ? upiSettings : null;
  const [savingAddress, setSavingAddress] = useState(false);
  const [placingOrder, setPlacingOrder] = useState(false);
  const [confirmationSummary, setConfirmationSummary] = useState<{
    subtotal: number;
    shipCost: number;
    tax: number;
    discount: number;
    total: number;
  } | null>(null);
  const [shippingRates, setShippingRates] = useState(defaultShipping);
  const [shippingRatesReady, setShippingRatesReady] = useState(false);
  useEffect(() => {
    let active = true;
    void supabase
      .from("settings")
      .select("value")
      .eq("key", "shipping")
      .eq("is_public", true)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!active) return;
        if (error) {
          setShippingRatesReady(false);
          console.error("Could not load checkout shipping rules", error.message);
          return;
        }
        const value =
          data?.value && typeof data.value === "object" && !Array.isArray(data.value)
            ? (data.value as Record<string, unknown>)
            : {};
        const numberOrDefault = (candidate: unknown, fallback: number) => {
          const parsed = Number(candidate);
          return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
        };
        setShippingRates({
          freeAbove: numberOrDefault(value["free_above"], defaultShipping.freeAbove),
          standard: numberOrDefault(value["standard"], defaultShipping.standard),
          express: numberOrDefault(value["express"], defaultShipping.express),
        });
        setShippingRatesReady(true);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (addresses.length > 0) setAddressFormOpen(false);
    if (addr && !addresses.some((address) => address.id === addr)) {
      setAddr(addresses[0]?.id ?? "");
    } else if (!addr && addresses.length > 0) {
      setAddr(addresses[0]!.id);
    }
  }, [addresses, addr]);
  useEffect(() => {
    if (user?.name || user?.phone) {
      setAddressForm((current) => ({
        ...current,
        name: current.name || user.name || "",
        phone: current.phone || user.phone || "",
      }));
    }
  }, [user?.name, user?.phone]);
  const selectedProduct = productId ? products.find((p) => p.id === productId) : undefined;
  const checkoutItems = productId
    ? cartItems.some((line) => line.product.id === productId)
      ? cartItems.filter((line) => line.product.id === productId)
      : selectedProduct
        ? [{ product: selectedProduct, qty: 1 }]
        : []
    : cartItems;
  const unresolvedCartLines = cartItems.length < cart.length;
  const subtotal = checkoutItems.reduce((sum, line) => sum + line.product.price * line.qty, 0);
  // Pickup or home delivery, as the customer's godown offers (same rules as the database):
  // pickup is free; delivery uses the godown's charge, free above its threshold.
  const { homeDelivery } = usePickupSettings();
  const { branches, features } = useBranches();
  const addressPin = addresses.find((a) => a.id === addr)?.pin ?? "";
  const fulfilBranch = features.branchRouting ? branchForPin(branches, addressPin) : defaultBranchOf(branches);
  // The order is priced by the godown serving the delivery address, as the database does: keep the
  // shopper's "Delivering to" PIN on that address so the prices shown are the prices charged.
  const [shopperPin, setShopperPin] = useShopperPin();
  useEffect(() => {
    if (!features.branchRouting || !/^\d{6}$/.test(addressPin) || addressPin === shopperPin) return;
    const before = branchForPin(branches, shopperPin || ((addresses.find((a) => a.default) ?? addresses[0])?.pin ?? ""));
    setShopperPin(addressPin);
    if (before && fulfilBranch && before.id !== fulfilBranch.id) {
      toast.info(`Prices updated for the ${fulfilBranch.city || fulfilBranch.name} godown`, { description: "It serves your delivery address." });
    }
  }, [features.branchRouting, addressPin, shopperPin, setShopperPin, branches, fulfilBranch, addresses]);
  const canPickup = fulfilBranch ? fulfilBranch.pickupEnabled : true;
  const canDeliver = fulfilBranch ? fulfilBranch.deliveryEnabled : homeDelivery;
  const fulfil: "Pickup" | "Delivery" = ship === "Delivery" && canDeliver ? "Delivery" : canPickup ? "Pickup" : "Delivery";
  const deliveryFee = branchDeliveryFee(fulfilBranch, subtotal);
  const shipCost = fulfil === "Delivery" ? deliveryFee : 0;

  // Marketplace ON: items fulfilled from different points (a vendor's own place, a godown) are
  // placed as separate orders, one per point, like separate shipments.
  const [vendorPoints, setVendorPoints] = useState<Record<string, string | null>>({});
  useEffect(() => {
    if (!features.marketplaceVendors) return;
    const vendorIds = [...new Set(checkoutItems.map((line) => line.product.vendorId).filter(Boolean))]
      .filter((id) => !(id in vendorPoints));
    if (!vendorIds.length) return;
    void Promise.all(vendorIds.map(async (id) => {
      const { data } = await supabase.rpc("vendor_fulfilment_branch", { _vendor_id: id });
      return [id, data ?? null] as const;
    })).then((entries) => setVendorPoints((current) => ({ ...current, ...Object.fromEntries(entries) })));
  }, [features.marketplaceVendors, checkoutItems, vendorPoints]);
  const orderGroups = features.marketplaceVendors
    ? Object.values(checkoutItems.reduce<Record<string, { point: string | null; lines: typeof checkoutItems }>>((groups, line) => {
      const point = vendorPoints[line.product.vendorId] ?? null;
      const key = point ?? "grain-bazar";
      (groups[key] ??= { point, lines: [] }).lines.push(line);
      return groups;
    }, {}))
    : [{ point: null, lines: checkoutItems }];
  const tax = checkoutItems.reduce(
    (sum, line) => sum + lineGst(line.product.price, line.qty, line.product.gst),
    0,
  );
  // A coupon applies to a single order; checkout does not send it when the cart splits.
  const appliedCoupon = orderGroups.length > 1 ? undefined : coupons.find(
    (c) =>
      c.code === couponCode &&
      c.status === "Active" &&
      subtotal >= c.min &&
      (!c.maxPerUser ||
        orders.filter((order) => order.coupon === c.code && order.status !== "Cancelled").length <
          c.maxPerUser),
  );
  const discount = appliedCoupon ? couponDiscount(appliedCoupon, subtotal) : 0;
  const total = subtotal + shipCost + tax - discount;
  const summary = confirmationSummary ?? { subtotal, shipCost, tax, discount, total };

  if (!hydrated || !authReady) {
    return (
      <SiteLayout>
        <div className="mx-auto max-w-xl px-6 py-20 text-center text-sm text-slate">Checking your sign-in…</div>
      </SiteLayout>
    );
  }
  if (!user) {
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

  const goNext = async () => {
    if (productCatalogStatus !== "ready" || unresolvedCartLines) {
      toast.error(
        "Some items in your cart are not sold at your godown or are no longer available. Remove them in the cart to continue.",
      );
      return;
    }
    if (checkoutItems.length === 0) {
      toast.error("Your cart is empty");
      void navigate({ to: "/cart" });
      return;
    }
    // A filled-in new address is saved by Continue itself (no separate "Save address" needed).
    if (step === 0 && addressFormOpen && (addressForm.line.trim() || addressForm.pin.trim() || !addr)) {
      if (!(await saveAddress())) return;
      // Saved, but we don't sell to that PIN yet: stay here and show why.
      if (isOutsideServiceArea(branches, features.branchRouting, addressForm.pin)) return;
      setStep(1);
      return;
    }
    if (step === 0 && !addr) {
      toast.error("Please select or add a delivery address");
      return;
    }
    if (addressOutside) {
      toast.error(`We don't deliver to PIN ${selectedAddress?.pin} yet`, { description: "Choose an address in our service area, or send us a request below." });
      setStep(0);
      return;
    }
    if (step === 0) {
      setAddressFormOpen(false);
      setChangingAddress(false);
    }
    if (step === 3 && isBusiness) {
      const problem = businessDetailsProblem(bizGstin, bizName, selectedAddress?.state);
      if (problem) {
        setBizTouched(true);
        toast.error("Check the business details", { description: problem });
        return;
      }
    }
    if (step === 3) {
      if (!directUpi) {
        toast.error("Online payment is being set up", { description: "Orders open as soon as UPI payment is switched on. Please call or WhatsApp us to order now." });
        return;
      }
      if (!shippingRatesReady) {
        toast.error("Checkout is waiting for the current shipping rules. Refresh and try again.");
        return;
      }
      if (placingOrder) return;
      setPlacingOrder(true);
      const placed: Awaited<ReturnType<typeof placeOrder>>[] = [];
      const placedLines: typeof checkoutItems = [];
      try {
        for (const group of orderGroups) {
          // A partner point may offer only one of pickup / delivery; the database checks it.
          const point = group.point ? branches.find((branch) => branch.id === group.point) : null;
          const groupFulfil = point ? (fulfil === "Delivery" && point.deliveryEnabled) || !point.pickupEnabled ? "Delivery" : "Pickup" : fulfil;
          placed.push(await placeOrder({
            lines: group.lines,
            method: "UPI",
            payment: "Pending",
            payFirst: true,
            business: isBusiness ? { isB2b: true, gstin: normaliseGstin(bizGstin), legalName: bizName.trim() } : { isB2b: false },
            ...(selectedAddress ? { shippingAddress: selectedAddress } : {}),
            ...(appliedCoupon && orderGroups.length === 1 ? { coupon: appliedCoupon.code } : {}),
            subtotal,
            discount,
            tax,
            shipping: shipCost,
            delivery: groupFulfil === "Pickup" ? "Pickup from our godown" : "Home delivery",
          }));
          placedLines.push(...group.lines);
        }
      } catch {
        if (!placed.length) return;
      } finally {
        setPlacingOrder(false);
      }
      // The database reprices and revalidates stock atomically. Show the
      // authoritative values returned by that transaction on confirmation.
      const sum = (pick: (order: (typeof placed)[number]) => number) => placed.reduce((total, order) => total + pick(order), 0);
      setConfirmationSummary({
        subtotal: sum((order) => order.subtotal),
        shipCost: sum((order) => order.shipping),
        tax: sum((order) => order.tax),
        discount: sum((order) => order.discount),
        total: sum((order) => order.amount),
      });
      if (productId) removeFromCart(productId);
      else if (placed.length < orderGroups.length) {
        // A later order failed: keep its items in the cart so they can be ordered again.
        for (const line of placedLines) removeFromCart(line.product.id);
        toast.error("Some items were not ordered", { description: "They are still in your cart. Review them and place another order." });
      } else clearCart();
      setPlacedId(placed.map((order) => order.id).join(", "));
      setPlacedOrders(placed.map((order) => ({ id: order.id, amount: order.amount, holdUntil: order.holdUntil ?? null })));
      toast.success("Pay now to place your order", { description: "Prices and stock are held for you while you pay." });
      setStep(step + 1);
      return;
    }
    setStep(step + 1);
  };

  /** Saves the new-address form; returns the new address id, or null if it could not be saved. */
  const saveAddress = async (): Promise<string | null> => {
    if (savingAddress) return null;
    const phoneDigits = addressForm.phone.replace(/\D/g, "");
    if (
      !addressForm.name.trim() ||
      phoneDigits.length < 10 ||
      !addressForm.line.trim() ||
      !addressForm.city.trim() ||
      !/^\d{6}$/.test(addressForm.pin.trim())
    ) {
      toast.error("Enter your name, valid phone, full address, city and 6-digit PIN code");
      return null;
    }
    setSavingAddress(true);
    const id = crypto.randomUUID();
    let saved = false;
    try {
      saved = await addAddress({
        id,
        label: addressForm.label.trim() || "Delivery",
        name: addressForm.name.trim(),
        phone: addressForm.phone.trim(),
        line: addressForm.line.trim(),
        city: addressForm.city.trim(),
        state: addressForm.state.trim(),
        pin: addressForm.pin.trim(),
        landmark: addressForm.landmark.trim(),
        ...(addressPoint ?? {}),
        default: addresses.length === 0,
      });
    } catch (error) {
      toast.error("Could not save this address", {
        description: error instanceof Error ? error.message : "Please retry.",
      });
    } finally {
      setSavingAddress(false);
    }
    if (!saved) return null;
    setAddr(id);
    setAddressFormOpen(false);
    setChangingAddress(false);
    toast.success("Delivery address saved");
    return id;
  };

  const selectedAddress = addresses.find((a) => a.id === addr);
  // Only the PIN codes our godowns serve can order (the database refuses the rest too).
  const addressOutside = isOutsideServiceArea(branches, features.branchRouting, selectedAddress?.pin);

  // After an order is placed the cart is (correctly) empty; keep showing its confirmation.
  if (!placedId && (productCatalogStatus !== "ready" || unresolvedCartLines || checkoutItems.length === 0)) {
    const unavailable = productCatalogStatus !== "ready" || unresolvedCartLines;
    return (
      <SiteLayout>
        <div className="mx-auto max-w-xl px-6 py-20 text-center">
          <h1 className="text-2xl font-bold text-navy">
            {unavailable ? "Please review your cart" : "Your cart is empty"}
          </h1>
          <p className="mt-3 text-sm text-slate">
            {productCatalogStatus === "loading"
              ? "We’re loading the live catalog before verifying your cart."
              : unavailable
                ? "Some items in your cart are not sold at the godown serving your PIN code, or are no longer available. Remove them in your cart to continue."
                : "Add a product to your cart before continuing to checkout."}
          </p>
          <Link
            to="/cart"
            className="mt-6 inline-block rounded-md bg-navy px-5 py-3 text-sm font-semibold text-white hover:bg-midnight"
          >
            Review cart
          </Link>
        </div>
      </SiteLayout>
    );
  }

  return (
    <SiteLayout>
      <div className="border-b border-border bg-ivory">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
          <Breadcrumbs items={[{ label: "Cart", to: "/cart" }, { label: "Checkout" }]} />
          <h1 className="mt-3 text-2xl font-bold text-navy sm:text-3xl">
            {selectedProduct ? `${selectedProduct.name} — CHECKOUT` : "Checkout"}
          </h1>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-10">
        <ol className="mb-8 flex flex-wrap gap-x-4 gap-y-2 sm:mb-10 sm:gap-x-6 sm:gap-y-3">
          {steps.map((s, i) => (
            <li key={s} className="flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm">
              <span
                className={cn(
                  "grid h-6 w-6 sm:h-7 sm:w-7 place-items-center rounded-full text-xs font-bold",
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

        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 sm:gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="rounded-lg border border-border bg-card p-4 sm:p-6 shadow-card">
            {step === 0 && (
              <>
                <h2 className="text-lg font-bold text-navy">Your address</h2>
                {addressOutside && selectedAddress && <NotInYourArea pin={selectedAddress.pin} compact className="mt-4" />}
                {selectedAddress && !changingAddress && !addressFormOpen && (
                  <div className="mt-5 space-y-3">
                    <div className="rounded-lg border border-gold bg-ivory p-4">
                      <p className="text-xs font-bold tracking-wider text-gold uppercase">{selectedAddress.label}{selectedAddress.default ? " · default" : ""}</p>
                      <p className="mt-1 font-semibold text-navy">{selectedAddress.name} · {selectedAddress.phone}</p>
                      <p className="text-sm text-slate">
                        {[selectedAddress.line, selectedAddress.city, `${selectedAddress.state} ${selectedAddress.pin}`.trim()].filter(Boolean).join(", ")}
                        {selectedAddress.landmark ? ` (${selectedAddress.landmark})` : ""}
                      </p>
                      <button type="button" onClick={() => setChangingAddress(true)} className="mt-2 text-sm font-semibold text-navy underline hover:text-gold">
                        Use a different address
                      </button>
                    </div>
                    <PickupPointCard pin={selectedAddress.pin} />
                  </div>
                )}
                {(!selectedAddress || changingAddress || addressFormOpen) && (
                <div className="mt-5 space-y-3">
                  {addresses.length === 0 && !addressFormOpen && (
                    <p className="rounded-lg border border-dashed border-border p-4 text-sm text-slate">
                      You have no saved delivery addresses. Add your address to continue.
                    </p>
                  )}
                  {addresses.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => { setAddr(a.id); setChangingAddress(false); }}
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
                        {[a.line, a.city, `${a.state} ${a.pin}`.trim()].filter(Boolean).join(", ")}
                        {a.landmark ? ` (${a.landmark})` : ""}
                      </p>
                    </button>
                  ))}
                  {selectedAddress && <PickupPointCard pin={selectedAddress.pin} />}
                  {!addressFormOpen && (
                    <button
                      type="button"
                      onClick={() => setAddressFormOpen(true)}
                      className="text-sm font-semibold text-navy hover:text-gold"
                    >
                      + Add new address
                    </button>
                  )}
                  {addressFormOpen && (
                    <div className="rounded-lg border border-border bg-ivory p-4">
                      <h3 className="font-semibold text-navy">Add your delivery address</h3>
                      <div className="mt-3 flex flex-wrap items-start gap-2">
                        <UseMyLocationButton onLocated={fillFromLocation} />
                        <PickContactButton onPicked={({ name, phone }) => setAddressForm((form) => ({ ...form, name: name || form.name, phone: phone || form.phone }))} />
                      </div>
                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        {(
                          [
                            ["label", "Address label (Home, Shop, etc.)"],
                            ["name", "Recipient name *"],
                            ["phone", "Phone number *"],
                            ["line", "Street / building address *"],
                            ["city", "City *"],
                            ["state", "State"],
                            ["pin", "6-digit PIN code *"],
                            ["landmark", "Landmark (optional)"],
                          ] as const
                        ).map(([key, label]) => (
                          <label key={key} className="text-xs font-medium text-slate">
                            {label}
                            <input
                              value={addressForm[key]}
                              onChange={(event) =>
                                setAddressForm((form) => ({ ...form, [key]: event.target.value }))
                              }
                              name={key}
                              autoComplete={ADDRESS_AUTOCOMPLETE[key]}
                              inputMode={key === "phone" || key === "pin" ? "numeric" : undefined}
                              maxLength={key === "pin" ? 6 : undefined}
                              className="mt-1 h-10 w-full rounded-md border border-border bg-card px-3 text-sm text-navy outline-none focus:border-gold"
                            />
                          </label>
                        ))}
                      </div>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={savingAddress}
                          onClick={() => void saveAddress()}
                          className="rounded-md bg-navy px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                        >
                          {savingAddress ? "Saving…" : "Save address"}
                        </button>
                        {addresses.length > 0 && (
                          <button
                            type="button"
                            onClick={() => setAddressFormOpen(false)}
                            className="rounded-md border border-border px-4 py-2 text-sm font-semibold text-navy"
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
              </>
            )}

            {step === 1 && (
              <>
                <h2 className="text-lg font-bold text-navy">{canPickup && canDeliver ? "Pickup or home delivery" : canDeliver ? "Home delivery" : "Pickup"}</h2>
                <div className="mt-5 space-y-3">
                  {canPickup && (
                    <button
                      type="button"
                      onClick={() => setShip("Pickup")}
                      className={cn(
                        "flex w-full items-center justify-between rounded-lg border p-4 text-left",
                        fulfil === "Pickup" ? "border-gold bg-ivory" : "border-border hover:border-gold",
                      )}
                    >
                      <span>
                        <span className="block font-semibold text-navy">Pickup from our godown</span>
                        <span className="text-sm text-slate">Collect your order in person.{canDeliver ? "" : " Home delivery is coming soon."}</span>
                      </span>
                      <span className="font-bold text-gold">Free</span>
                    </button>
                  )}
                  {canDeliver && (
                    <button
                      type="button"
                      onClick={() => setShip("Delivery")}
                      className={cn(
                        "flex w-full items-center justify-between rounded-lg border p-4 text-left",
                        fulfil === "Delivery" ? "border-gold bg-ivory" : "border-border hover:border-gold",
                      )}
                    >
                      <span>
                        <span className="block font-semibold text-navy">Home delivery</span>
                        <span className="text-sm text-slate">
                          Delivered to {selectedAddress?.line || "your address"}
                          {fulfilBranch?.freeDeliveryAbove != null ? ` · free above ${inr(fulfilBranch.freeDeliveryAbove)}` : ""}
                        </span>
                      </span>
                      <span className="font-bold text-gold">{deliveryFee === 0 ? "Free" : inr(deliveryFee)}</span>
                    </button>
                  )}
                  {fulfil === "Pickup" && <PickupPointCard pin={selectedAddress?.pin ?? null} />}
                </div>
              </>
            )}

            {step === 2 && (
              <>
                <h2 className="text-lg font-bold text-navy">Payment</h2>
                {directUpi ? (
                  <div className="mt-2 flex items-start gap-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
                    <CreditCard className="mt-0.5 h-4 w-4 shrink-0" />
                    <p>
                      Pay by <span className="font-semibold">UPI with no extra charges</span> (Google Pay, PhonePe, Paytm or any UPI app),
                      straight to {directUpi.payeeName}. Your order is placed and confirmed the moment the payment reaches us.
                    </p>
                  </div>
                ) : (
                  <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                    Online payment is being set up, so orders can't be placed on the website yet.
                    Please <Link to="/contact" className="font-semibold underline">call or WhatsApp us</Link> to order.
                  </p>
                )}
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
                  {couponCode && !appliedCoupon && (
                    <p role="status" className="mt-1 text-xs text-danger">
                      {orderGroups.length > 1
                        ? "Coupons apply to a single order. These items ship from different places, so place them separately to use a coupon."
                        : "This coupon is unavailable, below its minimum order, or has reached its per-customer limit."}
                    </p>
                  )}
                  {appliedCoupon && (
                    <p role="status" className="mt-1 text-xs text-emerald-700">
                      {appliedCoupon.code} applied · {appliedCoupon.value} off
                    </p>
                  )}
                </div>
              </>
            )}

            {step === 3 && (
              <>
                <h2 className="text-lg font-bold text-navy">Order Review</h2>
                <div className="mt-4 rounded-lg border border-border bg-ivory/50 p-3">
                  <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                    <input
                      type="checkbox"
                      checked={isBusiness}
                      onChange={(e) => { setIsBusiness(e.target.checked); setBizTouched(false); }}
                      className="mt-0.5 h-4 w-4 accent-[#2f5d46]"
                    />
                    <span>
                      <span className="font-semibold text-navy">Buying for a business? Add GSTIN (optional)</span>
                      <span className="block text-xs text-slate">Your GST tax invoice will carry your GSTIN and business name, so you can claim input tax credit.</span>
                    </span>
                  </label>
                  {isBusiness && (() => {
                    const problem = businessDetailsProblem(bizGstin, bizName, selectedAddress?.state);
                    const show = bizTouched || bizGstin.length >= 15;
                    return (
                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        <div>
                          <label className="mb-1 block text-xs font-semibold text-charcoal" htmlFor="biz-gstin">GSTIN</label>
                          <input
                            id="biz-gstin"
                            value={bizGstin}
                            maxLength={15}
                            autoComplete="off"
                            spellCheck={false}
                            placeholder="e.g. 29ABCDE1234F1Z5"
                            onChange={(e) => setBizGstin(normaliseGstin(e.target.value).slice(0, 15))}
                            onBlur={() => setBizTouched(true)}
                            className={cn("h-10 w-full rounded-md border bg-white px-3 font-mono text-sm uppercase tracking-wider", show && problem && /GSTIN|15 characters|state code/.test(problem) ? "border-danger" : "border-border")}
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-xs font-semibold text-charcoal" htmlFor="biz-name">Legal business name</label>
                          <input
                            id="biz-name"
                            value={bizName}
                            maxLength={150}
                            placeholder="As registered for GST"
                            onChange={(e) => setBizName(e.target.value)}
                            onBlur={() => setBizTouched(true)}
                            className="h-10 w-full rounded-md border border-border bg-white px-3 text-sm"
                          />
                        </div>
                        {show && problem ? (
                          <p className="text-xs font-semibold text-danger sm:col-span-2">{problem}</p>
                        ) : !problem ? (
                          <p className="text-xs font-semibold text-emerald-700 sm:col-span-2">GSTIN looks right · state {normaliseGstin(bizGstin).slice(0, 2)}</p>
                        ) : null}
                      </div>
                    );
                  })()}
                </div>
                <div className="mt-5 space-y-3">
                  {checkoutItems.map(({ product, qty }) => (
                    <div
                      key={product.id}
                      className="flex items-center gap-3 border-b border-border pb-3 last:border-0"
                    >
                      <img
                        src={product.image || `/products/${product.category.toLowerCase()}.jpg`}
                        alt={product.name}
                        loading="lazy"
                        width={800}
                        height={800}
                        onError={(e) => {
                          const cat = product.category.toLowerCase();
                          (e.currentTarget as HTMLImageElement).src = cat.includes("sugar")
                            ? "/products/sugar.jpg"
                            : cat.includes("oil")
                              ? "/products/oil.jpg"
                              : "/products/rice.jpg";
                        }}
                        className="h-14 w-14 rounded-md object-cover"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-navy">{product.name}</p>
                        <p className="text-xs text-slate">
                          Qty {qty}
                        </p>
                      </div>
                      <p className="font-semibold text-navy">{inr(product.price * qty)}</p>
                    </div>
                  ))}
                </div>
                <dl className="mt-5 space-y-1.5 text-sm text-slate">
                  <div>Address: {selectedAddress?.line}</div>
                  <div>{fulfil === "Delivery" ? `Home delivery: ${shipCost === 0 ? "free" : inr(shipCost)}` : "Pickup: from our godown (free)"}</div>
                  <div>Payment: UPI (pay on the next step; the order is placed when paid)</div>
                  {isBusiness && !businessDetailsProblem(bizGstin, bizName, selectedAddress?.state) && (
                    <div>Tax invoice for: {bizName.trim()} · GSTIN {normaliseGstin(bizGstin)}</div>
                  )}
                  {appliedCoupon && <div>Coupon: {appliedCoupon.code}</div>}
                </dl>
              </>
            )}

            {step === 4 && (
              <div className="py-6 text-center">
                <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-gold/15 text-gold">
                  <Check className="h-7 w-7" />
                </span>
                <h2 className="mt-5 text-xl font-bold text-navy">{allPaid ? "Order placed and confirmed" : "Pay to place your order"}</h2>
                <p className="mt-2 text-sm text-slate">
                  {allPaid
                    ? `Total ${inrPrecise(summary.total)} paid by UPI. `
                    : `Total ${inrPrecise(summary.total)}. Prices and stock are held for you while you pay; the order is placed and confirmed the moment the payment reaches us. `}
                  {fulfil === "Pickup" ? "We will let you know when it is ready to collect." : "Delivery in 2–4 business days after payment."}
                </p>
                {directUpi && placedOrders.length > 0 && (
                  <div className="mx-auto mt-6 max-w-2xl space-y-4">
                    {placedOrders.map((order) => (
                      <HeldCheckoutPay key={order.id} settings={directUpi} orderNo={order.id} amount={order.amount} holdUntil={order.holdUntil} customer={user?.name ?? ""} />
                    ))}
                  </div>
                )}
                <div className="mt-6 flex flex-wrap justify-center gap-3">
                  {allPaid && placedId && !placedId.includes(",") && (
                    <Link
                      to="/account/orders/$id"
                      params={{ id: placedId }}
                      className="rounded-md bg-navy px-6 py-3 text-sm font-semibold text-white hover:bg-midnight"
                    >
                      View Order
                    </Link>
                  )}
                  {allPaid && placedId?.includes(",") && (
                    <Link to="/account/orders" className="rounded-md bg-navy px-6 py-3 text-sm font-semibold text-white hover:bg-midnight">
                      View Orders
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
                  disabled={placingOrder}
                  onClick={() => {
                    if (step > 0) { setStep(step - 1); return; }
                    // First step: close the address chooser, else leave checkout for the product / cart.
                    if ((addressFormOpen && addresses.length > 0) || changingAddress) {
                      setAddressFormOpen(false);
                      setChangingAddress(false);
                      return;
                    }
                    if (productId) void navigate({ to: "/product/$id", params: { id: productId } });
                    else void navigate({ to: "/cart" });
                  }}
                  className="rounded-md border border-navy px-5 py-2.5 text-sm font-semibold text-navy transition-colors hover:bg-navy hover:text-white"
                >
                  Back
                </button>
                <button
                  disabled={placingOrder}
                  onClick={goNext}
                  className="rounded-md bg-gold px-6 py-2.5 text-sm font-bold text-midnight transition-colors hover:bg-gold-light disabled:cursor-wait disabled:opacity-60"
                >
                  {placingOrder ? "Holding your order…" : step === 3 ? "Continue to pay" : "Continue"}
                </button>
              </div>
            )}
          </div>

          <aside className="h-max rounded-lg border border-border bg-card p-6 shadow-card">
            <h2 className="text-sm font-bold tracking-wide text-navy uppercase">Summary</h2>
            <div className="mt-4 space-y-2.5 text-sm">
              {[
                ["Subtotal", inrPrecise(summary.subtotal)],
                [fulfil === "Delivery" ? "Delivery" : "Pickup", summary.shipCost === 0 ? "Free" : inrPrecise(summary.shipCost)],
                ["GST", inrPrecise(summary.tax)],
                ...(summary.discount > 0
                  ? [["Coupon discount", `- ${inrPrecise(summary.discount)}`]]
                  : []),
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between">
                  <span className="text-slate">{k}</span>
                  <span className="font-semibold text-navy">{v}</span>
                </div>
              ))}
              <div className="hairline-gold my-2" />
              <div className="flex justify-between text-base font-bold text-navy">
                <span>Total</span>
                <span>{inrPrecise(summary.total)}</span>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </SiteLayout>
  );
}
