import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { AuthCard } from "@/components/site/AuthCard";
import { OtpRequestStep, OtpVerifyStep } from "@/components/site/OtpForm";
import { useEmailOtp } from "@/lib/otp";
import { useApp } from "@/lib/store";

export const Route = createFileRoute("/vendor/login")({
  head: () => ({
    meta: [
      { title: "Vendor Login | Shami Business Ventures" },
      { name: "description", content: "Vendor sign-in with email or phone OTP for product, order, inventory and payout management." },
      { property: "og:title", content: "Vendor Login | Shami" },
      { property: "og:description", content: "Manage listings, orders, stock and earnings with OTP verification." },
    ],
  }),
  component: VendorLogin,
});

function VendorLogin() {
  const { login } = useApp();
  const navigate = useNavigate();
  const [email, setEmail] = useState("imran@shamisugar.in");
  const [phone, setPhone] = useState("9845012345");
  const otp = useEmailOtp();
  const destination = otp.channel === "phone" ? phone : email.trim();

  const finish = async () => {
    const ok = await otp.verify();
    if (!ok) return;
    login({ name: "Imran Shami", email: email.trim().toLowerCase(), role: "vendor" });
    toast.success(otp.channel === "phone" ? "Business mobile verified" : "Business email verified");
    navigate({ to: "/vendor/dashboard" });
  };

  return (
    <AuthCard
      title="Vendor Login"
      subtitle="Verify your business email or mobile number with a one-time code"
      footer={
        <>
          New vendor?{" "}
          <Link to="/vendor/register" className="font-semibold text-gold hover:underline">
            Register your business
          </Link>
        </>
      }
    >
      {otp.stage === "request" ? (
        <OtpRequestStep
          otp={otp}
          email={email}
          setEmail={setEmail}
          phone={phone}
          setPhone={setPhone}
          emailLabel="Business email"
        />
      ) : (
        <OtpVerifyStep
          destination={destination}
          otp={otp}
          submitLabel="Verify & Enter Vendor Panel"
          onSubmit={() => void finish()}
        />
      )}
    </AuthCard>
  );
}
