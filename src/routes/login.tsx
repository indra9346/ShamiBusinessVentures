import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { toast } from "sonner";
import { AuthCard } from "@/components/site/AuthCard";
import { OtpRequestStep, OtpVerifyStep } from "@/components/site/OtpForm";
import { useEmailOtp } from "@/lib/otp";
import { useApp } from "@/lib/store";

export const Route = createFileRoute("/login")({
  validateSearch: z.object({
    next: z.enum(["/checkout"]).optional(),
    productId: z.string().optional(),
  }),
  head: () => ({
    meta: [
      { title: "Customer Login | Shami Business Ventures" },
      {
        name: "description",
        content:
          "Sign in with an email or phone OTP to track orders, manage addresses and download GST invoices.",
      },
      { property: "og:title", content: "Customer Login | Shami" },
      {
        property: "og:description",
        content: "Access your Shami marketplace account with email or mobile OTP verification.",
      },
    ],
  }),
  component: LoginPage,
});

function LoginPage() {
  const { login } = useApp();
  const navigate = useNavigate();
  const { next, productId } = Route.useSearch();
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const otp = useEmailOtp({ requiredRole: "customer" });
  const destination = otp.channel === "phone" ? phone : email.trim();

  const finish = async () => {
    const ok = await otp.verify();
    if (!ok) return;
    const clean = email.trim().toLowerCase();
    const name =
      otp.channel === "phone"
        ? "Customer"
        : clean.split("@")[0]!.replace(/[._]/g, " ");
    login({
      name,
      email: otp.channel === "email" ? clean : "",
      role: "customer",
      ...(otp.channel === "phone" ? { phone: phone.trim() } : {}),
    });
    toast.success(otp.channel === "phone" ? "Mobile number verified" : "Email verified", {
      description: `Signed in as ${name}`,
    });
    if (next === "/checkout") {
      navigate({ to: "/checkout", search: { productId }, replace: true });
    } else {
      navigate({ to: "/account", replace: true });
    }
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
        />
      ) : (
        <OtpVerifyStep
          destination={destination}
          otp={otp}
          submitLabel="Verify & Sign In"
          onSubmit={() => void finish()}
        />
      )}
    </AuthCard>
  );
}
