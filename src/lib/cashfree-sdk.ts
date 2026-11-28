// Cashfree's checkout script (JS SDK v3), loaded only when a customer presses Pay with Cashfree switched on.

export type CashfreeCheckoutResult = {
  error?: { message?: string } | null;
  redirect?: boolean;
  paymentDetails?: { paymentMessage?: string } | null;
};
export type CashfreeInstance = {
  checkout(options: { paymentSessionId: string; redirectTarget?: "_self" | "_blank" | "_top" | "_modal" }): Promise<CashfreeCheckoutResult>;
};
type CashfreeFactory = (options: { mode: "sandbox" | "production" }) => CashfreeInstance;

declare global {
  interface Window {
    Cashfree?: CashfreeFactory;
  }
}

let loading: { url: string; promise: Promise<CashfreeFactory> } | null = null;

/** Adds Cashfree's script once and resolves with its factory. A failed load can be tried again. */
export function loadCashfreeSdk(url: string): Promise<CashfreeFactory> {
  if (typeof window === "undefined") return Promise.reject(new Error("Cashfree runs in the browser"));
  if (window.Cashfree) return Promise.resolve(window.Cashfree);
  if (loading?.url === url) return loading.promise;
  const promise = new Promise<CashfreeFactory>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    script.onload = () => (window.Cashfree ? resolve(window.Cashfree) : reject(new Error("Cashfree did not load")));
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error("Cashfree's payment page could not be loaded. Check your internet and try again."));
    };
    document.head.appendChild(script);
  });
  loading = { url, promise };
  return promise;
}
