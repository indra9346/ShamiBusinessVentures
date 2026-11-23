import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { DEFAULT_VOICE, ORDER_VOICE_KEY, cleanVoiceSettings, type VoiceSettings } from "@/lib/order-alerts";

// The office's voice wording (Admin › Settings › Order alerts), read once per tab and again when it is saved.
const CHANGED = "gb-office-voice-changed";
let cached: VoiceSettings | null = null;
let cachedAt = 0;
let reading: Promise<VoiceSettings> | null = null;

export function readOfficeVoice(): Promise<VoiceSettings> {
  // Re-read every 10 minutes, so a change saved on another computer reaches this one without a reload.
  if (cached && Date.now() - cachedAt < 600_000) return Promise.resolve(cached);
  if (STATIC_DATA_MODE) return Promise.resolve(DEFAULT_VOICE);
  reading ??= Promise.resolve(supabase.from("settings").select("value").eq("key", ORDER_VOICE_KEY).maybeSingle())
    .then(({ data }) => { cachedAt = Date.now(); return (cached = cleanVoiceSettings(data?.value)); })
    .catch(() => cached ?? DEFAULT_VOICE)
    .finally(() => { reading = null; });
  return reading;
}

export async function saveOfficeVoice(next: VoiceSettings) {
  const value = cleanVoiceSettings(next);
  if (!STATIC_DATA_MODE) {
    const { error } = await supabase.from("settings").upsert({ key: ORDER_VOICE_KEY, value: value as unknown as Json, is_public: false, updated_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
  }
  cached = value;
  cachedAt = Date.now();
  window.dispatchEvent(new Event(CHANGED));
  return value;
}

export function useOfficeVoice() {
  const [voice, setVoice] = useState<VoiceSettings>(cached ?? DEFAULT_VOICE);
  useEffect(() => {
    let live = true;
    const load = () => void readOfficeVoice().then((v) => { if (live) setVoice(v); });
    load();
    window.addEventListener(CHANGED, load);
    return () => { live = false; window.removeEventListener(CHANGED, load); };
  }, []);
  return voice;
}
