import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { AuthCard } from "@/components/site/AuthCard";
import { OtpRequestStep, OtpVerifyStep } from "@/components/site/OtpForm";
import { useEmailOtp } from "@/lib/otp";
import { useApp } from "@/lib/store";

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "Customer Login | Shami Business Ventures" },
      { name: "description", content: "Sign in with an email or phone OTP to track orders, manage addresses and download GST invoices." },
      { property: "og:title", content: "Customer Login | Shami" },
      { property: "og:description", content: "Access your Shami marketplace account with email or mobile OTP verification." },
    ],
  }),
  component: LoginPage,
});

const KNOWN_NAMES: Record<string, string> = {
  "rahul.d@gmail.com": "Rahul Deshpande",
  "customer@example.com": "Customer Demo",
};

function LoginPage() {
  const { login } = useApp();
  const navigate = useNavigate();
  const [email, setEmail] = useState("rahul.d@gmail.com");
  const [phone, setPhone] = useState("9876543210");
  const otp = useEmailOtp();
  const destination = otp.channel === "phone" ? phone : email.trim();

  const finish = async () => {
    const ok = await otp.verify();
    if (!ok) return;
    const clean = email.trim().toLowerCase();
    const name =
      otp.channel === "phone"
        ? (KNOWN_NAMES[clean] ?? "Shami Customer")
        : (KNOWN_NAMES[clean] ?? clean.split("@")[0]!.replace(/[._]/g, " "));
    login({ name, email: clean, role: "customer" });
    toast.success(otp.channel === "phone" ? "Mobile number verified" : "Email verified", {
      description: `Signed in as ${name}`,
    });
    navigate({ to: "/account" });
  };

  return (
    <AuthCard
      title="Customer Login"
      subtitle="Verify your email or mobile number with a one-time code to sign in"
      footer={
        <>
          New to Shami?{" "}
          <Link to="/register" className="font-semibold text-gold hover:underline">
            Create an account
          </Link>
          <div className="mt-2 text-xs">
            Vendor?{" "}
            <Link to="/vendor/login" className="font-semibold text-navy hover:text-gold">
              Vendor login
            </Link>{" "}
            · Admin?{" "}
            <Link to="/admin/login" className="font-semibold text-navy hover:text-gold">
              Admin login
            </Link>
          </div>
        </>
      }
    >
      {otp.stage === "request" ? (
        <OtpRequestStep otp={otp} email={email} setEmail={setEmail} phone={phone} setPhone={setPhone} />
      ) : (
        <OtpVerifyStep destination={destination} otp={otp} submitLabel="Verify & Sign In" onSubmit={() => void finish()} />
      )}
    </AuthCard>
  );
}
