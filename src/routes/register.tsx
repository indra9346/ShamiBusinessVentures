import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { AuthCard } from "@/components/site/AuthCard";
import { OtpRequestStep, OtpVerifyStep } from "@/components/site/OtpForm";
import { useEmailOtp } from "@/lib/otp";
import { useApp } from "@/lib/store";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/register")({
  head: () => ({ meta: [{ title: "Create Account | Shami Business Ventures" }, { name: "description", content: "Register as a buyer for bulk and retail essentials." }] }),
  component: RegisterPage,
});

function RegisterPage() {
  const { login } = useApp();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const otp = useEmailOtp({ requiredRole: "customer" });

  const finish = async () => {
    if (!await otp.verify()) return;
    login({ name: name.trim(), email: otp.channel === "email" ? email.trim().toLowerCase() : "", role: "customer", ...(otp.channel === "phone" ? { phone: `+91${phone.replace(/\D/g, "").slice(-10)}` } : {}) });
    toast.success("Your account is verified");
    navigate({ to: "/account", replace: true });
  };

  return <AuthCard title="Create Account" subtitle="Verify your email or mobile number to create your customer account" footer={<>Already registered? <Link to="/login" className="font-semibold text-gold hover:underline">Sign in</Link></>}>
    {otp.stage === "request" ? <div className="space-y-4">
      <label className="block"><span className="mb-1.5 block text-xs font-semibold text-charcoal">Full name</span><Input required minLength={2} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></label>
      <OtpRequestStep otp={otp} email={email} setEmail={setEmail} phone={phone} setPhone={setPhone} metadata={{ full_name: name.trim(), phone: phone.trim() }} submitLabel="Verify and Create Account" />
    </div> : <OtpVerifyStep destination={otp.channel === "phone" ? phone : email} otp={otp} submitLabel="Verify and Create Account" onSubmit={() => void finish()} />}
  </AuthCard>;
}
