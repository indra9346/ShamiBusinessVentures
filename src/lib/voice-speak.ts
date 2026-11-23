// Speaking an order alert in the browser with the office's voice settings (19 Nov 2026). Kept apart from the panel so
// the settings tab's "Play" and the live alerts sound the same.
import { SUGGESTED_WORDING, pickVoiceFor, type VoiceLanguage, type VoiceSettings } from "@/lib/order-alerts";

export const canSpeak = () => typeof window !== "undefined" && "speechSynthesis" in window;

/** The browser's voices (Chrome fills them in a moment after the page opens). */
export function browserVoices(): SpeechSynthesisVoice[] {
  return canSpeak() ? window.speechSynthesis.getVoices() : [];
}

/** Whether this computer can say Kannada. */
export const hasKannadaVoice = () => !!pickVoiceFor(browserVoices(), "kn");

/** A short two-note chime before the words. */
function chime() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [880, 1318.5].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = "sine";
      const at = ctx.currentTime + i * 0.18;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.25, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.4);
    });
    window.setTimeout(() => void ctx.close().catch(() => {}), 1200);
  } catch { /* no sound device */ }
}

/**
 * Says the text with the office's settings. Kannada words need a Kannada voice; a computer without one says the English
 * suggested wording instead (`english` gives that text), so an alert is never silent or garbled.
 */
export function speak(text: string, v: Pick<VoiceSettings, "language" | "rate" | "repeat" | "chime">, english?: string) {
  if (!canSpeak()) return;
  let language: VoiceLanguage = v.language;
  let words = text;
  let voice = pickVoiceFor(browserVoices(), language);
  if (language === "kn" && !voice) {
    language = "en";
    words = english ?? text;
    voice = pickVoiceFor(browserVoices(), "en");
  }
  const say = () => {
    for (let i = 0; i < v.repeat; i++) {
      const utterance = new SpeechSynthesisUtterance(words);
      utterance.lang = language === "kn" ? "kn-IN" : "en-IN";
      utterance.rate = v.rate;
      if (voice) utterance.voice = voice;
      window.speechSynthesis.speak(utterance);
    }
  };
  if (v.chime) { chime(); window.setTimeout(say, 700); } else say();
}

export { SUGGESTED_WORDING };
