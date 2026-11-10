import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowLeft, Camera, CheckCircle2, Keyboard, LogIn, RefreshCw, ScanLine, ShieldCheck, XOctagon } from "lucide-react";
import { LogoMark } from "@/components/brand/Logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { istDateTime } from "@/lib/delivery-notes";
import { scanDeliveryPaper } from "@/lib/delivery-notes.functions";
import { codeFromHash, paperName, readScannedText, scanWords, type PaperScan, type ScanTone } from "@/lib/delivery-papers";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { cn } from "@/lib/utils";

/*
 * The godown's check of a delivery note or slip: open by scanning its QR with this page's scanner, or with the
 * phone's camera app (the QR is a link here with the paper's code after "#"). Only godown staff and administrators
 * get an answer, and the database decides it (public.delivery_paper_scan). Green comes only after the handover is
 * recorded, so "no green, no goods" is a rule the godown can follow.
 */
export const Route = createFileRoute("/slip")({
  head: () => ({ meta: [{ title: "Check a delivery slip | Grain Bazar" }, { name: "robots", content: "noindex" }] }),
  component: SlipCheckPage,
});

type Me = { name: string; place: string; role: "admin" | "staff" };
type Reading = { kind: "scan"; scan: PaperScan } | { kind: "problem"; headline: string; lines: string[] };

const TONES: Record<ScanTone, string> = {
  green: "border-emerald-700 bg-emerald-600 text-white",
  ready: "border-navy bg-white text-navy",
  amber: "border-amber-600 bg-amber-300 text-black",
  red: "border-red-800 bg-red-600 text-white",
};

type Detector = { detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> };
type DetectorClass = { new (options: { formats: string[] }): Detector; getSupportedFormats?: () => Promise<string[]> };
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
  const checked = useRef("");
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
      const [{ data: isAdmin }, { data: employee }] = await Promise.all([
        supabase.rpc("has_role", { _user_id: userId, _role: "admin" }),
        supabase.from("staff_employees").select("name,branch_id,status").eq("user_id", userId).maybeSingle(),
      ]);
      if (isAdmin) {
        const { data: profile } = await supabase.from("profiles").select("full_name,email").eq("id", userId).maybeSingle();
        setMe({ name: profile?.full_name?.trim() || profile?.email?.trim() || "Admin", place: "Office (admin)", role: "admin" });
      } else if (employee?.status === "active") {
        const { data: branch } = await supabase.from("branches").select("name").eq("id", employee.branch_id).maybeSingle();
        setMe({ name: employee.name, place: branch?.name ?? employee.branch_id, role: "staff" });
      } else setMe("not_allowed");
    })();
  }, []);

  const run = useCallback(async (target: string, handover: boolean) => {
    setBusy(handover ? "handover" : "check");
    setFailed("");
    // A new paper's answer never sits under the last paper's. A handover keeps its own card while it records.
    if (!handover) setReading(null);
    try {
      setReading({ kind: "scan", scan: await scanDeliveryPaper({ data: { code: target, handover } }) });
    } catch (cause) {
      // No answer is never green: say it plainly and let them try again.
      const message = cause instanceof Error ? cause.message : "";
      setFailed(/unauthori[sz]ed|jwt|session/i.test(message)
        ? "You are signed out. Sign in again with your staff or admin account, then scan the paper again."
        : message || "The paper could not be checked");
      setReading(null);
    } finally {
      setBusy("");
    }
  }, []);

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
    setReading(result.problem === "other_site"
      ? { kind: "problem", headline: "Not a Grain Bazar QR", lines: [`This QR leads to another website (${result.host}), not to Grain Bazar. A forged paper can lead to a page that fakes a green screen.`, "Do not hand over. Keep the paper and tell the office."] }
      : { kind: "problem", headline: "Not a delivery paper QR", lines: ["This is not the QR code of a Grain Bazar delivery note or slip.", "Do not hand over against it. Ask the office."] });
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
          <h1 className="text-lg font-extrabold text-navy">Sign in to check this paper</h1>
          <p className="text-sm text-charcoal">
            {me === "not_allowed" ? "This account can't check delivery papers. " : ""}
            Only godown staff and the office can check a delivery note or slip. Sign in with your staff or admin account, then scan the QR again.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild className="bg-navy text-white hover:bg-navy/90"><Link to="/staff/login"><LogIn className="mr-1.5 h-4 w-4" /> Godown staff sign in</Link></Button>
            <Button asChild variant="outline"><Link to="/admin/login">Admin sign in</Link></Button>
          </div>
        </section>
      </Shell>
    );
  }

  const scan = reading?.kind === "scan" ? reading.scan : null;
  const words = scan ? scanWords(scan) : reading?.kind === "problem" ? { tone: "red" as const, headline: reading.headline, lines: reading.lines } : null;
  // After a scan, the server's word for who scanned: the account the answer was given to.
  const shown: Me = scan ? { name: scan.by, place: scan.godown || "Office (admin)", role: scan.role } : me;

  return (
    <Shell me={shown}>
      {busy === "check" && !reading && <p className="flex items-center gap-2 text-sm text-slate"><RefreshCw className="h-4 w-4 animate-spin" /> Checking the paper…</p>}
      {failed && (
        <div role="alert" className="rounded-2xl border-4 border-amber-600 bg-amber-300 p-4 text-black">
          <p className="flex items-center gap-2 text-xl font-extrabold uppercase"><AlertTriangle className="h-7 w-7 shrink-0" /> Not checked</p>
          <p className="mt-1 text-sm font-semibold">{failed}</p>
          <p className="mt-1 text-sm">Nothing was recorded. Do not hand over until the screen turns green. Try again, or ask the office.</p>
          {code && <Button className="mt-2 bg-black text-white hover:bg-black/85" disabled={busy !== ""} onClick={() => void run(code, false)}>Try again</Button>}
        </div>
      )}

      {words && (
        <section aria-live="assertive" className={cn("rounded-2xl border-4 p-4 shadow-md", TONES[words.tone])}>
          <p className="flex items-center gap-2 text-2xl font-extrabold uppercase leading-tight sm:text-3xl">
            {words.tone === "green" ? <CheckCircle2 className="h-10 w-10 shrink-0" /> : words.tone === "ready" ? <ShieldCheck className="h-9 w-9 shrink-0" />
              : words.tone === "amber" ? <AlertTriangle className="h-10 w-10 shrink-0" /> : <XOctagon className="h-10 w-10 shrink-0" />}
            <span className="min-w-0 break-words">{words.headline}</span>
          </p>
          <div className="mt-2 space-y-1 text-sm font-medium sm:text-base">
            {words.lines.map((line) => <p key={line} className="break-words">{line}</p>)}
          </div>
          {scan && <PaperFacts scan={scan} tone={words.tone} />}
          {scan?.result === "ready" && (
            <Button className="mt-4 h-14 w-full bg-emerald-700 text-lg font-extrabold text-white hover:bg-emerald-800" disabled={busy !== ""} onClick={() => void run(code, true)}>
              {busy === "handover" ? <><RefreshCw className="mr-2 h-5 w-5 animate-spin" /> Recording…</> : "Hand over now: record it"}
            </Button>
          )}
        </section>
      )}

      <Scanner scanning={scanning} setScanning={setScanning} onText={readText} />

      {!scanning && (
        <div className="space-y-2">
          <Button className="h-12 w-full bg-navy text-base font-bold text-white hover:bg-navy/90" disabled={busy !== ""}
            onClick={() => { setReading(null); setFailed(""); setScanning(true); }}>
            <ScanLine className="mr-2 h-5 w-5" /> {reading ? "Scan the next paper" : "Scan a delivery note or slip"}
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

      <section className="rounded-2xl border border-border bg-card p-4 text-xs text-charcoal shadow-sm">
        <p className="font-bold text-navy">How it works</p>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          <li>Give the goods only when this screen turns <span className="font-bold text-emerald-800">green</span>. Green appears once, after you press the button, and records who handed over and when.</li>
          <li><span className="font-bold text-red-700">Red</span>: do not hand over. Already handed over, an old cancelled copy, a forged or unknown code, or the order is cancelled or stopped.</li>
          <li><span className="font-bold text-amber-700">Amber</span>: do not hand over here. Ask the office.</li>
          <li>Scan with the button on this page. Check that your own name is at the top: a forged QR can open a fake page that doesn't know who you are.</li>
        </ul>
      </section>
    </Shell>
  );
}

function Shell({ me, children }: { me: Me | null; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[oklch(0.972_0.004_258)] pb-10">
      <header className="sticky top-0 z-30 border-b border-border bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-md items-center justify-between gap-2 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <LogoMark className="h-10 w-10 shrink-0" />
            <div className="min-w-0">
              <p className="truncate text-sm font-extrabold text-navy">{me ? me.name : "Delivery paper check"}</p>
              <p className="truncate text-xs text-slate">{me ? `${me.place} · checking delivery papers` : "Grain Bazar"}</p>
            </div>
          </div>
          {me && (
            <Link to={me.role === "admin" ? "/admin/delivery-notes" : "/staff"} className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1.5 text-xs font-semibold text-navy hover:border-gold hover:text-gold">
              <ArrowLeft className="h-3.5 w-3.5" /> {me.role === "admin" ? "Admin" : "Staff app"}
            </Link>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-md space-y-4 px-4 py-4">{children}</main>
    </div>
  );
}

/** What the paper is and what it covers, under the answer. */
function PaperFacts({ scan, tone }: { scan: PaperScan; tone: ScanTone }) {
  if (!scan.paper || !scan.note) return null;
  const light = tone === "green" || tone === "red";
  return (
    <div className={cn("mt-3 rounded-xl p-3 text-sm", light ? "bg-white/15" : "bg-black/5")}>
      <p className="font-bold">{paperName(scan.paper)} · {scan.note.note_no} · copy {scan.paper.copy_no}</p>
      <p>Order {scan.note.order_no} · {scan.note.customer}</p>
      <p>Godown: {scan.note.godown || "—"}</p>
      <ul className="mt-2 space-y-1">
        {(scan.lines ?? []).map((line) => (
          <li key={line.line} className="flex items-start justify-between gap-3 border-t border-current/20 pt-1">
            <span className="min-w-0 break-words"><span className="font-semibold">{line.line}. {line.name}</span>{line.pack_size ? ` · ${line.pack_size}` : ""}{line.stock_no ? ` · stock ${line.stock_no}` : ""}</span>
            <span className="shrink-0 text-right font-extrabold">× {line.qty}{line.handover ? <span className="block text-[11px] font-semibold">handed over</span> : null}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] opacity-80">Checked {istDateTime(scan.scanned_at)} by {scan.by}{scan.godown ? `, ${scan.godown}` : ""}</p>
    </div>
  );
}

/**
 * The camera, reading QR codes with the browser's own barcode reader (Chrome on Android has one). Where the browser
 * has none, the phone's camera app opens the QR's link here instead.
 */
function Scanner({ scanning, setScanning, onText }: { scanning: boolean; setScanning: (on: boolean) => void; onText: (text: string) => void }) {
  const video = useRef<HTMLVideoElement | null>(null);
  const [problem, setProblem] = useState("");

  useEffect(() => {
    if (!scanning) return undefined;
    const Reader = detectorClass();
    if (!Reader || !navigator.mediaDevices?.getUserMedia) {
      setProblem("This browser can't read QR codes inside the page. Open your phone's camera app and point it at the QR: it opens this page with the answer. Or paste the link below.");
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
        const reader = new Reader({ formats: ["qr_code"] });
        const look = async () => {
          if (stopped) return;
          try {
            const found = await reader.detect(element);
            const text = found.find((item) => item.rawValue)?.rawValue;
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
            <p className="flex items-center gap-1.5 text-xs text-white"><Camera className="h-4 w-4" /> Point the camera at the QR code</p>
            <Button size="sm" variant="outline" onClick={() => setScanning(false)}>Stop</Button>
          </div>
        </section>
      )}
    </>
  );
}
