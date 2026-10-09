/**
 * Static demo mode is intended for local and Vercel Preview testing only.
 * Set VITE_STATIC_DATA_MODE=false locally to exercise the Supabase path.
 */
export const STATIC_DATA_MODE = import.meta.env["VITE_STATIC_DATA_MODE"] === "true";


export const STATIC_DEMO_OTP = {
  email: "12345678",
  phone: "123456",
} as const;
