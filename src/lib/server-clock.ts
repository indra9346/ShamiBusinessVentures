import { useEffect, useState } from "react";

/*
 * The server's time, for payment countdowns. A held checkout ends at a time the database sets
 * (payment_hold_until), so counting with the phone's own clock would be off by however wrong that
 * clock is. The difference is measured once from the web server's Date header (NTP-synced, like the
 * database), using the middle of the request: accurate to about half a second.
 */

let offsetMs = 0;
let syncing: Promise<void> | null = null;

/** Milliseconds since the epoch, on the server's clock. */
export function serverNow(): number {
  return Date.now() + offsetMs;
}

type Sample = { sentAt: number; receivedAt: number; serverDate: number };

/**
 * The offset from timed samples. Best: two samples either side of the moment the server's second
 * changed, which pins that moment to within about half the gap between them. Otherwise the median
 * of the half-second estimates, so one slow request doesn't skew it.
 */
export function clockOffset(samples: Sample[]): number {
  const valid = samples.filter((s) => Number.isFinite(s.serverDate) && s.receivedAt >= s.sentAt);
  let best: { offset: number; uncertainty: number } | null = null;
  for (let i = 1; i < valid.length; i += 1) {
    const before = valid[i - 1]!, after = valid[i]!;
    if (after.serverDate !== before.serverDate + 1000) continue;
    const midBefore = (before.sentAt + before.receivedAt) / 2;
    const midAfter = (after.sentAt + after.receivedAt) / 2;
    const uncertainty = midAfter - midBefore;
    if (uncertainty > 0 && (!best || uncertainty < best.uncertainty)) {
      best = { offset: after.serverDate - (midBefore + midAfter) / 2, uncertainty };
    }
  }
  if (best) return best.offset;
  // A Date header is whole seconds: the true server time is on average half a second later.
  const offsets = valid
    .filter((s) => Number.isFinite(s.serverDate) && s.receivedAt >= s.sentAt)
    .map((s) => s.serverDate + 500 - (s.sentAt + s.receivedAt) / 2)
    .sort((a, b) => a - b);
  if (!offsets.length) return 0;
  const mid = Math.floor(offsets.length / 2);
  return offsets.length % 2 ? offsets[mid]! : (offsets[mid - 1]! + offsets[mid]!) / 2;
}

export function syncServerClock(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  syncing ??= (async () => {
    // Sample about every 100 ms until the server's second ticks over (at most ~1.3 s).
    const samples: Sample[] = [];
    for (let i = 0; i < 13; i += 1) {
      const sentAt = Date.now();
      const response = await fetch(`/favicon.ico?clock=${sentAt}`, { method: "HEAD", cache: "no-store" });
      const receivedAt = Date.now();
      samples.push({ sentAt, receivedAt, serverDate: Date.parse(response.headers.get("date") ?? "") });
      const last = samples.length - 1;
      if (last > 0 && samples[last]!.serverDate === samples[last - 1]!.serverDate + 1000) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    offsetMs = clockOffset(samples);
  })().catch(() => {
    // Offline or no Date header: the device clock is the best there is.
  });
  return syncing;
}

/**
 * The server time, re-rendered on every second boundary (so every countdown on every screen
 * flips at the same moment) and at once when the tab comes back to the front.
 */
export function useServerNow(stepMs = 1000): number {
  const [now, setNow] = useState(() => serverNow());
  useEffect(() => {
    let timer = 0;
    const tick = () => {
      setNow(serverNow());
      window.clearTimeout(timer);
      timer = window.setTimeout(tick, stepMs - (serverNow() % stepMs) + 5);
    };
    const onVisible = () => { if (document.visibilityState === "visible") tick(); };
    void syncServerClock().then(tick);
    tick();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", tick);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", tick);
    };
  }, [stepMs]);
  return now;
}
