import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { Role } from "@/lib/store";
import { STATIC_DATA_MODE, STATIC_DEMO_OTP } from "@/lib/demo-mode";

const OTP_TTL = 5 * 60;
const RESEND_AFTER = 30;

export type OtpStage = "request" | "verify";
export type OtpChannel = "email" | "phone";
type OtpOptions = { shouldCreateUser?: boolean; requiredRole?: Role };
type OtpMetadata = Record<string, string>;

/** The current Supabase project sends 8-digit email OTPs and 6-digit SMS OTPs. */
export function otpLengthForChannel(channel: OtpChannel) {
  return channel === "email" ? 8 : 6;
}

export function normalisePhone(value: string) {
  return value.replace(/\D/g, "").slice(-10);
}

export function isValidPhone(value: string) {
  return /^[6-9]\d{9}$/.test(normalisePhone(value));
}

export function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
}

/** Sends and verifies one-time codes through the configured Supabase Auth project. */
export function useEmailOtp({ shouldCreateUser = true, requiredRole }: OtpOptions = {}) {
  const [stage, setStage] = useState<OtpStage>("request");
  const [channel, setChannel] = useState<OtpChannel>("email");
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [expiresIn, setExpiresIn] = useState(0);
  const [resendIn, setResendIn] = useState(0);
  const destinationRef = useRef("");
  const metadataRef = useRef<OtpMetadata | undefined>(undefined);

  useEffect(() => {
    if (stage !== "verify") return;
    const timer = setInterval(() => {
      setExpiresIn((value) => Math.max(0, value - 1));
      setResendIn((value) => Math.max(0, value - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [stage]);

  const send = useCallback(
    async (destination: string, via: OtpChannel = channel, metadata?: OtpMetadata) => {
      const cleanEmail = destination.trim().toLowerCase();
      if (via === "email" && !isValidEmail(cleanEmail)) {
        toast.error("Enter a valid email address");
        return false;
      }
      if (via === "phone" && !isValidPhone(destination)) {
        toast.error("Enter a valid 10-digit Indian mobile number");
        return false;
      }

      setSending(true);
      const requestMetadata = metadata ?? metadataRef.current;
      if (STATIC_DATA_MODE) {
        destinationRef.current = via === "email" ? cleanEmail : `+91${normalisePhone(destination)}`;
        metadataRef.current = requestMetadata;
        setChannel(via);
        setCode("");
        setStage("verify");
        setExpiresIn(OTP_TTL);
        setResendIn(RESEND_AFTER);
        setSending(false);
        toast.success("Static preview code ready", {
          description: `Use ${STATIC_DEMO_OTP[via]}. No email or SMS was sent.`,
        });
        return true;
      }
      let result;
      try {
        result = via === "email"
          ? await supabase.auth.signInWithOtp({
              email: cleanEmail,
              options: {
                shouldCreateUser,
                ...(requestMetadata ? { data: requestMetadata } : {}),
              },
            })
          : await supabase.auth.signInWithOtp({
              phone: `+91${normalisePhone(destination)}`,
              options: {
                shouldCreateUser,
                ...(requestMetadata ? { data: requestMetadata } : {}),
              },
            });
      } catch {
        toast.error("Could not connect to the verification service");
        return false;
      } finally {
        setSending(false);
      }

      if (result.error) {
        const msg = result.error.message || "";
        const errCode = (result.error as { code?: string }).code || "";
        if (errCode === "phone_provider_disabled" || msg.toLowerCase().includes("unsupported phone provider")) {
          toast.error("SMS Provider Not Configured in Supabase", {
            description: "Phone OTP requires enabling an SMS provider (e.g. Twilio) or test numbers in your Supabase Auth dashboard. You can use Email OTP to sign in.",
            duration: 8000,
          });
          return false;
        }
        if (errCode === "otp_disabled" || msg.toLowerCase().includes("signups not allowed for otp")) {
          toast.error("No Account Found", {
            description: "No registered customer account exists with this phone or email. Please register first.",
            duration: 6000,
          });
          return false;
        }
        if (errCode === "over_sms_send_rate_limit" || msg.toLowerCase().includes("rate limit")) {
          toast.error("Too Many Requests", {
            description: "Please wait a few moments before requesting another OTP code.",
            duration: 6000,
          });
          return false;
        }
        toast.error("Could not send the verification code", { description: result.error.message });
        return false;
      }

      destinationRef.current = via === "email" ? cleanEmail : `+91${normalisePhone(destination)}`;
      metadataRef.current = requestMetadata;
      setChannel(via);
      setCode("");
      setStage("verify");
      setExpiresIn(OTP_TTL);
      setResendIn(RESEND_AFTER);
      toast.success(via === "phone" ? "Verification code sent by SMS" : "Verification code sent by email", {
        description: `Check ${via === "phone" ? destinationRef.current : cleanEmail}. The code expires in 5 minutes.`,
      });
      return true;
    },
    [channel, shouldCreateUser],
  );

  const verify = useCallback(async () => {
    const expectedLength = otpLengthForChannel(channel);
    if (!new RegExp(`^\\d{${expectedLength}}$`).test(code)) {
      toast.error(`Enter the ${expectedLength}-digit verification code`);
      return false;
    }
    if (expiresIn <= 0 || !destinationRef.current) {
      toast.error("This code has expired", { description: "Request a new verification code." });
      return false;
    }

    setVerifying(true);
    if (STATIC_DATA_MODE) {
      setVerifying(false);
      if (code !== STATIC_DEMO_OTP[channel]) {
        toast.error(`For static preview, enter ${STATIC_DEMO_OTP[channel]}`);
        return false;
      }
      return true;
    }
    let result;
    try {
      result = channel === "email"
        ? await supabase.auth.verifyOtp({ email: destinationRef.current, token: code, type: "email" })
        : await supabase.auth.verifyOtp({ phone: destinationRef.current, token: code, type: "sms" });
    } catch {
      toast.error("Could not connect to the verification service");
      return false;
    } finally {
      setVerifying(false);
    }

    if (result.error || !result.data.user) {
      toast.error("The verification code could not be confirmed", {
        description: result.error?.message ?? "Request a new code and try again.",
      });
      return false;
    }

    if (requiredRole) {
      let hasAuthorizedRole = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const { data: roleRows } = await supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", result.data.user.id);
        const roles = (roleRows ?? []).map((row) => row.role);
        if (requiredRole === "customer" ? roles.length > 0 : roles.includes(requiredRole)) {
          hasAuthorizedRole = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      if (!hasAuthorizedRole) {
        await supabase.auth.signOut();
        toast.error(`This account is not authorized for ${requiredRole} access`);
        return false;
      }
    }

    return true;
  }, [channel, code, expiresIn, requiredRole]);

  const reset = useCallback(() => {
    destinationRef.current = "";
    metadataRef.current = undefined;
    setCode("");
    setStage("request");
    setExpiresIn(0);
    setResendIn(0);
  }, []);

  return {
    stage,
    channel,
    setChannel,
    code,
    setCode,
    send,
    verify,
    reset,
    sending,
    verifying,
    expiresIn,
    resendIn,
    canResend: resendIn <= 0,
  };
}

export function formatCountdown(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}
