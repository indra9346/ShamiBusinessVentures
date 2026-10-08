import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
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
export type SessionUser = { name: string; email: string; role: Role; phone?: string; avatar?: string; addressKey?: string };
export type CartLine = { id: string; qty: number };
export type Address = (typeof seedAddresses)[number];
export type Customer = (typeof seedCustomers)[number];
export type Vendor = (typeof seedVendors)[number];
export type Review = (typeof seedReviews)[number];
export type Coupon = (typeof seedCoupons)[number];
export type Notif = (typeof seedNotifications)[number] & { source?: "seed" | "live" };


type AppState = {
  hydrated: boolean;
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
  addProduct: (p: Product) => Promise<boolean>;
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
    shippingAddress?: Address;
    delivery?: string;
    subtotal?: number;
    discount?: number;
    tax?: number;
    shipping?: number;
    source?: string;
    paymentDueDate?: string;
  }) => Promise<Order>;
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
  const [wishlistsByUser, setWishlistsByUser] = useState<Record<string, string[]>>({});
  const [products, setProducts] = useState<Product[]>(STATIC_DATA_MODE ? seedProducts : []);
  const [categories, setCategories] = useState<StoreCategory[]>(STATIC_DATA_MODE ? storeCategorySeed : []);
  const [batches, setBatches] = useState<PurchaseBatch[]>(STATIC_DATA_MODE ? seedBatches : []);
  const [orders, setOrders] = useState<Order[]>(STATIC_DATA_MODE ? seedOrders : []);
  const [vendors, setVendors] = useState<Vendor[]>(STATIC_DATA_MODE ? seedVendors : []);
  const [customers, setCustomers] = useState<Customer[]>(STATIC_DATA_MODE ? seedCustomers : []);
  const [reviews, setReviews] = useState<Review[]>(STATIC_DATA_MODE ? seedReviews : []);
  const [returns, setReturns] = useState<ReturnRequest[]>(STATIC_DATA_MODE ? seedReturns : []);
  const [coupons, setCoupons] = useState<Coupon[]>(STATIC_DATA_MODE ? seedCoupons : []);
  const [notifications, setNotifications] = useState<Notif[]>(STATIC_DATA_MODE ? seedNotifications : []);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [addressesByUser, setAddressesByUser] = useState<Record<string, Address[]>>({});
  const [hydrated, setHydrated] = useState(false);

  // The public catalog and dashboard catalog are read from Supabase. Demo fixtures
  // stay available to local development only and are never treated as production data.
  useEffect(() => {
    if (STATIC_DATA_MODE) return;
    let active = true;
    const reloadCatalog = async () => {
      const [productResult, categoryResult] = await Promise.all([
        supabase.from("catalog_products").select("payload"),
        supabase.from("store_categories").select("payload").order("sort_order"),
      ]);
      if (!active) return;
      if (productResult.error) {
        console.error("Could not load the Supabase product catalog:", productResult.error.message);
      } else {
        setProducts(productResult.data.map((row) => row.payload as unknown as Product));
      }
      if (categoryResult.error) {
        console.error("Could not load Supabase store categories:", categoryResult.error.message);
        // Keep the storefront navigable if production has not provisioned the
        // category table yet. These are category labels only; live products are
        // still read exclusively from Supabase.
        setCategories(storeCategorySeed);
      } else {
        const persistedCategories = categoryResult.data.map((row) => row.payload as unknown as StoreCategory);
        // Keep the storefront manageable on a brand-new project before an admin
        // has saved its first category; persisted rows take over as soon as present.
        setCategories(persistedCategories.length ? persistedCategories : storeCategorySeed);
      }
      if (user?.role) {
        const [
          { data: profiles, error: profilesError },
          { data: roleRows, error: rolesError },
          { data: batchRows, error: batchError },
          { data: orderRows, error: orderError },
        ] = await Promise.all([
          supabase.from("profiles").select("id, full_name, email, phone, company, gstin, vendor_id, status, created_at"),
          supabase.from("user_roles").select("user_id, role"),
          supabase.from("batches").select("*").order("purchase_date", { ascending: true }),
          supabase.from("orders").select("*").order("created_at", { ascending: false }),
        ]);
        if (!active) return;
        if (!batchError) {
          setBatches(batchRows.map((row) => ({
            id: row.id,
            batchCode: row.batch_code,
            productId: row.product_id,
            productName: row.product_name,
            vendor: row.vendor || "",
            vendorId: row.vendor_id || "",
            purchaseDate: row.purchase_date || "",
            quantity: Number(row.quantity),
            remainingQty: Number(row.remaining_quantity),
            unitCost: Number(row.unit_cost),
            warehouse: row.warehouse || "",
            status: row.status === "Depleted" ? "Depleted" : "Active",
          })));
        } else {
          console.error("Could not load inventory batches", batchError);
        }
        if (!orderError) {
          const ids = orderRows.map((order) => order.id);
          const { data: itemRows, error: itemError } = ids.length
            ? await supabase.from("order_items").select("*").in("order_id", ids)
            : { data: [], error: null };
          if (!active) return;
          if (itemError) {
            console.error("Could not load order lines", itemError);
          } else {
            const catalogById = new Map((productResult.data ?? []).map((row) => {
              const product = row.payload as unknown as Product;
              return [product.id, product] as const;
            }));
            const itemsByOrder = new Map<string, typeof itemRows>();
            for (const item of itemRows ?? []) itemsByOrder.set(item.order_id, [...(itemsByOrder.get(item.order_id) ?? []), item]);
            const allowedStatuses: OrderStatus[] = ["Placed", "Payment Confirmed", "Accepted", "Packed", "Dispatched", "Out for Delivery", "Delivered", "Cancelled"];
            setOrders(orderRows.map((row) => {
              const orderDate = new Date(row.created_at);
              const shippingAddress = row.shipping_address && typeof row.shipping_address === "object" && !Array.isArray(row.shipping_address)
                ? row.shipping_address as Record<string, unknown>
                : {};
              const orderItems = (itemsByOrder.get(row.id) ?? []).map((item) => {
                const product = catalogById.get(item.product_id) ?? {
                  id: item.product_id, name: item.product_name, sku: item.sku || "", brand: "", vendor: item.vendor || "",
                  vendorId: item.vendor_id || "", category: "", subcategory: "", image: "", mrp: Number(item.unit_price),
                  price: Number(item.unit_price), gst: Number(item.gst_rate), rating: 0, reviews: 0, stock: 0, reserved: 0,
                  sold: 0, weight: "", status: "approved" as const, active: true, tags: [], description: "", specs: [],
                  created: "", updated: "",
                };
                return { product, qty: Number(item.qty), vendor: item.vendor || "", vendorId: item.vendor_id || "", capacity: product.weight, unitPrice: Number(item.unit_price) };
              });
              const paymentStatus = row.payment_status.toLowerCase();
              const payment: Order["payment"] = paymentStatus === "paid" ? "Paid" : paymentStatus.includes("partial") ? "Partially Paid" : paymentStatus === "refunded" ? "Refunded" : paymentStatus === "failed" ? "Failed" : "Pending";
              return {
                id: row.order_no, date: Number.isNaN(orderDate.getTime()) ? row.created_at : orderDate.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }),
                customer: row.customer_name, customerId: row.user_id || "", email: row.customer_email, phone: row.customer_phone || "",
                ...(row.customer_gstin ? { gstin: row.customer_gstin } : {}), items: orderItems, subtotal: Number(row.subtotal), discount: Number(row.discount),
                tax: Number(row.gst_amount), shipping: Number(row.shipping), amount: Number(row.total), payment,
                ...(Number(row.paid_amount) ? { paidAmount: Number(row.paid_amount) } : {}), method: row.payment_method || "", txn: "",
                status: allowedStatuses.includes(row.order_status as OrderStatus) ? row.order_status as OrderStatus : "Placed",
                address: String(shippingAddress["line"] || ""), city: String(shippingAddress["city"] || ""), state: String(shippingAddress["state"] || ""),
                pin: String(shippingAddress["pin"] || ""), delivery: row.shipping_method === "Express" ? "Express Freight — next business day" : "Standard Freight — 2 to 4 days",
                ...(row.coupon ? { coupon: row.coupon } : {}),
              };
            }));
          }
        } else {
          console.error("Could not load orders", orderError);
        }
        if (!profilesError && !rolesError) {
          const rolesByUser = new Map(roleRows.map((row) => [row.user_id, row.role]));
          const asDate = (value: string) => new Date(value).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
          setVendors(profiles.filter((profile) => rolesByUser.get(profile.id) === "vendor").map((profile) => ({
            id: profile.vendor_id || profile.id,
            business: profile.company || profile.full_name,
            owner: profile.full_name,
            email: profile.email,
            phone: profile.phone || "",
            city: "",
            commission: 0,
            status: profile.status,
            gst: profile.gstin || "",
            rating: 0,
            joined: asDate(profile.created_at),
            bank: "",
            products: 0,
            orders: 0,
            sales: 0,
          }) as Vendor));
          setCustomers(profiles.filter((profile) => rolesByUser.get(profile.id) === "customer").map((profile) => ({
            id: profile.id,
            name: profile.full_name,
            email: profile.email,
            phone: profile.phone || "",
            city: "",
            state: "",
            pin: "",
            gst: profile.gstin || "",
            address: "",
            joined: asDate(profile.created_at),
            orders: 0,
            spend: 0,
            lastOrder: "—",
            status: profile.status.toLowerCase(),
            avatar: profile.full_name.split(/\s+/).map((word) => word[0] ?? "").join("").slice(0, 2),
          }) as Customer));
        } else {
          console.error("Could not load authorized profile records", profilesError ?? rolesError);
        }
        if (user.role === "customer") {
          const { data: { user: authUser } } = await supabase.auth.getUser();
          if (authUser) {
            const { data: addressRows, error: addressError } = await supabase.from("addresses")
              .select("*").eq("user_id", authUser.id).order("created_at", { ascending: true });
            if (!active) return;
            if (addressError) {
              console.error("Could not load saved addresses", addressError);
            } else {
              const ownerKey = user.addressKey ?? addressOwnerKey(user);
              const saved = (addressRows ?? []).map((row) => ({
                id: row.id, label: row.label, name: row.name, phone: row.phone, line: row.line,
                city: row.city, state: row.state, pin: row.pin, landmark: row.landmark || "", default: row.is_default,
              }) as Address);
              setAddresses(saved);
              if (ownerKey) setAddressesByUser((existing) => ({ ...existing, [ownerKey]: saved }));
            }
          }
        }
      }
    };
    void reloadCatalog();
    const channel = supabase.channel(`catalog-${user?.role ?? "public"}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "catalog_products" }, () => { void reloadCatalog(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "store_categories" }, () => { void reloadCatalog(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, () => { void reloadCatalog(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "order_items" }, () => { void reloadCatalog(); })
      .subscribe();
    return () => {
      active = false;
      void supabase.removeChannel(channel);
    };
  }, [user?.role]);

  const saveProduct = async (product: Product, newVendorSubmission = false) => {
    if (STATIC_DATA_MODE) {
      if (user?.role === "vendor") {
        const demoVendor = vendors.find((vendor) => vendor.email.toLowerCase() === user.email.toLowerCase())
          ?? vendors.find((vendor) => vendor.status === "approved");
        if (!demoVendor) return false;
        const previewProduct = {
          ...product,
          vendorId: demoVendor.id,
          vendor: demoVendor.business,
          ...(newVendorSubmission ? { status: "pending" as const } : {}),
        };
        setProducts((list) => list.map((item) => item.id === product.id ? previewProduct : item));
      }
      return true;
    }
    const { data: { user: authUser } } = await supabase.auth.getUser();
    if (!authUser) {
      toast.error("Sign in before saving a catalog item");
      return false;
    }
    let record = product;
    if (user?.role === "vendor") {
      const { data: profile, error: profileError } = await supabase.from("profiles")
        .select("vendor_id, company").eq("id", authUser.id).maybeSingle();
      if (profileError || !profile?.vendor_id) {
        toast.error("Your vendor profile is not linked yet. Ask an administrator to assign your vendor account.");
        return false;
      }
      record = {
        ...product,
        vendorId: profile.vendor_id,
        vendor: profile.company || product.vendor,
        ...(newVendorSubmission ? { status: "pending" as const } : {}),
      };
    }
    const { error } = await supabase.from("catalog_products").upsert({
      id: record.id,
      vendor_id: record.vendorId,
      category: record.category,
      status: record.status,
      active: record.active,
      payload: JSON.parse(JSON.stringify(record)),
      updated_at: new Date().toISOString(),
    });
    if (error) {
      console.error("Catalog save failed", error);
      toast.error("Could not save this product", { description: error.message });
      return false;
    }
    if (record !== product) setProducts((list) => list.map((item) => item.id === product.id ? record : item));
    return true;
  };

  const saveCategory = async (category: StoreCategory) => {
    if (STATIC_DATA_MODE) return true;
    const { error } = await supabase.from("store_categories").upsert({
      id: category.id,
      name: category.name,
      enabled: category.enabled,
      sort_order: category.order,
      payload: JSON.parse(JSON.stringify(category)),
      updated_at: new Date().toISOString(),
    });
    if (error) {
      console.error("Category save failed", error);
      toast.error("Could not save this category", { description: error.message });
      return false;
    }
    return true;
  };

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const s = JSON.parse(raw) as Partial<{
          user: SessionUser | null; cart: CartLine[]; wishlist: string[];
          categories: StoreCategory[]; products: Product[]; batches: PurchaseBatch[];
          orders: Order[]; vendors: Vendor[]; customers: Customer[];
          reviews: Review[]; returns: ReturnRequest[]; coupons: Coupon[]; notifications: Notif[];
          addressesByUser: Record<string, Address[]>; wishlistsByUser: Record<string, string[]>;
        }>;
        const restoredUser = s.user ? { ...s.user, addressKey: s.user.addressKey ?? addressOwnerKey(s.user) } : null;
        const savedAddresses = s.addressesByUser ?? {};
        const savedWishlists = s.wishlistsByUser ?? {};
        const restoredOwner = restoredUser?.addressKey ?? "";
        setUser(restoredUser);
        setAddressesByUser(savedAddresses);
        setAddresses(restoredUser?.addressKey ? savedAddresses[restoredUser.addressKey] ?? [] : []);
        setWishlistsByUser(savedWishlists);
        setCart(s.cart ?? []);
        // Old releases stored one shared wishlist without an account owner. It cannot be
        // safely attributed to the current customer, so only restore owner-scoped lists.
        setWishlist(restoredOwner ? savedWishlists[restoredOwner] ?? [] : []);
        if (STATIC_DATA_MODE && s.categories?.length) {
          const savedByName = new Map(s.categories.map((category) => [category.name.toLowerCase(), category]));
          const seededNames = new Set(storeCategorySeed.map((category) => category.name.toLowerCase()));
          const mergedSeed = storeCategorySeed.map((seedCategory) => {
            const saved = savedByName.get(seedCategory.name.toLowerCase());
            if (!saved) return seedCategory;
            const merged = { ...seedCategory, ...saved, image: saved.image || seedCategory.image };
            if (merged.name === "Rice" && merged.grades.some((grade) => ["Grade A", "Grade B"].includes(grade))) {
              merged.grades = ["Raw Rice", "Steam Rice", "Premium Rice"];
            }
            return merged;
          });
          setCategories([...mergedSeed, ...s.categories.filter((category) => !seededNames.has(category.name.toLowerCase()))]);
        }
        if (STATIC_DATA_MODE) {
          if (s.products?.length) setProducts(s.products);
          if (s.batches?.length) setBatches(s.batches);
          if (s.orders?.length) setOrders(s.orders);
          if (s.vendors?.length) setVendors(s.vendors);
          if (s.customers?.length) setCustomers(s.customers);
          if (s.reviews?.length) setReviews(s.reviews);
          if (s.returns?.length) setReturns(s.returns);
          if (s.coupons?.length) setCoupons(s.coupons);
          if (s.notifications?.length) setNotifications(s.notifications);
        }
      }
    } catch {
      /* ignore */
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated || !user?.addressKey) return;
    setAddressesByUser((saved) => saved[user.addressKey!] === addresses
      ? saved
      : { ...saved, [user.addressKey!]: addresses });
  }, [hydrated, user, addresses]);

  useEffect(() => {
    if (!hydrated || !user?.addressKey) return;
    setWishlistsByUser((saved) => saved[user.addressKey!] === wishlist
      ? saved
      : { ...saved, [user.addressKey!]: wishlist });
  }, [hydrated, user, wishlist]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({ user, cart, wishlist, wishlistsByUser, categories, products, batches, orders, vendors, customers, reviews, returns, coupons, notifications, addressesByUser }),
      );
    } catch {
      /* quota */
    }
  }, [hydrated, user, cart, wishlist, wishlistsByUser, categories, products, batches, orders, vendors, customers, reviews, returns, coupons, notifications, addressesByUser]);


  const value = useMemo<AppState>(() => {
    const cartItems = cart
      .map((l) => ({ product: products.find((p) => p.id === l.id)!, qty: l.qty }))
      .filter((l) => l.product);

    const pushNotif = (title: string, body: string, type: string, role: Notif["role"] = "admin") =>
      setNotifications((n) => [
        { id: Date.now() + Math.floor(Math.random() * 999), role, title, body, type, time: "just now", read: false, source: "live" },
        ...n,
      ]);

    return {
      hydrated,
      user,
      login: (u) => {
        const signedInUser = { ...u, addressKey: u.addressKey ?? addressOwnerKey(u) };
        setUser(signedInUser);
        setAddresses(signedInUser.addressKey ? addressesByUser[signedInUser.addressKey] ?? [] : []);
        setWishlist(signedInUser.addressKey ? wishlistsByUser[signedInUser.addressKey] ?? [] : []);
      },
      logout: () => { setUser(null); setAddresses([]); setWishlist([]); setCart([]); },
      updateProfile: (p) => {
        const current = user;
        if (!current) return;
        const changeEmail = Boolean(p.email && p.email.trim().toLowerCase() !== current.email.trim().toLowerCase());
        const localPatch = { ...p };
        if (changeEmail) delete localPatch.email;
        setUser({ ...current, ...localPatch });
        if (STATIC_DATA_MODE) return;
        void (async () => {
          const { data: { user: authUser }, error: authError } = await supabase.auth.getUser();
          if (authError || !authUser) throw new Error("Sign in again before updating your profile");
          const profilePatch = {
            ...(p.name !== undefined ? { full_name: p.name } : {}),
            ...(p.phone !== undefined ? { phone: p.phone || null } : {}),
          };
          if (Object.keys(profilePatch).length) {
            const { error } = await supabase.from("profiles").update(profilePatch).eq("id", authUser.id);
            if (error) throw error;
          }
          if (changeEmail && p.email) {
            const { error } = await supabase.auth.updateUser({ email: p.email.trim().toLowerCase() });
            if (error) throw error;
            toast.info("Confirm the email change from the message sent to your new address.");
          }
        })().catch((error: unknown) => {
          toast.error("Could not update your profile", { description: error instanceof Error ? error.message : "Please retry." });
          setUser(current);
        });
      },

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
      addCategory: (c) => {
        const category = { ...c, id: `C${Date.now().toString().slice(-6)}`, order: categories.length + 1 };
        setCategories((list) => [...list, category]);
        void saveCategory(category).then((ok) => {
          if (!ok) setCategories((list) => list.filter((item) => item.id !== category.id));
        });
      },
      updateCategory: (id, patch) => {
        const category = categories.find((item) => item.id === id);
        if (!category) return;
        const next = { ...category, ...patch };
        setCategories((list) => list.map((item) => item.id === id ? next : item));
        void saveCategory(next).then((ok) => {
          if (!ok) setCategories((list) => list.map((item) => item.id === id ? category : item));
        });
      },
      deleteCategory: (id) => {
        const existing = categories.find((category) => category.id === id);
        setCategories((list) => list.filter((category) => category.id !== id));
        if (!STATIC_DATA_MODE) void supabase.from("store_categories").delete().eq("id", id).then(({ error }) => {
          if (error) {
            toast.error("Could not delete this category", { description: error.message });
            if (existing) setCategories((list) => [...list, existing].sort((a, b) => a.order - b.order));
          }
        });
      },
      moveCategory: (id, dir) =>
        setCategories((l) => {
          const sorted = [...l].sort((a, b) => a.order - b.order);
          const i = sorted.findIndex((c) => c.id === id);
          const j = i + dir;
          if (i < 0 || j < 0 || j >= sorted.length) return l;
          [sorted[i]!, sorted[j]!] = [sorted[j]!, sorted[i]!];
          const reordered = sorted.map((c, k) => ({ ...c, order: k + 1 }));
          reordered.forEach((category) => { void saveCategory(category); });
          return reordered;
        }),

      products,
      addProduct: async (p) => {
        setProducts((list) => [p, ...list.filter((item) => item.id !== p.id)]);
        const saved = await saveProduct(p, user?.role === "vendor");
        if (!saved) setProducts((list) => list.filter((item) => item.id !== p.id));
        return saved;
      },
      updateProduct: (id, patch) => {
        // Enforce Admin-only pricing and cost modifications (Requirement 3)
        const hasPriceOrCostChange =
          patch.price !== undefined ||
          patch.mrp !== undefined ||
          patch.purchasePrice !== undefined;

        if (user && user.role !== "admin" && hasPriceOrCostChange) {
          throw new Error("Unauthorized: Only an Administrator is permitted to modify pricing and cost.");
        }

        const existing = products.find((product) => product.id === id);
        if (!existing) return;
        const updated = { ...existing, ...patch, updated: today() };
        setProducts((list) => list.map((p) => (p.id === id ? updated : p)));
        void saveProduct(updated).then((ok) => {
          if (!ok) setProducts((list) => list.map((item) => item.id === id ? existing : item));
        });
      },
      deleteProduct: (id) => {
        const existing = products.find((product) => product.id === id);
        setProducts((list) => list.filter((p) => p.id !== id));
        if (!STATIC_DATA_MODE) void supabase.from("catalog_products").delete().eq("id", id).then(({ error }) => {
          if (error) {
            toast.error("Could not delete this product", { description: error.message });
            if (existing) setProducts((list) => [existing, ...list.filter((product) => product.id !== id)]);
          }
        });
      },
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
          void saveProduct(copy);
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
        const product = products.find((item) => item.id === batchData.productId);
        if (product) void saveProduct({ ...product, stock: product.stock + batchData.remainingQty, updated: today() });
        if (!STATIC_DATA_MODE) void supabase.from("batches").insert({
          batch_code: batchData.batchCode,
          product_id: batchData.productId,
          product_name: batchData.productName,
          vendor: batchData.vendor,
          vendor_id: batchData.vendorId || null,
          quantity: batchData.quantity,
          remaining_quantity: batchData.remainingQty,
          unit_cost: batchData.unitCost,
          purchase_date: batchData.purchaseDate || null,
          warehouse: batchData.warehouse,
          status: batchData.remainingQty > 0 ? "Active" : "Depleted",
        }).select("id").single().then(({ data, error }) => {
          if (error) {
            toast.error("Could not save this inventory batch", { description: error.message });
            setBatches((list) => list.filter((batch) => batch.batchCode !== batchData.batchCode));
            if (product) {
              setProducts((list) => list.map((item) => item.id === product.id ? product : item));
              void saveProduct(product);
            }
          } else if (data) {
            setBatches((list) => list.map((batch) => batch.batchCode === batchData.batchCode ? { ...batch, id: data.id } : batch));
          }
        });
      },
      updateBatch: (batchId, patch) => {
        if (user && user.role !== "admin" && patch.unitCost !== undefined) {
          throw new Error("Unauthorized: Only an Administrator can modify batch purchase costs.");
        }
        const existing = batches.find((batch) => batch.id === batchId);
        setBatches((curr) => curr.map((b) => (b.id === batchId ? { ...b, ...patch } : b)));
        if (existing) {
          const dbPatch = {
            ...(patch.batchCode !== undefined ? { batch_code: patch.batchCode } : {}),
            ...(patch.productId !== undefined ? { product_id: patch.productId } : {}),
            ...(patch.productName !== undefined ? { product_name: patch.productName } : {}),
            ...(patch.vendor !== undefined ? { vendor: patch.vendor } : {}),
            ...(patch.vendorId !== undefined ? { vendor_id: patch.vendorId || null } : {}),
            ...(patch.purchaseDate !== undefined ? { purchase_date: patch.purchaseDate || null } : {}),
            ...(patch.quantity !== undefined ? { quantity: patch.quantity } : {}),
            ...(patch.remainingQty !== undefined ? { remaining_quantity: patch.remainingQty } : {}),
            ...(patch.unitCost !== undefined ? { unit_cost: patch.unitCost } : {}),
            ...(patch.warehouse !== undefined ? { warehouse: patch.warehouse } : {}),
            ...(patch.status !== undefined ? { status: patch.status } : {}),
          };
          if (!STATIC_DATA_MODE) void supabase.from("batches").update(dbPatch).eq("id", batchId).then(({ error }) => {
            if (error) {
              toast.error("Could not update this inventory batch", { description: error.message });
              setBatches((list) => list.map((batch) => batch.id === batchId ? existing : batch));
            }
          });
        }
      },
      deleteBatch: (batchId) => {
        if (user && user.role !== "admin") {
          throw new Error("Unauthorized: Only an Administrator can delete purchase batches.");
        }
        const existing = batches.find((batch) => batch.id === batchId);
        setBatches((curr) => curr.filter((b) => b.id !== batchId));
        if (!STATIC_DATA_MODE) void supabase.from("batches").delete().eq("id", batchId).then(({ error }) => {
          if (error) {
            toast.error("Could not delete this inventory batch", { description: error.message });
            if (existing) setBatches((list) => [existing, ...list]);
          }
        });
      },
      getFIFOCost: (productId) => getCurrentFIFOCost(productId, batches),
      getInventoryValuation: (productId) => calculateInventoryValuation(productId, batches),
      getAverageSellingPrice: (product) => getProductAverageSellingPrice(product, orders),

      orders,
      placeOrder: async ({ lines, method, payment, coupon, customerIndex = 0, customerOverride, shippingAddress, delivery, subtotal, discount, tax, shipping, source, paymentDueDate }) => {
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
        if (shippingAddress) {
          order.address = shippingAddress.line;
          order.city = shippingAddress.city;
          order.state = shippingAddress.state;
          order.pin = shippingAddress.pin;
          order.phone = shippingAddress.phone;
        }
        if (subtotal !== undefined) order.subtotal = subtotal;
        if (discount !== undefined) order.discount = discount;
        if (tax !== undefined) order.tax = tax;
        if (shipping !== undefined) order.shipping = shipping;
        if (subtotal !== undefined || discount !== undefined || tax !== undefined || shipping !== undefined) {
          order.amount = (order.subtotal ?? 0) - (order.discount ?? 0) + (order.tax ?? 0) + (order.shipping ?? 0);
        }
        if (source) order.source = source;
        if (paymentDueDate) order.paymentDueDate = paymentDueDate;
        if (!STATIC_DATA_MODE) {
          const { data: { user: authUser }, error: authError } = await supabase.auth.getUser();
          if (authError || !authUser) throw new Error("Sign in again before placing your order.");
          order.customerId = customerOverride?.id ?? authUser.id;
          if (!customerOverride) delete order.gstin;
          const addressPayload = {
            name: shippingAddress?.name ?? customerOverride?.name ?? order.customer,
            phone: shippingAddress?.phone ?? customerOverride?.phone ?? order.phone,
            line: order.address,
            city: order.city,
            state: order.state,
            pin: order.pin,
          };
          const { data, error } = await supabase.rpc("place_marketplace_order", {
            _order_no: id,
            _target_user_id: customerOverride?.id ?? authUser.id,
            _customer_name: order.customer,
            _customer_email: order.email,
            _customer_phone: order.phone || null,
            _customer_gstin: order.gstin || null,
            _shipping_address: addressPayload,
            _shipping_method: delivery?.toLowerCase().includes("express") ? "Express" : "Standard",
            _payment_method: method,
            _items: lines.map((line) => ({ product_id: line.product.id, qty: line.qty })),
          });
          if (error || !data) {
            const message = error?.message ?? "The order could not be saved";
            toast.error("Order was not placed", { description: message });
            throw new Error(message);
          }
          const saved = data as { subtotal: number; discount: number; gst_amount: number; shipping: number; total: number; items: Array<{ product_id: string; unit_price: number }> };
          order.subtotal = Number(saved.subtotal);
          order.discount = Number(saved.discount);
          order.tax = Number(saved.gst_amount);
          order.shipping = Number(saved.shipping);
          order.amount = Number(saved.total);
          order.payment = "Pending";
          order.status = "Placed";
          order.paidAmount = 0;
          order.txn = "";
          order.items = order.items.map((item) => ({
            ...item,
            unitPrice: Number(saved.items.find((savedItem) => savedItem.product_id === item.product.id)?.unit_price ?? item.unitPrice),
          }));
        }
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

        pushNotif("New order received", `${id} was placed worth â‚¹${order.amount.toLocaleString("en-IN")}.`, "info");
        return order;
      },
      updateOrderStatus: (id, status) => {
        const existing = orders.find((order) => order.id === id);
        setOrders((list) => list.map((order) => order.id === id ? { ...order, status } : order));
        if (!STATIC_DATA_MODE) void supabase.from("orders").update({ order_status: status }).eq("order_no", id).then(({ error }) => {
          if (error) {
            toast.error("Could not update order status", { description: error.message });
            if (existing) setOrders((list) => list.map((order) => order.id === id ? existing : order));
          }
        });
      },
      updateOrderDelivery: (orderId, delivery) => {
        const existing = orders.find((order) => order.id === orderId);
        setOrders((list) => list.map((order) => order.id === orderId ? { ...order, delivery } : order));
        if (!STATIC_DATA_MODE) void supabase.from("orders").update({
          shipping_method: delivery.toLowerCase().includes("express") ? "Express" : "Standard",
        }).eq("order_no", orderId).then(({ error }) => {
          if (error) {
            toast.error("Could not update delivery method", { description: error.message });
            if (existing) setOrders((list) => list.map((order) => order.id === orderId ? existing : order));
          }
        });
      },
      updateOrderItem: (orderId, index, patch) => {
        if (!STATIC_DATA_MODE) {
          toast.error("Order item editing is unavailable until the protected order-edit workflow is configured");
          return false;
        }
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
        if (!STATIC_DATA_MODE) {
          toast.error("Payment confirmation is not connected to a verified payment workflow yet");
          return;
        }
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
        pushNotif("Payment confirmed", `${inr(amount)} confirmed for ${id}${utr.trim() ? ` Â· UTR ${utr.trim()}` : ""}.`, "success", "admin");
        pushNotif("Payment confirmed", `We have confirmed your payment of ${inr(amount)} for order ${id}.`, "success", "customer");
      },
      refundOrder: (id) => {
        if (!STATIC_DATA_MODE) {
          toast.error("Refunds are not connected to a payment provider yet");
          return;
        }
        setOrders((list) => list.map((o) => (o.id === id ? { ...o, payment: "Refunded", status: "Cancelled" } : o)));
      },

      vendors,
      setVendorStatus: (id, status) => setVendors((l) => l.map((v) => (v.id === id ? { ...v, status } : v))),
      customers,
      setCustomerStatus: (id, status) => {
        const previous = customers.find((customer) => customer.id === id);
        setCustomers((list) => list.map((customer) => customer.id === id ? { ...customer, status } : customer));
        if (previous && previous.status !== status) pushNotif("Customer status updated", `${previous.name}: ${previous.status} â†’ ${status}.`, "info", "admin");
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
      addAddress: (a) => {
        setAddresses((list) => [...list, a]);
        if (!STATIC_DATA_MODE) void (async () => {
          const { data: { user: authUser } } = await supabase.auth.getUser();
          if (!authUser) throw new Error("Sign in to save an address");
          const { error } = await supabase.from("addresses").insert({
            id: a.id, user_id: authUser.id, label: a.label, name: a.name, phone: a.phone,
            line: a.line, city: a.city, state: a.state, pin: a.pin, landmark: a.landmark || null, is_default: a.default,
          });
          if (error) throw error;
        })().catch((error: unknown) => {
          toast.error("Could not save this address", { description: error instanceof Error ? error.message : "Please retry." });
          setAddresses((list) => list.filter((item) => item.id !== a.id));
        });
      },
      updateAddress: (id, patch) => {
        const existing = addresses.find((address) => address.id === id);
        const updated = { ...existing, ...patch } as Address;
        setAddresses((list) => list.map((address) => address.id === id ? updated : address));
        if (!STATIC_DATA_MODE) void supabase.from("addresses").update({
          ...(patch.label !== undefined ? { label: patch.label } : {}),
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
          ...(patch.line !== undefined ? { line: patch.line } : {}),
          ...(patch.city !== undefined ? { city: patch.city } : {}),
          ...(patch.state !== undefined ? { state: patch.state } : {}),
          ...(patch.pin !== undefined ? { pin: patch.pin } : {}),
          ...(patch.landmark !== undefined ? { landmark: patch.landmark || null } : {}),
          ...(patch.default !== undefined ? { is_default: patch.default } : {}),
        }).eq("id", id).then(({ error }) => {
          if (error) {
            toast.error("Could not update this address", { description: error.message });
            if (existing) setAddresses((list) => list.map((address) => address.id === id ? existing : address));
          }
        });
      },
      deleteAddress: (id) => {
        const existing = addresses.find((address) => address.id === id);
        setAddresses((list) => list.filter((address) => address.id !== id));
        if (!STATIC_DATA_MODE) void supabase.from("addresses").delete().eq("id", id).then(({ error }) => {
          if (error) {
            toast.error("Could not delete this address", { description: error.message });
            if (existing) setAddresses((list) => [...list, existing]);
          }
        });
      },
      setDefaultAddress: (id) => {
        const existing = addresses;
        setAddresses((list) => list.map((address) => ({ ...address, default: address.id === id })));
        if (!STATIC_DATA_MODE) void (async () => {
          const { data: { user: authUser } } = await supabase.auth.getUser();
          if (!authUser) throw new Error("Sign in to update your default address");
          const clear = await supabase.from("addresses").update({ is_default: false }).eq("user_id", authUser.id);
          if (clear.error) throw clear.error;
          const selected = await supabase.from("addresses").update({ is_default: true }).eq("id", id).eq("user_id", authUser.id);
          if (selected.error) throw selected.error;
        })().catch((error: unknown) => {
          toast.error("Could not change your default address", { description: error instanceof Error ? error.message : "Please retry." });
          setAddresses(existing);
        });
      },
    };
  }, [user, cart, wishlist, wishlistsByUser, categories, products, batches, orders, vendors, customers, reviews, returns, coupons, notifications, addresses, addressesByUser]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

const today = () =>
  new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }).replace(/ /g, " ");

function addressOwnerKey(user: SessionUser | null) {
  if (!user || user.role !== "customer") return "";
  if (user.addressKey) return user.addressKey;
  const phone = user.phone?.replace(/\D/g, "").slice(-10);
  if (phone) return `phone:${phone}`;
  const email = user.email.trim().toLowerCase();
  return email ? `email:${email}` : "";
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside AppProvider");
  return ctx;
}

/* ---------- derived helpers ---------- */
export const CURRENT_VENDOR_ID = "V01";

export function useVendorScope() {
  const { products, orders, reviews, vendors, user } = useApp();
  const [vendorId, setVendorId] = useState("");
  useEffect(() => {
    let active = true;
    if (user?.role !== "vendor") {
      setVendorId("");
      return () => { active = false; };
    }
    void (async () => {
      if (STATIC_DATA_MODE) {
        const demoVendor = vendors.find((vendor) => vendor.email.toLowerCase() === user.email.toLowerCase()) ?? vendors.find((vendor) => vendor.status === "approved");
        if (active) setVendorId(demoVendor?.id ?? "");
        return;
      }
      const { data: { user: authUser } } = await supabase.auth.getUser();
      if (!authUser) return;
      const { data, error } = await supabase.from("profiles").select("vendor_id").eq("id", authUser.id).maybeSingle();
      if (active && !error) setVendorId(data?.vendor_id ?? "");
    })();
    return () => { active = false; };
  }, [user?.role, user?.email, vendors]);
  const vendorProducts = products.filter((p) => p.vendorId === vendorId);
  const vendorOrders = orders.filter((o) => o.items.some((i) => i.vendorId === vendorId));
  const vendorReviews = reviews.filter((r) => r.vendorId === vendorId);
  const revenue = vendorOrders.reduce(
    (s, o) => s + o.items.filter((i) => i.vendorId === vendorId).reduce((t, i) => t + i.product.price * i.qty, 0),
    0,
  );
  return { vendorId, vendorProducts, vendorOrders, vendorReviews, revenue, user };
}
