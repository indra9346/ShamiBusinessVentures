import { useEffect, useState } from "react";
import { AlertCircle, AlertTriangle, Check, Info, Trash2, X } from "lucide-react";
import { toast } from "sonner";

export type NotificationType = "add" | "remove" | "success" | "error" | "info" | "warning";

export interface CartToastEventDetail {
  title: string;
  description?: string | undefined;
  image?: string | undefined;
  type?: NotificationType | undefined;
}

interface CartToastItem extends CartToastEventDetail {
  id: string;
}

const EVENT_NAME = "cart:floating-notify";

/**
 * Trigger the premium floating notification on the right-middle of the viewport.
 * Floats up realistically like water droplets till up and evaporates to invisible.
 * Active for all customer actions: Add to Cart, Remove from Cart, Wishlist, Coupons,
 * Checkout, Account updates, etc.
 */
export function showCustomerNotification(
  title: string,
  description?: string,
  type: NotificationType = "success",
  image?: string,
) {
  if (typeof window === "undefined") return;

  // Auto-detect removal keywords if type was marked success
  let resolvedType = type;
  const lowerTitle = (title || "").toLowerCase();
  if (resolvedType === "success" && (lowerTitle.includes("remov") || lowerTitle.includes("delet") || lowerTitle.includes("clear"))) {
    resolvedType = "remove";
  }

  const detail: CartToastEventDetail = {
    title,
    description: description !== undefined ? description : undefined,
    image: image !== undefined ? image : undefined,
    type: resolvedType,
  };
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail }));
}

/**
 * Backward-compatible helper for cart-specific operations.
 */
export function showCartNotification(
  title: string,
  description?: string,
  type: NotificationType = "add",
  image?: string,
) {
  showCustomerNotification(title, description, type, image);
}

// Global flag to ensure bridge is installed once
let bridgeInstalled = false;

/**
 * Universal customer toast bridge:
 * Intercepts all toast calls across customer-facing routes so that EVERY customer popup
 * gets the exact same floating water droplet rise & evaporation behavior as Add/Remove Cart.
 * Leaves Admin and Vendor panels untouched with their standard panel toast systems.
 */
export function installCustomerToastBridge() {
  if (typeof window === "undefined" || bridgeInstalled) return;
  bridgeInstalled = true;

  const isCustomerRoute = () => {
    const p = window.location.pathname;
    return !p.startsWith("/admin") && !p.startsWith("/vendor");
  };

  const origSuccess = toast.success?.bind(toast);
  const origError = toast.error?.bind(toast);
  const origInfo = toast.info?.bind(toast);
  const origWarning = toast.warning?.bind(toast);

  if (origSuccess) {
    toast.success = (msg: any, data?: any) => {
      if (isCustomerRoute()) {
        const title = typeof msg === "string" ? msg : String(msg?.title || msg || "");
        const desc = data?.description || (typeof msg === "object" ? msg?.description : undefined);
        const img = data?.image || (typeof msg === "object" ? msg?.image : undefined);
        showCustomerNotification(title, desc, "success", img);
        return "droplet-" + Date.now();
      }
      return origSuccess(msg, data);
    };
  }

  if (origError) {
    toast.error = (msg: any, data?: any) => {
      if (isCustomerRoute()) {
        const title = typeof msg === "string" ? msg : String(msg?.title || msg || "");
        const desc = data?.description || (typeof msg === "object" ? msg?.description : undefined);
        const img = data?.image || (typeof msg === "object" ? msg?.image : undefined);
        showCustomerNotification(title, desc, "error", img);
        return "droplet-" + Date.now();
      }
      return origError(msg, data);
    };
  }

  if (origInfo) {
    toast.info = (msg: any, data?: any) => {
      if (isCustomerRoute()) {
        const title = typeof msg === "string" ? msg : String(msg?.title || msg || "");
        const desc = data?.description || (typeof msg === "object" ? msg?.description : undefined);
        const img = data?.image || (typeof msg === "object" ? msg?.image : undefined);
        showCustomerNotification(title, desc, "info", img);
        return "droplet-" + Date.now();
      }
      return origInfo(msg, data);
    };
  }

  if (origWarning) {
    toast.warning = (msg: any, data?: any) => {
      if (isCustomerRoute()) {
        const title = typeof msg === "string" ? msg : String(msg?.title || msg || "");
        const desc = data?.description || (typeof msg === "object" ? msg?.description : undefined);
        const img = data?.image || (typeof msg === "object" ? msg?.image : undefined);
        showCustomerNotification(title, desc, "warning", img);
        return "droplet-" + Date.now();
      }
      return origWarning(msg, data);
    };
  }
}

// Auto-install on client bundle load
if (typeof window !== "undefined") {
  installCustomerToastBridge();
}

export function CartFloatingNotifier() {
  const [toasts, setToasts] = useState<CartToastItem[]>([]);

  useEffect(() => {
    installCustomerToastBridge();

    const handler = (e: Event) => {
      const customEvent = e as CustomEvent<CartToastEventDetail>;
      if (!customEvent.detail) return;

      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const newItem: CartToastItem = {
        id,
        title: customEvent.detail.title,
        ...(customEvent.detail.description !== undefined ? { description: customEvent.detail.description } : {}),
        ...(customEvent.detail.image !== undefined ? { image: customEvent.detail.image } : {}),
        type: customEvent.detail.type || "success",
      };

      setToasts((prev) => [...prev.slice(-2), newItem]);

      // Automatically unmount after droplet rise & evaporation finishes (2.4s)
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 2400);
    };

    window.addEventListener(EVENT_NAME, handler);
    return () => window.removeEventListener(EVENT_NAME, handler);
  }, []);

  const removeToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  if (toasts.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="pointer-events-none fixed right-4 sm:right-7 md:right-9 top-[58%] -translate-y-1/2 z-[9999] flex flex-col-reverse items-end gap-6"
    >
      {toasts.map((toastItem) => {
        const isRemove = toastItem.type === "remove";
        const isError = toastItem.type === "error";
        const isWarningOrInfo = toastItem.type === "info" || toastItem.type === "warning";
        const isSuccessOrAdd = !isRemove && !isError && !isWarningOrInfo;

        return (
          <div key={toastItem.id} className="relative flex flex-col items-center">
            {/* The Main Notification Card (Floats realistically till up and fades like a water droplet) */}
            <div
              className={`pointer-events-auto flex items-center gap-3 rounded-2xl border px-4 py-3 shadow-xl backdrop-blur-md min-w-[270px] max-w-[calc(100vw-32px)] sm:max-w-sm animate-cart-droplet transition-all ${
                isRemove
                  ? "border-rose-300/85 bg-[#fff1f2]/95 text-rose-950 shadow-[0_12px_36px_-6px_rgba(244,63,94,0.25),0_0_15px_rgba(244,63,94,0.15)]"
                  : isError
                    ? "border-red-300/85 bg-[#fef2f2]/95 text-red-950 shadow-[0_12px_36px_-6px_rgba(239,68,68,0.25),0_0_15px_rgba(239,68,68,0.15)]"
                    : isWarningOrInfo
                      ? "border-amber-300/85 bg-[#fffbeb]/95 text-amber-950 shadow-[0_12px_36px_-6px_rgba(245,158,11,0.25),0_0_15px_rgba(245,158,11,0.15)]"
                      : "border-emerald-300/85 bg-[#ecfdf5]/95 text-emerald-950 shadow-[0_12px_36px_-6px_rgba(16,185,129,0.28),0_0_15px_rgba(16,185,129,0.18)]"
              }`}
              style={{
                animation: "cart-droplet-rise 2.4s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards",
                willChange: "transform, opacity",
              }}
            >
              {/* Type-based Icon Badge */}
              <div
                className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-white shadow-xs ${
                  isRemove
                    ? "bg-gradient-to-br from-rose-400 to-rose-600"
                    : isError
                      ? "bg-gradient-to-br from-red-500 to-red-600"
                      : isWarningOrInfo
                        ? "bg-gradient-to-br from-amber-400 to-yellow-500 text-midnight"
                        : "bg-gradient-to-br from-emerald-400 to-emerald-600"
                }`}
              >
                {isRemove ? (
                  <Trash2 className="h-3.5 w-3.5" />
                ) : isError ? (
                  <AlertCircle className="h-4 w-4 stroke-[2.5]" />
                ) : isWarningOrInfo ? (
                  toastItem.type === "warning" ? (
                    <AlertTriangle className="h-3.5 w-3.5 stroke-[2.5]" />
                  ) : (
                    <Info className="h-4 w-4 stroke-[2.5]" />
                  )
                ) : (
                  <Check className="h-4 w-4 stroke-[3]" />
                )}
              </div>

              {/* Product Thumbnail (If provided) */}
              {toastItem.image && (
                <img
                  src={toastItem.image}
                  alt={toastItem.description || toastItem.title}
                  className={`h-11 w-11 shrink-0 rounded-lg object-cover border shadow-xs ${
                    isRemove
                      ? "border-rose-200/80"
                      : isError
                        ? "border-red-200/80"
                        : isWarningOrInfo
                          ? "border-amber-200/80"
                          : "border-emerald-200/90"
                  }`}
                />
              )}

              {/* Title & Product / Alert Information */}
              <div className="min-w-0 flex-1">
                <p
                  className={`text-xs sm:text-sm font-bold leading-tight ${
                    isRemove
                      ? "text-rose-950"
                      : isError
                        ? "text-red-950"
                        : isWarningOrInfo
                          ? "text-amber-950"
                          : "text-emerald-950"
                  }`}
                >
                  {toastItem.title}
                </p>
                {toastItem.description && (
                  <p
                    className={`mt-0.5 truncate text-xs font-semibold leading-tight ${
                      isRemove
                        ? "text-rose-800/80"
                        : isError
                          ? "text-red-800/85"
                          : isWarningOrInfo
                            ? "text-amber-800/85"
                            : "text-emerald-800/85"
                    }`}
                  >
                    {toastItem.description}
                  </p>
                )}
              </div>

              {/* Manual Close Button */}
              <button
                type="button"
                onClick={() => removeToast(toastItem.id)}
                className={`ml-1 rounded-full p-1 transition-colors ${
                  isRemove
                    ? "text-rose-700/60 hover:bg-rose-200/60 hover:text-rose-950"
                    : isError
                      ? "text-red-700/60 hover:bg-red-200/60 hover:text-red-950"
                      : isWarningOrInfo
                        ? "text-amber-700/60 hover:bg-amber-200/60 hover:text-amber-950"
                        : "text-emerald-700/60 hover:bg-emerald-200/60 hover:text-emerald-950"
                }`}
                aria-label="Dismiss"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* Ascending Water Droplet Trail (3 Droplets floating up realistically trailing the card) */}
            <div className="pointer-events-none absolute -bottom-8 flex flex-col items-center gap-2">
              {/* Droplet 1 */}
              <svg
                viewBox="0 0 24 24"
                className={`h-4 w-4 drop-shadow-xs ${
                  isRemove
                    ? "fill-rose-400/80 text-rose-300"
                    : isError
                      ? "fill-red-400/80 text-red-300"
                      : isWarningOrInfo
                        ? "fill-amber-400/80 text-amber-300"
                        : "fill-emerald-400/85 text-emerald-300"
                }`}
                style={{
                  animation: "water-droplet-trail-1 2.4s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards",
                  willChange: "transform, opacity",
                }}
              >
                <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" />
              </svg>

              {/* Droplet 2 */}
              <svg
                viewBox="0 0 24 24"
                className={`h-3 w-3 drop-shadow-xs ${
                  isRemove
                    ? "fill-rose-300/70 text-rose-200"
                    : isError
                      ? "fill-red-300/70 text-red-200"
                      : isWarningOrInfo
                        ? "fill-amber-300/70 text-amber-200"
                        : "fill-emerald-300/75 text-emerald-200"
                }`}
                style={{
                  animation: "water-droplet-trail-2 2.4s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards",
                  willChange: "transform, opacity",
                }}
              >
                <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" />
              </svg>

              {/* Droplet 3 */}
              <svg
                viewBox="0 0 24 24"
                className={`h-2.5 w-2.5 drop-shadow-xs ${
                  isRemove
                    ? "fill-rose-300/50 text-rose-200"
                    : isError
                      ? "fill-red-300/50 text-red-200"
                      : isWarningOrInfo
                        ? "fill-amber-300/50 text-amber-200"
                        : "fill-emerald-300/60 text-emerald-200"
                }`}
                style={{
                  animation: "water-droplet-trail-3 2.4s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards",
                  willChange: "transform, opacity",
                }}
              >
                <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" />
              </svg>
            </div>
          </div>
        );
      })}
    </div>
  );
}
