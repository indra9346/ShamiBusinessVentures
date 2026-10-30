/*
 * The festival theme switch on the storefront. The decorations are drawn into the page from the first
 * paint while the festival dates are on (the same on the server and in the browser). The admin switch
 * (settings row "festive_theme") can hide them: the last value seen is kept on the device and applied by
 * a tiny script in <head> before the first paint, as <html data-festive="off">, so a returning shopper
 * never sees them flash; the stylesheet hides every .gb-festive element under that attribute. All
 * decorations are overlays, so switching them on or off never moves the page.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { DIWALI_2026, FESTIVE_SETTING_KEY, defaultFestiveSetting, festiveStatus, festiveThemeOn, isInFestiveWindow, parseFestiveSetting, type FestiveSetting } from "@/lib/festive-rules";

export { DIWALI_2026, FESTIVE_SETTING_KEY, defaultFestiveSetting, festiveStatus, festiveThemeOn, isInFestiveWindow, parseFestiveSetting, type FestiveSetting };

const CACHE_KEY = "gb-festive-v1";

/** Runs in <head> before the page paints: hides the decorations if the admin switched them off. */
export const FESTIVE_HEAD_SCRIPT = `try{var f=JSON.parse(localStorage.getItem("${CACHE_KEY}")||"null");if(f&&f.enabled===false)document.documentElement.setAttribute("data-festive","off")}catch(e){}`;

function readCache(): FestiveSetting | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    return raw ? parseFestiveSetting(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function apply(value: FestiveSetting) {
  try { window.localStorage.setItem(CACHE_KEY, JSON.stringify(value)); } catch { /* storage blocked */ }
  if (value.enabled) document.documentElement.removeAttribute("data-festive");
  else document.documentElement.setAttribute("data-festive", "off");
}

let current: FestiveSetting = defaultFestiveSetting;
let request: Promise<FestiveSetting> | null = null;
const listeners = new Set<(value: FestiveSetting) => void>();

/** Applies a new value everywhere at once (used after the admin flips the switch). */
export function setFestiveSetting(value: FestiveSetting) {
  current = value;
  apply(value);
  for (const listener of listeners) listener(value);
}

export async function loadFestiveSetting(): Promise<FestiveSetting> {
  if (STATIC_DATA_MODE) return readCache() ?? defaultFestiveSetting;
  const { data, error } = await supabase.from("settings").select("value").eq("key", FESTIVE_SETTING_KEY).eq("is_public", true).maybeSingle();
  if (error) throw new Error(error.message);
  return parseFestiveSetting(data?.value);
}

export async function saveFestiveSetting(value: FestiveSetting) {
  if (!STATIC_DATA_MODE) {
    const { error } = await supabase.from("settings").upsert({ key: FESTIVE_SETTING_KEY, value, is_public: true });
    if (error) throw new Error(error.message);
  }
  setFestiveSetting(value);
}

function refresh() {
  request ??= loadFestiveSetting()
    .then((value) => { setFestiveSetting(value); return value; })
    .catch(() => current); // offline or blocked: keep what the device last saw
  return request;
}

/**
 * `on`: draw the decorations (festival dates; the same on the server and in the first browser render, so
 * nothing jumps when the page wakes up). `enabled`: the admin switch, once known. Decorations unmount
 * when it is off; until then the <head> script and stylesheet keep them hidden.
 */
export function useFestiveTheme() {
  const inWindow = isInFestiveWindow();
  const [setting, setSetting] = useState<FestiveSetting>(defaultFestiveSetting);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    const cached = readCache();
    if (cached) { current = cached; setSetting(cached); }
    listeners.add(setSetting);
    void refresh().then(() => { if (active) { setSetting(current); setReady(true); } });
    return () => { active = false; listeners.delete(setSetting); };
  }, []);
  return { on: inWindow && setting.enabled, inWindow, setting, ready, window: DIWALI_2026 };
}
