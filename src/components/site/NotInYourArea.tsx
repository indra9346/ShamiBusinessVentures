import { useEffect, useState } from "react";
import { CheckCircle2, Handshake, MapPinned, Phone, Send } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useBranches } from "@/lib/branches";
import { OPEN_PIN_DIALOG_EVENT } from "@/lib/godown-rules";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";


type RequestKind = "service" | "partner";

/**
 * Shown where we don't sell yet: a PIN no godown serves. An animated map (our godown inside its
 * delivery circle, a truck heading to the customer's pin and turning back at the edge), the plain
 * message, and two ways forward: ask us to serve the area, or become our channel partner there.
 * Both are saved as enquiries in Admin > Enquiries.
 */
export function NotInYourArea({ pin, compact = false, className }: { pin: string; compact?: boolean; className?: string }) {
  const { branches } = useBranches();
  const { user } = useApp();
  const [kind, setKind] = useState<RequestKind | null>(null);
  const [form, setForm] = useState({ name: "", phone: "", email: "", locality: "", note: "" });
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<RequestKind | null>(null);
  const servedCities = [...new Set(branches.filter((b) => b.active && !b.vendorId && b.servesPincodes.length).map((b) => b.city || b.name))];

  useEffect(() => {
    setForm((f) => ({ ...f, name: f.name || user?.name || "", phone: f.phone || user?.phone || "", email: f.email || user?.email || "" }));
  }, [user?.name, user?.phone, user?.email]);

  const send = async () => {
    const phone = form.phone.replace(/[^\d+]/g, "");
    if (form.name.trim().length < 2) { toast.error("Enter your name"); return; }
    if (phone.replace(/\D/g, "").length < 10) { toast.error("Enter a valid 10-digit mobile number"); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) { toast.error("Enter a valid email address"); return; }
    if (!kind) return;
    const message = kind === "service"
      ? `Please start Grain Bazar service in my area. PIN ${pin}${form.locality.trim() ? `, ${form.locality.trim()}` : ""}.${form.note.trim() ? ` ${form.note.trim()}` : ""}`
      : `I want to become the official Grain Bazar channel partner for PIN ${pin}${form.locality.trim() ? `, ${form.locality.trim()}` : ""}.${form.note.trim() ? ` ${form.note.trim()}` : ""}`;
    setSending(true);
    try {
      if (!STATIC_DATA_MODE) {
        const { data, error } = await supabase.rpc("submit_contact_enquiry", {
          _name: form.name.trim(), _email: form.email.trim(), _phone: phone, _message: message,
          _metadata: { request_type: kind === "service" ? "service_area_request" : "channel_partner_request", pin, locality: form.locality.trim() || null, source: "not_in_your_area" },
        });
        if (error || !data) throw error ?? new Error("The request could not be saved");
        void supabase.functions.invoke("send-enquiry", { body: { enquiry_id: data } }).catch(() => undefined);
      }
      setSent(kind);
      setKind(null);
    } catch {
      toast.error("Could not send your request", { description: "Please try again, or call us on +91 95385 00840." });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={cn("overflow-hidden rounded-2xl border border-gold/30 bg-card shadow-card", className)} role="status" aria-live="polite">
      <div className={cn("grid items-center gap-5 p-5", compact ? "" : "md:grid-cols-[minmax(0,0.95fr)_minmax(0,1fr)] md:p-7")}>
        <OutOfAreaScene pin={pin} />
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-gold">PIN {pin}</p>
          <h2 className="mt-1 text-xl font-extrabold text-navy sm:text-2xl">We're not in your area yet</h2>
          <p className="mt-2 text-sm leading-relaxed text-slate">
            Grain Bazar sells and delivers only around our godowns, so orders can't be placed for this PIN code for now.
            {servedCities.length > 0 && <> We serve <span className="font-semibold text-navy">{servedCities.join(" · ")}</span> today.</>}
          </p>

          {sent ? (
            <div className="gb-pop-in mt-4 flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
              <p>
                <span className="font-bold">Thank you! Your request is with our team.</span>{" "}
                {sent === "service" ? "We'll let you know as soon as Grain Bazar reaches your area." : "Our partnerships team will call you about becoming the channel partner for your area."}
              </p>
            </div>
          ) : kind ? (
            <form className="gb-pop-in mt-4 grid gap-2 rounded-xl border border-border bg-ivory/60 p-3" onSubmit={(e) => { e.preventDefault(); void send(); }}>
              <p className="text-sm font-bold text-navy">{kind === "service" ? "Request our service in your area" : "Become our channel partner for your area"}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <Input placeholder="Your name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-label="Your name" />
                <Input placeholder="Mobile number" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} aria-label="Mobile number" />
                <Input placeholder="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} aria-label="Email" />
                <Input placeholder="Area / locality (optional)" value={form.locality} onChange={(e) => setForm({ ...form, locality: e.target.value })} aria-label="Area or locality" />
              </div>
              <Input placeholder={kind === "service" ? "What would you like to buy? (optional)" : "Your shop or business (optional)"} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} aria-label="Message" />
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" disabled={sending} className="bg-navy text-white hover:bg-navy/90"><Send className="mr-1.5 h-4 w-4" />{sending ? "Sending…" : "Send to our team"}</Button>
                <button type="button" onClick={() => setKind(null)} className="text-xs font-semibold text-slate underline">Back</button>
              </div>
            </form>
          ) : (
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              <Button type="button" onClick={() => setKind("service")} className="h-auto min-w-0 justify-start gap-2 whitespace-normal bg-gold py-2.5 text-left font-bold leading-snug text-midnight hover:bg-gold-light">
                <MapPinned className="h-4 w-4 shrink-0" /> Request service in my area
              </Button>
              <Button type="button" variant="outline" onClick={() => setKind("partner")} className="h-auto min-w-0 justify-start gap-2 whitespace-normal border-navy py-2.5 text-left font-bold leading-snug text-navy hover:bg-navy hover:text-white">
                <Handshake className="h-4 w-4 shrink-0" /> Become our Channel Partner here
              </Button>
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <button type="button" onClick={() => window.dispatchEvent(new Event(OPEN_PIN_DIALOG_EVENT))} className="font-semibold text-gold hover:underline">
              Try another PIN code
            </button>
            <a href="tel:+919538500840" className="inline-flex items-center gap-1 font-semibold text-slate hover:text-navy"><Phone className="h-3.5 w-3.5" /> +91 95385 00840</a>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Our godown inside its delivery circle; a truck heads for the customer's pin and turns back at the edge. */
function OutOfAreaScene({ pin }: { pin: string }) {
  const [still, setStill] = useState(false);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    setStill(Boolean(media?.matches));
  }, []);
  const road = "M108 112 C 150 80, 196 128, 236 96 S 292 70, 304 74";
  return (
    <svg viewBox="0 0 360 190" className="mx-auto w-full max-w-[420px]" role="img" aria-label={`Map: PIN ${pin} is outside our delivery area`}>
      <defs>
        <linearGradient id="oaLand" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#f7f1e3" />
          <stop offset="100%" stopColor="#efe5cf" />
        </linearGradient>
        <radialGradient id="oaZone" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#2f5d46" stopOpacity="0.20" />
          <stop offset="100%" stopColor="#2f5d46" stopOpacity="0.04" />
        </radialGradient>
        <clipPath id="oaClip"><rect x="0" y="0" width="360" height="190" rx="18" /></clipPath>
      </defs>
      <g clipPath="url(#oaClip)">
        <rect width="360" height="190" fill="url(#oaLand)" />
        {/* streets */}
        <g stroke="#e3d6b8" strokeWidth="7" strokeLinecap="round" fill="none">
          <path d="M-10 40 H370" /><path d="M-10 150 H370" /><path d="M60 -10 V200" /><path d="M200 -10 V200" /><path d="M300 -10 V200" />
        </g>
        <g fill="#cfe3c8" opacity="0.8"><rect x="214" y="112" width="70" height="26" rx="6" /><rect x="14" y="56" width="34" height="80" rx="6" /></g>

        {/* delivery area */}
        <g className="gb-zone">
          <circle cx="104" cy="112" r="68" fill="url(#oaZone)" />
          <circle cx="104" cy="112" r="68" fill="none" stroke="#2f5d46" strokeWidth="1.6" strokeDasharray="5 5" className="gb-zone-ring" />
        </g>
        <text x="104" y="52" textAnchor="middle" fontSize="9" fontWeight="700" fill="#2f5d46" letterSpacing="1">WE DELIVER HERE</text>

        {/* the road out of the area */}
        <path d={road} fill="none" stroke="#b8a77f" strokeWidth="2.4" strokeDasharray="1 6" strokeLinecap="round" />

        {/* godown */}
        <g transform="translate(88 98)">
          <path d="M0 12 L16 2 L32 12 V30 H0 Z" fill="#2f5d46" />
          <rect x="11" y="17" width="10" height="13" fill="#d4a017" />
          <path d="M-2 13 L16 1 L34 13" stroke="#1e3d2e" strokeWidth="2.5" fill="none" strokeLinejoin="round" />
        </g>

        {/* truck: drives to the edge of the area, stops, turns back */}
        <g>
          <g transform="translate(-9 -7)">
            <rect x="0" y="2" width="12" height="9" rx="1.5" fill="#d4a017" />
            <path d="M12 5 H16 L19 8 V11 H12 Z" fill="#2f5d46" />
            <circle cx="4" cy="12" r="2.2" fill="#1e3d2e" /><circle cx="15" cy="12" r="2.2" fill="#1e3d2e" />
          </g>
          {!still && (
            <animateMotion dur="5s" repeatCount="indefinite" rotate="auto" calcMode="linear"
              keyPoints="0;0.36;0.36;0" keyTimes="0;0.42;0.68;1" path={road} />
          )}
        </g>
        {/* "can't go further" at the edge */}
        <g transform="translate(166 86)">
          <g className={still ? undefined : "gb-blink"}>
            <circle r="9" fill="#fff" stroke="#e11d48" strokeWidth="1.6" />
            <text y="4" textAnchor="middle" fontSize="12" fontWeight="800" fill="#e11d48">!</text>
          </g>
        </g>

        {/* customer's pin, searching */}
        <g transform="translate(304 74)">
          {!still && <>
            <circle r="10" fill="none" stroke="#e11d48" strokeWidth="1.6" className="gb-radar" />
            <circle r="10" fill="none" stroke="#e11d48" strokeWidth="1.6" className="gb-radar gb-radar-2" />
          </>}
          <g className={still ? undefined : "gb-bob"}>
            <path d="M0 2 C-11 -10 -10 -26 0 -27 C10 -26 11 -10 0 2 Z" fill="#e11d48" />
            <circle cy="-16" r="4.5" fill="#fff" />
          </g>
          <rect x="-26" y="10" width="52" height="15" rx="7.5" fill="#fff" stroke="#e11d48" strokeWidth="1" />
          <text y="21" textAnchor="middle" fontSize="9.5" fontWeight="800" fill="#9f1239">{pin}</text>
        </g>
      </g>
    </svg>
  );
}
