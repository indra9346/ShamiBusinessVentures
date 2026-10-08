/**
 * Static demo mode is intended for local and Vercel Preview testing only.
 * Set VITE_STATIC_DATA_MODE=false locally to exercise the Supabase path.
 */
const isProductionDeployment = import.meta.env["VERCEL_ENV"] === "production";
export const STATIC_DATA_MODE = !isProductionDeployment && (
  import.meta.env["VERCEL_ENV"] === "preview" ||
  import.meta.env["VITE_STATIC_DATA_MODE"] === "true" ||
  (import.meta.env.DEV && import.meta.env["VITE_STATIC_DATA_MODE"] !== "false")
);

export const STATIC_DEMO_OTP = "123456";
