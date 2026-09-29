import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

const OTP_TTL = 5 * 60; // seconds
const RESEND_AFTER = 30; // seconds

export type OtpStage = "request" | "verify";
export type OtpChannel = "email" | "phone";

export function normalisePhone(value: string) {
  return value.replace(/\D/g, "").slice(-10);
}

export function isValidPhone(value: string) {
  return /^[6-9]\d{9}$/.test(normalisePhone(value));
}

export function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
}

/**
 * Email / phone OTP verification for the demo login flows.
 * A 6-digit code is generated and "sent" to the destination — in this demo the
 * code is surfaced in the toast so it can be tested without a mailbox or SIM.
 */
export function useEmailOtp() {
  const [stage, setStage] = useState<OtpStage>("request");
  const [channel, setChannel] = useState<OtpChannel>("email");
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [expiresIn, setExpiresIn] = useState(0);
  const [resendIn, setResendIn] = useState(0);
  const issued = useRef<string | null>(null);

  useEffect(() => {
    if (stage !== "verify") return;
    const t = setInterval(() => {
      setExpiresIn((v) => (v > 0 ? v - 1 : 0));
      setResendIn((v) => (v > 0 ? v - 1 : 0));
    }, 1000);
    return () => clearInterval(t);
  }, [stage]);

  const send = useCallback(
    async (destination: string, via: OtpChannel = channel) => {
      if (via === "email" && !isValidEmail(destination)) {
        toast.error("Enter a valid email address");
        return false;
      }
      if (via === "phone" && !isValidPhone(destination)) {
        toast.error("Enter a valid 10-digit Indian mobile number");
        return false;
      }
      setSending(true);
      await new Promise((r) => setTimeout(r, 600));
      const generated = String(Math.floor(100000 + Math.random() * 900000));
      issued.current = generated;
      setCode("");
      setStage("verify");
      setExpiresIn(OTP_TTL);
      setResendIn(RESEND_AFTER);
      setSending(false);
      const label = via === "phone" ? `+91 ${normalisePhone(destination)}` : destination;
      toast.success(via === "phone" ? `OTP sent by SMS to ${label}` : `Verification code sent to ${label}`, {
        description: `Demo code: ${generated} · valid for 5 minutes`,
        duration: 12000,
      });
      return true;
    },
    [channel],
  );

  const verify = useCallback(async () => {
    if (code.length !== 6) {
      toast.error("Enter the 6-digit verification code");
      return false;
    }
    if (expiresIn <= 0) {
      toast.error("This code has expired", { description: "Request a new verification code." });
      return false;
    }
    setVerifying(true);
    await new Promise((r) => setTimeout(r, 500));
    setVerifying(false);
    if (code !== issued.current) {
      toast.error("Incorrect verification code");
      return false;
    }
    return true;
  }, [code, expiresIn]);

  const reset = useCallback(() => {
    issued.current = null;
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
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
