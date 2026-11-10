import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowLeft, Camera, CheckCircle2, Keyboard, LogIn, RefreshCw, ScanLine, ShieldCheck, XOctagon } from "lucide-react";
import { LogoMark } from "@/components/brand/Logo";
import { readGodownDevice } from "@/components/attendance/godownDevice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { istDateTime } from "@/lib/delivery-notes";
import { scanDeliveryPaper } from "@/lib/delivery-notes.functions";
import {
  codeFromHash, paperKindWords, paperName, phoneWords, readScannedText, roleWords, scannedTextWords, scanWords,
  type Bi, type PaperScan, type ScannerRole, type ScanTone, type ScanWords,
} from "@/lib/delivery-papers";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { cn } from "@/lib/utils";

/*
 * The godown's check of a delivery note or slip: open by scanning its QR with this page's scanner, or with the
 * phone's camera app (the QR is a link here with the paper's code after "#"). Only godown staff, channel partners
 * and administrators get an answer, and the database decides it (public.delivery_paper_scan). Green comes only after
 * the handover is recorded, so "no green, no goods" is a rule the godown can follow. Everything the answer says is
 * in English and Kannada together.
 */
export const Route = createFileRoute("/slip")({
  head: () => ({ meta: [{ title: "Check a delivery slip | Grain Bazar" }, { name: "robots", content: "noindex" }] }),
  component: SlipCheckPage,
});

type Me = { name: string; place: string; role: ScannerRole };
type Reading = { kind: "scan"; scan: PaperScan } | { kind: "problem"; words: ScanWords };

const TONES: Record<ScanTone, string> = {
  green: "border-emerald-700 bg-emerald-600 text-white",
  ready: "border-navy bg-white text-navy",
  amber: "border-amber-600 bg-amber-300 text-black",
  red: "border-red-800 bg-red-600 text-white",
};

/** English with its Kannada underneath. The dictionary must not translate this again. */
function Both({ text, className = "", knClassName = "" }: { text: Bi; className?: string; knClassName?: string }) {
  return (
    <span data-no-translate className={cn("block", className)}>
      <span className="block">{text.en}</span>
      <span lang="kn" className={cn("block", knClassName)}>{text.kn}</span>
    </span>
  );
}

type Detector = { detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> };
type DetectorClass = { new (options: { formats: string[] }): Detector };
const detectorClass = () => (typeof window === "undefined" ? undefined : (window as unknown as { BarcodeDetector?: DetectorClass }).BarcodeDetector);

function SlipCheckPage() {
  const [me, setMe] = useState<Me | null | "signed_out" | "not_allowed">(null);
  const [reading, setReading] = useState<Reading | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"" | "check" | "handover">("");
  const [failed, setFailed] = useState("");
  const [scanning, setScanning] = useState(false);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState("");
  const [ticked, setTicked] = useState<number[]>([]);
  const checked = useRef("");
  // The godown's registered phone keeps its token from the attendance registration; any other phone has none.
  const [device] = useState(() => (typeof window === "undefined" ? null : readGodownDevice()));

  // A new answer is read from its headline (first on the page), even if the page was scrolled down to the button.
  useEffect(() => {
    if (reading || failed) window.scrollTo({ top: 0 });
  }, [reading, failed]);

  // Who is signed in, shown at the top of every answer: a fake page reached from a forged QR can't know it.
  useEffect(() => {
    if (STATIC_DATA_MODE) return;
    void (async () => {
      const { data: session } = await supabase.auth.getSession();
      const userId = session.session?.user.id;
      if (!userId) { setMe("signed_out"); return; }
      const [{ data: isAdmin }, { data: employee }, { data: partner }] = await Promise.all([
        supabase.rpc("has_role", { _user_id: userId, _role: "admin" }),
        supabase.from("staff_employees").select("name,branch_id,status").eq("user_id", userId).maybeSingle(),
        supabase.from("channel_partners").select("name,branch_id,status").eq("user_id", userId).maybeSingle(),
      ]);
      const godownName = async (id: string) => (await supabase.from("branches").select("name").eq("id", id).maybeSingle()).data?.name ?? id;
      if (isAdmin) {
        const { data: profile } = await supabase.from("profiles").select("full_name,email").eq("id", userId).maybeSingle();
        setMe({ name: profile?.full_name?.trim() || profile?.email?.trim() || "Admin", place: "Office", role: "admin" });
      } else if (employee?.status === "active") {
        setMe({ name: employee.name, place: await godownName(employee.branch_id), role: "staff" });
      } else if (partner?.status === "active") {
        setMe({ name: partner.name, place: await godownName(partner.branch_id), role: "partner" });
      } else setMe("not_allowed");
    })();
  }, []);

  const run = useCallback(async (target: string, handover: boolean, lines?: number[]) => {
    setBusy(handover ? "handover" : "check");
    setFailed("");
    // A new paper's answer never sits under the last paper's. A handover keeps its own card while it records.
    if (!handover) { setReading(null); setTicked([]); }
    try {
      const scan = await scanDeliveryPaper({ data: { code: target, handover, lines, device: device?.token } });
      setReading({ kind: "scan", scan });
      // The items still to go stay ticked only if they still are.
      if (scan.result !== "handed_over") setTicked((current) => current.filter((line) => scan.lines?.some((item) => item.line === line && !item.handover)));
      else setTicked([]);
    } catch (cause) {
      // No answer is never green: say it plainly and let them try again.
      const message = cause instanceof Error ? cause.message : "";
      setFailed(/unauthori[sz]ed|jwt|session/i.test(message)
        ? "You are signed out. Sign in again with your staff, partner or admin account, then scan the paper again."
        : message || "The paper could not be checked");
      setReading(null);
    } finally {
      setBusy("");
    }
  }, [device]);

  const open = useCallback((next: string) => {
    setCode(next);
    if (typeof window !== "undefined" && window.location.hash !== `#${next}`) window.history.replaceState(null, "", `#${next}`);
    void run(next, false);
  }, [run]);

  // The code in the address: from the phone's camera app, or a QR scanned while this page was open.
  useEffect(() => {
    if (typeof me !== "object" || me === null) return undefined;
    const fromHash = () => {
      const next = codeFromHash(window.location.hash);
      if (!next || next === checked.current) return;
      checked.current = next;
      open(next);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, [me, open]);

  const readText = useCallback((text: string) => {
    const result = readScannedText(text, window.location.host);
    if ("code" in result) { checked.current = result.code; open(result.code); return; }
    setCode("");
    setFailed("");
    setTicked([]);
    setReading({ kind: "problem", words: scannedTextWords(result) });
  }, [open]);

  if (STATIC_DATA_MODE) {
    return <Shell me={null}><p className="text-sm text-slate">Checking delivery papers needs the live database, so it is not available in this demo.</p></Shell>;
  }
  if (me === null) {
    return <Shell me={null}><p className="flex items-center gap-2 text-sm text-slate"><RefreshCw className="h-4 w-4 animate-spin" /> Opening…</p></Shell>;
  }
  if (me === "signed_out" || me === "not_allowed") {
    return (
      <Shell me={null}>
        <section className="space-y-3 rounded-2xl border border-border bg-card p-4 shadow-sm">
          <h1 className="text-lg font-extrabold text-navy"><Both text={{ en: "Sign in to check this paper", kn: "ಈ ಪತ್ರ ಪರಿಶೀಲಿಸಲು ಸೈನ್ ಇನ್ ಮಾಡಿ" }} /></h1>
          <p className="text-sm text-charcoal">
            {me === "not_allowed" ? "This account can't check delivery papers. " : ""}
            Only godown staff, channel partners and the office can check a delivery note or slip. Sign in with your account, then scan the QR again.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild className="bg-navy text-white hover:bg-navy/90"><Link to="/staff/login"><LogIn className="mr-1.5 h-4 w-4" /> Godown staff sign in</Link></Button>
            <Button asChild variant="outline"><Link to="/partner/login">Channel partner sign in</Link></Button>
            <Button asChild variant="outline"><Link to="/admin/login">Admin sign in</Link></Button>
          </div>
        </section>
      </Shell>
    );
  }

  const scan = reading?.kind === "scan" ? reading.scan : null;
  const words = scan ? scanWords(scan) : reading?.kind === "problem" ? reading.words : null;
  // After a scan, the server's word for who scanned: the account the answer was given to.
  const shown: Me = scan ? { name: scan.by, place: scan.godown || "Office", role: scan.role } : me;
  const phone = scan?.device?.registered ?? Boolean(device);
  const ticking = Boolean(scan && scan.paper?.doc === "note" && (scan.result === "ready" || scan.result === "partly_handed_over"));
  const openLines = (scan?.lines ?? []).filter((line) => !line.handover).map((line) => line.line);

  return (
    <Shell me={shown} phone={phone}>
      {busy === "check" && !reading && <p className="flex items-center gap-2 text-sm text-slate"><RefreshCw className="h-4 w-4 animate-spin" /> Checking the paper…</p>}
      {failed && (
        <div role="alert" className="rounded-2xl border-4 border-amber-600 bg-amber-300 p-4 text-black">
          <p className="flex items-center gap-2 text-xl font-extrabold uppercase"><AlertTriangle className="h-7 w-7 shrink-0" /> <Both text={{ en: "Not checked", kn: "ಪರಿಶೀಲನೆ ಆಗಿಲ್ಲ" }} /></p>
          <p className="mt-1 text-sm font-semibold">{failed}</p>
          <Both className="mt-1 text-sm" text={{ en: "Nothing was recorded. Do not hand over until the screen turns green. Try again, or ask the office.", kn: "ಏನೂ ದಾಖಲಾಗಿಲ್ಲ. ಪರದೆ ಹಸಿರಾಗುವವರೆಗೆ ಸರಕು ಕೊಡಬೇಡಿ. ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ ಅಥವಾ ಕಚೇರಿಯನ್ನು ಕೇಳಿ." }} />
          {code && <Button className="mt-2 bg-black text-white hover:bg-black/85" disabled={busy !== ""} onClick={() => void run(code, false)}>Try again · ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ</Button>}
        </div>
      )}

      {words && (
        <section aria-live="assertive" data-no-translate className={cn("rounded-2xl border-4 p-4 shadow-md", TONES[words.tone])}>
          <div className="flex items-start gap-2">
            {words.tone === "green" ? <CheckCircle2 className="h-10 w-10 shrink-0" /> : words.tone === "ready" ? <ShieldCheck className="h-9 w-9 shrink-0" />
              : words.tone === "amber" ? <AlertTriangle className="h-10 w-10 shrink-0" /> : <XOctagon className="h-10 w-10 shrink-0" />}
            <Both text={words.headline} className="min-w-0 break-words text-2xl font-extrabold uppercase leading-tight sm:text-3xl" knClassName="mt-0.5 text-xl normal-case sm:text-2xl" />
          </div>
          <div className="mt-2 space-y-1.5 text-sm font-medium sm:text-base">
            {words.lines.map((line) => <Both key={line.en} text={line} className="break-words" knClassName="text-[0.95em] opacity-90" />)}
          </div>
          {scan && <PaperFacts scan={scan} tone={words.tone} ticking={ticking} ticked={ticked} onTick={(line, on) => setTicked((current) => (on ? [...new Set([...current, line])] : current.filter((item) => item !== line)))} />}
          {scan?.result === "ready" && !ticking && (
            <Button className="mt-4 h-auto min-h-14 w-full flex-col bg-emerald-700 py-2 text-lg font-extrabold text-white hover:bg-emerald-800" disabled={busy !== ""} onClick={() => void run(code, true)}>
              {busy === "handover" ? <><RefreshCw className="mr-2 h-5 w-5 animate-spin" /> Recording… · ದಾಖಲಿಸಲಾಗುತ್ತಿದೆ…</> : <><span>Hand over now: record it</span><span className="text-base">ಈಗ ಹಸ್ತಾಂತರಿಸಿ: ದಾಖಲಿಸಿ</span></>}
            </Button>
          )}
          {ticking && (
            <div className="mt-3 space-y-2">
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="outline" className="border-navy text-navy" disabled={busy !== "" || openLines.length === 0} onClick={() => setTicked(openLines)}>Tick all still to go · ಎಲ್ಲವನ್ನೂ ಗುರುತಿಸಿ</Button>
                {ticked.length > 0 && <Button type="button" size="sm" variant="outline" disabled={busy !== ""} onClick={() => setTicked([])}>Clear · ತೆರವುಗೊಳಿಸಿ</Button>}
              </div>
              <Button className="h-auto min-h-14 w-full flex-col bg-emerald-700 py-2 text-lg font-extrabold text-white hover:bg-emerald-800" disabled={busy !== "" || ticked.length === 0} onClick={() => void run(code, true, [...ticked].sort((a, b) => a - b))}>
                {busy === "handover" ? <><RefreshCw className="mr-2 h-5 w-5 animate-spin" /> Recording… · ದಾಖಲಿಸಲಾಗುತ್ತಿದೆ…</>
                  : ticked.length === 0 ? <><span>Tick the items being handed over</span><span className="text-base">ಹಸ್ತಾಂತರಿಸುವ ಸರಕುಗಳನ್ನು ಗುರುತಿಸಿ</span></>
                    : <><span>Hand over item{ticked.length === 1 ? "" : "s"} {[...ticked].sort((a, b) => a - b).join(", ")}: record it</span><span className="text-base">ಸರಕು {[...ticked].sort((a, b) => a - b).join(", ")} ಹಸ್ತಾಂತರಿಸಿ: ದಾಖಲಿಸಿ</span></>}
              </Button>
            </div>
          )}
        </section>
      )}

      <Scanner scanning={scanning} setScanning={setScanning} onText={readText} />

      {!scanning && (
        <div className="space-y-2">
          <Button className="h-auto min-h-12 w-full flex-col bg-navy py-2 text-base font-bold text-white hover:bg-navy/90" disabled={busy !== ""}
            onClick={() => { setReading(null); setFailed(""); setTicked([]); setScanning(true); }}>
            <span className="flex items-center"><ScanLine className="mr-2 h-5 w-5" /> {reading ? "Scan the next paper" : "Scan a delivery note or slip"}</span>
            <span className="text-sm font-semibold">{reading ? "ಮುಂದಿನ ಪತ್ರ ಸ್ಕ್ಯಾನ್ ಮಾಡಿ" : "ಡೆಲಿವರಿ ನೋಟ್ ಅಥವಾ ಸ್ಲಿಪ್ ಸ್ಕ್ಯಾನ್ ಮಾಡಿ"}</span>
          </Button>
          {typing ? (
            <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); if (typed.trim()) readText(typed); }}>
              <Input aria-label="Code or link from the QR" value={typed} onChange={(event) => setTyped(event.target.value)} placeholder="Paste the link or code" className="h-10 min-w-0 flex-1" />
              <Button type="submit" variant="outline" className="h-10" disabled={busy !== "" || !typed.trim()}>Check</Button>
            </form>
          ) : (
            <button type="button" className="flex items-center gap-1.5 text-xs font-semibold text-navy hover:underline" onClick={() => setTyping(true)}>
              <Keyboard className="h-3.5 w-3.5" /> The camera can't read it: paste the link or code
            </button>
          )}
        </div>
      )}

      <section data-no-translate className="rounded-2xl border border-border bg-card p-4 text-xs text-charcoal shadow-sm">
        <p className="font-bold text-navy">How it works · ಹೇಗೆ ಕೆಲಸ ಮಾಡುತ್ತದೆ</p>
        <ul className="mt-1 list-disc space-y-1.5 pl-4">
          <li><Both text={{ en: "Give the goods only when this screen turns green. Green appears once, after you press the button, and records who handed over, when and on which phone.", kn: "ಈ ಪರದೆ ಹಸಿರಾದಾಗ ಮಾತ್ರ ಸರಕು ಕೊಡಿ. ಬಟನ್ ಒತ್ತಿದ ನಂತರ ಒಮ್ಮೆ ಮಾತ್ರ ಹಸಿರು ಬರುತ್ತದೆ; ಯಾರು, ಯಾವಾಗ, ಯಾವ ಫೋನ್‌ನಲ್ಲಿ ಹಸ್ತಾಂತರಿಸಿದರು ಎಂದು ದಾಖಲಾಗುತ್ತದೆ." }} /></li>
          <li><Both text={{ en: "Red: do not hand over. Already handed over, a duplicate copy, a replaced original, a forged or unknown code, or the order is cancelled or stopped.", kn: "ಕೆಂಪು: ಹಸ್ತಾಂತರಿಸಬೇಡಿ. ಈಗಾಗಲೇ ಹಸ್ತಾಂತರವಾಗಿದೆ, ನಕಲು ಪ್ರತಿ, ಬದಲಾದ ಮೂಲ ಪ್ರತಿ, ನಕಲಿ ಅಥವಾ ಗೊತ್ತಿಲ್ಲದ ಕೋಡ್, ಅಥವಾ ಆರ್ಡರ್ ರದ್ದು/ನಿಲ್ಲಿಸಲಾಗಿದೆ." }} /></li>
          <li><Both text={{ en: "Amber: do not hand over here. Ask the office.", kn: "ಹಳದಿ: ಇಲ್ಲಿ ಹಸ್ತಾಂತರಿಸಬೇಡಿ. ಕಚೇರಿಯನ್ನು ಕೇಳಿ." }} /></li>
          <li><Both text={{ en: "Only the ORIGINAL paper works. Papers stamped DUPLICATE COPY are for records.", kn: "ಮೂಲ ಪ್ರತಿ ಮಾತ್ರ ಕೆಲಸ ಮಾಡುತ್ತದೆ. 'ನಕಲು ಪ್ರತಿ' ಮುದ್ರೆಯ ಪತ್ರಗಳು ದಾಖಲೆಗೆ ಮಾತ್ರ." }} /></li>
          <li><Both text={{ en: "Scan with the button on this page. Check that your own name is at the top: a forged QR can open a fake page that doesn't know who you are.", kn: "ಈ ಪುಟದ ಬಟನ್‌ನಿಂದ ಸ್ಕ್ಯಾನ್ ಮಾಡಿ. ಮೇಲೆ ನಿಮ್ಮ ಹೆಸರು ಇದೆಯೇ ನೋಡಿ: ನಕಲಿ QR ನಿಮ್ಮನ್ನು ತಿಳಿಯದ ನಕಲಿ ಪುಟ ತೆರೆಯಬಹುದು." }} /></li>
        </ul>
      </section>
    </Shell>
  );
}

function Shell({ me, phone, children }: { me: Me | null; phone?: boolean; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[oklch(0.972_0.004_258)] pb-10">
      <header className="sticky top-0 z-30 border-b border-border bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-md items-center justify-between gap-2 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <LogoMark className="h-10 w-10 shrink-0" />
            <div className="min-w-0">
              <p className="truncate text-sm font-extrabold text-navy">{me ? me.name : "Delivery paper check"}</p>
              <p className="truncate text-xs text-slate" data-no-translate>
                {me ? `${roleWords(me.role).en} · ${me.place} · ${phoneWords(Boolean(phone)).en}` : "Grain Bazar"}
              </p>
            </div>
          </div>
          {me && (
            <Link to={me.role === "admin" ? "/admin/delivery-notes" : me.role === "partner" ? "/partner" : "/staff"}
              className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1.5 text-xs font-semibold text-navy hover:border-gold hover:text-gold">
              <ArrowLeft className="h-3.5 w-3.5" /> {me.role === "admin" ? "Admin" : me.role === "partner" ? "Partner" : "Staff app"}
            </Link>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-md space-y-4 px-4 py-4">{children}</main>
    </div>
  );
}

/** What the paper is and what it covers, under the answer; on a note being handed over, the items to tick. */
function PaperFacts({ scan, tone, ticking, ticked, onTick }: { scan: PaperScan; tone: ScanTone; ticking: boolean; ticked: number[]; onTick: (line: number, on: boolean) => void }) {
  if (!scan.paper || !scan.note) return null;
  const light = tone === "green" || tone === "red";
  const name = paperName(scan.paper);
  const kind = paperKindWords(scan.paper.kind, scan.paper.duplicate_no);
  const now = scan.handed_now ?? [];
  return (
    <div className={cn("mt-3 rounded-xl p-3 text-sm", light ? "bg-white/15" : "bg-black/5")}>
      <p className="font-bold">{name.en} · {scan.note.note_no} · {kind.en}</p>
      <p className="text-xs font-semibold opacity-90" lang="kn">{name.kn} · {kind.kn}</p>
      <p>Order {scan.note.order_no} · {scan.note.customer}</p>
      <p>Godown · ಗೋದಾಮು: {scan.note.godown || "—"}</p>
      <ul className="mt-2 space-y-1">
        {(scan.lines ?? []).map((line) => {
          const open = !line.handover;
          const label = (
            <>
              <span className="min-w-0 break-words"><span className="font-semibold">{line.line}. {line.name}</span>{line.pack_size ? ` · ${line.pack_size}` : ""}{line.stock_no ? ` · stock ${line.stock_no}` : ""}</span>
              <span className="shrink-0 text-right font-extrabold">× {line.qty}
                {line.handover && <span className="block text-[11px] font-semibold">{now.includes(line.line) ? "give now · ಈಗ ಕೊಡಿ" : "handed over · ಹಸ್ತಾಂತರವಾಗಿದೆ"}</span>}
              </span>
            </>
          );
          return (
            <li key={line.line} className="border-t border-current/20 pt-1">
              {ticking && open ? (
                <label className="flex cursor-pointer items-start gap-2">
                  <input type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-emerald-700" checked={ticked.includes(line.line)} onChange={(event) => onTick(line.line, event.target.checked)} aria-label={`Item ${line.line}: ${line.name}`} />
                  <span className="flex min-w-0 flex-1 items-start justify-between gap-3">{label}</span>
                </label>
              ) : (
                <div className={cn("flex items-start justify-between gap-3", ticking && "opacity-60")}>{label}</div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-[11px] opacity-80">Checked {istDateTime(scan.scanned_at)} by {scan.by} ({roleWords(scan.role).en}{scan.godown ? `, ${scan.godown}` : ""}, {phoneWords(Boolean(scan.device?.registered)).en}{scan.device?.registered && scan.device.label ? `: ${scan.device.label}` : ""})</p>
    </div>
  );
}

/**
 * The camera, reading QR codes with the browser's own barcode reader (Chrome on Android has one). Where the browser
 * has none (Safari on an iPhone), a QR reader written in JavaScript (jsQR) is loaded and reads the camera frames.
 * The phone's camera app also opens the QR's link here.
 */
function Scanner({ scanning, setScanning, onText }: { scanning: boolean; setScanning: (on: boolean) => void; onText: (text: string) => void }) {
  const video = useRef<HTMLVideoElement | null>(null);
  const [problem, setProblem] = useState("");

  useEffect(() => {
    if (!scanning) return undefined;
    if (!navigator.mediaDevices?.getUserMedia) {
      setProblem("This browser can't open the camera here. Open your phone's camera app and point it at the QR: it opens this page with the answer. Or paste the link below.");
      setScanning(false);
      return undefined;
    }
    let stream: MediaStream | null = null;
    let timer: number | undefined;
    let stopped = false;
    const stop = () => {
      stopped = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
    void (async () => {
      try {
        setProblem("");
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        if (stopped) { stop(); return; }
        const element = video.current;
        if (!element) return;
        element.srcObject = stream;
        await element.play();
        const Reader = detectorClass();
        let read: () => Promise<string | null>;
        if (Reader) {
          const reader = new Reader({ formats: ["qr_code"] });
          read = async () => (await reader.detect(element)).find((item) => item.rawValue)?.rawValue ?? null;
        } else {
          const { default: jsQR } = await import("jsqr");
          const canvas = document.createElement("canvas");
          const context = canvas.getContext("2d", { willReadFrequently: true });
          read = async () => {
            if (!context || !element.videoWidth) return null;
            // A frame of at most 640 px across is plenty for a QR filling part of the picture, and quick on a phone.
            const scale = Math.min(1, 640 / element.videoWidth);
            canvas.width = Math.round(element.videoWidth * scale);
            canvas.height = Math.round(element.videoHeight * scale);
            context.drawImage(element, 0, 0, canvas.width, canvas.height);
            const frame = context.getImageData(0, 0, canvas.width, canvas.height);
            return jsQR(frame.data, frame.width, frame.height, { inversionAttempts: "dontInvert" })?.data || null;
          };
        }
        const look = async () => {
          if (stopped) return;
          try {
            const text = await read();
            if (text) { stop(); setScanning(false); onText(text); return; }
          } catch { /* a frame that couldn't be read: try the next */ }
          timer = window.setTimeout(() => void look(), 200);
        };
        void look();
      } catch (cause) {
        stop();
        setScanning(false);
        setProblem(cause instanceof Error && cause.name === "NotAllowedError"
          ? "Camera permission was refused. Allow the camera for this site in the browser settings, or use the phone's camera app."
          : "The camera could not be opened. Use the phone's camera app to scan the QR, or paste the link below.");
      }
    })();
    return stop;
  }, [scanning, setScanning, onText]);

  return (
    <>
      {problem && <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">{problem}</p>}
      {scanning && (
        <section className="space-y-2 rounded-2xl border border-border bg-black p-2 shadow-sm">
          <video ref={video} className="aspect-square w-full rounded-xl object-cover" muted playsInline />
          <div className="flex items-center justify-between gap-2 px-1 pb-1">
            <p className="flex items-center gap-1.5 text-xs text-white"><Camera className="h-4 w-4" /> Point the camera at the QR code · QR ಕಡೆ ಕ್ಯಾಮೆರಾ ತೋರಿಸಿ</p>
            <Button size="sm" variant="outline" onClick={() => setScanning(false)}>Stop</Button>
          </div>
        </section>
      )}
    </>
  );
}
