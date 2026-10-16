import { useEffect, useState } from "react";
import { Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Panel } from "@/components/panel/widgets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import {
  PICKUP_SETTINGS_KEY,
  defaultPickupSettings,
  parsePickupSettings,
  setPickupSettings,
  type PickupPoint,
  type PickupSettings,
} from "@/lib/pickup-points";

type Draft = Omit<PickupPoint, "pincodes"> & { pincodesText: string };

const toDraft = (point: PickupPoint): Draft => ({ ...point, pincodesText: point.pincodes.join(", ") });
const fromDraft = (draft: Draft): PickupPoint => {
  const { pincodesText, ...rest } = draft;
  return {
    ...rest,
    pincodes: [...new Set(pincodesText.split(/[^\d]+/).filter((pin) => /^\d{6}$/.test(pin)))],
  };
};

/** Admin: the godowns customers collect orders from, the PIN codes each serves, and its Zoho location. */
export function PickupPointsPanel() {
  const [homeDelivery, setHomeDelivery] = useState(false);
  const [points, setPoints] = useState<Draft[]>(defaultPickupSettings.points.map(toDraft));
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState<"" | "saving" | "locations">("");

  useEffect(() => {
    let active = true;
    void supabase.from("settings").select("value").eq("key", PICKUP_SETTINGS_KEY).maybeSingle().then(({ data, error }) => {
      if (!active || error || !data) return;
      const parsed = parsePickupSettings(data.value);
      setHomeDelivery(parsed.homeDelivery);
      if (parsed.points.length) setPoints(parsed.points.map(toDraft));
    });
    return () => { active = false; };
  }, []);

  const update = (index: number, patch: Partial<Draft>) =>
    setPoints((current) => current.map((point, i) => (i === index ? { ...point, ...patch } : point)));

  const loadLocations = async () => {
    setBusy("locations");
    try {
      const { listZohoLocations } = await import("@/lib/zoho-commerce.functions");
      const list = await listZohoLocations();
      setLocations(list);
      toast.success(`Loaded ${list.length} Zoho locations`);
    } catch (cause) {
      toast.error("Could not load Zoho locations", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy("");
    }
  };

  const save = async () => {
    const cleaned = points.map(fromDraft);
    const problem = cleaned.find((point) => !point.name.trim())
      ? "Every godown needs a name"
      : cleaned.find((point) => point.mapUrl && !/^https:\/\//i.test(point.mapUrl))
        ? "The Google Maps link must start with https://"
        : cleaned.filter((point) => point.isDefault).length > 1
          ? "Only one godown can be the default"
          : null;
    if (problem) {
      toast.error(problem);
      return;
    }
    const value: PickupSettings = { homeDelivery, points: cleaned };
    setBusy("saving");
    const { error } = await supabase
      .from("settings")
      .upsert([{ key: PICKUP_SETTINGS_KEY, value: value as unknown as Json, is_public: true }], { onConflict: "key" });
    setBusy("");
    if (error) {
      toast.error("Could not save pickup points", { description: error.message });
      return;
    }
    setPickupSettings(value);
    toast.success("Pickup points saved");
  };

  return (
    <Panel title="Pickup Godowns">
      <div className="grid gap-4 xl:max-w-4xl">
        <div className="flex items-center justify-between gap-4 rounded-md border border-border p-4">
          <div>
            <p className="text-sm font-bold text-navy">Home delivery available</p>
            <p className="text-xs text-slate">
              Off: customers collect every order from the godown serving their PIN code, shown at checkout, on the order and in tracking.
              Set Standard shipping to ₹0 in Commerce Rules while orders are collected.
            </p>
          </div>
          <Switch checked={homeDelivery} onCheckedChange={setHomeDelivery} aria-label="Home delivery available" />
        </div>

        {points.map((point, index) => (
          <fieldset key={point.id} className="grid gap-3 rounded-md border border-border p-4 sm:grid-cols-2">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate">Godown {index + 1}</legend>
            <div className="grid gap-1.5">
              <Label>Name shown to customers</Label>
              <Input value={point.name} maxLength={120} onChange={(e) => update(index, { name: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label>Phone for pickup questions</Label>
              <Input value={point.phone} maxLength={30} inputMode="tel" onChange={(e) => update(index, { phone: e.target.value })} />
            </div>
            <div className="grid gap-1.5 sm:col-span-2">
              <Label>Full address</Label>
              <Textarea rows={2} maxLength={500} value={point.address} onChange={(e) => update(index, { address: e.target.value })} placeholder="Door no., street, landmark, Challakere, Chitradurga 577522" />
            </div>
            <div className="grid gap-1.5 sm:col-span-2">
              <Label>Google Maps link</Label>
              <Input value={point.mapUrl} maxLength={1000} onChange={(e) => update(index, { mapUrl: e.target.value.trim() })} placeholder="https://maps.app.goo.gl/… (Google Maps → Share → Copy link)" />
              {point.mapUrl && /^https:\/\//i.test(point.mapUrl) && (
                <a href={point.mapUrl} target="_blank" rel="noreferrer" className="text-xs font-semibold text-navy hover:text-gold">Open this link to check it</a>
              )}
            </div>
            <div className="grid gap-1.5 sm:col-span-2">
              <Label>Pickup instructions</Label>
              <Textarea rows={2} maxLength={500} value={point.instructions} onChange={(e) => update(index, { instructions: e.target.value })} placeholder="Timings, what to bring (order number, ID), whom to ask for" />
            </div>
            <div className="grid gap-1.5 sm:col-span-2">
              <Label>PIN codes served (comma separated)</Label>
              <Input value={point.pincodesText} onChange={(e) => update(index, { pincodesText: e.target.value })} placeholder="577522, 577536, …" />
            </div>
            <div className="grid gap-1.5 sm:col-span-2">
              <Label>Zoho location (warehouse the sales order uses)</Label>
              <div className="flex flex-wrap gap-2">
                {locations.length > 0 ? (
                  <select
                    className="h-9 min-w-56 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                    value={point.zohoLocationId}
                    onChange={(e) => {
                      const chosen = locations.find((location) => location.id === e.target.value);
                      update(index, { zohoLocationId: e.target.value, zohoLocationName: chosen?.name ?? "" });
                    }}
                  >
                    <option value="">Not linked (Zoho uses its primary location)</option>
                    {locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
                  </select>
                ) : (
                  <Input
                    className="min-w-56 flex-1 font-mono text-xs"
                    value={point.zohoLocationId}
                    onChange={(e) => update(index, { zohoLocationId: e.target.value.replace(/\D/g, "") })}
                    placeholder={`Location ID${point.zohoLocationName ? ` for ${point.zohoLocationName}` : ""}`}
                  />
                )}
                <Button type="button" variant="outline" disabled={!!busy} onClick={() => void loadLocations()}>
                  <RefreshCw className={`mr-1.5 h-4 w-4 ${busy === "locations" ? "animate-spin" : ""}`} /> Load from Zoho
                </Button>
              </div>
              {point.zohoLocationName && <p className="text-xs text-slate">Linked: {point.zohoLocationName}{point.zohoLocationId ? ` (${point.zohoLocationId})` : " (ID not set yet)"}</p>}
            </div>
            <div className="flex flex-wrap items-center gap-6 sm:col-span-2">
              <label className="flex items-center gap-2 text-sm text-charcoal">
                <Switch checked={point.active} onCheckedChange={(active) => update(index, { active })} aria-label="Godown active" /> Active
              </label>
              <label className="flex items-center gap-2 text-sm text-charcoal">
                <Switch
                  checked={point.isDefault}
                  onCheckedChange={(isDefault) => setPoints((current) => current.map((p, i) => ({ ...p, isDefault: i === index ? isDefault : isDefault ? false : p.isDefault })))}
                  aria-label="Default godown"
                />
                Default for other PIN codes
              </label>
              {points.length > 1 && (
                <Button type="button" variant="outline" size="sm" className="ml-auto text-danger" onClick={() => setPoints((current) => current.filter((_, i) => i !== index))}>
                  <Trash2 className="mr-1 h-4 w-4" /> Remove
                </Button>
              )}
            </div>
          </fieldset>
        ))}

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setPoints((current) => [...current, {
              ...toDraft({ ...defaultPickupSettings.points[0]!, id: `point-${Date.now()}`, name: "", address: "", mapUrl: "", instructions: "", phone: "", pincodes: [], zohoLocationId: "", zohoLocationName: "", isDefault: false }),
            }])}
          >
            <Plus className="mr-1 h-4 w-4" /> Add another godown
          </Button>
          <Button className="bg-navy text-white hover:bg-navy/90" disabled={!!busy} onClick={() => void save()}>
            <Save className="mr-1 h-4 w-4" /> {busy === "saving" ? "Saving…" : "Save Pickup Godowns"}
          </Button>
        </div>
      </div>
    </Panel>
  );
}
