import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowLeft, Camera, CheckCircle2, Download, FileText, Keyboard, LogIn, Printer, RefreshCw, ScanLine, ShieldCheck, XOctagon } from "lucide-react";
import { LogoMark } from "@/components/brand/Logo";
import { readGodownDevice } from "@/components/attendance/godownDevice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { istDateTime } from "@/lib/delivery-notes";
import { buildDeliveryNotePdf, canvasTextImage, loadLogoPng, releasedPdfInput } from "@/lib/delivery-note-pdf";
import { scanDeliveryPaper } from "@/lib/delivery-notes.functions";
import {
  CUSTOMER_SCAN_WORDS, codeFromHash, handoverWho, invoiceScanWords, isInvoiceScan, paperKindWords, paperName, phoneWords, readScannedText, releasedWords, roleTitle,
  roleWords, scannedTextWords, scanWords,
  type Bi, type InvoiceScan, type InvoiceScanAction, type PaperScan, type PaperScanLine, type ScannerRole, type ScanTone, type ScanWords,
} from "@/lib/delivery-papers";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { godownDetails, godownLine } from "@/lib/invoice-lines";
import { cn } from "@/lib/utils";

/*
 * The godown's scan of a delivery QR: the one on the customer's invoice (12 Nov 2026), or a delivery note's or slip's
 * printed before then. Open it by scanning with this page's scanner, or with the phone's camera app (the QR is a link
 * here with the code after "#"). Only the godown in-charge, godown staff, channel partners and administrators get an
 * answer, and the database decides it (public.delivery_invoice_scan, public.delivery_paper_scan). Green comes only
 * after the handover is recorded, so "no green, no goods" is a rule the godown can follow. Everything the answer says
 * is in English and Kannada together.
 *
 * On an invoice QR the screen shows the released delivery note, the customer (with the phone's last 4 digits) and the
 * items, and offers what this person may do (the admin's Delivery QR rules): print the note, print the slips, hand
 * over the ticked items. A print is recorded first; the PDF is then made on this phone, with no QR on it.
 */
export const Route = createFileRoute("/slip")({
  head: () => ({ meta: [{ title: "Scan an invoice QR | Grain Bazar" }, { name: "robots", content: "noindex" }] }),
  component: SlipCheckPage,
});

type Me = { name: string; place: string; role: ScannerRole };
type Reading = { kind: "scan"; scan: PaperScan } | { kind: "invoice"; scan: InvoiceScan } | { kind: "problem"; words: ScanWords };
/** The PDF of the last print, kept so it can be opened to print or saved again without recording another copy. */
type PaperFile = { url: string; fileName: string; what: Bi };

const TONES: Record<ScanTone, string> = {
  green: "border-emerald-700 bg-emerald-600 text-white",
  ready: "border-navy bg-white text-navy",
  amber: "border-amber-600 bg-amber-300 text-black",
  red: "border-red-800 bg-red-600 text-white",
};

/** Answers on which nothing about the order may be printed: the database refuses those prints anyway. */
const NO_PRINT = ["order_problem", "replaced", "other_godown", "not_released"];
/** Answers on which items still to go can be ticked and handed over. */
const TICKABLE = ["released", "partly_handed_over", "printed"];

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

/** Who is signed in, before the 12 Nov 2026 database update (no my_delivery_role yet): from their own records. */
async function meFromRecords(userId: string): Promise<Me | "not_allowed"> {
  const [{ data: isAdmin }, { data: employee }, { data: partner }] = await Promise.all([
    supabase.rpc("has_role", { _user_id: userId, _role: "admin" }),
    supabase.from("staff_employees").select("name,branch_id,status").eq("user_id", userId).maybeSingle(),
    supabase.from("channel_partners").select("name,branch_id,status").eq("user_id", userId).maybeSingle(),
  ]);
  const godownName = async (id: string) => (await supabase.from("branches").select("name").eq("id", id).maybeSingle()).data?.name ?? id;
  if (isAdmin) {
    const { data: profile } = await supabase.from("profiles").select("full_name,email").eq("id", userId).maybeSingle();
    return { name: profile?.full_name?.trim() || profile?.email?.trim() || "Admin", place: "Office", role: "admin" };
  }
  if (employee?.status === "active") return { name: employee.name, place: await godownName(employee.branch_id), role: "staff" };
  if (partner?.status === "active") return { name: partner.name, place: await godownName(partner.branch_id), role: "partner" };
  return "not_allowed";
}

function SlipCheckPage() {
  const [me, setMe] = useState<Me | null | "signed_out" | "not_allowed" | "customer">(null);
  const [reading, setReading] = useState<Reading | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"" | InvoiceScanAction>("");
  const [failed, setFailed] = useState("");
  const [scanning, setScanning] = useState(false);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState("");
  const [ticked, setTicked] = useState<number[]>([]);
  const [paperFile, setPaperFile] = useState<PaperFile | null>(null);
  const checked = useRef("");
  // The godown's registered phone keeps its token from the attendance registration; any other phone has none.
  const [device] = useState(() => (typeof window === "undefined" ? null : readGodownDevice()));

  // A new answer is read from its headline (first on the page), even if the page was scrolled down to the button.
  useEffect(() => {
    if (reading || failed) window.scrollTo({ top: 0 });
  }, [reading, failed]);

  // The last PDF's address is let go when a new one replaces it, or the page closes.
  useEffect(() => () => { if (paperFile) URL.revokeObjectURL(paperFile.url); }, [paperFile]);

  // Who is signed in, shown at the top of every answer: a fake page reached from a forged QR can't know it.
  useEffect(() => {
    if (STATIC_DATA_MODE) return;
    void (async () => {
      const { data: session } = await supabase.auth.getSession();
      const userId = session.session?.user.id;
      if (!userId) { setMe("signed_out"); return; }
      const { data: role, error } = await supabase.rpc("my_delivery_role");
      if (error) { setMe(await meFromRecords(userId)); return; }
      const who = role as { role: ScannerRole; name: string; branch_name: string | null } | null;
      // Signed in, but not at a godown or the office: a customer who opened their own invoice's QR.
      if (!who) { setMe("customer"); return; }
      setMe({ name: who.name, place: who.role === "admin" ? "Office" : who.branch_name || "—", role: who.role });
    })();
  }, []);

  /** The PDF of a print the database just recorded, made on this phone: no QR on it. Returns its file, or the reason. */
  const makePdf = useCallback((answer: InvoiceScan, kit: [typeof import("jspdf"), string | null]): PaperFile => {
    const print = answer.print!;
    const selection = answer.action === "print_note"
      ? { note: true, slips: [] }
      : { note: false, slips: Object.keys(print.slip_copies ?? {}).map(Number).sort((a, b) => a - b) };
    const handovers = Object.fromEntries((answer.lines ?? []).map((line) => [String(line.line), line.handover]));
    const input = releasedPdfInput(print, { gate: answer.gate ?? { code: "not_found" }, selection, handovers, origin: window.location.origin, customerNumber: answer.customer_number ?? null });
    const { pdf, fileName } = buildDeliveryNotePdf(input, { jspdf: kit[0], logo: kit[1], textImage: canvasTextImage });
    pdf.save(fileName);
    const what = answer.action === "print_note"
      ? { en: `Delivery note ${print.note.note_no}, copy ${print.note_copy ?? ""}`, kn: `ಡೆಲಿವರಿ ನೋಟ್ ${print.note.note_no}, ಪ್ರತಿ ${print.note_copy ?? ""}` }
      : { en: `Delivery slip${selection.slips.length === 1 ? "" : "s"} ${selection.slips.join(", ")}`, kn: `ಡೆಲಿವರಿ ಸ್ಲಿಪ್ ${selection.slips.join(", ")}` };
    return { url: URL.createObjectURL(pdf.output("blob")), fileName, what };
  }, []);

  const run = useCallback(async (target: string, action: InvoiceScanAction, lines?: number[]) => {
    const printing = action === "print_note" || action === "print_slips";
    setBusy(action);
    setFailed("");
    // A new QR's answer never sits under the last one's. A handover or a print keeps its own card while it records.
    if (action === "check") { setReading(null); setTicked([]); setPaperFile(null); }
    let recorded = false;
    try {
      // Everything the PDF needs is loaded before the print is recorded, so a recorded copy always gets its file.
      const kit = printing ? await Promise.all([import("jspdf"), loadLogoPng()]) : null;
      const answer = await scanDeliveryPaper({ data: { code: target, action, lines, device: device?.token } });
      setReading(isInvoiceScan(answer) ? { kind: "invoice", scan: answer } : { kind: "scan", scan: answer });
      // The items still to go stay ticked only if they still are.
      const after = answer.lines ?? [];
      if (answer.result !== "handed_over") setTicked((current) => current.filter((line) => after.some((item) => item.line === line && !item.handover)));
      else setTicked([]);
      if (isInvoiceScan(answer) && answer.result === "printed" && answer.print && kit) {
        recorded = true;
        setPaperFile(makePdf(answer, kit));
      }
    } catch (cause) {
      // No answer is never green: say it plainly and let them try again.
      const message = cause instanceof Error ? cause.message : "";
      setFailed(recorded
        ? `The copy was recorded but the PDF could not be made on this phone (${message || "unknown reason"}). Ask the office to print it.`
        : /unauthori[sz]ed|jwt|session/i.test(message)
          ? "You are signed out. Sign in again with your staff, partner or admin account, then scan the QR again."
          : message || "The QR could not be checked");
      // The answer of a recorded print stays on screen; anything else that failed leaves no answer behind.
      if (!recorded) setReading(null);
    } finally {
      setBusy("");
    }
  }, [device, makePdf]);

  const open = useCallback((next: string) => {
    setCode(next);
    if (typeof window !== "undefined" && window.location.hash !== `#${next}`) window.history.replaceState(null, "", `#${next}`);
    void run(next, "check");
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
    setPaperFile(null);
    setReading({ kind: "problem", words: scannedTextWords(result) });
  }, [open]);

  if (STATIC_DATA_MODE) {
    return <Shell me={null}><p className="text-sm text-slate">Checking delivery papers needs the live database, so it is not available in this demo.</p></Shell>;
  }
  if (me === null) {
    return <Shell me={null}><p className="flex items-center gap-2 text-sm text-slate"><RefreshCw className="h-4 w-4 animate-spin" /> Opening…</p></Shell>;
  }
  if (me === "customer") {
    return (
      <Shell me={null}>
        <section className="space-y-3 rounded-2xl border border-border bg-card p-4 shadow-sm">
          <h1 className="text-lg font-extrabold text-navy"><Both text={{ en: "Your delivery QR", kn: "ನಿಮ್ಮ ಡೆಲಿವರಿ QR" }} /></h1>
          <Both className="text-base font-semibold text-charcoal" text={CUSTOMER_SCAN_WORDS} />
          <Both className="text-sm text-slate" text={{
            en: "It works once your payment is confirmed. Keep it to yourself: whoever shows it at the godown can collect the goods.",
            kn: "ನಿಮ್ಮ ಪಾವತಿ ದೃಢಪಟ್ಟ ನಂತರ ಇದು ಕೆಲಸ ಮಾಡುತ್ತದೆ. ಇದನ್ನು ಬೇರೆಯವರಿಗೆ ಕೊಡಬೇಡಿ: ಗೋದಾಮಿನಲ್ಲಿ ತೋರಿಸಿದವರು ಸರಕು ಪಡೆಯಬಹುದು.",
          }} />
          <Button asChild variant="outline"><Link to="/account/orders">My orders</Link></Button>
          <p className="border-t border-border pt-3 text-xs text-slate">Godown staff: you are signed in with a customer account. Sign out, then sign in with your staff, partner or admin account.</p>
        </section>
      </Shell>
    );
  }
  if (me === "signed_out" || me === "not_allowed") {
    return (
      <Shell me={null}>
        <section className="space-y-3 rounded-2xl border border-border bg-card p-4 shadow-sm">
          <h1 className="text-lg font-extrabold text-navy"><Both text={{ en: "Sign in to check this QR", kn: "ಈ QR ಪರಿಶೀಲಿಸಲು ಸೈನ್ ಇನ್ ಮಾಡಿ" }} /></h1>
          <p className="text-sm text-charcoal">
            {me === "not_allowed" ? "This account can't check delivery QR codes. " : ""}
            Only the godown in-charge, godown staff, channel partners and the office can check the QR on an invoice or a delivery paper. Sign in with your account, then scan the QR again.
          </p>
          <Both className="text-sm font-semibold text-charcoal" text={CUSTOMER_SCAN_WORDS} />
          <div className="flex flex-wrap gap-2">
            <Button asChild className="bg-navy text-white hover:bg-navy/90"><Link to="/staff/login"><LogIn className="mr-1.5 h-4 w-4" /> Godown staff sign in</Link></Button>
            <Button asChild variant="outline"><Link to="/partner/login">Channel partner sign in</Link></Button>
            <Button asChild variant="outline"><Link to="/admin/login">Admin sign in</Link></Button>
          </div>
        </section>
      </Shell>
    );
  }

  const paper = reading?.kind === "scan" ? reading.scan : null;
  const invoice = reading?.kind === "invoice" ? reading.scan : null;
  const words = paper ? scanWords(paper) : invoice ? invoiceScanWords(invoice) : reading?.kind === "problem" ? reading.words : null;
  const answered = paper ?? invoice;
  // After a scan, the server's word for who scanned: the account the answer was given to.
  const shown: Me = answered ? { name: answered.by, place: answered.godown || (answered.role === "admin" ? "Office" : "—"), role: answered.role } : me;
  const phone = answered?.device?.registered ?? Boolean(device);
  const openLines = (answered?.lines ?? []).filter((line) => !line.handover).map((line) => line.line);
  const ticking = Boolean(
    (paper && paper.paper?.doc === "note" && (paper.result === "ready" || paper.result === "partly_handed_over"))
    || (invoice && invoice.note && invoice.can?.handover && TICKABLE.includes(invoice.result) && openLines.length > 0),
  );
  const canPrint = Boolean(invoice?.note && invoice.can && !NO_PRINT.includes(invoice.result));
  const onTick = (line: number, on: boolean) => setTicked((current) => (on ? [...new Set([...current, line])] : current.filter((item) => item !== line)));
  const sortedTicks = [...ticked].sort((a, b) => a - b);

  return (
    <Shell me={shown} phone={phone}>
      {busy === "check" && !reading && <p className="flex items-center gap-2 text-sm text-slate"><RefreshCw className="h-4 w-4 animate-spin" /> Checking the QR…</p>}
      {failed && (
        <div role="alert" className="rounded-2xl border-4 border-amber-600 bg-amber-300 p-4 text-black">
          <p className="flex items-center gap-2 text-xl font-extrabold uppercase"><AlertTriangle className="h-7 w-7 shrink-0" /> <Both text={{ en: "Not checked", kn: "ಪರಿಶೀಲನೆ ಆಗಿಲ್ಲ" }} /></p>
          <p className="mt-1 text-sm font-semibold">{failed}</p>
          <Both className="mt-1 text-sm" text={{ en: "Nothing was handed over. Do not hand over until the screen turns green. Try again, or ask the office.", kn: "ಏನೂ ಹಸ್ತಾಂತರವಾಗಿಲ್ಲ. ಪರದೆ ಹಸಿರಾಗುವವರೆಗೆ ಸರಕು ಕೊಡಬೇಡಿ. ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ ಅಥವಾ ಕಚೇರಿಯನ್ನು ಕೇಳಿ." }} />
          {code && <Button className="mt-2 bg-black text-white hover:bg-black/85" disabled={busy !== ""} onClick={() => void run(code, "check")}>Try again · ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ</Button>}
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
          {paper && <PaperFacts scan={paper} tone={words.tone} ticking={ticking} ticked={ticked} onTick={onTick} />}
          {invoice && <InvoiceFacts scan={invoice} tone={words.tone} ticking={ticking} ticked={ticked} onTick={onTick} />}
          {paper?.result === "ready" && !ticking && (
            <Button className="mt-4 h-auto min-h-14 w-full flex-col bg-emerald-700 py-2 text-lg font-extrabold text-white hover:bg-emerald-800" disabled={busy !== ""} onClick={() => void run(code, "handover")}>
              {busy === "handover" ? <><RefreshCw className="mr-2 h-5 w-5 animate-spin" /> Recording… · ದಾಖಲಿಸಲಾಗುತ್ತಿದೆ…</> : <><span>Hand over now: record it</span><span className="text-base">ಈಗ ಹಸ್ತಾಂತರಿಸಿ: ದಾಖಲಿಸಿ</span></>}
            </Button>
          )}
          {ticking && (
            <div className="mt-3 space-y-2">
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="outline" className="border-navy text-navy" disabled={busy !== "" || openLines.length === 0} onClick={() => setTicked(openLines)}>Tick all still to go · ಎಲ್ಲವನ್ನೂ ಗುರುತಿಸಿ</Button>
                {ticked.length > 0 && <Button type="button" size="sm" variant="outline" disabled={busy !== ""} onClick={() => setTicked([])}>Clear · ತೆರವುಗೊಳಿಸಿ</Button>}
              </div>
              <Button className="h-auto min-h-14 w-full flex-col bg-emerald-700 py-2 text-lg font-extrabold text-white hover:bg-emerald-800" disabled={busy !== "" || ticked.length === 0} onClick={() => void run(code, "handover", sortedTicks)}>
                {busy === "handover" ? <><RefreshCw className="mr-2 h-5 w-5 animate-spin" /> Recording… · ದಾಖಲಿಸಲಾಗುತ್ತಿದೆ…</>
                  : ticked.length === 0 ? <><span>Tick the items being handed over</span><span className="text-base">ಹಸ್ತಾಂತರಿಸುವ ಸರಕುಗಳನ್ನು ಗುರುತಿಸಿ</span></>
                    : <><span>Hand over item{ticked.length === 1 ? "" : "s"} {sortedTicks.join(", ")}: record it</span><span className="text-base">ಸರಕು {sortedTicks.join(", ")} ಹಸ್ತಾಂತರಿಸಿ: ದಾಖಲಿಸಿ</span></>}
              </Button>
            </div>
          )}
          {invoice && canPrint && (invoice.can?.print_note || invoice.can?.print_slips) && (
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {invoice.can?.print_note && (
                <Button type="button" variant="outline" className="h-auto min-h-12 flex-col border-2 border-navy bg-white py-1.5 font-bold text-navy hover:bg-navy/5" disabled={busy !== ""} onClick={() => void run(code, "print_note")}>
                  {busy === "print_note" ? <span className="flex items-center"><RefreshCw className="mr-2 h-4 w-4 animate-spin" /> Making the PDF… · PDF ತಯಾರಾಗುತ್ತಿದೆ…</span>
                    : <><span className="flex items-center"><FileText className="mr-1.5 h-4 w-4" /> Print delivery note</span><span className="text-sm">ಡೆಲಿವರಿ ನೋಟ್ ಮುದ್ರಿಸಿ</span></>}
                </Button>
              )}
              {invoice.can?.print_slips && (
                <Button type="button" variant="outline" className="h-auto min-h-12 flex-col border-2 border-navy bg-white py-1.5 font-bold text-navy hover:bg-navy/5" disabled={busy !== ""} onClick={() => void run(code, "print_slips")}>
                  {busy === "print_slips" ? <span className="flex items-center"><RefreshCw className="mr-2 h-4 w-4 animate-spin" /> Making the PDF… · PDF ತಯಾರಾಗುತ್ತಿದೆ…</span>
                    : <><span className="flex items-center"><Printer className="mr-1.5 h-4 w-4" /> Print slips</span><span className="text-sm">ಸ್ಲಿಪ್‌ಗಳನ್ನು ಮುದ್ರಿಸಿ</span></>}
                </Button>
              )}
              <Both className="text-[11px] opacity-80 sm:col-span-2" text={{
                en: "Each print is recorded as a copy, with your name. The papers have no QR: only the invoice's QR hands goods over.",
                kn: "ಪ್ರತಿ ಮುದ್ರಣವು ನಿಮ್ಮ ಹೆಸರಿನೊಂದಿಗೆ ಪ್ರತಿಯಾಗಿ ದಾಖಲಾಗುತ್ತದೆ. ಪತ್ರಗಳಲ್ಲಿ QR ಇಲ್ಲ: ಇನ್‌ವಾಯ್ಸ್‌ನ QR ಮಾತ್ರ ಸರಕು ಹಸ್ತಾಂತರಿಸುತ್ತದೆ.",
              }} />
            </div>
          )}
          {invoice && paperFile && (
            <div className="mt-3 rounded-xl border border-current/30 bg-black/5 p-3 text-sm">
              <Both className="font-bold" text={{ en: `Downloaded: ${paperFile.what.en}`, kn: `ಡೌನ್‌ಲೋಡ್ ಆಗಿದೆ: ${paperFile.what.kn}` }} />
              <p className="break-all text-[11px] opacity-80">{paperFile.fileName}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <a href={paperFile.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-md bg-navy px-3 py-2 text-xs font-bold text-white hover:bg-navy/90">
                  <Printer className="h-4 w-4" /> Open to print · ಮುದ್ರಿಸಲು ತೆರೆಯಿರಿ
                </a>
                <a href={paperFile.url} download={paperFile.fileName} className="inline-flex items-center gap-1.5 rounded-md border border-navy bg-white px-3 py-2 text-xs font-bold text-navy hover:bg-navy/5">
                  <Download className="h-4 w-4" /> Save again · ಮತ್ತೆ ಉಳಿಸಿ
                </a>
              </div>
              <Both className="mt-1 text-[11px] opacity-80" text={{
                en: "Opening or saving it again is the same copy: nothing new is recorded.",
                kn: "ಮತ್ತೆ ತೆರೆದರೂ ಉಳಿಸಿದರೂ ಅದೇ ಪ್ರತಿ: ಹೊಸದಾಗಿ ಏನೂ ದಾಖಲಾಗುವುದಿಲ್ಲ.",
              }} />
            </div>
          )}
        </section>
      )}

      <Scanner scanning={scanning} setScanning={setScanning} onText={readText} />

      {!scanning && (
        <div className="space-y-2">
          <Button className="h-auto min-h-12 w-full flex-col bg-navy py-2 text-base font-bold text-white hover:bg-navy/90" disabled={busy !== ""}
            onClick={() => { setReading(null); setFailed(""); setTicked([]); setPaperFile(null); setScanning(true); }}>
            <span className="flex items-center"><ScanLine className="mr-2 h-5 w-5" /> {reading ? "Scan the next invoice" : "Scan the QR on the customer's invoice"}</span>
            <span className="text-sm font-semibold">{reading ? "ಮುಂದಿನ ಇನ್‌ವಾಯ್ಸ್ ಸ್ಕ್ಯಾನ್ ಮಾಡಿ" : "ಗ್ರಾಹಕರ ಇನ್‌ವಾಯ್ಸ್‌ನ QR ಸ್ಕ್ಯಾನ್ ಮಾಡಿ"}</span>
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
          <li><Both text={{ en: "Scan the QR on the customer's invoice. The screen shows whether the delivery note is released, the customer's name, the last 4 digits of their phone and the items.", kn: "ಗ್ರಾಹಕರ ಇನ್‌ವಾಯ್ಸ್‌ನ QR ಸ್ಕ್ಯಾನ್ ಮಾಡಿ. ಡೆಲಿವರಿ ನೋಟ್ ಬಿಡುಗಡೆಯಾಗಿದೆಯೇ, ಗ್ರಾಹಕರ ಹೆಸರು, ಅವರ ಫೋನ್‌ನ ಕೊನೆಯ 4 ಅಂಕಿಗಳು ಮತ್ತು ಸರಕುಗಳನ್ನು ಪರದೆ ತೋರಿಸುತ್ತದೆ." }} /></li>
          <li><Both text={{ en: "Give the goods only when this screen turns green. Green appears once, after you press the button, and records who handed over, when and on which phone.", kn: "ಈ ಪರದೆ ಹಸಿರಾದಾಗ ಮಾತ್ರ ಸರಕು ಕೊಡಿ. ಬಟನ್ ಒತ್ತಿದ ನಂತರ ಒಮ್ಮೆ ಮಾತ್ರ ಹಸಿರು ಬರುತ್ತದೆ; ಯಾರು, ಯಾವಾಗ, ಯಾವ ಫೋನ್‌ನಲ್ಲಿ ಹಸ್ತಾಂತರಿಸಿದರು ಎಂದು ದಾಖಲಾಗುತ್ತದೆ." }} /></li>
          <li><Both text={{ en: "White: released, nothing handed over yet. Printing the delivery note or slips hands nothing over.", kn: "ಬಿಳಿ: ಬಿಡುಗಡೆಯಾಗಿದೆ, ಇನ್ನೂ ಏನೂ ಹಸ್ತಾಂತರವಾಗಿಲ್ಲ. ಡೆಲಿವರಿ ನೋಟ್ ಅಥವಾ ಸ್ಲಿಪ್ ಮುದ್ರಿಸಿದರೆ ಹಸ್ತಾಂತರ ಆಗುವುದಿಲ್ಲ." }} /></li>
          <li><Both text={{ en: "Red: do not hand over. Already handed over, an old invoice QR the office replaced, a forged or unknown code, or the order is cancelled or stopped.", kn: "ಕೆಂಪು: ಹಸ್ತಾಂತರಿಸಬೇಡಿ. ಈಗಾಗಲೇ ಹಸ್ತಾಂತರವಾಗಿದೆ, ಕಚೇರಿ ಬದಲಿಸಿದ ಹಳೆಯ ಇನ್‌ವಾಯ್ಸ್ QR, ನಕಲಿ ಅಥವಾ ಗೊತ್ತಿಲ್ಲದ ಕೋಡ್, ಅಥವಾ ಆರ್ಡರ್ ರದ್ದು/ನಿಲ್ಲಿಸಲಾಗಿದೆ." }} /></li>
          <li><Both text={{ en: "Amber: do not hand over here. Ask the office.", kn: "ಹಳದಿ: ಇಲ್ಲಿ ಹಸ್ತಾಂತರಿಸಬೇಡಿ. ಕಚೇರಿಯನ್ನು ಕೇಳಿ." }} /></li>
          <li><Both text={{ en: "Delivery papers printed with their own QR before 12 Nov 2026 still work: only the ORIGINAL. Papers stamped DUPLICATE COPY are for records.", kn: "12 ನವೆಂಬರ್ 2026 ರ ಮೊದಲು ತಮ್ಮದೇ QR ನೊಂದಿಗೆ ಮುದ್ರಿಸಿದ ಡೆಲಿವರಿ ಪತ್ರಗಳು ಈಗಲೂ ಕೆಲಸ ಮಾಡುತ್ತವೆ: ಮೂಲ ಪ್ರತಿ ಮಾತ್ರ. 'ನಕಲು ಪ್ರತಿ' ಮುದ್ರೆಯ ಪತ್ರಗಳು ದಾಖಲೆಗೆ ಮಾತ್ರ." }} /></li>
          <li><Both text={{ en: "Scan with the button on this page. Check that your own name is at the top: a forged QR can open a fake page that doesn't know who you are.", kn: "ಈ ಪುಟದ ಬಟನ್‌ನಿಂದ ಸ್ಕ್ಯಾನ್ ಮಾಡಿ. ಮೇಲೆ ನಿಮ್ಮ ಹೆಸರು ಇದೆಯೇ ನೋಡಿ: ನಕಲಿ QR ನಿಮ್ಮನ್ನು ತಿಳಿಯದ ನಕಲಿ ಪುಟ ತೆರೆಯಬಹುದು." }} /></li>
        </ul>
      </section>
    </Shell>
  );
}

function Shell({ me, phone, children }: { me: Me | null; phone?: boolean; children: ReactNode }) {
  const title = me ? roleTitle(me.role) : null;
  const handset = phoneWords(Boolean(phone));
  return (
    <div className="min-h-screen bg-[oklch(0.972_0.004_258)] pb-10">
      <header className="sticky top-0 z-30 border-b border-border bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-md items-center justify-between gap-2 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <LogoMark className="h-10 w-10 shrink-0" />
            <div className="min-w-0">
              <p className="truncate text-sm font-extrabold text-navy">{me ? me.name : "Delivery QR check"}</p>
              <p className="truncate text-xs text-slate" data-no-translate>
                {me && title ? `${title.en} · ${me.place} · ${handset.en}` : "Grain Bazar"}
              </p>
              {me && title && <p lang="kn" className="truncate text-[11px] text-slate" data-no-translate>{`${title.kn} · ${handset.kn}`}</p>}
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

/** The items under an answer: on a note or invoice being handed over, the items still to go can be ticked. */
function LineList({ lines, handedNow, ticking, ticked, onTick }: { lines: PaperScanLine[]; handedNow: number[]; ticking: boolean; ticked: number[]; onTick: (line: number, on: boolean) => void }) {
  return (
    <ul className="mt-2 space-y-1">
      {lines.map((line) => {
        const open = !line.handover;
        const label = (
          <>
            <span className="min-w-0 break-words"><span className="font-semibold">{line.line}. {line.name}</span>{line.pack_size ? ` · ${line.pack_size}` : ""}{line.stock_no ? ` · stock ${line.stock_no}` : ""}</span>
            <span className="shrink-0 text-right font-extrabold">× {line.qty}
              {line.handover && <span className="block text-[11px] font-semibold">{handedNow.includes(line.line) ? "give now · ಈಗ ಕೊಡಿ" : "handed over · ಹಸ್ತಾಂತರವಾಗಿದೆ"}</span>}
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
            {/* Who handed it over, when, with their mobile (owner, 11 Nov 2026). */}
            {line.handover && (
              <p className="break-words text-[11px] font-semibold opacity-90">
                Handed over {istDateTime(line.handover.at)} by {handoverWho(line.handover).en}
                <span className="block font-normal" lang="kn">{istDateTime(line.handover.at)} ರಂದು {handoverWho(line.handover).kn} ಅವರಿಂದ ಹಸ್ತಾಂತರ</span>
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** "Checked 12 Nov 2026, … by Ravi (godown in-charge, Challakere Godown, own phone)". */
function CheckedBy({ scan }: { scan: PaperScan | InvoiceScan }) {
  return (
    <p className="mt-2 text-[11px] opacity-80">Checked {istDateTime(scan.scanned_at)} by {scan.by} ({roleWords(scan.role).en}{"by_phone" in scan && scan.by_phone ? `, mobile ${scan.by_phone}` : ""}{scan.godown ? `, ${scan.godown}` : ""}, {phoneWords(Boolean(scan.device?.registered)).en}{scan.device?.registered && scan.device.label ? `: ${scan.device.label}` : ""})</p>
  );
}

/** What the paper is and what it covers, under the answer; on a note being handed over, the items to tick. */
function PaperFacts({ scan, tone, ticking, ticked, onTick }: { scan: PaperScan; tone: ScanTone; ticking: boolean; ticked: number[]; onTick: (line: number, on: boolean) => void }) {
  if (!scan.paper || !scan.note) return null;
  const light = tone === "green" || tone === "red";
  const name = paperName(scan.paper);
  const kind = paperKindWords(scan.paper.kind, scan.paper.duplicate_no);
  return (
    <div className={cn("mt-3 rounded-xl p-3 text-sm", light ? "bg-white/15" : "bg-black/5")}>
      <p className="font-bold">{name.en} · {scan.note.note_no} · {kind.en}</p>
      <p className="text-xs font-semibold opacity-90" lang="kn">{name.kn} · {kind.kn}</p>
      <p>Order {scan.note.order_no} · {scan.note.customer}</p>
      <p>Godown · ಗೋದಾಮು: {scan.note.godown || "—"}</p>
      <LineList lines={scan.lines ?? []} handedNow={scan.handed_now ?? []} ticking={ticking} ticked={ticked} onTick={onTick} />
      <CheckedBy scan={scan} />
    </div>
  );
}

/**
 * The order behind an invoice's QR: the customer and the last 4 digits of their phone (to check who collects), the
 * released note and how it was released, and the items. Nothing about the order shows for another godown's order or
 * a replaced QR: the database gives none.
 */
function InvoiceFacts({ scan, tone, ticking, ticked, onTick }: { scan: InvoiceScan; tone: ScanTone; ticking: boolean; ticked: number[]; onTick: (line: number, on: boolean) => void }) {
  const light = tone === "green" || tone === "red";
  const note = scan.note;
  if (!note) {
    return (
      <div className={cn("mt-3 rounded-xl p-3 text-sm", light ? "bg-white/15" : "bg-black/5")}>
        <p className="font-bold">Order · ಆರ್ಡರ್ {scan.invoice.order_no}</p>
        <CheckedBy scan={scan} />
      </div>
    );
  }
  const released = releasedWords(note);
  return (
    <div className={cn("mt-3 rounded-xl p-3 text-sm", light ? "bg-white/15" : "bg-black/5")}>
      <p className="text-base font-extrabold">Order · ಆರ್ಡರ್ {note.order_no}</p>
      <p className="font-semibold">{note.customer || "—"}</p>
      {note.phone_end && <p>Phone ending · ಫೋನ್ ಕೊನೆಯ ಅಂಕಿಗಳು: <span className="font-mono text-base font-extrabold tracking-widest">{note.phone_end}</span></p>}
      <p className="mt-2 font-bold">Delivery note {note.note_no} released · ಡೆಲಿವರಿ ನೋಟ್ {note.note_no} ಬಿಡುಗಡೆಯಾಗಿದೆ</p>
      <Both className="text-xs" knClassName="opacity-90" text={released} />
      <p className="mt-1 text-xs">Invoice · ಇನ್‌ವಾಯ್ಸ್ {note.invoice_number || "—"} · Godown · ಗೋದಾಮು: {note.godown || scan.order_godown || "—"}</p>
      {/* The godown's address, phone and channel partner, as the invoice prints them under the QR. */}
      {godownLine(godownDetails(scan.godown_details)) && <p className="break-words text-[11px] opacity-90">{godownLine(godownDetails(scan.godown_details))}</p>}
      <LineList lines={scan.lines ?? []} handedNow={scan.handed_now ?? []} ticking={ticking} ticked={ticked} onTick={onTick} />
      <CheckedBy scan={scan} />
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
