import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { AuthCard } from "@/components/site/AuthCard";
import { OtpRequestStep, OtpVerifyStep } from "@/components/site/OtpForm";
import { useEmailOtp } from "@/lib/otp";
import { useApp } from "@/lib/store";

export const Route = createFileRoute("/admin/login")({
  head: () => ({
    meta: [
      { title: "Admin Login | Shami Business Ventures" },
      { name: "description", content: "Administrator sign-in with email or phone OTP for the Shami marketplace control centre." },
      { property: "og:title", content: "Admin Login | Shami" },
      { property: "og:description", content: "Platform control centre access with OTP verification." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminLogin,
});

function AdminLogin() {
  const { login } = useApp();
  const navigate = useNavigate();
  const [email, setEmail] = useState("admin@shamiventures.in");
  const [phone, setPhone] = useState("9900112233");
  const otp = useEmailOtp();
  const destination = otp.channel === "phone" ? phone : email.trim();

  const finish = async () => {
    const ok = await otp.verify();
    if (!ok) return;
    login({ name: "Platform Admin", email: email.trim().toLowerCase(), role: "admin" });
    toast.success(otp.channel === "phone" ? "Admin mobile verified" : "Admin email verified");
    navigate({ to: "/admin/dashboard" });
  };

  return (
    <AuthCard title="Admin Login" subtitle="Verify your administrator email or mobile number with a one-time code">
      {otp.stage === "request" ? (
        <OtpRequestStep
          otp={otp}
          email={email}
          setEmail={setEmail}
          phone={phone}
          setPhone={setPhone}
          emailLabel="Admin email"
        />
      ) : (
        <OtpVerifyStep
          destination={destination}
          otp={otp}
          submitLabel="Verify & Enter Admin Panel"
          onSubmit={() => void finish()}
        />
      )}
    </AuthCard>
  );
}
