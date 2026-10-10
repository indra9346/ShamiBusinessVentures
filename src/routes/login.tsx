import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { toast } from "sonner";
import { AuthCard } from "@/components/site/AuthCard";
import { OtpRequestStep, OtpVerifyStep } from "@/components/site/OtpForm";
import { useEmailOtp } from "@/lib/otp";
import { useApp } from "@/lib/store";
import { supabase } from "@/integrations/supabase/client";

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
  // A sign-in request must never create an account. Customer accounts are
  // created only through /register, where the profile is collected.
  const otp = useEmailOtp({ shouldCreateUser: false, requiredRole: "customer" });
  const destination = otp.channel === "phone" ? phone : email.trim();

  const finish = async () => {
    const ok = await otp.verify();
    if (!ok) return;
    const clean = email.trim().toLowerCase();
    const { data: { user: authUser } } = await supabase.auth.getUser();
    let name =
      otp.channel === "phone"
        ? "Customer"
        : clean.split("@")[0]!.replace(/[._]/g, " ");
    let userPhone = otp.channel === "phone" ? `+91${phone.replace(/\D/g, "").slice(-10)}` : "";
    let userEmail = otp.channel === "email" ? clean : (authUser?.email ?? "");

    if (authUser?.id) {
      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("full_name, phone, email, status")
        .eq("id", authUser.id)
        .maybeSingle();

      if (profileError || !profile) {
        await supabase.auth.signOut();
        toast.error("Could not verify your customer profile", {
          description: profileError?.message ?? "Contact Shami support to restore your account profile.",
        });
        return;
      }
      if (!["active", "approved"].includes((profile.status ?? "").trim().toLowerCase())) {
        await supabase.auth.signOut();
        toast.error("This customer account is not active", {
          description: "Contact Shami support if you think this is a mistake.",
        });
        return;
      }

      if (profile.full_name) name = profile.full_name;
      if (profile.phone) userPhone = profile.phone;
      if (profile.email) userEmail = profile.email;
      const meta = (authUser.user_metadata ?? {}) as Record<string, unknown>;
      if (!userPhone) {
        userPhone = authUser.phone || (meta["phone"] as string) || "";
      }
      if ((!name || name === "Customer") && meta["full_name"]) {
        name = meta["full_name"] as string;
      }
    }

    login({
      ...(authUser?.id ? { id: authUser.id } : {}),
      name,
      email: userEmail,
      role: "customer",
      ...(userPhone ? { phone: userPhone } : {}),
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
