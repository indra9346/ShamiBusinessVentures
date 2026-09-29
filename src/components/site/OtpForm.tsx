import { Input } from "@/components/ui/input";
import { formatCountdown, normalisePhone, useEmailOtp, type OtpChannel } from "@/lib/otp";

/**
 * Step 1: choose email or phone and request a code.
 */
export function OtpRequestStep({
  otp,
  email,
  setEmail,
  phone,
  setPhone,
  emailLabel = "Email",
  submitLabel = "Send OTP",
}: {
  otp: ReturnType<typeof useEmailOtp>;
  email: string;
  setEmail: (v: string) => void;
  phone: string;
  setPhone: (v: string) => void;
  emailLabel?: string;
  submitLabel?: string;
}) {
  const tabs: { key: OtpChannel; label: string }[] = [
    { key: "email", label: "Email OTP" },
    { key: "phone", label: "Phone OTP" },
  ];

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void otp.send(otp.channel === "phone" ? phone : email.trim(), otp.channel);
      }}
      className="space-y-4"
    >
      <div className="flex rounded-md border border-border p-1">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => otp.setChannel(t.key)}
            className={`flex-1 rounded py-2 text-xs font-semibold transition-colors ${
              otp.channel === t.key ? "bg-navy text-white" : "text-slate hover:text-navy"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {otp.channel === "email" ? (
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-charcoal">{emailLabel}</span>
          <Input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="email" />
        </label>
      ) : (
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-charcoal">Mobile number</span>
          <div className="flex items-center gap-2">
            <span className="rounded-md border border-border bg-ivory px-3 py-2 text-sm font-semibold text-navy">
              +91
            </span>
            <Input
              value={phone}
              onChange={(e) => setPhone(normalisePhone(e.target.value))}
              inputMode="numeric"
              autoComplete="tel"
              placeholder="98XXXXXXXX"
            />
          </div>
        </label>
      )}

      <button
        disabled={otp.sending}
        className="w-full rounded-md bg-navy py-3 text-sm font-semibold text-white transition-colors hover:bg-midnight disabled:opacity-60"
      >
        {otp.sending ? "Sending code…" : submitLabel}
      </button>
      <p className="text-xs text-slate">
        {otp.channel === "phone"
          ? "A 6-digit code will be sent by SMS to this mobile number."
          : "A 6-digit verification code will be emailed to this address."}
      </p>
    </form>
  );
}

/**
 * Step 2 of the login flows: OTP entry.
 */
export function OtpVerifyStep({
  destination,
  otp,
  submitLabel,
  onSubmit,
}: {
  destination: string;
  otp: ReturnType<typeof useEmailOtp>;
  submitLabel: string;
  onSubmit: () => void;
}) {
  const shown = otp.channel === "phone" ? `+91 ${normalisePhone(destination)}` : destination;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="space-y-4"
    >
      <div className="rounded-md border border-dashed border-gold/50 bg-ivory p-3 text-xs text-slate">
        We sent a 6-digit verification code to <span className="font-semibold text-navy">{shown}</span>.
      </div>
      <label className="block">
        <span className="mb-1.5 block text-xs font-semibold text-charcoal">Verification code (OTP)</span>
        <Input
          value={otp.code}
          onChange={(e) => otp.setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="••••••"
          className="h-12 text-center text-lg font-bold tracking-[0.5em] text-navy"
        />
      </label>
      <p className="text-xs text-slate">
        {otp.expiresIn > 0 ? `Code expires in ${formatCountdown(otp.expiresIn)}` : "Code expired — request a new one."}
      </p>
      <button
        disabled={otp.verifying}
        className="w-full rounded-md bg-navy py-3 text-sm font-semibold text-white transition-colors hover:bg-midnight disabled:opacity-60"
      >
        {otp.verifying ? "Verifying…" : submitLabel}
      </button>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <button type="button" onClick={otp.reset} className="font-semibold text-navy hover:text-gold">
          {otp.channel === "phone" ? "Change number" : "Change email"}
        </button>
        <button
          type="button"
          disabled={!otp.canResend || otp.sending}
          onClick={() => void otp.send(destination, otp.channel)}
          className="font-semibold text-gold hover:underline disabled:text-slate disabled:no-underline"
        >
          {otp.canResend ? "Resend code" : `Resend in ${otp.resendIn}s`}
        </button>
      </div>
    </form>
  );
}
