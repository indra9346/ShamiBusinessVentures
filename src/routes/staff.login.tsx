import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { showAuthNotice } from "@/components/site/AuthNotice";
import { AuthCard } from "@/components/site/AuthCard";
import { OtpVerifyStep } from "@/components/site/OtpForm";
import { Input } from "@/components/ui/input";
import { normalisePhone, useEmailOtp } from "@/lib/otp";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/staff/login")({
  head: () => ({ meta: [{ title: "Godown Staff Login | Grain Bazar" }, { name: "robots", content: "noindex" }] }),
  component: StaffLogin,
});

/** Sign-in for godown employees: an SMS code to the mobile the Grain Bazar office registered. */
function StaffLogin() {
  const navigate = useNavigate();
  const [phone, setPhone] = useState("");
  const otp = useEmailOtp({ shouldCreateUser: false });

  // Already signed in as an active employee: straight to attendance.
  useEffect(() => {
    void supabase.auth.getSession().then(async ({ data }) => {
      if (!data.session?.user) return;
      const { data: employee } = await supabase.from("staff_employees").select("status").eq("user_id", data.session.user.id).maybeSingle();
      if (employee?.status === "active") navigate({ to: "/staff", replace: true });
    });
  }, [navigate]);

  const finish = async () => {
    if (!(await otp.verify())) return;
    const { data: { user } } = await supabase.auth.getUser();
    const { data: employee } = user
      ? await supabase.from("staff_employees").select("status").eq("user_id", user.id).maybeSingle()
      : { data: null };
    if (!employee || employee.status !== "active") {
      await supabase.auth.signOut();
      otp.reset();
      showAuthNotice(employee ? "Your staff login is deactivated" : "This mobile is not registered as a godown employee", "Contact the Grain Bazar office.");
      return;
    }
    navigate({ to: "/staff", replace: true });
  };

  return (
    <AuthCard title="Godown Staff Login" subtitle="Mark your attendance and request leave. Sign in with the mobile number registered by the Grain Bazar office.">
      {otp.stage === "request" ? (
        <form onSubmit={(event) => { event.preventDefault(); void otp.send(phone, "phone"); }} className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-charcoal">Mobile number</span>
            <div className="flex items-center gap-2">
              <span className="rounded-md border border-border bg-ivory px-3 py-2 text-sm font-semibold text-navy">+91</span>
              <Input value={phone} onChange={(event) => setPhone(normalisePhone(event.target.value))} inputMode="numeric" autoComplete="tel" placeholder="98XXXXXXXX" />
            </div>
          </label>
          <button disabled={otp.sending} className="w-full rounded-md bg-navy py-3 text-sm font-semibold text-white transition-colors hover:bg-midnight disabled:opacity-60">
            {otp.sending ? "Sending code…" : "Send OTP"}
          </button>
          <p className="text-xs text-slate">A 6-digit code will be sent by SMS to this mobile number.</p>
        </form>
      ) : (
        <OtpVerifyStep destination={phone} otp={otp} submitLabel="Verify & Sign In" onSubmit={() => void finish()} />
      )}
    </AuthCard>
  );
}
