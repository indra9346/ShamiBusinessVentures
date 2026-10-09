import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
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
export type SessionUser = { id?: string; name: string; email: string; role: Role; phone?: string; avatar?: string; addressKey?: string };
export type CartLine = { id: string; qty: number };
export type Address = (typeof seedAddresses)[number];
export type Customer = (typeof seedCustomers)[number];
export type Vendor = (typeof seedVendors)[number] & { avatar?: string; businessAddress?: string };
export type Review = (typeof seedReviews)[number] & { reply?: string };
export type Coupon = (typeof seedCoupons)[number];
export type Notif = (typeof seedNotifications)[number] & { source?: "seed" | "live"; databaseId?: string };


type AppState = {
  hydrated: boolean;
  user: SessionUser | null;
  login: (u: SessionUser) => void;
  logout: () => void;
  updateProfile: (p: Partial<SessionUser>) => Promise<boolean>;

  cart: CartLine[];
  cartItems: { product: Product; qty: number }[];
  cartCount: number;
  subtotal: number;
  productCatalogStatus: "loading" | "ready" | "unavailable";
  categoryCatalogStatus: "loading" | "ready" | "unavailable";
  addToCart: (id: string, qty?: number) => void;
  setQty: (id: string, qty: number) => void;
  removeFromCart: (id: string) => void;
  clearCart: () => void;

  wishlist: string[];
  toggleWishlist: (id: string) => void;

  categories: StoreCategory[];
  addCategory: (c: Omit<StoreCategory, "id" | "order">) => Promise<boolean>;
  updateCategory: (id: string, patch: Partial<StoreCategory>) => Promise<boolean>;
  deleteCategory: (id: string) => Promise<boolean>;
  moveCategory: (id: string, dir: -1 | 1) => void;

  products: Product[];
  addProduct: (p: Product) => Promise<boolean>;
  updateProduct: (id: string, patch: Partial<Product>) => Promise<boolean>;
  deleteProduct: (id: string) => Promise<boolean>;
  duplicateProduct: (id: string) => Promise<boolean>;

  batches: PurchaseBatch[];
  addBatch: (b: Omit<PurchaseBatch, "id">) => Promise<boolean>;
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
  updateOrderStatus: (id: string, status: OrderStatus) => Promise<boolean>;
  updateOrderItem: (orderId: string, index: number, patch: { qty?: number; capacity?: string; unitPrice?: number }) => boolean;
  updateOrderDelivery: (orderId: string, delivery: string) => void;
  confirmPayment: (id: string, amount: number, utr: string, advancePercent?: number) => Promise<boolean>;
  refundOrder: (id: string) => Promise<boolean>;

  vendors: Vendor[];
  setVendorStatus: (id: string, status: string) => Promise<boolean>;
  setVendorCommission: (id: string, rate: number) => Promise<boolean>;
  customers: Customer[];
  setCustomerStatus: (id: string, status: string) => Promise<boolean>;

  reviews: Review[];
  setReviewStatus: (id: string, status: string) => Promise<boolean>;
  deleteReview: (id: string) => Promise<boolean>;
  replyReview: (id: string, reply: string) => Promise<boolean>;
  reportReview: (id: string, reason: string) => Promise<boolean>;

  returns: ReturnRequest[];
  setReturnStatus: (id: string, status: string, refund?: string) => Promise<boolean>;
  requestReturn: (orderItemId: string, quantity: number, reason: string) => Promise<boolean>;

  coupons: Coupon[];
  addCoupon: (c: Coupon) => Promise<boolean>;
  deleteCoupon: (code: string) => Promise<boolean>;

  notifications: Notif[];
  markRead: (id: number) => Promise<boolean>;
  markAllRead: () => Promise<boolean>;
  deleteNotification: (id: number) => Promise<boolean>;

  addresses: Address[];
  addAddress: (a: Address) => Promise<boolean>;
  updateAddress: (id: string, patch: Partial<Address>) => Promise<boolean>;
  deleteAddress: (id: string) => Promise<boolean>;
  setDefaultAddress: (id: string) => Promise<boolean>;
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
  const [productCatalogStatus, setProductCatalogStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const [categoryCatalogStatus, setCategoryCatalogStatus] = useState<"loading" | "ready" | "unavailable">("loading");

  // The public catalog and dashboard catalog are read from Supabase. Demo fixtures
  // stay available to local development only and are never treated as production data.
  useEffect(() => {
    if (STATIC_DATA_MODE) {
      setProductCatalogStatus("ready");
      setCategoryCatalogStatus("ready");
      return;
    }
    let active = true;
    const reloadCatalog = async () => {
      setProductCatalogStatus("loading");
      setCategoryCatalogStatus("loading");
      const [productResult, categoryResult] = await Promise.all([
        supabase.from("catalog_products").select("payload"),
        supabase.from("store_categories").select("payload").order("sort_order"),
      ]);
      if (!active) return;
      if (productResult.error) {
        console.error("Could not load the Supabase product catalog:", productResult.error.message);
        setProductCatalogStatus("unavailable");
        setProducts([]);
      } else {
        setProductCatalogStatus("ready");
        setProducts(
          productResult.data.map((row) => {
            const p = row.payload as unknown as Product;
            return {
              ...p,
              image: p.image || `/products/${p.category.toLowerCase()}.jpg`,
            };
          }),
        );
      }
      if (categoryResult.error) {
        console.error("Could not load Supabase store categories:", categoryResult.error.message);
        setCategoryCatalogStatus("unavailable");
        // Seed labels keep navigation available; they are not live category records.
        setCategories(storeCategorySeed);
      } else {
        setCategoryCatalogStatus("ready");
        const persistedCategories = categoryResult.data.map((row) => {
          const payload = row.payload as unknown as StoreCategory;
          const seed = storeCategorySeed.find(
            (s) => s.id === payload.id || s.name.toLowerCase() === payload.name.toLowerCase(),
          );
          return {
            ...payload,
            image: payload.image || seed?.image || `/categories/${payload.name.toLowerCase()}.jpg`,
          };
        });
        setCategories(persistedCategories.length > 0 ? persistedCategories : storeCategorySeed);
      }
      if (user?.role) {
        const [
          { data: profiles, error: profilesError },
          { data: roleRows, error: rolesError },
          { data: batchRows, error: batchError },
          { data: orderRows, error: orderError },
          { data: reviewRows, error: reviewError },
          { data: returnRows, error: returnError },
          { data: couponRows, error: couponError },
        ] = await Promise.all([
          supabase.from("profiles").select("id, full_name, email, phone, company, gstin, avatar_url, business_city, business_address, vendor_id, commission_rate, status, created_at"),
          supabase.from("user_roles").select("user_id, role"),
          supabase.from("batches").select("*").order("purchase_date", { ascending: true }),
          supabase.from("orders").select("*").order("created_at", { ascending: false }),
          supabase.from("product_reviews").select("*").order("created_at", { ascending: false }),
          supabase.from("return_requests").select("*").order("created_at", { ascending: false }),
          supabase.from("coupons").select("*").order("created_at", { ascending: false }),
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
          const [{ data: itemRows, error: itemError }, { data: paymentRows, error: paymentError }] = ids.length
            ? await Promise.all([
              supabase.from("order_items").select("*").in("order_id", ids),
              supabase.from("payments").select("*").in("order_id", ids).order("created_at", { ascending: false }),
            ])
            : [{ data: [], error: null }, { data: [], error: null }];
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
            const latestPaymentByOrder = new Map<string, NonNullable<typeof paymentRows>[number]>();
            for (const payment of paymentRows ?? []) if (payment.order_id && !latestPaymentByOrder.has(payment.order_id)) latestPaymentByOrder.set(payment.order_id, payment);
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
                return { product, qty: Number(item.qty), vendor: item.vendor || "", vendorId: item.vendor_id || "", capacity: product.weight, unitPrice: Number(item.unit_price), dbItemId: item.id };
              });
              const paymentStatus = row.payment_status.toLowerCase();
              const latestPayment = latestPaymentByOrder.get(row.id);
              const payment: Order["payment"] = paymentStatus === "paid" ? "Paid" : paymentStatus.includes("partial") ? "Partially Paid" : paymentStatus === "refunded" ? "Refunded" : paymentStatus === "failed" ? "Failed" : "Pending";
              return {
                id: row.order_no, date: Number.isNaN(orderDate.getTime()) ? row.created_at : orderDate.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }),
                customer: row.customer_name, customerId: row.user_id || "", email: row.customer_email, phone: row.customer_phone || "",
                ...(row.customer_gstin ? { gstin: row.customer_gstin } : {}), items: orderItems, subtotal: Number(row.subtotal), discount: Number(row.discount),
                tax: Number(row.gst_amount), shipping: Number(row.shipping), amount: Number(row.total), payment,
                ...(Number(row.paid_amount) ? { paidAmount: Number(row.paid_amount) } : {}), method: row.payment_method || "", txn: latestPayment?.txn_ref || "",
                ...(latestPayment?.txn_ref ? { utr: latestPayment.txn_ref } : {}),
                status: allowedStatuses.includes(row.order_status as OrderStatus) ? row.order_status as OrderStatus : "Placed",
                address: String(shippingAddress["line"] || ""), city: String(shippingAddress["city"] || ""), state: String(shippingAddress["state"] || ""),
                pin: String(shippingAddress["pin"] || ""), delivery: row.shipping_method === "Express" ? "Express Freight — next business day" : "Standard Freight — 2 to 4 days",
                ...(row.coupon ? { coupon: row.coupon } : {}),
              };
            }));
          }
          if (paymentError) console.error("Could not load payment references", paymentError.message);
        } else {
          console.error("Could not load orders", orderError);
        }
        const asDate = (value: string) => new Date(value).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
        const liveProducts = (productResult.data ?? []).map((row) => row.payload as unknown as Product);
        if (!reviewError) {
          setReviews((reviewRows ?? []).map((row) => {
            const product = liveProducts.find((item) => item.id === row.product_id);
            const customer = profiles?.find((profile) => profile.id === row.customer_id);
            const vendor = profiles?.find((profile) => profile.vendor_id === row.vendor_id);
            return {
              id: row.id, product: product?.name ?? row.product_id, productId: row.product_id,
              customer: customer?.full_name || "Customer", customerId: row.customer_id,
              avatar: (customer?.full_name || "C").split(/\s+/).map((word) => word[0] ?? "").join("").slice(0, 2),
              vendor: vendor?.company || vendor?.full_name || "Vendor", vendorId: row.vendor_id,
              rating: row.rating, title: row.title, body: row.body, date: asDate(row.created_at), status: row.status,
              ...(row.vendor_reply ? { reply: row.vendor_reply } : {}),
            };
          }) as Review[]);
        } else console.error("Could not load product reviews", reviewError);
        if (!returnError) {
          setReturns((returnRows ?? []).map((row) => {
            const customer = profiles?.find((profile) => profile.id === row.customer_id);
            const product = liveProducts.find((item) => item.id === row.product_id);
            const vendor = profiles?.find((profile) => profile.vendor_id === row.vendor_id);
            const order = orderRows?.find((item) => item.id === row.order_id);
            return {
              id: row.id, order: order?.order_no ?? row.order_id, customer: customer?.full_name || "Customer",
              product: product?.name || row.product_id, vendor: vendor?.company || vendor?.full_name || "Vendor",
              reason: row.reason, amount: Number(row.amount), date: asDate(row.created_at), status: row.status, refund: row.refund_status,
            };
          }) as ReturnRequest[]);
        } else console.error("Could not load return requests", returnError);
        if (!couponError) {
          const todayISO = new Date().toISOString().slice(0, 10);
          setCoupons((couponRows ?? []).map((row) => ({
            code: row.code, type: row.discount_type,
            value: row.discount_type === "Percentage" ? `${row.discount_value}%` : `₹${row.discount_value}`,
            min: Number(row.minimum_order), max: Number(row.maximum_discount),
            start: asDate(row.starts_on), end: asDate(row.ends_on), limit: row.usage_limit, used: row.used_count,
            status: !row.active || row.used_count >= row.usage_limit || row.ends_on < todayISO ? "Expired" : row.starts_on > todayISO ? "Scheduled" : "Active",
          })));
        } else console.error("Could not load coupons", couponError);
        if (!profilesError && !rolesError) {
          const rolesByUser = new Map(roleRows.map((row) => [row.user_id, row.role]));
          setVendors(profiles.filter((profile) => rolesByUser.get(profile.id) === "vendor").map((profile) => ({
            id: profile.vendor_id || profile.id,
            business: profile.company || profile.full_name,
            owner: profile.full_name,
            email: profile.email,
            phone: profile.phone || "",
            ...(profile.avatar_url ? { avatar: profile.avatar_url } : {}),
            ...(profile.business_address ? { businessAddress: profile.business_address } : {}),
            city: profile.business_city || "",
            commission: Number(profile.commission_rate),
            status: profile.status,
            gst: profile.gstin || "",
            rating: 0,
            joined: asDate(profile.created_at),
            bank: "",
            products: 0,
            orders: 0,
            sales: 0,
          }) as Vendor));
          setCustomers(profiles.filter((profile) => rolesByUser.get(profile.id) === "customer").map((profile) => {
            const customerOrders = (orderRows ?? []).filter((order) => order.user_id === profile.id);
            const latest = customerOrders[0];
            const address = latest?.shipping_address && typeof latest.shipping_address === "object" && !Array.isArray(latest.shipping_address)
              ? latest.shipping_address as Record<string, unknown>
              : {};
            return {
              id: profile.id,
              name: profile.full_name,
              email: profile.email,
              phone: profile.phone || "",
              city: String(address["city"] || ""),
              state: String(address["state"] || ""),
              pin: String(address["pin"] || ""),
              gst: profile.gstin || "",
              address: String(address["line"] || ""),
              joined: asDate(profile.created_at),
              orders: customerOrders.filter((order) => order.order_status !== "Cancelled").length,
              spend: customerOrders.filter((order) => order.order_status !== "Cancelled").reduce((sum, order) => sum + Number(order.total), 0),
              lastOrder: latest ? asDate(latest.created_at) : "—",
              status: profile.status.toLowerCase(),
              avatar: profile.full_name.split(/\s+/).map((word) => word[0] ?? "").join("").slice(0, 2),
            } as Customer;
          }));
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
      .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, () => { void reloadCatalog(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "user_roles" }, () => { void reloadCatalog(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, () => { void reloadCatalog(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "order_items" }, () => { void reloadCatalog(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "payments" }, () => { void reloadCatalog(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "product_reviews" }, () => { void reloadCatalog(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "return_requests" }, () => { void reloadCatalog(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "coupons" }, () => { void reloadCatalog(); })
      .subscribe();
    return () => {
      active = false;
      void supabase.removeChannel(channel);
    };
  }, [user]);

  useEffect(() => {
    if (STATIC_DATA_MODE || !user?.id) return;
    const recipientId = user.id;
    let active = true;
    const load = async () => {
      const { data, error } = await supabase.from("notifications").select("*").eq("recipient_id", recipientId).order("created_at", { ascending: false }).limit(100);
      if (!active) return;
      if (error) { console.error("Could not load account notifications", error.message); return; }
      const persisted: Notif[] = (data ?? []).map((row) => ({
        id: Number.parseInt(row.id.replaceAll("-", "").slice(0, 12), 16), databaseId: row.id, source: "live",
        role: row.recipient_role === "admin" || row.recipient_role === "vendor" ? row.recipient_role : "customer",
        title: row.title, type: row.status || "info", body: row.message,
        time: new Date(row.created_at).toLocaleString("en-IN"), read: row.read,
      }));
      setNotifications((current) => [...persisted, ...current.filter((item) => !item.databaseId)]);
    };
    void load();
    const channel = supabase.channel(`notifications-${recipientId}`).on("postgres_changes", { event: "*", schema: "public", table: "notifications", filter: `recipient_id=eq.${recipientId}` }, () => void load()).subscribe();
    return () => { active = false; void supabase.removeChannel(channel); };
  }, [user?.id]);

  const saveProduct = useCallback(async (product: Product, newVendorSubmission = false) => {
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
        // Every seller change returns the item to the admin review queue.
        status: "pending",
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
      const description = error.code === "42501" && user?.role === "vendor"
        ? "Your vendor account may need approved KYC documents before catalog changes. Open Store Profile → KYC Documents, submit the required files, and wait for admin review."
        : error.message;
      toast.error("Could not save this product", { description });
      return false;
    }
    if (record !== product) setProducts((list) => list.map((item) => item.id === product.id ? record : item));
    return true;
  }, [user, vendors]);

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
      .map((line) => ({ product: products.find((p) => p.id === line.id), qty: line.qty }))
      .filter((line): line is { product: Product; qty: number } => Boolean(line.product));

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
      logout: () => {
        void supabase.auth.signOut();
        setUser(null);
        setAddresses([]);
        setWishlist([]);
        setCart([]);
        try {
          localStorage.removeItem(KEY);
        } catch {
          /* ignore */
        }
      },
      updateProfile: async (p) => {
        const current = user;
        if (!current) return false;
        const changeEmail = Boolean(p.email && p.email.trim().toLowerCase() !== current.email.trim().toLowerCase());
        const localPatch = { ...p };
        if (changeEmail) delete localPatch.email;
        setUser({ ...current, ...localPatch });
        if (STATIC_DATA_MODE) return true;
        try {
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
          return true;
        } catch (error) {
          toast.error("Could not update your profile", { description: error instanceof Error ? error.message : "Please retry." });
          setUser(current);
          return false;
        }
      },

      cart,
      cartItems,
      cartCount: cartItems.reduce((s, l) => s + l.qty, 0),
      subtotal: cartItems.reduce((s, l) => s + l.product.price * l.qty, 0),
      productCatalogStatus,
      categoryCatalogStatus,
      addToCart: (id, qty = 1) => {
        const product = products.find((item) => item.id === id);
        const addAmount = Math.max(1, Math.floor(Number(qty) || 1));
        const available = product ? Math.max(0, Math.floor((Number(product.stock) || 0) - (Number(product.reserved) || 0))) : null;
        if (product && available === 0) {
          toast.error("This product is currently out of stock");
          return;
        }
        const existing = cart.find((line) => line.id === id);
        const requested = (existing?.qty ?? 0) + addAmount;
        const safeQty = Math.min(requested, available ?? requested);
        if (safeQty < requested) toast.warning(`Only ${safeQty} unit${safeQty === 1 ? "" : "s"} available`);
        setCart((current) => existing
          ? current.map((line) => line.id === id ? { ...line, qty: safeQty } : line)
          : [...current, { id, qty: safeQty }]);
      },
      setQty: (id, qty) => {
        const product = products.find((item) => item.id === id);
        const parsed = Math.max(1, Math.floor(Number(qty) || 1));
        const available = product ? Math.max(0, Math.floor((Number(product.stock) || 0) - (Number(product.reserved) || 0))) : null;
        const safeQty = available === null ? parsed : Math.min(parsed, available);
        if (product && safeQty === 0) {
          toast.error("This product is out of stock and has been removed from your cart");
          setCart((current) => current.filter((line) => line.id !== id));
          return;
        }
        if (safeQty < parsed) toast.warning(`Quantity adjusted to ${safeQty}; that is the available stock`);
        setCart((current) => current.map((line) => line.id === id ? { ...line, qty: safeQty } : line));
      },
      removeFromCart: (id) => setCart((c) => c.filter((l) => l.id !== id)),
      clearCart: () => setCart([]),

      wishlist,
      toggleWishlist: (id) => setWishlist((w) => (w.includes(id) ? w.filter((x) => x !== id) : [...w, id])),

      categories,
      addCategory: async (c) => {
        const category = { ...c, id: `C${Date.now().toString().slice(-6)}`, order: categories.length + 1 };
        if (!await saveCategory(category)) return false;
        setCategories((list) => [...list, category]);
        return true;
      },
      updateCategory: async (id, patch) => {
        const category = categories.find((item) => item.id === id);
        if (!category) return false;
        const next = { ...category, ...patch };
        if (!await saveCategory(next)) return false;
        setCategories((list) => list.map((item) => item.id === id ? next : item));
        return true;
      },
      deleteCategory: async (id) => {
        const existing = categories.find((category) => category.id === id);
        if (!existing) return false;
        if (!STATIC_DATA_MODE) {
          const { error } = await supabase.from("store_categories").delete().eq("id", id);
          if (error) { toast.error("Could not delete this category", { description: error.message }); return false; }
        }
        setCategories((list) => list.filter((category) => category.id !== id));
        return true;
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
      updateProduct: async (id, patch) => {
        // Enforce Admin-only pricing and cost modifications (Requirement 3)
        const hasPriceOrCostChange =
          patch.price !== undefined ||
          patch.mrp !== undefined ||
          patch.purchasePrice !== undefined;

        if (user && user.role !== "admin" && hasPriceOrCostChange) {
          throw new Error("Unauthorized: Only an Administrator is permitted to modify pricing and cost.");
        }

        const existing = products.find((product) => product.id === id);
        if (!existing) return false;
        const updated = { ...existing, ...patch, updated: today() };
        setProducts((list) => list.map((p) => (p.id === id ? updated : p)));
        const ok = await saveProduct(updated);
        if (!ok) setProducts((list) => list.map((item) => item.id === id ? existing : item));
        return ok;
      },
      deleteProduct: async (id) => {
        const existing = products.find((product) => product.id === id);
        if (!existing) return false;
        if (!STATIC_DATA_MODE) {
          const { error } = await supabase.from("catalog_products").delete().eq("id", id);
          if (error) { toast.error("Could not delete this product", { description: error.message }); return false; }
        }
        setProducts((list) => list.filter((p) => p.id !== id));
        return true;
      },
      duplicateProduct: async (id) => {
        const p = products.find((x) => x.id === id);
        if (!p) return false;
        const copy: Product = {
            ...p,
            id: `P${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
            name: `${p.name} (Copy)`,
            sku: `${p.sku}-C-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
            sold: 0,
            created: today(),
            updated: today(),
          };
        setProducts((list) => [copy, ...list]);
        const saved = await saveProduct(copy, user?.role === "vendor");
        if (!saved) setProducts((list) => list.filter((item) => item.id !== copy.id));
        return saved;
      },

      batches,
      addBatch: async (batchData) => {
        if (user && user.role !== "admin") {
          throw new Error("Unauthorized: Only an Administrator can add purchase batches.");
        }
        if (!STATIC_DATA_MODE) {
          const { data, error } = await supabase.rpc("admin_receive_inventory_batch", {
            _batch_code: batchData.batchCode, _product_id: batchData.productId,
            _quantity: batchData.quantity, _unit_cost: batchData.unitCost,
            _purchase_date: batchData.purchaseDate || null, _warehouse: batchData.warehouse,
          });
          if (error || !data) { toast.error("Could not save this inventory batch", { description: error?.message ?? "Product not found." }); return false; }
          const persisted = { ...batchData, id: data, status: batchData.remainingQty > 0 ? "Active" : "Depleted" } as PurchaseBatch;
          setBatches((list) => [persisted, ...list]);
          setProducts((list) => list.map((p) => p.id === batchData.productId ? { ...p, stock: p.stock + batchData.remainingQty, updated: today() } : p));
          return true;
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
        return true;
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
        if (method === "Cash on Delivery" || method === "COD") {
          throw new Error("Cash on delivery is not enabled for this store. Please select an online payment method (UPI, Card, Net Banking).");
        }
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
            id: shippingAddress?.id,
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
      updateOrderStatus: async (id, status) => {
        const existing = orders.find((order) => order.id === id);
        if (!existing) return false;
        setOrders((list) => list.map((order) => order.id === id ? { ...order, status } : order));
        if (!STATIC_DATA_MODE) {
          const { error } = await supabase.from("orders").update({ order_status: status }).eq("order_no", id);
          if (error) {
            toast.error("Could not update order status", { description: error.message });
            setOrders((list) => list.map((order) => order.id === id ? existing : order));
            return false;
          }
        }
        return true;
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
      confirmPayment: async (id, amount, utr, advancePercent = 30) => {
        if (!STATIC_DATA_MODE) {
          const { data, error } = await supabase.rpc("admin_confirm_manual_payment", { _order_no: id, _amount: amount, _utr: utr.trim() });
          if (error || !data) { toast.error("Could not record payment", { description: error?.message ?? "Order not found." }); return false; }
          return true;
        }
        const order = orders.find((candidate) => candidate.id === id);
        if (!order || !Number.isFinite(amount) || amount <= 0) return false;
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
        return true;
      },
      refundOrder: async (id) => {
        if (!STATIC_DATA_MODE) {
          toast.error("Refunds are not connected to a payment provider yet");
          return false;
        }
        setOrders((list) => list.map((o) => (o.id === id ? { ...o, payment: "Refunded", status: "Cancelled" } : o)));
        return true;
      },

      vendors,
      setVendorStatus: async (id, status) => {
        if (!STATIC_DATA_MODE) {
          const { data: profile, error: lookupError } = await supabase.from("profiles").select("id").eq("vendor_id", id).maybeSingle();
          if (lookupError || !profile) {
            toast.error("Could not update vendor status", { description: lookupError?.message ?? "No matching vendor profile was found." });
            return false;
          }
          const { data, error } = await supabase.rpc("admin_set_profile_status", { _profile_id: profile.id, _status: status });
          if (error || !data) {
            toast.error("Could not update vendor status", { description: error?.message ?? "No matching vendor profile was found." });
            return false;
          }
        }
        setVendors((list) => list.map((vendor) => vendor.id === id ? { ...vendor, status } : vendor));
        return true;
      },
      setVendorCommission: async (id, rate) => {
        if (!Number.isFinite(rate) || rate < 0 || rate > 100) return false;
        if (!STATIC_DATA_MODE) {
          const { data, error } = await supabase.rpc("admin_set_vendor_commission", { _vendor_id: id, _rate: rate });
          if (error || !data) {
            toast.error("Could not save vendor commission", { description: error?.message ?? "No matching vendor profile was found." });
            return false;
          }
        }
        setVendors((list) => list.map((vendor) => vendor.id === id ? { ...vendor, commission: rate } : vendor));
        return true;
      },
      customers,
      setCustomerStatus: async (id, status) => {
        const previous = customers.find((customer) => customer.id === id);
        if (!STATIC_DATA_MODE) {
          const { data, error } = await supabase.rpc("admin_set_profile_status", { _profile_id: id, _status: status });
          if (error || !data) {
            toast.error("Could not update customer status", { description: error?.message ?? "No matching customer profile was found." });
            return false;
          }
        }
        setCustomers((list) => list.map((customer) => customer.id === id ? { ...customer, status } : customer));
        if (previous && previous.status !== status) pushNotif("Customer status updated", `${previous.name}: ${previous.status} â†’ ${status}.`, "info", "admin");
        return true;
      },

      reviews,
      setReviewStatus: async (id, status) => {
        if (!STATIC_DATA_MODE) {
          const { data, error } = await supabase.rpc("admin_set_review_status", { _id: id, _status: status });
          if (error || !data) { toast.error("Could not update review status", { description: error?.message ?? "Review not found." }); return false; }
        }
        setReviews((list) => list.map((review) => review.id === id ? { ...review, status } : review));
        return true;
      },
      deleteReview: async (id) => {
        if (!STATIC_DATA_MODE) {
          const { data, error } = await supabase.rpc("admin_delete_review", { _id: id });
          if (error || !data) { toast.error("Could not delete review", { description: error?.message ?? "Review not found." }); return false; }
        }
        setReviews((list) => list.filter((review) => review.id !== id));
        return true;
      },
      replyReview: async (id, reply) => {
        if (!reply.trim()) return false;
        if (!STATIC_DATA_MODE) {
          const { data, error } = await supabase.rpc("vendor_reply_to_review", { _id: id, _reply: reply.trim() });
          if (error || !data) { toast.error("Could not post review reply", { description: error?.message ?? "Review not found for this vendor." }); return false; }
        }
        setReviews((list) => list.map((review) => review.id === id ? { ...review, reply: reply.trim() } : review));
        return true;
      },
      reportReview: async (id, reason) => {
        if (STATIC_DATA_MODE) return false;
        const { data, error } = await supabase.rpc("vendor_report_review", { _id: id, _reason: reason.trim() });
        if (error || !data) { toast.error("Could not report review", { description: error?.message ?? "Review not found for this vendor." }); return false; }
        return true;
      },

      returns,
      setReturnStatus: async (id, status, refund) => {
        if (!STATIC_DATA_MODE) {
          const { data, error } = await supabase.rpc("admin_update_return", { _id: id, _status: status, _refund_status: refund ?? "Pending" });
          if (error || !data) { toast.error("Could not update return request", { description: error?.message ?? "Return request not found." }); return false; }
        }
        setReturns((list) => list.map((item) => item.id === id ? { ...item, status, refund: refund ?? item.refund } : item));
        return true;
      },
      requestReturn: async (orderItemId, quantity, reason) => {
        if (STATIC_DATA_MODE) return true;
        const { data, error } = await supabase.rpc("customer_request_return", { _order_item_id: orderItemId, _quantity: quantity, _reason: reason });
        if (error || !data) { toast.error("Could not submit return request", { description: error?.message ?? "Try again." }); return false; }
        return true;
      },

      coupons,
      addCoupon: async (c) => {
        if (!STATIC_DATA_MODE) {
          const { data: { user: authUser } } = await supabase.auth.getUser();
          const value = Number.parseFloat(c.value.replace(/[^\d.]/g, ""));
          const startsOn = new Date(c.start).toISOString().slice(0, 10);
          const endsOn = new Date(c.end).toISOString().slice(0, 10);
          const { error } = await supabase.from("coupons").insert({
            code: c.code.toUpperCase(), discount_type: c.type, discount_value: value,
            minimum_order: c.min, maximum_discount: c.max, starts_on: startsOn, ends_on: endsOn,
            usage_limit: c.limit, active: c.status !== "Expired", created_by: authUser?.id ?? null,
          });
          if (error) { toast.error("Could not save coupon", { description: error.message }); return false; }
        }
        setCoupons((list) => [c, ...list]);
        return true;
      },
      deleteCoupon: async (code) => {
        if (!STATIC_DATA_MODE) {
          const { error } = await supabase.from("coupons").delete().eq("code", code);
          if (error) { toast.error("Could not delete coupon", { description: error.message }); return false; }
        }
        setCoupons((list) => list.filter((coupon) => coupon.code !== code));
        return true;
      },

      notifications,
      markRead: async (id) => {
        const notification = notifications.find((item) => item.id === id);
        if (!notification) return false;
        if (!STATIC_DATA_MODE && notification.databaseId) {
          const { error } = await supabase.from("notifications").update({ read: true }).eq("id", notification.databaseId).eq("recipient_id", user?.id ?? "");
          if (error) { toast.error("Could not mark notification read", { description: error.message }); return false; }
        }
        setNotifications((list) => list.map((item) => item.id === id ? { ...item, read: true } : item));
        return true;
      },
      markAllRead: async () => {
        if (!STATIC_DATA_MODE && user?.id) {
          const { error } = await supabase.from("notifications").update({ read: true }).eq("recipient_id", user.id).eq("read", false);
          if (error) { toast.error("Could not mark notifications read", { description: error.message }); return false; }
        }
        setNotifications((list) => list.map((item) => ({ ...item, read: true })));
        return true;
      },
      deleteNotification: async (id) => {
        const notification = notifications.find((item) => item.id === id);
        if (!notification) return false;
        if (!STATIC_DATA_MODE && notification.databaseId) {
          const { error } = await supabase.from("notifications").delete().eq("id", notification.databaseId).eq("recipient_id", user?.id ?? "");
          if (error) { toast.error("Could not delete notification", { description: error.message }); return false; }
        }
        setNotifications((list) => list.filter((item) => item.id !== id));
        return true;
      },

      addresses,
      addAddress: async (a) => {
        if (!STATIC_DATA_MODE) {
          const { data: { user: authUser }, error: authError } = await supabase.auth.getUser();
          if (authError || !authUser) {
            toast.error("Sign in again before saving an address");
            return false;
          }
          const { error } = await supabase.from("addresses").insert({
            id: a.id, user_id: authUser.id, label: a.label, name: a.name, phone: a.phone,
            line: a.line, city: a.city, state: a.state, pin: a.pin, landmark: a.landmark || null, is_default: a.default,
          });
          if (error) {
            toast.error("Could not save this address", { description: error.message });
            return false;
          }
        }
        setAddresses((list) => [...list, a]);
        return true;
      },
      updateAddress: async (id, patch) => {
        const existing = addresses.find((address) => address.id === id);
        if (!existing) return false;
        const updated = { ...existing, ...patch } as Address;
        if (!STATIC_DATA_MODE) {
          const { error } = await supabase.from("addresses").update({
            ...(patch.label !== undefined ? { label: patch.label } : {}),
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
            ...(patch.line !== undefined ? { line: patch.line } : {}),
            ...(patch.city !== undefined ? { city: patch.city } : {}),
            ...(patch.state !== undefined ? { state: patch.state } : {}),
            ...(patch.pin !== undefined ? { pin: patch.pin } : {}),
            ...(patch.landmark !== undefined ? { landmark: patch.landmark || null } : {}),
          }).eq("id", id).eq("user_id", user?.id ?? "");
          if (error) { toast.error("Could not update this address", { description: error.message }); return false; }
        }
        setAddresses((list) => list.map((address) => address.id === id ? updated : address));
        return true;
      },
      deleteAddress: async (id) => {
        const existing = addresses.find((address) => address.id === id);
        if (!existing) return false;
        if (!STATIC_DATA_MODE) {
          const { error } = await supabase.from("addresses").delete().eq("id", id).eq("user_id", user?.id ?? "");
          if (error) { toast.error("Could not delete this address", { description: error.message }); return false; }
        }
        setAddresses((list) => list.filter((address) => address.id !== id));
        return true;
      },
      setDefaultAddress: async (id) => {
        if (!addresses.some((address) => address.id === id)) return false;
        if (!STATIC_DATA_MODE) {
          const { data, error } = await supabase.rpc("customer_set_default_address", { _id: id });
          if (error || !data) { toast.error("Could not change your default address", { description: error?.message ?? "Address not found." }); return false; }
        }
        setAddresses((list) => list.map((address) => ({ ...address, default: address.id === id })));
        return true;
      },
    };
  }, [hydrated, user, cart, wishlist, wishlistsByUser, categories, products, batches, orders, vendors, customers, reviews, returns, coupons, notifications, addresses, addressesByUser, productCatalogStatus, categoryCatalogStatus, saveProduct]);

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
  const vendor = vendors.find((item) => item.id === vendorId) ?? null;
  const revenue = vendorOrders.reduce(
    (s, o) => s + o.items.filter((i) => i.vendorId === vendorId).reduce((t, i) => t + i.product.price * i.qty, 0),
    0,
  );
  return { vendorId, vendor, vendorProducts, vendorOrders, vendorReviews, revenue, user };
}
