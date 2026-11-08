import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { pageHead, SITE_NAME } from "@/lib/seo";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Check, CreditCard, Loader2, Lock, XCircle } from "lucide-react";
import { toast } from "sonner";
import { SiteLayout, Breadcrumbs } from "@/components/site/SiteLayout";
import { getAvailablePurchaseQuantity, inr, inrPrecise } from "@/lib/data";
import { couponDiscount, gstAfterCoupon, lineGstInside, toPaise } from "@/lib/pricing";
import { useApp, type Address } from "@/lib/store";
import { PickupPointCard } from "@/components/site/PickupPointCard";
import { usePickupSettings } from "@/lib/pickup-points";
import { branchDeliveryFee, branchForPin, defaultBranchOf, orderGodownFor, useBranches, useShopperPin } from "@/lib/branches";
import { cn } from "@/lib/utils";
import { resizedImage } from "@/lib/image-url";
import { supabase } from "@/integrations/supabase/client";
import { UseMyLocationButton, type CapturedLocation } from "@/components/site/UseMyLocationButton";
import { PickContactButton } from "@/components/site/PickContactButton";
import { HeldCheckoutPay } from "@/components/site/HeldCheckoutPay";
import { WaitingCheckouts } from "@/components/site/WaitingCheckouts";
import { AWAITING_PAYMENT, PAYMENT_EXPIRED } from "@/lib/payment-hold";
import { NotInYourArea } from "@/components/site/NotInYourArea";
import { isOutsideServiceArea } from "@/lib/godown-rules";
import { useBankDetails, useUpiPayments } from "@/lib/upi-store";
import { isBankMethod, lapsedTransfer, methodLabel, methodsForOrders, pickMethod, UPI_BELOW, type PayMethod } from "@/lib/payment-rules";
import { parsePayParam, payPanelId, payParam, restorablePlaced } from "@/lib/upi-return";
import { settingsProblem } from "@/lib/upi-pay";
import { GST_BILL_PAY_NOTE, gstBillProblem, normaliseGstin } from "@/lib/gstin";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import {
  addressChangeBetween, addressChangeText, addressEditPatch, addressFieldsOf, addressFormProblem, addressLockReason, cleanAddressFields, lineProblems, lineProblemText,
  mapPointAfterEdit, mapPointOf, pinHint, pointIsTheSavedOne, type AddressChange, type MapPoint, type SeenOrder,
} from "@/lib/checkout-address";

const ADDRESS_AUTOCOMPLETE: Record<string, string> = {
  label: "off", name: "name", phone: "tel-national", line: "street-address",
  city: "address-level2", state: "address-level1", pin: "postal-code", landmark: "off",
};

const addressText = (address: Address) =>
  [address.line, address.city, `${address.state} ${address.pin}`.trim()].filter(Boolean).join(", ") + (address.landmark ? ` (${address.landmark})` : "");

/** The customer's default address, else their first one ("" when none). */
const preferredAddressId = (list: { id: string; default?: boolean }[]) =>
  (list.find((address) => address.default) ?? list[0])?.id ?? "";

export const Route = createFileRoute("/checkout")({
  // pay: the held checkouts being paid, so a reload after the UPI app reopens the pay step (owner, 7 Nov 2026).
  validateSearch: z.object({ productId: z.string().optional(), coupon: z.string().optional(), pay: z.string().optional() }),
  head: () => pageHead({ title: `Secure Checkout | ${SITE_NAME}`, description: "Choose your address, delivery and payment, and place your order.", path: "/checkout", noindex: true }),
  component: Checkout,
});

const steps = ["Address", "Delivery", "Payment", "Review", "Pay"];
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
    setQty,
    productNameOf,
    addresses,
    addAddress,
    updateAddress,
    placeOrder,
    coupons,
    orders,
    paymentHolds,
  } = useApp();
  const { productId, coupon: cartCoupon, pay } = Route.useSearch();
  const navigate = useNavigate();
  useEffect(() => {
    // Wait until the saved sign-in has been read, or a refresh would bounce signed-in customers.
    if (hydrated && authReady && !user)
      void navigate({ to: "/login", search: { next: "/checkout", productId }, replace: true });
  }, [hydrated, authReady, user, navigate, productId]);
  const [step, setStep] = useState(0);
  const [addr, setAddr] = useState(preferredAddressId(addresses));
  // The customer's default address is used automatically; the list and form open only on request.
  const [changingAddress, setChangingAddress] = useState(false);
  const [addressFormOpen, setAddressFormOpen] = useState(addresses.length === 0);
  // The saved address being edited, and the step to go back to when Edit was pressed on a later one.
  const [editingAddressId, setEditingAddressId] = useState<string | null>(null);
  const [editReturnStep, setEditReturnStep] = useState<number | null>(null);
  // Saved addresses reload in the background: only the form that opened by itself closes when they arrive.
  const formOpenedByHand = useRef(false);
  useEffect(() => {
    if (!addr && addresses.length > 0)
      setAddr(preferredAddressId(addresses));
    if (addresses.length > 0 && !formOpenedByHand.current) setAddressFormOpen(false);
  }, [addresses, addr]);
  const [addressPoint, setAddressPoint] = useState<MapPoint | null>(null);
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
  const blankAddressForm = () => ({
    label: "Home",
    name: user?.name ?? "",
    phone: user?.phone ?? "",
    line: "",
    city: "",
    state: "Karnataka",
    pin: "",
    landmark: "",
  });
  const [addressForm, setAddressForm] = useState(blankAddressForm);
  const openAddForm = () => {
    setAddressForm(blankAddressForm());
    setAddressPoint(null);
    setEditingAddressId(null);
    setEditReturnStep(null);
    formOpenedByHand.current = true;
    setAddressFormOpen(true);
  };
  const openEditForm = (address: Address, returnTo: number | null) => {
    setAddressForm(addressFieldsOf(address));
    setAddressPoint(mapPointOf(address));
    setEditingAddressId(address.id);
    setEditReturnStep(returnTo);
    formOpenedByHand.current = true;
    setAddressFormOpen(true);
    setStep(0);
  };
  const closeAddressForm = () => {
    setAddressForm(blankAddressForm());
    setAddressPoint(null);
    setEditingAddressId(null);
    setEditReturnStep(null);
    formOpenedByHand.current = false;
    setAddressFormOpen(false);
  };
  // The form on a phone sits below the fold: bring it up, and come back up when it closes.
  const addressFormRef = useRef<HTMLDivElement>(null);
  const checkoutCardRef = useRef<HTMLDivElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (editingAddressId) addressFormRef.current?.scrollIntoView({ block: "start" });
    else if (wasEditing.current) checkoutCardRef.current?.scrollIntoView({ block: "start" });
    wasEditing.current = Boolean(editingAddressId);
  }, [editingAddressId]);
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
  const [chosenMethod, setChosenMethod] = useState<PayMethod | null>(null);
  // A coupon applied on the cart page carries over.
  const [couponCode, setCouponCode] = useState(cartCoupon?.trim().toUpperCase() ?? "");
  // GST bill (client's rule): ticked, the bill is to the firm, with its name and GSTIN (both required), on the order,
  // its Zoho Books invoice and the e-invoice. Not ticked: no GST bill, the bill is in the customer's own name.
  const [isBusiness, setIsBusiness] = useState(false);
  const [bizGstin, setBizGstin] = useState("");
  const [bizName, setBizName] = useState("");
  const [bizTouched, setBizTouched] = useState(false);
  useEffect(() => {
    // A customer whose last order had a GST bill gets the firm name and GSTIN filled in.
    if (STATIC_DATA_MODE || !user?.id) return;
    let active = true;
    void supabase.from("profiles").select("gstin,company").eq("id", user.id).maybeSingle().then(({ data }) => {
      if (!active || !data?.company?.trim() || !data.gstin?.trim()) return;
      setBizGstin(data.gstin ?? "");
      setBizName(data.company);
      setIsBusiness(true);
    });
    return () => { active = false; };
  }, [user?.id]);
  const [placedId, setPlacedId] = useState<string | null>(null);
  const [placedOrders, setPlacedOrders] = useState<{ id: string; amount: number; holdUntil: string | null; method: PayMethod }[]>([]);
  // Every held checkout from this visit has been paid and is now an order.
  const allPaid = placedOrders.length > 0 && placedOrders.every((placed) => orders.some((order) => order.id === placed.id));
  // Every held checkout from this visit ended without being paid.
  const [endedHolds, setEndedHolds] = useState<string[]>([]);
  const markEnded = useCallback((orderNo: string) => setEndedHolds((list) => (list.includes(orderNo) ? list : [...list, orderNo])), []);
  const allEnded = placedOrders.length > 0 && placedOrders.every((placed) => endedHolds.includes(placed.id) || paymentHolds.find((hold) => hold.orderNo === placed.id)?.status === PAYMENT_EXPIRED);
  // Direct UPI to the company's own account (no gateway fee), when the admin has switched it on.
  const { settings: upiSettings, submissions } = useUpiPayments();
  const directUpi = upiSettings && upiSettings.enabled && !settingsProblem(upiSettings) ? upiSettings : null;
  // NEFT and RTGS: the company's bank account, once an admin has entered it.
  const { details: bankDetails, loaded: bankLoaded, failed: bankFailed } = useBankDetails(Boolean(user), user?.id);
  const [savingAddress, setSavingAddress] = useState(false);
  const [placingOrder, setPlacingOrder] = useState(false);
  // The address the held checkout was started with: a copy, so a later edit cannot change what is shown here.
  const [heldAddress, setHeldAddress] = useState<{ address: Address; godown: string } | null>(null);
  const [confirmationSummary, setConfirmationSummary] = useState<{
    subtotal: number;
    shipCost: number;
    tax: number;
    discount: number;
    total: number;
  } | null>(null);
  // Back on checkout after a reload (often what happens on a phone after paying in the UPI app): the pay step for the
  // checkouts named in ?pay=, from the customer's own held checkouts. Once per visit.
  const restoredPay = useRef(false);
  useEffect(() => {
    if (restoredPay.current || placedOrders.length > 0 || !pay) return;
    const restored = restorablePlaced(paymentHolds, parsePayParam(pay));
    if (!restored.length) return;
    restoredPay.current = true;
    const total = restored.reduce((sum, order) => sum + order.amount, 0);
    setPlacedOrders(restored);
    setPlacedId(restored.map((order) => order.id).join(", "));
    setConfirmationSummary({ subtotal: total, shipCost: 0, tax: 0, discount: 0, total });
    setStep(4);
    window.setTimeout(() => document.getElementById(payPanelId(restored[0]!.id))?.scrollIntoView({ block: "start" }), 300);
  }, [pay, paymentHolds, placedOrders.length]);
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
    if (addresses.length > 0 && !formOpenedByHand.current) setAddressFormOpen(false);
    // The default address, not simply the oldest one (a removed address falls back the same way).
    if (addr && !addresses.some((address) => address.id === addr)) {
      setAddr(preferredAddressId(addresses));
    } else if (!addr && addresses.length > 0) {
      setAddr(preferredAddressId(addresses));
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
  const subtotal = checkoutItems.reduce((sum, line) => sum + line.product.price * line.qty, 0);
  // Pickup or home delivery, as the customer's godown offers (same rules as the database):
  // pickup is free; delivery uses the godown's charge, free above its threshold.
  const { homeDelivery } = usePickupSettings();
  const { branches, features } = useBranches();
  const selectedAddress = addresses.find((a) => a.id === addr);
  const addressPin = selectedAddress?.pin ?? "";
  // Only the PIN codes our godowns serve can order (the database refuses the rest too).
  const addressOutside = isOutsideServiceArea(branches, features.branchRouting, selectedAddress?.pin);
  const fulfilBranch = features.branchRouting ? branchForPin(branches, addressPin) : defaultBranchOf(branches);
  // The order is priced by the godown serving the delivery address, as the database does: keep the
  // shopper's "Delivering to" PIN on that address so the prices shown are the prices charged.
  const [shopperPin, setShopperPin] = useShopperPin();
  // What the customer last saw, so a change of address can say what it did to the order.
  const seenOrder = useRef<SeenOrder | null>(null);
  const [addressChange, setAddressChange] = useState<AddressChange | null>(null);
  useEffect(() => {
    if (!features.branchRouting || !/^\d{6}$/.test(addressPin) || addressPin === shopperPin) return;
    // An address no godown serves keeps the current prices; the address step says "not in your area".
    if (isOutsideServiceArea(branches, features.branchRouting, addressPin)) return;
    const before = branchForPin(branches, shopperPin || ((addresses.find((a) => a.default) ?? addresses[0])?.pin ?? ""));
    setShopperPin(addressPin);
    if (before && fulfilBranch && before.id !== fulfilBranch.id && !seenOrder.current) {
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
  // Prices include GST: the subtotal is what the customer pays for the goods, and this is the GST inside it.
  const tax = checkoutItems.reduce(
    (sum, line) => sum + lineGstInside(line.product.price, line.qty, line.product.gst),
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
  const total = toPaise(subtotal + shipCost - discount);
  // A coupon comes off each item in proportion, and the GST inside them with it (the database works it out the same way).
  const taxShown = discount > 0 ? gstAfterCoupon(checkoutItems.map((line) => ({ price: line.product.price, qty: line.qty, gstPercent: line.product.gst })), discount) : tax;
  const summary = confirmationSummary ?? { subtotal, shipCost, tax: taxShown, discount, total };
  // The order's value decides how it can be paid; the database checks again on the final total. A cart that
  // splits is several orders, each with its own total.
  const orderTotals = orderGroups.length > 1
    ? orderGroups.map((group) => {
      const goods = group.lines.reduce((sum, line) => sum + line.product.price * line.qty, 0);
      const point = group.point ? branches.find((branch) => branch.id === group.point) ?? null : null;
      const delivers = point ? (fulfil === "Delivery" && point.deliveryEnabled) || !point.pickupEnabled : fulfil === "Delivery";
      return toPaise(goods + (delivers ? branchDeliveryFee(point ?? fulfilBranch, goods) : 0));
    })
    : [total];
  const payOptions = methodsForOrders(orderTotals, { upi: Boolean(directUpi), bank: Boolean(bankDetails) });
  // An earlier transfer of this amount that nobody checked in time: its UTR goes on the bank form, so start there.
  const earlierTransfer = lapsedTransfer(submissions, Date.now());
  const reuseTransfer = earlierTransfer && Math.abs(earlierTransfer.amount - total) < 0.005 && payOptions.includes("NEFT") ? earlierTransfer : undefined;
  const payMethod = pickMethod(chosenMethod ?? (reuseTransfer ? "NEFT" : null), payOptions);
  // Not "nothing on offer" while the settings are still being read, or could not be read just now.
  const payOptionsKnown = upiSettings !== null && bankLoaded;
  const waitingHolds = paymentHolds.filter((hold) => hold.status === AWAITING_PAYMENT && !placedOrders.some((placed) => placed.id === hold.orderNo));
  const sentOrderNos = submissions.filter((item) => item.status === "submitted").map((item) => item.orderNo);
  const placedMethod = placedOrders[0]?.method ?? "UPI";
  // The figures on screen belong to the delivery address only once the catalogue has followed its PIN.
  const pricesFollowAddress = !features.branchRouting || !/^\d{6}$/.test(addressPin) || addressPin === shopperPin;
  // With PIN matching on and no PIN known yet (saved addresses still loading), no godown has been decided.
  const pinKnown = !features.branchRouting || Boolean(addressPin || shopperPin);
  const pricesKnown = Boolean(placedId) || (!addressOutside && pricesFollowAddress && pinKnown && checkoutItems.length > 0);
  const servingGodown = features.branchRouting && !addressPin && shopperPin ? branchForPin(branches, shopperPin) : fulfilBranch;
  const godownLabel = servingGodown?.city || servingGodown?.name || "nearest";
  // What this order asks for, against what the serving godown can sell. The cart itself is left alone.
  const wantedLines = productId ? [{ id: productId, qty: cart.find((line) => line.id === productId)?.qty ?? 1 }] : cart;
  const cartProblems = productCatalogStatus !== "ready" || placedId || addressOutside || !pricesFollowAddress || !pinKnown
    ? []
    : lineProblems(wantedLines.map((line) => {
      const product = products.find((item) => item.id === line.id);
      return { id: line.id, qty: line.qty, name: product?.name ?? productNameOf(line.id), available: product ? getAvailablePurchaseQuantity(product) : null };
    }));
  useEffect(() => {
    if (placedId || !addressPin) return;
    if (addressOutside) { setAddressChange(null); return; }
    if (!pricesKnown) return;
    const now = { pin: addressPin, godownId: fulfilBranch?.id ?? null, godownName: fulfilBranch?.city || fulfilBranch?.name || "nearest", total };
    const before = seenOrder.current;
    seenOrder.current = now;
    if (before && before.pin !== now.pin) setAddressChange(addressChangeBetween(before, now));
  }, [placedId, addressPin, addressOutside, pricesKnown, fulfilBranch?.id, fulfilBranch?.city, fulfilBranch?.name, total]);

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
    if (productCatalogStatus !== "ready") {
      toast.error("The live product catalog is unavailable, so checkout is disabled.");
      return;
    }
    if (wantedLines.length === 0) {
      toast.error("Your cart is empty");
      void navigate({ to: "/cart" });
      return;
    }
    // GST bill details are checked against the address they will be billed to (GSTIN state = address state).
    if ((step === 0 || step === 3) && isBusiness) {
      const billingState = step === 0 && addressFormOpen ? addressForm.state : selectedAddress?.state;
      const problem = gstBillProblem(bizGstin, bizName, billingState);
      if (problem) {
        setBizTouched(true);
        if (step === 3) setStep(0);
        toast.error("Check the GST bill details", { description: problem });
        return;
      }
    }
    // A filled-in address is saved by Continue itself (no separate "Save address" needed).
    if (step === 0 && addressFormOpen && (editingAddressId || addressForm.line.trim() || addressForm.pin.trim() || !addr)) {
      const saved = await saveAddress();
      if (!saved) return;
      // Saved, but we don't sell to that PIN yet: stay here and show why.
      if (isOutsideServiceArea(branches, features.branchRouting, addressForm.pin)) return;
      if (saved.stay) return;
      setStep(saved.backTo ?? 1);
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
    if (!pricesFollowAddress) {
      toast.message("Updating prices…");
      return;
    }
    if (cartProblems.length > 0) {
      toast.error("Some items need a change before you can continue", { description: "Remove the items listed on this page, or change your address." });
      checkoutCardRef.current?.scrollIntoView({ block: "start" });
      return;
    }
    if (step === 0) {
      closeAddressForm();
      setChangingAddress(false);
    }
    if (step === 2 && !payMethod) {
      if (payOptionsKnown) toast.error("Online payment is being set up", { description: "Please call or WhatsApp us to order now." });
      else toast.message("Checking payment options…");
      return;
    }
    if (step === 3) {
      if (!payMethod) {
        toast.error("Online payment is being set up", { description: "Please call or WhatsApp us to order now." });
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
            method: payMethod,
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
        // The database stores the goods before GST; the customer saw them with GST inside.
        subtotal: sum((order) => order.subtotal + order.tax),
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
      if (selectedAddress) setHeldAddress({ address: selectedAddress, godown: godownLabel });
      setPlacedId(placed.map((order) => order.id).join(", "));
      setPlacedOrders(placed.map((order) => ({ id: order.id, amount: order.amount, holdUntil: order.holdUntil ?? null, method: payMethod })));
      // Kept in the address, so coming back from the UPI app to a reloaded page lands on this pay step again.
      restoredPay.current = true;
      void navigate({ to: "/checkout", search: (prev) => ({ ...prev, pay: payParam(placed.map((order) => order.id)) }), replace: true });
      toast.success("Pay now to place your order", { description: "Prices and stock are held for you while you pay." });
      setStep(step + 1);
      return;
    }
    setStep(step + 1);
  };

  /**
   * Saves the form, new or edited; null if it could not be saved. An edit goes back to the step it came
   * from, unless it moved godown: then every figure has changed and the steps are walked again.
   * `stay` tells Continue not to move on: the new total, or items to fix, should be read first.
   */
  const saveAddress = async (): Promise<{ id: string; backTo: number | null; stay: boolean } | null> => {
    if (savingAddress) return null;
    const problem = addressFormProblem(addressForm);
    if (problem) {
      toast.error(problem);
      return null;
    }
    if (editingAddressId) {
      const existing = addresses.find((address) => address.id === editingAddressId);
      if (!existing) {
        toast.error("Could not update this address", { description: "Please refresh the page and try again." });
        return null;
      }
      const edit = addressEditPatch(existing, addressForm, addressPoint);
      let updated = true;
      if (edit) {
        setSavingAddress(true);
        try {
          updated = await updateAddress(existing.id, edit);
        } catch (error) {
          updated = false;
          toast.error("Could not update this address", { description: error instanceof Error ? error.message : "Please retry." });
        } finally {
          setSavingAddress(false);
        }
      }
      if (!updated) return null;
      const pin = addressForm.pin.trim();
      const stay = isOutsideServiceArea(branches, features.branchRouting, pin) || orderGodownFor({ branches, features }, pin)?.id !== fulfilBranch?.id;
      const backTo = stay ? null : editReturnStep;
      setAddr(existing.id);
      closeAddressForm();
      setChangingAddress(false);
      if (edit) toast.success("Delivery address updated");
      if (backTo !== null) setStep(backTo);
      return { id: existing.id, backTo, stay: stay || cartProblems.length > 0 };
    }
    setSavingAddress(true);
    const id = crypto.randomUUID();
    let saved = false;
    try {
      saved = await addAddress({
        id,
        ...cleanAddressFields(addressForm),
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
    closeAddressForm();
    setChangingAddress(false);
    toast.success("Delivery address saved");
    return { id, backTo: null, stay: false };
  };

  // After an order is placed the cart is (correctly) empty; keep showing its confirmation.
  if (!placedId && (productCatalogStatus !== "ready" || wantedLines.length === 0)) {
    const unavailable = productCatalogStatus !== "ready";
    return (
      <SiteLayout>
        <div className="mx-auto max-w-xl px-6 py-20 text-center">
          <h1 className="text-2xl font-bold text-navy">
            {unavailable ? "Please review your cart" : "Your cart is empty"}
          </h1>
          <WaitingCheckouts holds={waitingHolds} sent={sentOrderNos} className="mt-5 text-left" />
          <p className="mt-3 text-sm text-slate">
            {productCatalogStatus === "loading"
              ? "We’re loading the live catalog before verifying your cart."
              : unavailable
                ? "The live product catalog is unavailable, so checkout is disabled."
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

  // The order summary: beside the steps on computers, inside the card above the buttons on phones.
  // No figures from another godown: an address we don't serve, or a cart it can't sell, has no total yet.
  const summaryRows = !pricesKnown ? (
    <p className="mt-4 text-sm text-slate">
      {addressOutside
        ? "Prices show once your address is in our service area."
        : checkoutItems.length === 0 && pinKnown ? `No item in your cart is sold at the ${godownLabel} godown.` : "Updating prices…"}
    </p>
  ) : (
    <div className="mt-4 space-y-2.5 text-sm">
      {[
        ["Subtotal (incl. GST)", inrPrecise(summary.subtotal)],
        [fulfil === "Delivery" ? "Delivery" : "Pickup", summary.shipCost === 0 ? "Free" : inrPrecise(summary.shipCost)],
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
      {summary.tax > 0 && <p className="text-right text-xs text-slate">{`Includes GST of ${inrPrecise(summary.tax)}`}</p>}
    </div>
  );

  const editingAddress = editingAddressId ? addresses.find((address) => address.id === editingAddressId) : undefined;
  // Only beside a real total: no address or cart problem may leave it quoting a figure the summary doesn't show.
  const addressChangeNotice = addressChange && pricesKnown ? addressChangeText(addressChange, total, inrPrecise) : null;
  // Where the address shows after the first step: the way back to edit it.
  const addressStrip = selectedAddress ? (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-ivory/50 p-3 text-sm">
      <div className="min-w-0">
        <p className="text-xs font-bold tracking-wider text-gold uppercase">{fulfil === "Delivery" ? "Deliver to" : "Your address"}</p>
        <p className="mt-0.5 font-semibold break-words text-navy">{selectedAddress.name} · {selectedAddress.phone}</p>
        <p className="break-words text-slate">{addressText(selectedAddress)}</p>
      </div>
      <button type="button" disabled={placingOrder} onClick={() => openEditForm(selectedAddress, step)} aria-label="Edit this address" className="shrink-0 font-semibold text-navy underline hover:text-gold disabled:opacity-60">
        Edit
      </button>
    </div>
  ) : null;

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

        {step < 4 && <WaitingCheckouts holds={waitingHolds} sent={sentOrderNos} className="mb-6" />}

        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 sm:gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div ref={checkoutCardRef} className="scroll-mt-28 rounded-lg border border-border bg-card p-4 sm:p-6 shadow-card">
            {step < 4 && addressChangeNotice && (
              <div role="status" className="mb-5 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                <p className="font-semibold">{addressChangeNotice.title}</p>
                <p className="mt-0.5">{addressChangeNotice.detail}</p>
              </div>
            )}
            {step < 4 && cartProblems.length > 0 && (
              <div role="alert" className="mb-5 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                <p className="font-semibold">Some items need a change before you can continue</p>
                <ul className="mt-2 space-y-2">
                  {cartProblems.map((problem) => {
                    const inCart = cart.some((line) => line.id === problem.id);
                    return (
                      <li key={problem.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                        <span className="min-w-0 break-words">{lineProblemText(problem, godownLabel)}</span>
                        {inCart && (
                          <span className="flex shrink-0 flex-wrap gap-3 font-semibold">
                            {problem.available ? <button type="button" onClick={() => setQty(problem.id, problem.available ?? 1)} className="underline">{`Set quantity to ${problem.available}`}</button> : null}
                            <button type="button" onClick={() => removeFromCart(problem.id)} className="underline">Remove</button>
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {step > 0 && selectedAddress && (
                  <button type="button" onClick={() => { setChangingAddress(true); setStep(0); }} className="mt-2 font-semibold underline">Change address</button>
                )}
              </div>
            )}
            {step === 0 && (
              <>
                <h2 className="text-lg font-bold text-navy">Your address</h2>
                {addressOutside && selectedAddress && !editingAddressId && <NotInYourArea pin={selectedAddress.pin} compact className="mt-4" />}
                {selectedAddress && !changingAddress && !addressFormOpen && (
                  <div className="mt-5 space-y-3">
                    <div className="rounded-lg border border-gold bg-ivory p-4">
                      <p className="text-xs font-bold tracking-wider break-words text-gold uppercase">{selectedAddress.label}{selectedAddress.default ? " · default" : ""}</p>
                      <p className="mt-1 font-semibold break-words text-navy">{selectedAddress.name} · {selectedAddress.phone}</p>
                      <p className="text-sm break-words text-slate">{addressText(selectedAddress)}</p>
                      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm font-semibold">
                        <button type="button" onClick={() => openEditForm(selectedAddress, null)} aria-label="Edit this address" className="text-navy underline hover:text-gold">
                          Edit
                        </button>
                        <button type="button" onClick={() => setChangingAddress(true)} className="text-navy underline hover:text-gold">
                          Use a different address
                        </button>
                      </div>
                    </div>
                    {!addressOutside && <PickupPointCard pin={selectedAddress.pin} />}
                  </div>
                )}
                {(!selectedAddress || changingAddress || addressFormOpen) && (
                <div className="mt-5 space-y-3">
                  {addresses.length === 0 && !addressFormOpen && (
                    <p className="rounded-lg border border-dashed border-border p-4 text-sm text-slate">
                      You have no saved delivery addresses. Add your address to continue.
                    </p>
                  )}
                  {!editingAddressId && addresses.map((a) => (
                    <div
                      key={a.id}
                      className={cn(
                        "flex items-start gap-3 rounded-lg border p-4 transition-colors",
                        addr === a.id ? "border-gold bg-ivory" : "border-border hover:border-gold",
                      )}
                    >
                      <button
                        type="button"
                        disabled={savingAddress}
                        onClick={() => { setAddr(a.id); setChangingAddress(false); closeAddressForm(); }}
                        className="min-w-0 flex-1 text-left"
                      >
                        <p className="text-xs font-bold tracking-wider break-words text-gold uppercase">
                          {a.label}
                        </p>
                        <p className="mt-1 font-semibold break-words text-navy">
                          {a.name} · {a.phone}
                        </p>
                        <p className="text-sm break-words text-slate">{addressText(a)}</p>
                      </button>
                      <button type="button" disabled={savingAddress} onClick={() => openEditForm(a, null)} aria-label={`Edit ${a.label} address`} className="shrink-0 text-sm font-semibold text-navy underline hover:text-gold disabled:opacity-60">
                        Edit
                      </button>
                    </div>
                  ))}
                  {!editingAddressId && selectedAddress && !addressOutside && <PickupPointCard pin={selectedAddress.pin} />}
                  {!addressFormOpen && (
                    <button
                      type="button"
                      onClick={openAddForm}
                      className="text-sm font-semibold text-navy hover:text-gold"
                    >
                      + Add new address
                    </button>
                  )}
                  {addressFormOpen && (
                    <div ref={addressFormRef} className="scroll-mt-28 rounded-lg border border-border bg-ivory p-4">
                      <h3 className="font-semibold text-navy">{editingAddressId ? "Edit your delivery address" : "Add your delivery address"}</h3>
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
                      {editingAddress && (() => {
                        const pin = addressForm.pin.trim();
                        const outside = isOutsideServiceArea(branches, features.branchRouting, pin);
                        const goesTo = orderGodownFor({ branches, features }, pin);
                        const hint = pinHint({ pin, outside, movesTo: goesTo && goesTo.id !== fulfilBranch?.id ? goesTo.city || goesTo.name : null });
                        const savedPoint = pointIsTheSavedOne(editingAddress, addressPoint) ? addressPoint : null;
                        const pointGoes = savedPoint && !mapPointAfterEdit(editingAddress, addressPoint, pin);
                        return (
                          <div className="mt-3 space-y-1.5 text-xs">
                            {hint && <p className="font-semibold text-amber-800">{hint}</p>}
                            {pointGoes ? (
                              <p className="text-amber-800">The PIN changed, so the old map point will be removed. Use your current location to set a new one.</p>
                            ) : savedPoint ? (
                              <p className="text-slate">
                                <span>Map point saved with this address</span>{" · "}
                                <a className="font-semibold text-navy underline" href={`https://www.google.com/maps?q=${savedPoint.latitude},${savedPoint.longitude}`} target="_blank" rel="noreferrer">View on map</a>
                              </p>
                            ) : null}
                            <p className="text-slate">Your past orders and any checkout waiting for payment keep the address they were placed with.</p>
                          </div>
                        );
                      })()}
                      <div className="mt-4 flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={savingAddress}
                          onClick={() => void saveAddress()}
                          className="rounded-md bg-navy px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                        >
                          {savingAddress ? "Saving…" : editingAddressId ? "Save changes" : "Save address"}
                        </button>
                        {addresses.length > 0 && (
                          <button
                            type="button"
                            disabled={savingAddress}
                            onClick={() => { const back = editReturnStep; closeAddressForm(); if (back !== null) setStep(back); }}
                            className="rounded-md border border-border px-4 py-2 text-sm font-semibold text-navy disabled:opacity-60"
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
                {!addressOutside && (() => {
                  const billingState = addressFormOpen ? addressForm.state : selectedAddress?.state;
                  const problem = isBusiness ? gstBillProblem(bizGstin, bizName, billingState) : null;
                  const gstin = normaliseGstin(bizGstin);
                  return (
                    <div className="mt-5 rounded-lg border border-border bg-ivory/50 p-3 sm:p-4">
                      <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                        <input
                          type="checkbox"
                          checked={isBusiness}
                          onChange={(e) => { setIsBusiness(e.target.checked); setBizTouched(false); }}
                          className="mt-0.5 h-4 w-4 shrink-0 accent-[#2f5d46]"
                        />
                        <span>
                          <span className="font-semibold text-navy">I need a GST bill</span>
                          <span className="block text-xs text-slate">A tax invoice in your firm's name with its GSTIN, to claim input tax credit. Leave it unticked for a bill in your own name, without GST details.</span>
                        </span>
                      </label>
                      {!isBusiness && (
                        <p className="mt-2 text-xs text-charcoal">
                          <span className="font-semibold">No GST bill.</span>{" "}
                          <span>{`Bill to: ${(user?.name || selectedAddress?.name || "your name").trim()}`}</span>
                        </p>
                      )}
                      {isBusiness && (
                        <div className="mt-3 grid gap-3 sm:grid-cols-2">
                          <div>
                            <label className="mb-1 block text-xs font-semibold text-charcoal" htmlFor="biz-name">Firm name *</label>
                            <input
                              id="biz-name"
                              value={bizName}
                              maxLength={150}
                              autoComplete="organization"
                              placeholder="Firm name, as on the GST certificate"
                              onChange={(e) => setBizName(e.target.value)}
                              onBlur={() => setBizTouched(true)}
                              className={cn("h-10 w-full rounded-md border bg-white px-3 text-sm", bizTouched && bizName.trim().length < 2 ? "border-danger" : "border-border")}
                            />
                          </div>
                          <div>
                            <label className="mb-1 block text-xs font-semibold text-charcoal" htmlFor="biz-gstin">GSTIN *</label>
                            <input
                              id="biz-gstin"
                              value={bizGstin}
                              maxLength={15}
                              autoComplete="off"
                              spellCheck={false}
                              placeholder="e.g. 29ABCDE1234F1Z5"
                              onChange={(e) => setBizGstin(normaliseGstin(e.target.value).slice(0, 15))}
                              onBlur={() => setBizTouched(true)}
                              className={cn("h-10 w-full rounded-md border bg-white px-3 font-mono text-sm uppercase tracking-wider", (bizTouched || gstin.length >= 15) && problem && /GSTIN|15 characters|state code/.test(problem) ? "border-danger" : "border-border")}
                            />
                          </div>
                          {problem && (bizTouched || gstin.length >= 15) ? (
                            <p className="text-xs font-semibold text-danger sm:col-span-2">{problem}</p>
                          ) : !problem && gstin ? (
                            <p className="text-xs font-semibold text-emerald-700 sm:col-span-2">GSTIN looks right · state {gstin.slice(0, 2)}</p>
                          ) : null}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </>
            )}

            {step === 1 && (
              <>
                <h2 className="text-lg font-bold text-navy">{canPickup && canDeliver ? "Pickup or home delivery" : canDeliver ? "Home delivery" : "Pickup"}</h2>
                <div className="mt-5 space-y-3">
                  {addressStrip}
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
                {!payOptionsKnown && payOptions.length === 0 ? (
                  <p className="mt-2 flex items-center gap-2 text-sm text-slate">
                    <Loader2 className="h-4 w-4 animate-spin" /> {bankFailed ? "We could not load the payment options. Trying again…" : "Checking payment options…"}
                  </p>
                ) : payOptions.length > 0 ? (
                  <div className="mt-2 space-y-2" role="radiogroup" aria-label="Payment method">
                    {reuseTransfer && (
                      <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm font-semibold text-amber-950">{`You already sent UTR ${reuseTransfer.utr} for an earlier checkout. Do not pay again: choose NEFT and send the same UTR on the next steps.`}</p>
                    )}
                    {Math.max(...orderTotals) >= UPI_BELOW && <p className="text-sm text-slate">Orders of ₹1,00,000 and above are paid by bank transfer.</p>}
                    {payOptions.map((option) => (
                      <label key={option} className={cn("flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm", payMethod === option ? "border-gold bg-gold/5" : "border-border bg-card")}>
                        <input type="radio" name="pay-method" className="mt-1 accent-[var(--gold)]" checked={payMethod === option} onChange={() => setChosenMethod(option)} />
                        <span className="min-w-0">
                          <span className="flex items-center gap-2 font-semibold text-navy"><CreditCard className="h-4 w-4 shrink-0" /> {methodLabel(option)}</span>
                          <span className="mt-0.5 block text-slate">
                            {option === "UPI"
                              ? "Pay now with Google Pay, PhonePe, Paytm or any UPI app, no extra charges. Scan the QR: the amount fills in by itself. Your order is placed as soon as we confirm the payment."
                              : "Transfer from your bank to our account, then enter the UTR in your order details within 1 hour. Your order is placed once we check it against our bank account."}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                    {directUpi
                      ? "Payment by bank transfer is being set up, so orders of ₹1,00,000 and above can't be placed on the website yet. Smaller orders can be paid by UPI. Please "
                      : "Online payment is being set up, so orders can't be placed on the website yet. Please "}
                    <Link to="/contact" className="font-semibold underline">call or WhatsApp us</Link> to order.
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
                <div className="mt-5 space-y-3">
                  {checkoutItems.map(({ product, qty }) => (
                    <div
                      key={product.id}
                      className="flex items-center gap-3 border-b border-border pb-3 last:border-0"
                    >
                      <img
                        src={resizedImage(product.image || `/products/${product.category.toLowerCase()}.jpg`, 160)}
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
                <div className="mt-5">{addressStrip}</div>
                <dl className="mt-5 space-y-1.5 text-sm text-slate">
                  <div>{fulfil === "Delivery" ? `Home delivery: ${shipCost === 0 ? "free" : inr(shipCost)}` : "Pickup: from our godown (free)"}</div>
                  <div>{payMethod && isBankMethod(payMethod)
                    ? `Payment: ${methodLabel(payMethod)} (our bank details are on the next step; enter the UTR within 1 hour)`
                    : payMethod === "UPI" ? "Payment: UPI (pay on the next step; the order is placed when paid)" : "Payment: not available yet"}</div>
                  {isBusiness && !gstBillProblem(bizGstin, bizName, selectedAddress?.state)
                    ? <div><span>GST bill to:</span> <span>{`${bizName.trim()} · GSTIN ${normaliseGstin(bizGstin)}`}</span></div>
                    : !isBusiness && <div><span>Bill to:</span> <span>{(user?.name || selectedAddress?.name || "").trim()}</span> <span>(no GST bill)</span></div>}
                  {isBusiness && <div className="font-semibold text-amber-900">{GST_BILL_PAY_NOTE}</div>}
                  {appliedCoupon && <div>Coupon: {appliedCoupon.code}</div>}
                </dl>
              </>
            )}

            {step === 4 && (
              <div className="py-6 text-center">
                <span className={cn("mx-auto grid h-14 w-14 place-items-center rounded-full", allEnded ? "bg-muted text-slate" : "bg-gold/15 text-gold")}>
                  {allEnded ? <XCircle className="h-7 w-7" /> : <Check className="h-7 w-7" />}
                </span>
                <h2 className="mt-5 text-xl font-bold text-navy">{allPaid ? "Order placed and confirmed" : allEnded ? "Order not placed" : "Pay to place your order"}</h2>
                {!allEnded && (
                  <p className="mt-2 text-sm text-slate">
                    {allPaid
                      ? `Total ${inrPrecise(summary.total)} paid by ${placedMethod}. `
                      : isBankMethod(placedMethod)
                        ? `Total ${inrPrecise(summary.total)}. Prices and stock are held for you: transfer the money and enter the UTR within the time shown. The order is placed once we check it. `
                        : `Total ${inrPrecise(summary.total)}. Prices and stock are held for you while you pay; the order is placed as soon as we confirm the payment in our bank. `}
                    {fulfil === "Pickup" ? "We will let you know when it is ready to collect." : "Delivery in 2–4 business days after payment."}
                  </p>
                )}
                {heldAddress && !allEnded && (
                  <div className="mx-auto mt-6 max-w-2xl rounded-lg border border-border bg-ivory/60 p-4 text-left text-sm">
                    <p className="flex items-center gap-1.5 text-xs font-bold tracking-wider text-gold uppercase">
                      <Lock className="h-3.5 w-3.5" /> {allPaid ? "Address on this order" : "Address on this checkout"}
                    </p>
                    <p className="mt-1 font-semibold break-words text-navy">{heldAddress.address.name} · {heldAddress.address.phone}</p>
                    <p className="break-words text-slate">{addressText({ ...heldAddress.address, landmark: "" })}</p>
                    <p className="mt-2 text-xs text-slate">
                      {addressLockReason({ paid: allPaid, checking: placedOrders.some((placed) => sentOrderNos.includes(placed.id)), godown: heldAddress.godown })}
                    </p>
                  </div>
                )}
                {placedOrders.length > 0 && (
                  <div className="mx-auto mt-6 max-w-2xl space-y-4">
                    {placedOrders.map((order) => (
                      <HeldCheckoutPay key={order.id} settings={directUpi} method={order.method} orderNo={order.id} amount={order.amount} holdUntil={order.holdUntil} customer={user?.name ?? ""} onEnded={markEnded} />
                    ))}
                    {!allPaid && !allEnded && isBankMethod(placedMethod) && (
                      <Link to="/account/orders" className="block text-sm font-semibold text-gold hover:underline">You can close this page and enter the UTR later under My Orders.</Link>
                    )}
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

            {/* Phones: the summary after the step's details (the items on Review), the buttons last. */}
            <div className="mt-6 rounded-lg border border-border bg-ivory/40 p-4 lg:hidden">
              <h2 className="text-sm font-bold tracking-wide text-navy uppercase">Summary</h2>
              {summaryRows}
            </div>

            {step < 4 && (
              // On phones the buttons stay pinned at the bottom of the screen, under the thumb.
              <div className="sticky bottom-0 z-20 -mx-4 -mb-4 mt-6 flex items-center gap-3 rounded-b-lg border-t border-border bg-card/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:static sm:mx-0 sm:mb-0 sm:mt-8 sm:justify-between sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none">
                <button
                  disabled={placingOrder || savingAddress}
                  onClick={() => {
                    if (step > 0) { setStep(step - 1); return; }
                    // First step: close the form or the address chooser, else leave checkout for the product / cart.
                    if (editingAddressId) {
                      const back = editReturnStep;
                      closeAddressForm();
                      if (back !== null) setStep(back);
                      return;
                    }
                    if ((addressFormOpen && addresses.length > 0) || changingAddress) {
                      closeAddressForm();
                      setChangingAddress(false);
                      return;
                    }
                    if (productId) void navigate({ to: "/product/$id", params: { id: productId } });
                    else void navigate({ to: "/cart" });
                  }}
                  className="h-12 shrink-0 rounded-md border border-navy px-5 text-sm font-semibold text-navy transition-colors hover:bg-navy hover:text-white sm:h-auto sm:py-2.5"
                >
                  Back
                </button>
                <button
                  disabled={placingOrder}
                  onClick={goNext}
                  className="flex h-12 min-w-0 flex-1 flex-wrap content-center items-center justify-center gap-x-1.5 rounded-md bg-gold px-4 text-sm leading-tight font-bold text-midnight shadow-sm transition-colors hover:bg-gold-light active:scale-[0.99] disabled:cursor-wait disabled:opacity-60 sm:h-auto sm:flex-none sm:py-2.5"
                >
                  <span className="whitespace-nowrap">{placingOrder ? "Holding your order…" : step === 3 ? "Continue to pay" : "Continue"}</span>
                  {!placingOrder && pricesKnown && <span className="whitespace-nowrap text-[13px] font-semibold opacity-80 sm:hidden">· {inrPrecise(summary.total)}</span>}
                </button>
              </div>
            )}
          </div>

          {/* Computers: the summary beside the steps. Phones show it inside the card, above the buttons. */}
          <aside className="hidden h-max rounded-lg border border-border bg-card p-6 shadow-card lg:block">
            <h2 className="text-sm font-bold tracking-wide text-navy uppercase">Summary</h2>
            {summaryRows}
          </aside>
        </div>
      </div>
    </SiteLayout>
  );
}
