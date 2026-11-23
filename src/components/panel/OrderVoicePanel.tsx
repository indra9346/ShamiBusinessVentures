import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Play, RotateCcw, Save } from "lucide-react";
import { Panel } from "@/components/panel/widgets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useBranches } from "@/lib/branches";
import {
  SAMPLE_ORDER, SAMPLE_UNUSUAL, SUGGESTED_WORDING, VOICE_PLACEHOLDERS, cleanVoiceSettings, orderSpeech, unusualSpeeches,
  type VoiceLanguage, type VoiceSettings,
} from "@/lib/order-alerts";
import { saveOfficeVoice, useOfficeVoice } from "@/hooks/use-office-voice";
import { canSpeak, hasKannadaVoice, speak } from "@/lib/voice-speak";
import { cn } from "@/lib/utils";

const english = (v: VoiceSettings): VoiceSettings => ({ ...v, language: "en", ...SUGGESTED_WORDING.en });
const SPEEDS = [{ rate: 0.8, label: "Slow" }, { rate: 0.95, label: "Normal" }, { rate: 1.1, label: "Fast" }];
const PLACEHOLDER_HELP: Record<string, string> = {
  "{branch}": "godown, e.g. Challakere", "{items}": "what was ordered, e.g. 2 Sugar S1", "{amount}": "e.g. 5,496 rupees and 50 paise",
  "{order}": "last part of the order no.", "{customer}": "customer's name", "{qty}": "units ordered", "{item}": "product", "{usual}": "usual sales a day",
};

/*
 * Admin › Settings › Order alerts (owner, 19 Nov 2026: "Need voice notification customization"). The words said for each
 * order and for an unusual order, in English or Kannada, with speed, repeat, chime, which godowns, and the unusual rule.
 * Saved once for the whole office; each computer still turns its own voice on or off from the speaker button.
 */
export function OrderVoicePanel() {
  const office = useOfficeVoice();
  const { branches } = useBranches();
  const [draft, setDraft] = useState<VoiceSettings>(office);
  const [saving, setSaving] = useState(false);
  const [kannadaVoice, setKannadaVoice] = useState(true);
  useEffect(() => { setDraft(office); }, [office]);
  useEffect(() => {
    if (!canSpeak()) return;
    const check = () => setKannadaVoice(hasKannadaVoice());
    check();
    window.speechSynthesis.addEventListener("voiceschanged", check);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", check);
  }, []);

  const set = (patch: Partial<VoiceSettings>) => setDraft((d) => ({ ...d, ...patch }));
  const setLanguage = (language: VoiceLanguage) => set({ language, ...SUGGESTED_WORDING[language] });
  const changed = JSON.stringify(cleanVoiceSettings(draft)) !== JSON.stringify(office);
  const orderPreview = orderSpeech(cleanVoiceSettings(draft), SAMPLE_ORDER);
  const unusualPreview = unusualSpeeches(cleanVoiceSettings(draft), SAMPLE_ORDER.orderNo, SAMPLE_ORDER.godown, [SAMPLE_UNUSUAL])[0] ?? "";
  const play = (which: "order" | "unusual") => {
    const v = cleanVoiceSettings(draft);
    if (which === "order") speak(orderSpeech(v, SAMPLE_ORDER), v, orderSpeech(english(v), SAMPLE_ORDER));
    else speak(unusualPreview, v, unusualSpeeches(english(v), SAMPLE_ORDER.orderNo, SAMPLE_ORDER.godown, [SAMPLE_UNUSUAL])[0]);
  };
  const save = async () => {
    setSaving(true);
    try {
      setDraft(await saveOfficeVoice(draft));
      toast.success("Order alert wording saved", { description: "Every admin computer uses it within 10 minutes." });
    } catch (cause) {
      toast.error("Could not save", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setSaving(false);
    }
  };
  const toggleBranch = (id: string) => set({ branches: draft.branches.includes(id) ? draft.branches.filter((b) => b !== id) : [...draft.branches, id] });

  return (
    <Panel title="Order alerts: what is said">
      <div className="grid gap-5 text-sm xl:max-w-3xl">
        <div className="grid gap-2">
          <p className="text-xs font-bold uppercase tracking-wide text-slate">Language</p>
          <div className="flex gap-2">
            {(["en", "kn"] as const).map((l) => (
              <Button key={l} size="sm" variant={draft.language === l ? "default" : "outline"} onClick={() => setLanguage(l)}>{l === "en" ? "English" : "ಕನ್ನಡ (Kannada)"}</Button>
            ))}
          </div>
          {draft.language === "kn" && !kannadaVoice && (
            <p className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
              This computer has no Kannada voice, so it says the English wording. On Windows: Settings › Time &amp; language › Speech › Add voices › Kannada, then reopen the browser.
            </p>
          )}
        </div>

        <div className="grid gap-1">
          <span className="font-semibold text-navy">Each new order</span>
          <Textarea rows={2} maxLength={300} value={draft.orderText} onChange={(e) => set({ orderText: e.target.value })} />
          <span className="text-xs text-slate">{`Sounds like: "${orderPreview}"`}</span>
          <Button size="sm" variant="outline" className="justify-self-start" onClick={() => play("order")}><Play className="mr-1 h-3.5 w-3.5" />Play</Button>
        </div>

        <div className="grid gap-1">
          <span className="font-semibold text-navy">An unusual order (far above an item's usual sales)</span>
          <Textarea rows={2} maxLength={300} value={draft.unusualText} onChange={(e) => set({ unusualText: e.target.value })} />
          <span className="text-xs text-slate">{`Sounds like: "${unusualPreview}"`}</span>
          <Button size="sm" variant="outline" className="justify-self-start" onClick={() => play("unusual")}><Play className="mr-1 h-3.5 w-3.5" />Play</Button>
        </div>

        <div className="rounded-md border border-border bg-slate-50 p-3 text-xs text-slate">
          <p className="mb-1 font-semibold text-navy">Words in curly brackets are filled in for each order</p>
          <ul className="grid gap-0.5 sm:grid-cols-2">
            {[...new Set([...VOICE_PLACEHOLDERS.order, ...VOICE_PLACEHOLDERS.unusual])].map((p) => (
              <li key={p}><span className="font-mono text-navy">{p}</span>{` ${PLACEHOLDER_HELP[p] ?? ""}`}</li>
            ))}
          </ul>
          <button type="button" className="mt-2 inline-flex items-center gap-1 font-semibold text-gold hover:underline" onClick={() => set(SUGGESTED_WORDING[draft.language])}>
            <RotateCcw className="h-3 w-3" />Use the suggested wording
          </button>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-1">
            <span className="text-xs font-semibold text-slate">Speed</span>
            <div className="flex gap-1">
              {SPEEDS.map((s) => (
                <Button key={s.rate} size="sm" variant={Math.abs(draft.rate - s.rate) < 0.01 ? "default" : "outline"} onClick={() => set({ rate: s.rate })}>{s.label}</Button>
              ))}
            </div>
          </div>
          <div className="grid gap-1">
            <span className="text-xs font-semibold text-slate">Say each alert</span>
            <div className="flex gap-1">
              {[1, 2, 3].map((n) => (
                <Button key={n} size="sm" variant={draft.repeat === n ? "default" : "outline"} onClick={() => set({ repeat: n })}>{n === 1 ? "Once" : `${n} times`}</Button>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 self-end">
            <Switch checked={draft.chime} onCheckedChange={(chime) => set({ chime })} />Chime before speaking
          </label>
        </div>

        <div className="grid gap-1">
          <span className="text-xs font-semibold text-slate">Godowns to announce (none ticked = all)</span>
          <div className="flex flex-wrap gap-2">
            {branches.map((b) => (
              <label key={b.id} className={cn("flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs", draft.branches.includes(b.id) ? "border-gold bg-gold/10 text-navy" : "border-border")}>
                <input type="checkbox" checked={draft.branches.includes(b.id)} onChange={() => toggleBranch(b.id)} />{b.name}
              </label>
            ))}
          </div>
        </div>

        <div className="grid gap-1">
          <span className="text-xs font-semibold text-slate">Unusual: an item more than this many days of its average sales (last 30 days), and at least this many units</span>
          <span className="flex items-center gap-2 text-xs">
            <Input type="number" min={1.5} max={30} step={0.5} className="h-8 w-20" value={draft.factor} aria-label="Days of average sales" onChange={(e) => set({ factor: Number(e.target.value) })} />days
            <Input type="number" min={1} max={10000} step={1} className="h-8 w-24" value={draft.minUnits} aria-label="At least this many units" onChange={(e) => set({ minUnits: Number(e.target.value) })} />units
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={saving || !changed} onClick={() => void save()}><Save className="mr-1 h-4 w-4" />{saving ? "Saving…" : "Save for the office"}</Button>
          {changed && <Button variant="outline" onClick={() => setDraft(office)}>Undo changes</Button>}
          <span className="text-xs text-slate">Each computer turns its own voice on or off from the speaker button at the top.</span>
        </div>
      </div>
    </Panel>
  );
}
