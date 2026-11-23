/*
 * Google Analytics (GA4), so the owner can see how many real people visit each day. It stays off unless
 * this is a production build with VITE_GA_MEASUREMENT_ID set, not the static demo, on the live address.
 * What may be counted is in analytics-rules.ts. Google's script is large (over 150 KB), so it loads only
 * after the page is usable; pages seen before that wait in the queue and are sent when it arrives.
 */
import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { afterPageLoad } from "@/lib/storefront-snapshot";
import {
  cleanPageUrl,
  isLiveHost,
  isPanelPath,
  isUntrackedPath,
  validMeasurementId,
} from "@/lib/analytics-rules";

const MEASUREMENT_ID = validMeasurementId(import.meta.env["VITE_GA_MEASUREMENT_ID"]);
const STAFF_DEVICE_KEY = "gb-staff-device";
/**
 * Once the page has loaded: the script loads at the visitor's first touch, scroll, key or mouse move, or
 * after this long for someone who does none of those. Tested on the mobile score: at 5 s the script still
 * landed inside the time Lighthouse measures and cost points.
 */
const LOAD_DELAY_MS = 15000;

function gtag(..._args: unknown[]) {
  const target = window as Window & { dataLayer?: unknown[] };
  // Google's script reads the real `arguments` object from this queue; an array is ignored.
  // eslint-disable-next-line prefer-rest-params
  (target.dataLayer ??= []).push(arguments);
}

function isStaffDevice() {
  try {
    return window.localStorage.getItem(STAFF_DEVICE_KEY) === "1";
  } catch {
    return false;
  }
}

function markStaffDevice() {
  try {
    window.localStorage.setItem(STAFF_DEVICE_KEY, "1");
  } catch {
    /* storage blocked */
  }
}

function loadScriptWhenPageIsUsable(id: string) {
  const triggers = ["pointerdown", "pointermove", "scroll", "keydown"];
  let loaded = false;
  const load = () => {
    if (loaded) return;
    loaded = true;
    for (const trigger of triggers) window.removeEventListener(trigger, load);
    const script = document.createElement("script");
    script.src = `https://www.googletagmanager.com/gtag/js?id=${id}`;
    script.async = true;
    document.head.appendChild(script);
  };
  afterPageLoad(() => {
    for (const trigger of triggers)
      window.addEventListener(trigger, load, { once: true, passive: true });
    window.setTimeout(load, LOAD_DELAY_MS);
  });
}

function start(id: string) {
  // Google's own off switch, checked as each hit is sent. As a getter it is right even for a hit from
  // Google's automatic listeners in the moment a page changes. If Enhanced measurement is on for the
  // stream, those listeners report the address of any link tapped, so a link that holds a customer's
  // details carries [data-analytics-off] (the enquiry receipt, the map link to a pinned location).
  Object.defineProperty(window, `ga-disable-${id}`, {
    get: () =>
      isStaffDevice() ||
      isUntrackedPath(window.location.pathname) ||
      document.querySelector("[data-analytics-off]") !== null,
  });
  gtag("js", new Date());
  gtag("config", id, {
    send_page_view: false, // countPage() sends them, with the clean address
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });
  loadScriptWhenPageIsUsable(id);
}

let started = false;
let previousUrl = "";

function countPage(id: string) {
  const { href, pathname } = window.location;
  if (isPanelPath(pathname)) markStaffDevice();
  if (isStaffDevice() || isUntrackedPath(pathname)) return;
  if (!started) {
    started = true;
    previousUrl = cleanPageUrl(document.referrer);
    start(id);
  }
  const url = cleanPageUrl(href);
  gtag("set", { page_location: url, page_referrer: previousUrl, page_title: document.title });
  gtag("event", "page_view");
  previousUrl = url;
}

/** Counts the first page and each later page change (the site changes pages without a full reload). */
export function useGoogleAnalytics() {
  const router = useRouter();
  useEffect(() => {
    const id = MEASUREMENT_ID;
    if (!id || !import.meta.env.PROD || STATIC_DATA_MODE || !isLiveHost(window.location.hostname))
      return;
    countPage(id);
    return router.subscribe("onResolved", ({ pathChanged }) => {
      if (pathChanged) countPage(id);
    });
  }, [router]);
}
