import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Volume2, VolumeX } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { useBranches } from "@/lib/branches";
import {
  DEFAULT_ALERT_SETTINGS, SAMPLE_ORDER, SUGGESTED_WORDING, branchAnnounced, branchWords, cleanAlertSettings, itemDailyAverages, orderAlertText,
  orderSpeech, shouldAnnounce, unusualLines, unusualSpeeches, cleanVoiceSettings, type AlertSettings, type SoldLine, type VoiceSettings,
} from "@/lib/order-alerts";
import { readOfficeVoice, useOfficeVoice } from "@/hooks/use-office-voice";
import { speak } from "@/lib/voice-speak";
import { cn } from "@/lib/utils";

/*
 * Order alerts in the admin panel (client's note, 17 Nov 2026): every new order is announced like Zoho Commerce does,
 * "Order received from Challakere branch, order amount …" (a message here, a desktop notification while the panel is in
 * the background, and said aloud), and an order far above an item's usual sales per day is said aloud as unusual.
 * Works while an admin panel is open in a browser. What is said, the language, speed, chime, godowns and the unusual rule are
 * the office's (Admin › Settings › Order alerts, 19 Nov 2026); voice and desktop on/off are per computer. One tab speaks
 * per order.
 */
const SETTINGS_KEY = "gb-order-alert-settings";
const SAID_KEY = "gb-order-alerts-said";
const AVERAGE_DAYS = 30;
/** Every admin page mounts the panel again: the averages are read at most once an hour per tab. */
let averagesCache: { at: number; map: Map<string, { name: string; perDay: number; units: number }> } | null = null;

type OrderRow = { id: string; order_no: string; order_status: string; total: number | string | null; branch_id: string | null; created_at: string; customer_name?: string | null };

function readSettings(): AlertSettings {
  try { return cleanAlertSettings(JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? "null")); } catch { return DEFAULT_ALERT_SETTINGS; }
}

/** Claims an order for this tab (the first tab to see it speaks); remembers for three days. */
function claim(orderId: string) {
  try {
    const now = Date.now();
    const said = JSON.parse(window.localStorage.getItem(SAID_KEY) ?? "{}") as Record<string, number>;
    for (const [id, at] of Object.entries(said)) if (now - at > 3 * 86_400_000) delete said[id];
    if (said[orderId]) return false;
    said[orderId] = now;
    window.localStorage.setItem(SAID_KEY, JSON.stringify(said));
    return true;
  } catch {
    return true;
  }
}

/** English with the suggested wording: what a computer without a Kannada voice says instead. */
const inEnglish = (v: VoiceSettings): VoiceSettings => ({ ...v, language: "en", ...SUGGESTED_WORDING.en });

function desktop(title: string, body: string, onClick: () => void) {
  if (typeof window === "undefined" || !("Notification" in window) || Notification.permission !== "granted" || !document.hidden) return;
  try {
    const note = new Notification(title, { body, tag: title + body, icon: "/favicon.ico" });
    note.onclick = () => { window.focus(); onClick(); note.close(); };
  } catch { /* some browsers allow notifications only from a service worker */ }
}

/** Listens for orders and announces them. Mounted once in the admin panel. */
export function OrderAlerts() {
  const { branches } = useBranches();
  const navigate = useNavigate();
  const office = useOfficeVoice();
  const [settings, setSettings] = useState<AlertSettings>(DEFAULT_ALERT_SETTINGS);
  const averages = useRef<Map<string, { name: string; perDay: number; units: number }>>(new Map());
  const settingsRef = useRef(settings);
  const branchesRef = useRef(branches);
  branchesRef.current = branches;
  settingsRef.current = settings;

  useEffect(() => { setSettings(readSettings()); }, []);
  const save = (next: AlertSettings) => {
    setSettings(next);
    try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* this visit only */ }
  };

  // Each item's average sales per day over the last 30 days, read now and every hour.
  const loadAverages = useCallback(async () => {
    if (averagesCache && Date.now() - averagesCache.at < 3600_000) { averages.current = averagesCache.map; return; }
    const since = new Date(Date.now() - AVERAGE_DAYS * 86_400_000).toISOString();
    const { data } = await supabase.from("order_items")
      .select("product_id,product_name,qty,orders!inner(created_at,order_status)")
      .gte("orders.created_at", since)
      .not("orders.order_status", "in", "(\"Awaiting Payment\",\"Payment Expired\",\"Cancelled\")")
      .limit(5000);
    const lines: SoldLine[] = ((data ?? []) as unknown as { product_id: string | null; product_name: string; qty: number; orders: { created_at: string } | { created_at: string }[] }[])
      .map((row) => ({ product_id: row.product_id, product_name: row.product_name, qty: Number(row.qty) || 0,
        created_at: (Array.isArray(row.orders) ? row.orders[0]?.created_at : row.orders?.created_at) ?? "" }));
    averages.current = itemDailyAverages(lines, Date.now(), AVERAGE_DAYS);
    averagesCache = { at: Date.now(), map: averages.current };
  }, []);

  const announce = useCallback(async (order: OrderRow) => {
    if (!shouldAnnounce(order, Date.now())) return;
    const voice = await readOfficeVoice();
    if (!branchAnnounced(voice, order.branch_id) || !claim(order.id)) return;
    const godown = branchesRef.current.find((b) => b.id === order.branch_id)?.name ?? "";
    const text = orderAlertText({ order_no: order.order_no, total: Number(order.total) || 0 }, godown);
    const open = () => void navigate({ to: "/admin/orders/$id", params: { id: order.order_no } });
    toast.success(text.title, { description: text.body, duration: 15000, action: { label: "Open", onClick: open } });
    desktop(text.title, text.body, open);
    // The order before the new one counts in the average: an unusual order must not raise its own bar.
    const { data: items } = await supabase.from("order_items").select("product_id,product_name,qty").eq("order_id", order.id);
    const lines = (items ?? []).map((i) => ({ ...i, qty: Number(i.qty) || 0 }));
    const unusual = unusualLines(lines, averages.current, voice);
    const said = { orderNo: order.order_no, total: Number(order.total) || 0, customer: order.customer_name ?? "", godown, lines };
    if (settingsRef.current.voice) speak(orderSpeech(voice, said), voice, orderSpeech(inEnglish(voice), said));
    if (unusual.length) {
      toast.warning(`Unusual order ${order.order_no}`, {
        description: unusual.map((l) => `${l.qty} × ${l.name} (usual ${l.perDay > 0 ? `${l.perDay} a day` : "almost none"})`).join("; "),
        duration: 30000, action: { label: "Open", onClick: open },
      });
      desktop(`Unusual order from ${branchWords(godown)}`, `${order.order_no}: ${unusual.map((l) => `${l.qty} × ${l.name}`).join(", ")}`, open);
      if (settingsRef.current.voice) {
        const english = unusualSpeeches(inEnglish(voice), order.order_no, godown, unusual);
        unusualSpeeches(voice, order.order_no, godown, unusual).forEach((words, i) => speak(words, voice, english[i]));
      }
    }
  }, [navigate]);

  useEffect(() => {
    if (STATIC_DATA_MODE) return;
    void loadAverages().catch(() => {});
    const timer = window.setInterval(() => void loadAverages().catch(() => {}), 3600_000);
    const channel = supabase.channel(`order-alerts-${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "orders" }, (payload) => void announce(payload.new as OrderRow))
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "orders" }, (payload) => void announce(payload.new as OrderRow))
      .subscribe();
    return () => { window.clearInterval(timer); void supabase.removeChannel(channel); };
  }, [announce, loadAverages]);

  return <AlertsMenu settings={settings} save={save} office={office} admin />;
}

/** The speaker button and its menu: this computer's voice and desktop switches, a test, and (admin) the wording. */
function AlertsMenu({ settings, save, office, admin }: { settings: AlertSettings; save: (next: AlertSettings) => void; office: VoiceSettings; admin?: boolean }) {
  const [open, setOpen] = useState(false);
  const on = settings.voice || settings.desktop;
  const test = () => speak(orderSpeech(office, SAMPLE_ORDER), office, orderSpeech(inEnglish(office), SAMPLE_ORDER));
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-label="Order alerts"
        className={cn("relative rounded-full border border-border p-2 text-navy transition-colors hover:border-gold hover:text-gold", open && "border-gold bg-gold/10 text-gold")}>
        {on ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-72 rounded-lg border border-border bg-white p-3 text-sm shadow-lg">
          <p className="font-semibold text-navy">Order alerts</p>
          <p className="mt-0.5 text-xs text-slate">{admin ? "Each new order is shown and said aloud; unusual orders get a warning." : "Each new order of your godown is shown and said aloud; unusual orders get a warning."}</p>
          <label className="mt-2 flex items-center gap-2">
            <input type="checkbox" checked={settings.voice} onChange={(e) => { save({ ...settings, voice: e.target.checked }); if (e.target.checked) test(); }} />
            Say orders aloud
          </label>
          <label className="mt-1 flex items-center gap-2">
            <input type="checkbox" checked={settings.desktop} onChange={(e) => {
              save({ ...settings, desktop: e.target.checked });
              if (e.target.checked && "Notification" in window && Notification.permission === "default") void Notification.requestPermission();
            }} />
            Desktop notification when this tab is in the background
          </label>
          <p className="mt-2 text-xs text-slate">{`Unusual: an item more than ${office.factor} days of its average sales (last ${AVERAGE_DAYS} days), at least ${office.minUnits} units.`}</p>
          <div className="mt-2 flex items-center gap-3">
            <button type="button" className="text-xs font-semibold text-gold hover:underline" onClick={test}>Play a test</button>
            {admin && <Link to="/admin/settings" search={{ tab: "alerts" }} onClick={() => setOpen(false)} className="text-xs font-semibold text-navy hover:underline">Change wording</Link>}
          </div>
          <p className="mt-1 text-[11px] text-slate">{admin ? "Alerts sound while an admin page is open in this browser." : "Alerts sound while this page is open in this browser. Tap anywhere on the page once after opening it, so the browser lets it speak."}</p>
        </div>
      )}
    </div>
  );
}

type GodownAlertRow = OrderRow & { items: { product_id: string | null; product_name: string; qty: number }[] };
type GodownAlerts = { now: string; godowns: string[]; orders: GodownAlertRow[]; averages: { product_id: string; product_name: string; units: number }[]; voice: unknown };

/** How often a channel partner's or staff member's panel asks for new orders. */
export const GODOWN_POLL_MS = 20_000;

/**
 * Order alerts for a channel partner or godown staff (owner, 19 Nov 2026: "order notification sound enable for channel
 * partner login and staff portal login"). They cannot read the orders table, so the panel asks
 * my_godown_order_alerts every 20 seconds for their own godown's orders; the first answer only marks what is already
 * there. Same wording, language and unusual rule as the office; voice and desktop on/off per computer.
 */
export function GodownOrderAlerts({ ordersPage }: { ordersPage?: string }) {
  const { branches } = useBranches();
  const navigate = useNavigate();
  const [settings, setSettings] = useState<AlertSettings>(DEFAULT_ALERT_SETTINGS);
  const [office, setOffice] = useState<VoiceSettings>(cleanVoiceSettings(null));
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const branchesRef = useRef(branches);
  branchesRef.current = branches;
  useEffect(() => { setSettings(readSettings()); }, []);
  const save = (next: AlertSettings) => {
    setSettings(next);
    try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* this visit only */ }
  };

  useEffect(() => {
    if (STATIC_DATA_MODE) return;
    let stopped = false;
    let since: string | null = null;
    let averages = new Map<string, { perDay: number }>();
    let averagesAt = 0;
    const poll = async () => {
      const withAverages = Date.now() - averagesAt > 3600_000;
      const { data, error } = await supabase.rpc("my_godown_order_alerts", { _since: since ?? new Date(Date.now() - 3600_000).toISOString(), _with_averages: withAverages });
      if (stopped || error || !data) return;
      const reply = data as unknown as GodownAlerts;
      const voice = cleanVoiceSettings(reply.voice);
      setOffice(voice);
      if (withAverages) {
        averagesAt = Date.now();
        averages = new Map(reply.averages.map((a) => [a.product_id, { perDay: Math.round((Number(a.units) / AVERAGE_DAYS) * 100) / 100 }]));
      }
      const first = since === null;
      // A minute's overlap: an order saved while this one was asked is seen next time (claim stops a repeat).
      since = new Date(Date.parse(reply.now) - 60_000).toISOString();
      for (const order of reply.orders) {
        if (!shouldAnnounce(order, Date.now()) || !claim(order.id)) continue;
        if (first) continue; // already there when the page opened: marked, not said
        const godown = branchesRef.current.find((b) => b.id === order.branch_id)?.name ?? "";
        const text = orderAlertText({ order_no: order.order_no, total: Number(order.total) || 0 }, godown);
        const open = ordersPage ? () => void navigate({ to: ordersPage }) : undefined;
        toast.success(text.title, { description: text.body, duration: 15000, ...(open ? { action: { label: "Open", onClick: open } } : {}) });
        desktop(text.title, text.body, open ?? (() => {}));
        const lines = order.items.map((i) => ({ ...i, qty: Number(i.qty) || 0 }));
        const said = { orderNo: order.order_no, total: Number(order.total) || 0, customer: order.customer_name ?? "", godown, lines };
        if (settingsRef.current.voice) speak(orderSpeech(voice, said), voice, orderSpeech(inEnglish(voice), said));
        const unusual = unusualLines(lines, averages, voice);
        if (unusual.length) {
          toast.warning(`Unusual order ${order.order_no}`, {
            description: unusual.map((l) => `${l.qty} × ${l.name} (usual ${l.perDay > 0 ? `${l.perDay} a day` : "almost none"})`).join("; "), duration: 30000,
          });
          desktop(`Unusual order from ${branchWords(godown)}`, `${order.order_no}: ${unusual.map((l) => `${l.qty} × ${l.name}`).join(", ")}`, open ?? (() => {}));
          if (settingsRef.current.voice) {
            const english = unusualSpeeches(inEnglish(voice), order.order_no, godown, unusual);
            unusualSpeeches(voice, order.order_no, godown, unusual).forEach((words, i) => speak(words, voice, english[i]));
          }
        }
      }
    };
    void poll().catch(() => {});
    const timer = window.setInterval(() => void poll().catch(() => {}), GODOWN_POLL_MS);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [navigate, ordersPage]);

  return <AlertsMenu settings={settings} save={save} office={office} />;
}
