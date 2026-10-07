import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  addresses as seedAddresses,
  batches as seedBatches,
  buildOrder,
  calculateFIFOCost,
  calculateInventoryValuation,
  coupons as seedCoupons,
  customers as seedCustomers,
  inr,
  getCurrentFIFOCost,
  getProductAverageSellingPrice,
  notifications as seedNotifications,
  orders as seedOrders,
  products as seedProducts,
  returns as seedReturns,
  reviews as seedReviews,
  storeCategorySeed,
  vendors as seedVendors,
  type Order,
  type OrderStatus,
  type Product,
  type PurchaseBatch,
  type ReturnRequest,
  type StoreCategory,
} from "./data";

export type Role = "customer" | "vendor" | "admin";
export type SessionUser = { name: string; email: string; role: Role; phone?: string; avatar?: string };
export type CartLine = { id: string; qty: number };
export type Address = (typeof seedAddresses)[number];
export type Customer = (typeof seedCustomers)[number];
export type Vendor = (typeof seedVendors)[number];
export type Review = (typeof seedReviews)[number];
export type Coupon = (typeof seedCoupons)[number];
export type Notif = (typeof seedNotifications)[number];


type AppState = {
  user: SessionUser | null;
  login: (u: SessionUser) => void;
  logout: () => void;
  updateProfile: (p: Partial<SessionUser>) => void;

  cart: CartLine[];
  cartItems: { product: Product; qty: number }[];
  cartCount: number;
  subtotal: number;
  addToCart: (id: string, qty?: number) => void;
  setQty: (id: string, qty: number) => void;
  removeFromCart: (id: string) => void;
  clearCart: () => void;

  wishlist: string[];
  toggleWishlist: (id: string) => void;

  categories: StoreCategory[];
  addCategory: (c: Omit<StoreCategory, "id" | "order">) => void;
  updateCategory: (id: string, patch: Partial<StoreCategory>) => void;
  deleteCategory: (id: string) => void;
  moveCategory: (id: string, dir: -1 | 1) => void;

  products: Product[];
  addProduct: (p: Product) => void;
  updateProduct: (id: string, patch: Partial<Product>) => void;
  deleteProduct: (id: string) => void;
  duplicateProduct: (id: string) => void;

  batches: PurchaseBatch[];
  addBatch: (b: Omit<PurchaseBatch, "id">) => void;
  updateBatch: (id: string, patch: Partial<PurchaseBatch>) => void;
  deleteBatch: (id: string) => void;
  getFIFOCost: (productId: string) => number;
  getInventoryValuation: (productId: string) => ReturnType<typeof calculateInventoryValuation>;
  getAverageSellingPrice: (product: Product) => number;

  orders: Order[];
  placeOrder: (input: {
    lines: { product: Product; qty: number; capacity?: string; unitPrice?: number }[];
    method: string;
    payment: Order["payment"];
    coupon?: string;
    customerIndex?: number;
    customerOverride?: Customer;
    delivery?: string;
    source?: string;
    paymentDueDate?: string;
  }) => Order;
  updateOrderStatus: (id: string, status: OrderStatus) => void;
  updateOrderItem: (orderId: string, index: number, patch: { qty?: number; capacity?: string; unitPrice?: number }) => boolean;
  updateOrderDelivery: (orderId: string, delivery: string) => void;
  confirmPayment: (id: string, amount: number, utr: string, advancePercent?: number) => void;
  refundOrder: (id: string) => void;

  vendors: Vendor[];
  setVendorStatus: (id: string, status: string) => void;
  customers: Customer[];
  setCustomerStatus: (id: string, status: string) => void;

  reviews: Review[];
  setReviewStatus: (id: string, status: string) => void;
  deleteReview: (id: string) => void;

  returns: ReturnRequest[];
  setReturnStatus: (id: string, status: string, refund?: string) => void;

  coupons: Coupon[];
  addCoupon: (c: Coupon) => void;
  deleteCoupon: (code: string) => void;

  notifications: Notif[];
  markRead: (id: number) => void;
  markAllRead: () => void;
  deleteNotification: (id: number) => void;

  addresses: Address[];
  addAddress: (a: Address) => void;
  updateAddress: (id: string, patch: Partial<Address>) => void;
  deleteAddress: (id: string) => void;
  setDefaultAddress: (id: string) => void;
};

const AppContext = createContext<AppState | null>(null);
const KEY = "sbv-state-v2";

export function AppProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [wishlist, setWishlist] = useState<string[]>([]);
  const [products, setProducts] = useState<Product[]>(seedProducts);
  const [categories, setCategories] = useState<StoreCategory[]>(storeCategorySeed);
  const [batches, setBatches] = useState<PurchaseBatch[]>(seedBatches);
  const [orders, setOrders] = useState<Order[]>(seedOrders);
  const [vendors, setVendors] = useState<Vendor[]>(seedVendors);
  const [customers, setCustomers] = useState<Customer[]>(seedCustomers);
  const [reviews, setReviews] = useState<Review[]>(seedReviews);
  const [returns, setReturns] = useState<ReturnRequest[]>(seedReturns);
  const [coupons, setCoupons] = useState<Coupon[]>(seedCoupons);
  const [notifications, setNotifications] = useState<Notif[]>(seedNotifications);
  const [addresses, setAddresses] = useState<Address[]>(seedAddresses);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const s = JSON.parse(raw) as Partial<{
          user: SessionUser | null; cart: CartLine[]; wishlist: string[];
          categories: StoreCategory[]; products: Product[]; batches: PurchaseBatch[];
          orders: Order[]; vendors: Vendor[]; customers: Customer[];
          reviews: Review[]; returns: ReturnRequest[]; coupons: Coupon[]; notifications: Notif[]; addresses: Address[];
        }>;
        setUser(s.user ?? null);
        setCart(s.cart ?? []);
        setWishlist([]);
        if (s.categories?.length) {
          setCategories(
            s.categories.map((category) => {
              const currentVisual = storeCategorySeed.find((seedCategory) => seedCategory.name === category.name);
              return currentVisual ? { ...category, image: currentVisual.image } : category;
            }),
          );
        }
        if (s.products?.length) setProducts(s.products);
        if (s.batches?.length) setBatches(s.batches);
        if (s.orders?.length) setOrders(s.orders);
        if (s.vendors?.length) setVendors(s.vendors);
        if (s.customers?.length) setCustomers(s.customers);
        if (s.reviews?.length) setReviews(s.reviews);
        if (s.returns?.length) setReturns(s.returns);
        if (s.coupons?.length) setCoupons(s.coupons);
        if (s.notifications?.length) setNotifications(s.notifications);
        if (s.addresses?.length) setAddresses(s.addresses);
      } else {
        setCart([
          { id: seedProducts[0]!.id, qty: 2 },
          { id: seedProducts[15]!.id, qty: 3 },
        ]);
        setWishlist([seedProducts[8]!.id, seedProducts[21]!.id, seedProducts[40]!.id]);
      }
    } catch {
      /* ignore */
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({ user, cart, wishlist, categories, products, batches, orders, vendors, customers, reviews, returns, coupons, notifications, addresses }),
      );
    } catch {
      /* quota */
    }
  }, [hydrated, user, cart, wishlist, categories, products, batches, orders, vendors, customers, reviews, returns, coupons, notifications, addresses]);


  const value = useMemo<AppState>(() => {
    const cartItems = cart
      .map((l) => ({ product: products.find((p) => p.id === l.id)!, qty: l.qty }))
      .filter((l) => l.product);

    const pushNotif = (title: string, body: string, type: string, role: Notif["role"] = "admin") =>
      setNotifications((n) => [
        { id: Date.now() + Math.floor(Math.random() * 999), role, title, body, type, time: "just now", read: false },
        ...n,
      ]);

    return {
      user,
      login: (u) => setUser(u),
      logout: () => setUser(null),
      updateProfile: (p) => setUser((u) => (u ? { ...u, ...p } : u)),

      cart,
      cartItems,
      cartCount: cart.reduce((s, l) => s + l.qty, 0),
      subtotal: cartItems.reduce((s, l) => s + l.product.price * l.qty, 0),
      addToCart: (id, qty = 1) =>
        setCart((c) => {
          const prod = products.find((p) => p.id === id);
          const addAmount = Math.max(1, Math.floor(Number(qty) || 1));
          if (c.some((l) => l.id === id)) {
            return c.map((l) => {
              if (l.id !== id) return l;
              const nextQty = l.qty + addAmount;
              const safeQty = prod && prod.stock > 0 ? Math.min(nextQty, prod.stock) : nextQty;
              return { ...l, qty: safeQty };
            });
          }
          const initialQty = prod && prod.stock > 0 ? Math.min(addAmount, prod.stock) : addAmount;
          return [...c, { id, qty: initialQty }];
        }),
      setQty: (id, qty) =>
        setCart((c) => {
          const prod = products.find((p) => p.id === id);
          const parsed = Math.max(1, Math.floor(Number(qty) || 1));
          const safeQty = prod && prod.stock > 0 ? Math.min(parsed, prod.stock) : parsed;
          return c.map((l) => (l.id === id ? { ...l, qty: safeQty } : l));
        }),
      removeFromCart: (id) => setCart((c) => c.filter((l) => l.id !== id)),
      clearCart: () => setCart([]),

      wishlist,
      toggleWishlist: (id) => setWishlist((w) => (w.includes(id) ? w.filter((x) => x !== id) : [...w, id])),

      categories,
      addCategory: (c) =>
        setCategories((l) => [...l, { ...c, id: `C${Date.now().toString().slice(-6)}`, order: l.length + 1 }]),
      updateCategory: (id, patch) => setCategories((l) => l.map((c) => (c.id === id ? { ...c, ...patch } : c))),
      deleteCategory: (id) => setCategories((l) => l.filter((c) => c.id !== id)),
      moveCategory: (id, dir) =>
        setCategories((l) => {
          const sorted = [...l].sort((a, b) => a.order - b.order);
          const i = sorted.findIndex((c) => c.id === id);
          const j = i + dir;
          if (i < 0 || j < 0 || j >= sorted.length) return l;
          [sorted[i]!, sorted[j]!] = [sorted[j]!, sorted[i]!];
          return sorted.map((c, k) => ({ ...c, order: k + 1 }));
        }),

      products,
      addProduct: (p) => setProducts((list) => [p, ...list]),
      updateProduct: (id, patch) => {
        // Enforce Admin-only pricing and cost modifications (Requirement 3)
        const hasPriceOrCostChange =
          patch.price !== undefined ||
          patch.mrp !== undefined ||
          patch.purchasePrice !== undefined;

        if (user && user.role !== "admin" && hasPriceOrCostChange) {
          throw new Error("Unauthorized: Only an Administrator is permitted to modify pricing and cost.");
        }

        setProducts((list) => list.map((p) => (p.id === id ? { ...p, ...patch, updated: today() } : p)));
      },
      deleteProduct: (id) => setProducts((list) => list.filter((p) => p.id !== id)),
      duplicateProduct: (id) =>
        setProducts((list) => {
          const p = list.find((x) => x.id === id);
          if (!p) return list;
          const copy: Product = {
            ...p,
            id: `P${Date.now().toString().slice(-6)}`,
            name: `${p.name} (Copy)`,
            sku: `${p.sku}-C`,
            sold: 0,
            created: today(),
            updated: today(),
          };
          return [copy, ...list];
        }),

      batches,
      addBatch: (batchData) => {
        if (user && user.role !== "admin") {
          throw new Error("Unauthorized: Only an Administrator can add purchase batches.");
        }
        const newBatch: PurchaseBatch = {
          ...batchData,
          id: `BATCH-${Date.now().toString().slice(-6)}`,
          status: batchData.remainingQty > 0 ? "Active" : "Depleted",
        };
        setBatches((curr) => [newBatch, ...curr]);
        // Sync product stock
        setProducts((list) =>
          list.map((p) =>
            p.id === batchData.productId ? { ...p, stock: p.stock + batchData.remainingQty } : p,
          ),
        );
      },
      updateBatch: (batchId, patch) => {
        if (user && user.role !== "admin" && patch.unitCost !== undefined) {
          throw new Error("Unauthorized: Only an Administrator can modify batch purchase costs.");
        }
        setBatches((curr) => curr.map((b) => (b.id === batchId ? { ...b, ...patch } : b)));
      },
      deleteBatch: (batchId) => {
        if (user && user.role !== "admin") {
          throw new Error("Unauthorized: Only an Administrator can delete purchase batches.");
        }
        setBatches((curr) => curr.filter((b) => b.id !== batchId));
      },
      getFIFOCost: (productId) => getCurrentFIFOCost(productId, batches),
      getInventoryValuation: (productId) => calculateInventoryValuation(productId, batches),
      getAverageSellingPrice: (product) => getProductAverageSellingPrice(product, orders),

      orders,
      placeOrder: ({ lines, method, payment, coupon, customerIndex = 0, customerOverride, delivery, source, paymentDueDate }) => {
        const id = `ORD-${20000 + Math.floor(Math.random() * 9000)}`;
        const order = buildOrder(
          id,
          today(),
          customerIndex,
          lines.map((l) => ({ product: l.product, qty: l.qty, vendor: l.product.vendor, vendorId: l.product.vendorId, capacity: l.capacity ?? l.product.weight, unitPrice: l.unitPrice ?? l.product.price })),
          payment,
          method,
          payment === "Paid" ? "Payment Confirmed" : "Placed",
          coupon,
        );
        if (customerOverride) {
          order.customer = customerOverride.name;
          order.customerId = customerOverride.id;
          order.email = customerOverride.email;
          order.phone = customerOverride.phone;
          order.gstin = customerOverride.gst;
          order.address = customerOverride.address;
          order.city = customerOverride.city;
          order.state = customerOverride.state;
          order.pin = customerOverride.pin;
        } else if (user) {
          order.customer = user.name;
          order.email = user.email;
          if (user.phone) order.phone = user.phone;
        }
        if (delivery) order.delivery = delivery;
        if (source) order.source = source;
        if (paymentDueDate) order.paymentDueDate = paymentDueDate;
        setOrders((o) => [order, ...o]);

        // Consume inventory stock
        setProducts((list) =>
          list.map((p) => {
            const line = lines.find((l) => l.product.id === p.id);
            return line ? { ...p, stock: Math.max(0, p.stock - line.qty), sold: p.sold + line.qty } : p;
          }),
        );

        // Consume FIFO purchase batch layers
        setBatches((currentBatches) => {
          const nextBatches = [...currentBatches];
          for (const line of lines) {
            let needed = line.qty;
            const prodBatchIndices = nextBatches
              .map((b, idx) => ({ ...b, originalIdx: idx }))
              .filter((b) => b.productId === line.product.id && b.remainingQty > 0)
              .sort((a, b) => new Date(a.purchaseDate).getTime() - new Date(b.purchaseDate).getTime());

            for (const b of prodBatchIndices) {
              if (needed <= 0) break;
              const take = Math.min(needed, b.remainingQty);
              const remaining = b.remainingQty - take;
              nextBatches[b.originalIdx] = {
                ...nextBatches[b.originalIdx]!,
                remainingQty: remaining,
                status: remaining === 0 ? "Depleted" : "Active",
              };
              needed -= take;
            }
          }
          return nextBatches;
        });

        pushNotif("New order received", `${id} was placed worth ₹${order.amount.toLocaleString("en-IN")}.`, "info");
        return order;
      },
      updateOrderStatus: (id, status) =>
        setOrders((list) => list.map((o) => (o.id === id ? { ...o, status } : o))),
      updateOrderDelivery: (orderId, delivery) =>
        setOrders((list) => list.map((order) => order.id === orderId ? { ...order, delivery } : order)),
      updateOrderItem: (orderId, index, patch) => {
        const order = orders.find((candidate) => candidate.id === orderId);
        const item = order?.items[index];
        if (!order || !item || order.status === "Cancelled") return false;
        const nextQty = patch.qty ?? item.qty;
        if (!Number.isInteger(nextQty) || nextQty < 1) return false;
        const delta = nextQty - item.qty;
        const product = products.find((candidate) => candidate.id === item.product.id);
        if (delta > 0 && product && product.stock < delta) return false;
        if (delta !== 0 && product) {
          setProducts((list) => list.map((candidate) => candidate.id === product.id
            ? { ...candidate, stock: Math.max(0, candidate.stock - delta), sold: Math.max(0, candidate.sold + delta) }
            : candidate));
          setBatches((current) => {
            const next = [...current];
            if (delta > 0) {
              let needed = delta;
              const fifo = next.map((batch, batchIndex) => ({ batch, batchIndex }))
                .filter(({ batch }) => batch.productId === product.id && batch.remainingQty > 0)
                .sort((a, b) => a.batch.purchaseDate.localeCompare(b.batch.purchaseDate));
              for (const { batch, batchIndex } of fifo) {
                if (!needed) break;
                const taken = Math.min(needed, batch.remainingQty);
                next[batchIndex] = { ...batch, remainingQty: batch.remainingQty - taken, status: batch.remainingQty === taken ? "Depleted" : "Active" };
                needed -= taken;
              }
            } else {
              const latest = next.map((batch, batchIndex) => ({ batch, batchIndex }))
                .filter(({ batch }) => batch.productId === product.id)
                .sort((a, b) => b.batch.purchaseDate.localeCompare(a.batch.purchaseDate))[0];
              if (latest) next[latest.batchIndex] = { ...latest.batch, remainingQty: latest.batch.remainingQty + Math.abs(delta), status: "Active" };
            }
            return next;
          });
        }
        const items = order.items.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch, qty: nextQty } : line);
        const subtotal = items.reduce((sum, line) => sum + (line.unitPrice ?? line.product.price) * line.qty, 0);
        const tax = Math.round(Math.max(0, subtotal - order.discount) * 0.05);
        const amount = subtotal - order.discount + tax + order.shipping;
        const paidAmount = order.paidAmount ?? (order.payment === "Paid" ? order.amount : 0);
        const payment = paidAmount >= amount ? "Paid" : paidAmount > 0 ? "Partially Paid" : order.payment === "COD" ? "COD" : "Pending";
        setOrders((list) => list.map((candidate) => candidate.id === orderId
          ? { ...candidate, items, subtotal, tax, amount, payment, paidAmount }
          : candidate));
        pushNotif("Order updated", `${orderId} item details were updated.`, "info", "admin");
        return true;
      },
      confirmPayment: (id, amount, utr, advancePercent = 30) => {
        const order = orders.find((candidate) => candidate.id === id);
        if (!order || !Number.isFinite(amount) || amount <= 0) return;
        const paidAmount = Math.min(order.amount, (order.paidAmount ?? (order.payment === "Paid" ? order.amount : 0)) + amount);
        setOrders((list) => list.map((candidate) => candidate.id === id ? {
          ...candidate,
          paidAmount,
          ...(utr.trim() ? { utr: utr.trim() } : candidate.utr ? { utr: candidate.utr } : {}),
          advancePercent,
          payment: paidAmount >= candidate.amount ? "Paid" : "Partially Paid",
          status: paidAmount > 0 && candidate.status === "Placed" ? "Payment Confirmed" : candidate.status,
        } : candidate));
        pushNotif("Payment confirmed", `${inr(amount)} confirmed for ${id}${utr.trim() ? ` · UTR ${utr.trim()}` : ""}.`, "success", "admin");
        pushNotif("Payment confirmed", `We have confirmed your payment of ${inr(amount)} for order ${id}.`, "success", "customer");
      },
      refundOrder: (id) =>
        setOrders((list) =>
          list.map((o) => (o.id === id ? { ...o, payment: "Refunded", status: "Cancelled" } : o)),
        ),

      vendors,
      setVendorStatus: (id, status) => setVendors((l) => l.map((v) => (v.id === id ? { ...v, status } : v))),
      customers,
      setCustomerStatus: (id, status) => {
        const previous = customers.find((customer) => customer.id === id);
        setCustomers((list) => list.map((customer) => customer.id === id ? { ...customer, status } : customer));
        if (previous && previous.status !== status) pushNotif("Customer status updated", `${previous.name}: ${previous.status} → ${status}.`, "info", "admin");
      },

      reviews,
      setReviewStatus: (id, status) => setReviews((l) => l.map((r) => (r.id === id ? { ...r, status } : r))),
      deleteReview: (id) => setReviews((l) => l.filter((r) => r.id !== id)),

      returns,
      setReturnStatus: (id, status, refund) =>
        setReturns((l) => l.map((r) => (r.id === id ? { ...r, status, refund: refund ?? r.refund } : r))),

      coupons,
      addCoupon: (c) => setCoupons((l) => [c, ...l]),
      deleteCoupon: (code) => setCoupons((l) => l.filter((c) => c.code !== code)),

      notifications,
      markRead: (id) => setNotifications((l) => l.map((n) => (n.id === id ? { ...n, read: true } : n))),
      markAllRead: () => setNotifications((l) => l.map((n) => ({ ...n, read: true }))),
      deleteNotification: (id) => setNotifications((l) => l.filter((n) => n.id !== id)),

      addresses,
      addAddress: (a) => setAddresses((l) => [...l, a]),
      updateAddress: (id, patch) => setAddresses((l) => l.map((a) => (a.id === id ? { ...a, ...patch } : a))),
      deleteAddress: (id) => setAddresses((l) => l.filter((a) => a.id !== id)),
      setDefaultAddress: (id) => setAddresses((l) => l.map((a) => ({ ...a, default: a.id === id }))),
    };
  }, [user, cart, wishlist, categories, products, batches, orders, vendors, customers, reviews, returns, coupons, notifications, addresses]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

const today = () =>
  new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }).replace(/ /g, " ");

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside AppProvider");
  return ctx;
}

/* ---------- derived helpers ---------- */
export const CURRENT_VENDOR_ID = "V01";

export function useVendorScope() {
  const { products, orders, reviews, user } = useApp();
  const vendorId = CURRENT_VENDOR_ID;
  const vendorProducts = products.filter((p) => p.vendorId === vendorId);
  const vendorOrders = orders.filter((o) => o.items.some((i) => i.vendorId === vendorId));
  const vendorReviews = reviews.filter((r) => r.vendorId === vendorId);
  const revenue = vendorOrders.reduce(
    (s, o) => s + o.items.filter((i) => i.vendorId === vendorId).reduce((t, i) => t + i.product.price * i.qty, 0),
    0,
  );
  return { vendorId, vendorProducts, vendorOrders, vendorReviews, revenue, user };
}
