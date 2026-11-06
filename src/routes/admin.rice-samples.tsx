import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, ExternalLink, FlaskConical, History, MessageCircle, Phone, Plus, ScrollText, ShoppingCart, Star, XCircle } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { FilterNote, Panel, scrollToSection, StatCard } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { inrPrecise } from "@/lib/data";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  BROKEN_LABELS, GRAIN_LABELS, NO_GST_WORDS, PO_DEATH_WORDS, RICE_PO_SETTINGS_KEY, SORT_LABELS, STATUS_LABELS, SWELLING_LABELS, TASTE_LABELS, bestInComparison, canCancelPo, inPlay, poDeathReason, poTaxAmount, poTaxLabel, poTaxReason, isBulkUnit, isSamplePhone, glazingChoices, latestTest, NO_MEASURE_FILTER, parseMoisture, testMatchesMeasures, type TestMeasureFilter, phoneLinks, planPoLine,
  poLineProblem, poReference, priceUnitWarning, riceTextOptions, sampleLabel, sortSamples, testsBySample, zohoPoUrl, zohoStatusLabel,
  type BrokenResult, type GrainResult, type PoTax, type RetiredPo, type PartyRole, type RaiseResult, type RicePo, type RiceSample, type RiceTest, type SampleSort, type SampleStatus, type SwellingResult, type TasteResult, type ZohoItemMatch, type ZohoVendorMatch,
} from "@/lib/rice-samples";
import type { RiceDesk, RiceGodown } from "@/lib/rice-samples.functions";
import { listActiveRiceOptions } from "@/lib/product-codes";

export const Route = createFileRoute("/admin/rice-samples")({
  head: () => ({ meta: [{ title: "Rice Samples | Grain Bazar Admin" }, { name: "robots", content: "noindex" }] }),
  component: AdminRiceSamples,
});

const num = (value: string) => {
  const parsed = Number(value.replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
};
const qty = (value: number) => Number(value).toLocaleString("en-IN", { maximumFractionDigits: 3 });
const day = (value: string) => new Date(`${value}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
const when = (value: string) => new Date(value).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const todayLocal = () => { const now = new Date(); return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10); };
const nowLocal = () => { const now = new Date(); return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };
const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : "Something went wrong");
const STATUS_TONE: Record<SampleStatus, string> = {
  arrived: "bg-navy/6 text-navy border-navy/15",
  tested: "bg-gold/12 text-gold border-gold/30",
  selected: "bg-success/10 text-success border-success/25",
  discarded: "bg-slate/10 text-slate border-slate/25",
  unavailable: "bg-danger/10 text-danger border-danger/25",
};
const PARTY_LABEL: Record<PartyRole, string> = { broker: "Broker", seller: "Seller" };
const inputClass = "h-10 bg-white text-base sm:text-sm";
const PO_CHECK_MS = 60_000;
type StatusAction = "discard" | "unavailable" | "reopen" | "delete" | "restore";
/** Forms stay open when someone taps beside them, so typed figures are not lost. */
const keepOpen = { onInteractOutside: (event: { preventDefault(): void }) => event.preventDefault() };

/** Shown only in the static preview, which has no database. Made-up names and numbers. */
const demoDesk = (): RiceDesk => {
  const sample = (id: string, variety: string, method: string, price: number, quantity: number, role: PartyRole, name: string, arrival: string, status: SampleStatus): RiceSample => ({
    id, sample_no: Number(id.slice(-1)), arrival_date: arrival, variety, method, price_per_qntl: price, quantity_qntl: quantity, party_role: role, party_name: name, party_phone: "9000000001", seller_name: role === "broker" ? "Sample Mills" : "",
    notes: "", status, status_reason: status === "unavailable" ? "Broker says the lot is sold" : "", status_changed_at: `${arrival}T10:00:00Z`, created_by_name: "Head Office", created_at: `${arrival}T10:00:00Z`, updated_at: `${arrival}T10:00:00Z`, deleted_at: null, deleted_by_name: "", deleted_reason: "",
  });
  const test = (sampleId: string, score: number, grain: GrainResult, taste: TasteResult, broken: BrokenResult): RiceTest => ({
    id: `T-${sampleId}`, sample_id: sampleId, tested_at: "2026-11-02T06:00:00Z", tested_by_name: "Godown team", score, grain, swelling: "good", taste, broken, notes: "Good smell, cooked in 15 minutes", moisture_percent: 12.5, glazing: "Silky", recorded_at: "2026-11-02T06:05:00Z",
  });
  return {
    samples: [
      sample("a0000000-0000-4000-8000-000000000001", "Sona Rice", "Steam Rice", 4200, 120, "broker", "Sample Broker", "2026-11-02", "tested"),
      sample("a0000000-0000-4000-8000-000000000002", "Sona Rice", "Raw Rice", 3950, 200, "seller", "Sample Traders", "2026-11-02", "tested"),
      sample("a0000000-0000-4000-8000-000000000003", "HMT", "Raw Rice", 4600, 80, "broker", "Second Broker", "2026-11-01", "arrived"),
      sample("a0000000-0000-4000-8000-000000000004", "RNR", "Steam Rice", 3700, 60, "broker", "Second Broker", "2026-10-30", "unavailable"),
    ],
    tests: [test("a0000000-0000-4000-8000-000000000001", 8, "separate", "good", "few"), test("a0000000-0000-4000-8000-000000000002", 6, "slightly_sticky", "ok", "some")],
    events: [], pos: [],
    godowns: [{ id: "BR-CLK", name: "Grain Bazar Challakere Godown", isDefault: true, locationId: "1", locationName: "CLK" }],
    issueOnCreate: false, adminName: "Head Office", zoho: null,
  };
};

type ListFilter = "in_play" | "all" | SampleStatus | "out" | "deleted";
const FILTER_LABELS: Record<ListFilter, string> = {
  in_play: "In play", all: "All samples", arrived: "Waiting for a cook test", tested: "Tested", selected: "PO raised", discarded: "Discarded", unavailable: "Unavailable", out: "Discarded or unavailable", deleted: "Deleted cards",
};
/** Deleted cards show only under their own filter. */
const matchesFilter = (status: SampleStatus, filter: ListFilter) =>
  filter === "deleted" ? false : filter === "all" ? true : filter === "in_play" ? inPlay(status) : filter === "out" ? status === "discarded" || status === "unavailable" : status === filter;

type SampleForm = {
  id: string | null; arrivalDate: string; variety: string; method: string; price: string; quantity: string;
  partyRole: PartyRole; partyName: string; partyPhone: string; sellerName: string; notes: string;
};
const emptySampleForm = (): SampleForm => ({ id: null, arrivalDate: todayLocal(), variety: "", method: "", price: "", quantity: "", partyRole: "broker", partyName: "", partyPhone: "", sellerName: "", notes: "" });
const formFromSample = (sample: RiceSample, keepId: boolean): SampleForm => ({
  id: keepId ? sample.id : null, arrivalDate: keepId ? sample.arrival_date : todayLocal(), variety: sample.variety, method: sample.method, price: String(sample.price_per_qntl), quantity: String(sample.quantity_qntl),
  partyRole: sample.party_role, partyName: sample.party_name, partyPhone: sample.party_phone, sellerName: sample.seller_name, notes: keepId ? sample.notes : "",
});

function AdminRiceSamples() {
  const [desk, setDesk] = useState<RiceDesk | null>(null);
  const [loadError, setLoadError] = useState("");
  const [filter, setFilter] = useState<ListFilter>("in_play");
  const [sort, setSort] = useState<SampleSort>("score");
  const [search, setSearch] = useState("");
  const [measures, setMeasures] = useState<TestMeasureFilter>(NO_MEASURE_FILTER);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [sampleForm, setSampleForm] = useState<SampleForm | null>(null);
  const [testing, setTesting] = useState<RiceSample | null>(null);
  const [changing, setChanging] = useState<{ sample: RiceSample; action: StatusAction } | null>(null);
  const [cancelling, setCancelling] = useState<{ sample: RiceSample; po: RicePo } | null>(null);
  const [buying, setBuying] = useState<RiceSample | null>(null);
  const [historyOf, setHistoryOf] = useState<RiceSample | null>(null);
  const [savingMode, setSavingMode] = useState(false);

  const lastLoad = useRef(0);
  // quiet: a check in the background keeps what is on screen if it fails. Only the newest request's answer shows, or a slow one could bring back a button already gone.
  const load = useCallback(async (quiet = false) => {
    if (STATIC_DATA_MODE) { setDesk((current) => current ?? demoDesk()); return; }
    const mine = ++lastLoad.current;
    try {
      const { getRiceSampleDesk } = await import("@/lib/rice-samples.functions");
      const fresh = await getRiceSampleDesk();
      if (mine !== lastLoad.current) return;
      setDesk(fresh);
      setLoadError("");
    } catch (cause) {
      if (!quiet && mine === lastLoad.current) setLoadError(errorText(cause));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // Purchase orders move on in Zoho, so while this page is on screen it asks every minute and shows what changed, including changes
  // other admins made. The server makes no Zoho call when nothing is raised, and several open pages share one check.
  useEffect(() => {
    if (STATIC_DATA_MODE) return;
    let active = true, checking = false;
    const check = async () => {
      if (document.visibilityState !== "visible" || checking) return;
      checking = true;
      try {
        const { pollRiceSamplePos } = await import("@/lib/rice-samples.functions");
        const result = await pollRiceSamplePos();
        if (!active) return;
        for (const freed of result.freed) toast.warning(`${freed.number} was ${PO_DEATH_WORDS[freed.reason]} in Zoho`, { description: "The sample is back in play, with its history." });
        await load(true);
      } catch {
        // The next check tries again.
      } finally {
        checking = false;
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), PO_CHECK_MS);
    const onVisible = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const tests = useMemo(() => testsBySample(desk?.tests ?? []), [desk]);
  const pos = useMemo(() => new Map((desk?.pos ?? []).map((po) => [po.sample_id, po])), [desk]);
  const samples = useMemo(() => desk?.samples ?? [], [desk]);
  const onCards = useMemo(() => samples.filter((s) => !s.deleted_at), [samples]);
  const counts = useMemo(() => ({
    inPlay: onCards.filter((s) => inPlay(s.status)).length,
    arrived: onCards.filter((s) => s.status === "arrived").length,
    tested: onCards.filter((s) => s.status === "tested").length,
    selected: onCards.filter((s) => s.status === "selected").length,
    out: onCards.filter((s) => s.status === "discarded" || s.status === "unavailable").length,
  }), [onCards]);
  const shown = useMemo(() => {
    const term = search.trim().toLowerCase();
    const list = samples.filter((s) => (filter === "deleted" ? Boolean(s.deleted_at) : !s.deleted_at && matchesFilter(s.status, filter)) && (!term || `${s.variety} ${s.method} ${s.party_name} ${s.seller_name}`.toLowerCase().includes(term)));
    const measured = list.filter((s) => testMatchesMeasures(latestTest(tests.get(s.id) ?? []), measures));
    return sortSamples(measured, sort, tests);
  }, [samples, filter, search, sort, tests, measures]);
  const compared = useMemo(() => compareIds.map((id) => onCards.find((s) => s.id === id)).filter((s): s is RiceSample => Boolean(s)), [compareIds, onCards]);
  const openList = (next: ListFilter) => { setFilter(next); scrollToSection("rice-sample-list"); };
  // The purchase order screen must see the sample as it is now, not as it was when the screen opened.
  const buyingNow = buying ? samples.find((sample) => sample.id === buying.id) ?? buying : null;
  const toggleCompare = (id: string) => setCompareIds((current) => current.includes(id) ? current.filter((value) => value !== id) : current.length >= 4 ? (toast.error("Compare up to 4 samples at a time"), current) : [...current, id]);

  const setMode = async (issueOnCreate: boolean) => {
    if (STATIC_DATA_MODE) { toast("Preview only: nothing is saved"); return; }
    setSavingMode(true);
    const { error } = await supabase.from("settings").upsert({ key: RICE_PO_SETTINGS_KEY, value: { issueOnCreate } as unknown as Json, is_public: false, updated_at: new Date().toISOString() });
    setSavingMode(false);
    if (error) { toast.error("Could not save the setting", { description: error.message }); return; }
    toast.success(issueOnCreate ? "New purchase orders will be issued straight away" : "New purchase orders will be created as Draft");
    await load();
  };

  return (
    <PanelLayout items={adminNav} tone="admin" title="Rice Samples" subtitle="Record samples, cook and test them, compare them, and raise the Zoho purchase order for the one you buy">
      <div className="mb-6 grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-5">
        <StatCard compact onClick={() => openList("in_play")} label="In play" value={String(counts.inPlay)} icon={FlaskConical} highlight />
        <StatCard compact onClick={() => openList("arrived")} label="Waiting for a cook test" value={String(counts.arrived)} icon={ScrollText} />
        <StatCard compact onClick={() => openList("tested")} label="Tested" value={String(counts.tested)} icon={Star} />
        <StatCard compact onClick={() => openList("selected")} label="PO raised" value={String(counts.selected)} icon={ShoppingCart} />
        <StatCard compact onClick={() => openList("out")} label="Discarded or unavailable" value={String(counts.out)} icon={XCircle} />
      </div>

      {compared.length >= 2 && (
        <Panel id="rice-compare" title={`Side by side (${compared.length})`} className="mb-6" action={<Button size="sm" variant="outline" onClick={() => setCompareIds([])}>Clear</Button>}>
          <CompareTable samples={compared} tests={tests} onTest={setTesting} onBuy={setBuying} pos={pos} />
        </Panel>
      )}

      <Panel
        title="Samples"
        className="mb-6"
        action={<Button className="h-10 bg-navy text-white hover:bg-navy/90" onClick={() => setSampleForm(emptySampleForm())}><Plus className="mr-1 h-4 w-4" />Add sample</Button>}
      >
        <div id="rice-sample-list" className="scroll-mt-36" />
        <div className="mb-4 grid gap-2 sm:grid-cols-3">
          <div className="grid gap-1"><Label className="text-[11px] text-slate">Show</Label>
            <select aria-label="Show samples" className="h-10 min-w-0 rounded-md border border-input bg-white px-2 text-sm" value={filter} onChange={(event) => setFilter(event.target.value as ListFilter)}>
              {(["in_play", "all", "arrived", "tested", "selected", "out", "unavailable", "discarded", "deleted"] as ListFilter[]).map((key) => <option key={key} value={key}>{FILTER_LABELS[key]}</option>)}
            </select>
          </div>
          <div className="grid gap-1"><Label className="text-[11px] text-slate">Sort</Label>
            <select aria-label="Sort samples" className="h-10 min-w-0 rounded-md border border-input bg-white px-2 text-sm" value={sort} onChange={(event) => setSort(event.target.value as SampleSort)}>
              {(Object.keys(SORT_LABELS) as SampleSort[]).map((key) => <option key={key} value={key}>{SORT_LABELS[key]}</option>)}
            </select>
          </div>
          <div className="grid gap-1"><Label className="text-[11px] text-slate">Search</Label>
            <Input className={inputClass} placeholder="Variety, broker or seller" value={search} onChange={(event) => setSearch(event.target.value)} />
          </div>
        </div>
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="grid gap-1"><Label className="text-[11px] text-slate">Moisture from %</Label>
            <Input aria-label="Moisture from percent" className={inputClass} type="number" min="0" max="100" step="0.01" value={measures.moistureFrom} onChange={(event) => setMeasures((m) => ({ ...m, moistureFrom: event.target.value }))} />
          </div>
          <div className="grid gap-1"><Label className="text-[11px] text-slate">Moisture to %</Label>
            <Input aria-label="Moisture to percent" className={inputClass} type="number" min="0" max="100" step="0.01" value={measures.moistureTo} onChange={(event) => setMeasures((m) => ({ ...m, moistureTo: event.target.value }))} />
          </div>
          <div className="grid gap-1"><Label className="text-[11px] text-slate">Glazing</Label>
            <select aria-label="Filter by glazing" className="h-10 min-w-0 rounded-md border border-input bg-white px-2 text-sm" value={measures.glazing} onChange={(event) => setMeasures((m) => ({ ...m, glazing: event.target.value }))}>
              <option value="">Any glazing</option>
              {glazingChoices([...tests.values()].flat()).map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </div>
          <div className="flex items-end">
            <Button type="button" variant="outline" className="h-10 w-full" disabled={!measures.moistureFrom && !measures.moistureTo && !measures.glazing} onClick={() => setMeasures(NO_MEASURE_FILTER)}>Clear test filters</Button>
          </div>
        </div>
        {filter !== "in_play" && filter !== "all" && <FilterNote label={FILTER_LABELS[filter]} onClear={() => setFilter("all")} />}
        {loadError ? (
          <p className="text-sm text-danger">Samples could not be loaded: {loadError}</p>
        ) : !desk ? (
          <p className="text-sm text-slate">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="text-sm text-slate">{onCards.length === 0 && filter !== "deleted" ? "No samples yet. Add the first one when a sample arrives." : "No samples match this view."}</p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {shown.map((sample) => (
              <SampleCard
                key={sample.id}
                sample={sample}
                tests={tests.get(sample.id) ?? []}
                po={pos.get(sample.id) ?? null}
                zoho={desk.zoho}
                compared={compareIds.includes(sample.id)}
                onCompare={() => toggleCompare(sample.id)}
                onTest={() => setTesting(sample)}
                onBuy={() => setBuying(sample)}
                onEdit={() => setSampleForm(formFromSample(sample, true))}
                onSimilar={() => setSampleForm(formFromSample(sample, false))}
                onStatus={(action) => setChanging({ sample, action })}
                onHistory={() => setHistoryOf(sample)}
                onCancelPo={(po) => setCancelling({ sample, po })}
                onChanged={load}
              />
            ))}
          </div>
        )}
      </Panel>

      {desk && (
        <Panel title="Purchase order setting">
          <p className="mb-3 text-sm text-slate">
            New purchase orders are created in Zoho as <strong className="text-navy">{desk.issueOnCreate ? "Issued" : "Draft"}</strong>.
            {desk.issueOnCreate ? " Zoho does not send them to the vendor by itself: send each one from Zoho." : " Someone checks the Draft in Zoho, issues it and sends it to the vendor from there."}
          </p>
          <Button variant="outline" className="h-10" disabled={savingMode} onClick={() => void setMode(!desk.issueOnCreate)}>
            {desk.issueOnCreate ? "Change to Draft" : "Change to issue straight away"}
          </Button>
        </Panel>
      )}

      {sampleForm && desk && <SampleFormDialog form={sampleForm} onForm={setSampleForm} samples={samples} onClose={() => setSampleForm(null)} onSaved={load} />}
      {testing && desk && <TestDialog glazingOptions={glazingChoices([...tests.values()].flat())} sample={testing} adminName={desk.adminName} onClose={() => setTesting(null)} onSaved={load} />}
      {changing && <StatusDialog sample={changing.sample} action={changing.action} onClose={() => setChanging(null)} onSaved={load} />}
      {cancelling && <CancelPoDialog sample={cancelling.sample} po={cancelling.po} onClose={() => setCancelling(null)} onDone={load} />}
      {buyingNow && desk && <BuyDialog sample={buyingNow} tests={tests.get(buyingNow.id) ?? []} desk={desk} po={pos.get(buyingNow.id) ?? null} onReload={load} onClose={() => { setBuying(null); void load(); }} />}
      {compared.length >= 2 && (
        <button type="button" className="fixed inset-x-4 bottom-4 z-40 h-12 rounded-lg bg-navy text-sm font-bold text-white shadow-lg sm:inset-x-auto sm:right-6 sm:px-6" onClick={() => scrollToSection("rice-compare")}>
          Compare {compared.length} samples
        </button>
      )}
      {historyOf && desk && <HistoryDialog sample={historyOf} tests={tests.get(historyOf.id) ?? []} events={desk.events.filter((event) => event.sample_id === historyOf.id)} po={pos.get(historyOf.id) ?? null} onClose={() => setHistoryOf(null)} />}
    </PanelLayout>
  );
}

function ContactLinks({ phone }: { phone: string }) {
  const links = phoneLinks(phone);
  return (
    <span className="inline-flex flex-wrap gap-2">
      <a href={links.tel} className="inline-flex h-11 items-center gap-1 rounded-md border border-border bg-white px-2.5 text-xs font-semibold text-navy hover:border-gold"><Phone className="h-3.5 w-3.5" />Call</a>
      {links.whatsapp && <a href={links.whatsapp} target="_blank" rel="noreferrer" className="inline-flex h-11 items-center gap-1 rounded-md border border-border bg-white px-2.5 text-xs font-semibold text-navy hover:border-gold"><MessageCircle className="h-3.5 w-3.5" />WhatsApp</a>}
    </span>
  );
}

const SampleBadge = ({ status }: { status: SampleStatus }) => (
  <span className={cn("inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold", STATUS_TONE[status])}>{STATUS_LABELS[status]}</span>
);

function SampleCard({ sample, tests, po, zoho, compared, onCompare, onTest, onBuy, onEdit, onSimilar, onStatus, onHistory, onCancelPo, onChanged }: {
  sample: RiceSample; tests: RiceTest[]; po: RicePo | null; zoho: RiceDesk["zoho"]; compared: boolean; onCompare: () => void; onTest: () => void; onBuy: () => void; onEdit: () => void; onSimilar: () => void;
  onStatus: (action: StatusAction) => void; onHistory: () => void; onCancelPo: (po: RicePo) => void; onChanged: () => Promise<void>;
}) {
  const latest = latestTest(tests);
  const pending = po?.state === "sending" || po?.state === "uncertain";
  const deleted = Boolean(sample.deleted_at);
  const open = inPlay(sample.status) && !pending && !deleted;
  // A live or on-its-way purchase order keeps the card: the database refuses too.
  const canDelete = !deleted && !pending && sample.status !== "selected";
  return (
    <article className="min-w-0 rounded-lg border border-border bg-white p-4">
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="break-words text-base font-bold text-navy">{sample.variety}{sample.method ? ` · ${sample.method}` : ""}</h3>
          <p className="text-xs text-slate"><strong className="text-navy">{sampleLabel(sample.sample_no)}</strong> · Arrived {day(sample.arrival_date)}</p>
        </div>
        <SampleBadge status={sample.status} />
      </header>

      <div className="mt-3 grid grid-cols-3 gap-2">
        <div className="rounded-md bg-ivory px-2 py-2">
          <p className="text-[10px] font-medium text-slate uppercase">Price / quintal</p>
          <p className="text-sm font-bold text-navy">{inrPrecise(sample.price_per_qntl)}</p>
          <p className="text-[10px] text-slate">{inrPrecise(sample.price_per_qntl / 100)} per kg</p>
        </div>
        <div className="rounded-md bg-ivory px-2 py-2">
          <p className="text-[10px] font-medium text-slate uppercase">Available</p>
          <p className="text-sm font-bold text-navy">{qty(sample.quantity_qntl)}</p>
          <p className="text-[10px] text-slate">quintal</p>
        </div>
        <div className="rounded-md bg-ivory px-2 py-2">
          <p className="text-[10px] font-medium text-slate uppercase">Score</p>
          <p className={cn("text-sm font-bold", latest ? "text-navy" : "text-slate")}>{latest ? `${latest.score}/10` : "Not tested"}</p>
          <p className="text-[10px] text-slate">{tests.length} {tests.length === 1 ? "test" : "tests"}</p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 break-words text-sm text-navy">
          <span className="text-slate">{PARTY_LABEL[sample.party_role]}:</span> <strong>{sample.party_name}</strong>
          {sample.seller_name && <span className="block text-xs text-slate">Seller: {sample.seller_name}</span>}
        </p>
        <ContactLinks phone={sample.party_phone} />
      </div>

      {latest && (
        <p className="mt-3 rounded-md bg-navy/5 px-2 py-1.5 text-xs text-navy">
          <span className="font-semibold">Latest test:</span> Grain {GRAIN_LABELS[latest.grain].toLowerCase()}, swelling {SWELLING_LABELS[latest.swelling].toLowerCase()}, taste {TASTE_LABELS[latest.taste].toLowerCase()}, {BROKEN_LABELS[latest.broken].toLowerCase()} broken. {latest.tested_by_name}, {when(latest.tested_at)}.
          {(latest.moisture_percent !== null || latest.glazing) && <span className="mt-1 block">{measureText(latest)}</span>}
          {latest.taste === "off" && <span className="mt-1 block font-semibold text-danger">Off taste or smell</span>}
          {latest.notes && <span className="mt-1 block break-words text-slate">{latest.notes}</span>}
        </p>
      )}
      {sample.notes && <p className="mt-2 break-words text-xs text-slate">{sample.notes}</p>}
      {(sample.status === "discarded" || sample.status === "unavailable") && (
        <p className="mt-2 break-words rounded-md bg-danger/5 px-2 py-1.5 text-xs text-danger">{STATUS_LABELS[sample.status]}{sample.status_reason ? `: ${sample.status_reason}` : ""} ({when(sample.status_changed_at)})</p>
      )}

      {deleted && (
        <p className="mt-2 break-words rounded-md bg-slate/10 px-2 py-1.5 text-xs text-navy">
          <strong>Deleted</strong> by {sample.deleted_by_name || "an admin"}{sample.deleted_reason ? `: ${sample.deleted_reason}` : ""}. It shows nowhere else, and its history is kept.
        </p>
      )}
      {po && <PoPanel key={po.attempt_id} sample={sample} po={po} zoho={zoho} onChanged={onChanged} onCancel={() => onCancelPo(po)} />}

      <div className="mt-3 flex flex-wrap gap-2">
        {open && <Button className="h-10 flex-1 bg-navy text-white hover:bg-navy/90" onClick={onTest}><FlaskConical className="mr-1 h-4 w-4" />Add cook test</Button>}
        {open && <Button className="h-10 flex-1 bg-gold text-midnight hover:bg-gold/90" onClick={onBuy}><ShoppingCart className="mr-1 h-4 w-4" />Buy this</Button>}
        {!deleted && (sample.status === "discarded" || sample.status === "unavailable") && <Button variant="outline" className="h-10" onClick={() => onStatus("reopen")}>Reopen</Button>}
        {deleted && <Button variant="outline" className="h-10" onClick={() => onStatus("restore")}>Restore card</Button>}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs font-semibold">
        {!deleted && <label className="inline-flex min-h-11 items-center gap-1.5 text-navy"><input type="checkbox" className="h-5 w-5" checked={compared} onChange={onCompare} />Compare</label>}
        <button type="button" className="inline-flex min-h-11 items-center gap-1 text-navy hover:underline" onClick={onHistory}><History className="h-3.5 w-3.5" />History</button>
        {open && <button type="button" className="min-h-11 text-navy hover:underline" onClick={onEdit}>Edit</button>}
        <button type="button" className="min-h-11 text-navy hover:underline" onClick={onSimilar}>Add similar</button>
        {open && <button type="button" className="min-h-11 text-amber-700 hover:underline" onClick={() => onStatus("unavailable")}>Mark unavailable</button>}
        {open && <button type="button" className="min-h-11 text-danger hover:underline" onClick={() => onStatus("discard")}>Discard</button>}
        {canDelete && <button type="button" className="min-h-11 text-danger hover:underline" onClick={() => onStatus("delete")}>Delete card</button>}
      </div>
    </article>
  );
}

/** What the desk knows about the sample's purchase order. Once raised it is read-only: Zoho is in control. */
function PoPanel({ sample, po, zoho, onChanged, onCancel }: { sample: RiceSample; po: RicePo; zoho: RiceDesk["zoho"]; onChanged: () => Promise<void>; onCancel: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<RaiseResult | null>(null);
  const [handCheck, setHandCheck] = useState(false);
  const releaseByHand = async () => {
    setBusy(true);
    try {
      const { releaseRiceSampleByHand } = await import("@/lib/rice-samples.functions");
      const result = await releaseRiceSampleByHand({ data: { sampleId: sample.id, reference: po.reference, confirmed: true } });
      if (!result.ok) toast.error(result.message);
      await onChanged();
    } catch (cause) {
      toast.error("Could not save that", { description: errorText(cause) });
    } finally {
      setBusy(false);
    }
  };
  const check = async () => {
    setBusy(true);
    try {
      const { checkRiceSamplePurchaseOrder } = await import("@/lib/rice-samples.functions");
      setNote(await checkRiceSamplePurchaseOrder({ data: { sampleId: sample.id } }));
      await onChanged();
    } catch (cause) {
      toast.error("Could not check Zoho", { description: errorText(cause) });
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () => {
    setBusy(true);
    try {
      const { refreshRiceSamplePoStatus } = await import("@/lib/rice-samples.functions");
      const result = await refreshRiceSamplePoStatus({ data: { sampleId: sample.id } });
      if (!result.ok) toast.error(result.message);
      else if (result.message) toast.warning(result.message);
      await onChanged();
    } catch (cause) {
      toast.error("Could not check Zoho", { description: errorText(cause) });
    } finally {
      setBusy(false);
    }
  };

  if (po.state === "dead") return <RetiredList po={po} prominent={!sample.deleted_at && inPlay(sample.status)} />;
  if (po.state === "rejected") {
    return (
      <>
        <p className="mt-3 break-words rounded-md bg-danger/5 px-2 py-1.5 text-xs text-danger"><strong>The last attempt did not create a purchase order.</strong> {po.last_error}</p>
        <RetiredList po={po} />
      </>
    );
  }
  if (po.state === "sending" || po.state === "uncertain") {
    return (
      <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
        <p className="flex items-start gap-1.5 font-semibold"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{po.state === "sending" ? `${po.claimed_by_name || "An admin"} started this purchase order ${when(po.claimed_at)}.` : "It is not known yet whether Zoho has this purchase order."}</p>
        {po.last_error && <p className="mt-1 break-words">{po.last_error}</p>}
        {note && note.kind !== "raised" && <p className="mt-1 break-words font-semibold">{note.message}</p>}
        <Button className="mt-2 h-10 bg-navy text-white hover:bg-navy/90" disabled={busy} onClick={() => void check()}>{busy ? "Checking…" : "Check Zoho"}</Button>
        {note?.kind === "uncertain" && note.searchIncomplete && (
          <div className="mt-2 rounded-md bg-white p-2">
            <p className="break-all">In Zoho, search Purchase Orders for this reference: <strong>{po.reference}</strong></p>
            {!handCheck ? (
              <Button variant="outline" className="mt-2 h-10" onClick={() => setHandCheck(true)}>I searched Zoho: it is not there</Button>
            ) : (
              <>
                <p className="mt-2 font-semibold">This frees the sample and goes on its history under your name. If the purchase order does exist, raising again makes a second one.</p>
                <div className="mt-2 flex gap-2">
                  <Button variant="outline" className="h-10 flex-1" onClick={() => setHandCheck(false)}>No</Button>
                  <Button className="h-10 flex-1 bg-navy text-white hover:bg-navy/90" disabled={busy} onClick={() => void releaseByHand()}>Yes, it is not there</Button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    );
  }
  const url = zoho && po.zoho_po_id ? zohoPoUrl(zoho.region, zoho.organizationId, po.zoho_po_id) : "";
  return (
    <div className="mt-3 rounded-md border border-success/30 bg-success/5 p-3 text-xs text-navy">
      <p className="flex flex-wrap items-center gap-1.5 text-sm font-bold"><CheckCircle2 className="h-4 w-4 text-success" />{po.zoho_po_number || "Purchase order"}<span className="font-medium text-slate">· {po.zoho_gone ? "Deleted in Zoho" : zohoStatusLabel(po.zoho_po_status)}</span></p>
      <p className="mt-1 break-words text-slate">
        {po.snapshot.vendorName} ({PARTY_LABEL[po.snapshot.vendorRole].toLowerCase()}) · {qty(po.snapshot.quantityQntl)} quintal at {inrPrecise(po.snapshot.ratePerQntl)} · to {po.snapshot.branchName}
        {po.zoho_tax_total !== null && po.snapshot.taxKind !== "none" ? ` · GST in Zoho ${inrPrecise(po.zoho_tax_total)}` : ""}
        {po.zoho_total !== null ? ` · total in Zoho ${inrPrecise(po.zoho_total)}` : ""}
      </p>
      {po.snapshot.taxKind === "none" && <p className="mt-1 font-semibold">{NO_GST_WORDS}</p>}
      <p className="mt-1 text-slate">Raised by {po.raised_by_name || "an admin"}{po.raised_at ? `, ${when(po.raised_at)}` : ""}.{po.zoho_gone || poDeathReason(po.zoho_po_status) ? "" : " Carry on in Zoho; this sample is locked here."}{po.zoho_checked_at ? ` Status checked ${when(po.zoho_checked_at)}.` : ""}</p>
      {po.zoho_gone && <p className="mt-1 font-semibold text-danger">Zoho no longer has this purchase order. This updates by itself once Zoho has been checked.</p>}
      {po.differences.map((difference) => <p key={difference} className="mt-1 font-semibold text-danger">{difference} Check it in Zoho.</p>)}
      {po.duplicates.length > 0 && <p className="mt-1 font-semibold text-danger">Zoho also has {po.duplicates.map((other) => other.number || other.id).join(", ")} with this sample's reference. Open Zoho and delete the extra one.</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {url && <a href={url} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center gap-1 rounded-md bg-navy px-3 text-xs font-semibold text-white hover:bg-navy/90"><ExternalLink className="h-3.5 w-3.5" />Open in Zoho</a>}
        <Button variant="outline" className="h-10" disabled={busy} onClick={() => void refresh()}>{busy ? "Checking…" : "Refresh status"}</Button>
        {canCancelPo(po.zoho_po_status) && !po.zoho_gone && <Button variant="outline" className="h-10 text-danger" onClick={onCancel}>Cancel in Zoho</Button>}
      </div>
      <p className="mt-2 text-slate">{canCancelPo(po.zoho_po_status) ? "To delete this card or raise another, cancel or remove this purchase order first: the card updates by itself." : poDeathReason(po.zoho_po_status) ? "The card frees itself once Zoho has been checked and nothing else alive holds this reference." : "Rice has been received or billed on this purchase order, so the card stays while Zoho holds it."}</p>
      <RetiredList po={po} />
    </div>
  );
}

/** The sample's earlier purchase orders, each dead in Zoho. Prominent straight after one died, when the sample has just come back into play. */
function RetiredList({ po, prominent = false }: { po: RicePo; prominent?: boolean }) {
  const retired = [...po.retired_pos].reverse();
  if (!retired.length) return null;
  const line = (old: RetiredPo) => old.reason === "duplicate" ? `${old.number || old.id} was a duplicate of it` : `${old.number || old.id} was ${PO_DEATH_WORDS[old.reason] ?? old.reason} in Zoho${old.retired_at ? `, seen ${when(old.retired_at)}` : ""}`;
  if (!prominent) return <p className="mt-2 break-words text-xs text-slate">Earlier: {retired.map(line).join("; ")}.</p>;
  const [latest, ...older] = retired as [RetiredPo, ...RetiredPo[]];
  return (
    <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
      <p className="flex items-start gap-1.5 font-semibold"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{line(latest)}.</p>
      {latest.note && <p className="mt-1 break-words">{latest.note}</p>}
      <p className="mt-1">This sample is back in play. You can raise a new purchase order, which gets its own reference, or discard, mark unavailable or delete the card.</p>
      {older.length > 0 && <p className="mt-1 break-words text-slate">Before that: {older.map(line).join("; ")}.</p>}
    </div>
  );
}

/** Zoho's own Mark as Cancelled. Nothing is deleted from Zoho, and the sample is only freed once Zoho shows it as cancelled. */
function CancelPoDialog({ sample, po, onClose, onDone }: { sample: RiceSample; po: RicePo; onClose: () => void; onDone: () => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const cancel = async () => {
    if (reason.trim().length < 3) { toast.error("Enter why this purchase order is cancelled"); return; }
    setBusy(true);
    setMessage("");
    try {
      const { cancelRiceSamplePurchaseOrder } = await import("@/lib/rice-samples.functions");
      const result = await cancelRiceSamplePurchaseOrder({ data: { sampleId: sample.id, poId: po.zoho_po_id, reason: reason.trim(), confirmed: true } });
      if (result.kind === "cancelled") {
        toast.success(`${result.number} cancelled in Zoho`, { description: result.settling ? "This card updates by itself within a minute." : "The sample is back in play." });
        onClose();
      } else {
        setMessage(result.message);
      }
      await onDone();
    } catch (cause) {
      setMessage(`Zoho may or may not have taken this (${errorText(cause)}). This page shows the answer once Zoho has been checked.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className={dialogClass} {...keepOpen}>
        <DialogHeader>
          <DialogTitle>Cancel {po.zoho_po_number}?</DialogTitle>
          <DialogDescription>{sampleLabel(sample.sample_no)}: {sample.variety}{sample.method ? ` · ${sample.method}` : ""}. This marks it Cancelled in the official Zoho books. Nothing is deleted from Zoho, and it stays there on record.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1"><Label className="text-xs text-slate">Why (kept on this sample's history, not sent to Zoho)</Label>
          <Textarea rows={2} className="bg-white text-base sm:text-sm" value={reason} onChange={(event) => setReason(event.target.value)} />
        </div>
        {message && <p className="break-words rounded-md bg-amber-50 px-2 py-1.5 text-xs font-medium text-amber-800">{message}</p>}
        <div className="flex gap-2">
          <Button variant="outline" className="h-11 flex-1" disabled={busy} onClick={onClose}>Keep it</Button>
          <Button className="h-11 flex-1 bg-danger text-white hover:bg-danger/90" disabled={busy} onClick={() => void cancel()}>{busy ? "Cancelling…" : "Cancel in Zoho"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CompareTable({ samples, tests, pos, onTest, onBuy }: { samples: RiceSample[]; tests: Map<string, RiceTest[]>; pos: Map<string, RicePo>; onTest: (sample: RiceSample) => void; onBuy: (sample: RiceSample) => void }) {
  const best = bestInComparison(samples, tests);
  const cell = (label: string, value: ReactNode, good = false) => (
    <div className={cn("border-t border-border py-2 first:border-t-0", good && "rounded bg-emerald-50 px-1.5")}>
      <p className="text-[10px] font-medium text-slate uppercase">{label}{good ? " · best" : ""}</p>
      <div className="text-sm font-semibold break-words text-navy">{value}</div>
    </div>
  );
  return (
    <div className="-mx-1 overflow-x-auto px-1 pb-1">
      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${samples.length}, minmax(150px, 1fr))` }}>
        {samples.map((sample) => {
          const list = tests.get(sample.id) ?? [];
          const latest = latestTest(list);
          const po = pos.get(sample.id);
          const open = inPlay(sample.status) && po?.state !== "sending" && po?.state !== "uncertain";
          return (
            <div key={sample.id} className="min-w-0 rounded-md border border-border bg-white p-2.5">
              <p className="text-sm font-bold break-words text-navy">{sample.variety}</p>
              <p className="mb-1 text-xs text-slate"><strong>{sampleLabel(sample.sample_no)}</strong> · {sample.method || "—"}</p>
              <SampleBadge status={sample.status} />
              <div className="mt-2">
                {cell("Price / quintal", inrPrecise(sample.price_per_qntl), best.bestPrice.has(sample.id))}
                {cell("Score", latest ? `${latest.score}/10` : "Not tested", best.bestScore.has(sample.id))}
                {cell("Available", `${qty(sample.quantity_qntl)} quintal`)}
                {cell("Grain", latest ? GRAIN_LABELS[latest.grain] : "—")}
                {cell("Swelling", latest ? SWELLING_LABELS[latest.swelling] : "—")}
                {cell("Taste and smell", latest ? <span className={latest.taste === "off" ? "text-danger" : ""}>{TASTE_LABELS[latest.taste]}</span> : "—")}
                {cell("Broken grains", latest ? BROKEN_LABELS[latest.broken] : "—")}
                {cell("Moisture", latest && latest.moisture_percent !== null ? `${Number(latest.moisture_percent)}%` : "—")}
                {cell("Glazing", latest?.glazing || "—")}
                {cell("Tests", String(list.length))}
                {cell("Arrived", day(sample.arrival_date))}
                {cell(PARTY_LABEL[sample.party_role], sample.party_name)}
                {latest?.notes ? cell("Test notes", <span className="font-normal">{latest.notes}</span>) : null}
              </div>
              <div className="mt-2 grid gap-1.5">
                <ContactLinks phone={sample.party_phone} />
                {open && <Button variant="outline" className="h-10" onClick={() => onTest(sample)}>Add test</Button>}
                {open && <Button className="h-10 bg-gold text-midnight hover:bg-gold/90" onClick={() => onBuy(sample)}>Buy this</Button>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const dialogClass = "max-h-[92vh] w-[calc(100vw-1.5rem)] max-w-lg overflow-y-auto rounded-lg p-4 sm:p-6";

/** The variety and method choices for the form: the rice master list, or earlier samples if it can't be read. */
const loadRiceOptions = async (samples: RiceSample[]) => {
  const codes = await listActiveRiceOptions().catch(() => []);
  return riceTextOptions(codes.length ? codes.map((code) => ({ variety: code.varietyName, method: code.methodName })) : samples);
};

function SampleFormDialog({ form, onForm, samples, onClose, onSaved }: { form: SampleForm; onForm: (form: SampleForm) => void; samples: RiceSample[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [saving, setSaving] = useState(false);
  const [options, setOptions] = useState(() => riceTextOptions(samples));
  useEffect(() => { void loadRiceOptions(samples).then(setOptions); }, [samples]);
  const price = num(form.price);
  const warning = priceUnitWarning(price);
  const set = (patch: Partial<SampleForm>) => onForm({ ...form, ...patch });
  const save = async () => {
    if (!form.variety.trim()) { toast.error("Enter the rice variety"); return; }
    if (!(price > 0)) { toast.error("Enter the purchase price per quintal"); return; }
    if (!(num(form.quantity) > 0)) { toast.error("Enter the quantity available in quintals"); return; }
    if (!form.partyName.trim()) { toast.error(`Enter the ${form.partyRole}'s name`); return; }
    if (!isSamplePhone(form.partyPhone)) { toast.error("Enter a phone number with 10 digits"); return; }
    if (STATIC_DATA_MODE) { toast("Preview only: nothing is saved"); onClose(); return; }
    setSaving(true);
    const { error } = await supabase.rpc("rice_sample_save", {
      _id: form.id, _arrival_date: form.arrivalDate, _variety: form.variety, _method: form.method, _price_per_qntl: price, _quantity_qntl: num(form.quantity),
      _party_role: form.partyRole, _party_name: form.partyName, _party_phone: form.partyPhone, _seller_name: form.partyRole === "broker" ? form.sellerName : "", _notes: form.notes,
    });
    setSaving(false);
    if (error) { toast.error("Could not save the sample", { description: error.message }); return; }
    toast.success(form.id ? "Sample updated" : "Sample added");
    onClose();
    await onSaved();
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className={dialogClass} {...keepOpen}>
        <DialogHeader>
          <DialogTitle>{form.id ? "Edit sample" : "Add sample"}</DialogTitle>
          <DialogDescription>Prices are per quintal (100 kg), before GST.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid min-w-0 gap-1"><Label className="text-xs text-slate">Rice variety</Label>
              <Input className={inputClass} list="rice-varieties" value={form.variety} onChange={(event) => set({ variety: event.target.value })} />
              <datalist id="rice-varieties">{options.varieties.map((value) => <option key={value} value={value} />)}</datalist>
            </div>
            <div className="grid min-w-0 gap-1"><Label className="text-xs text-slate">Method</Label>
              <Input className={inputClass} list="rice-methods" placeholder="Raw, Steam…" value={form.method} onChange={(event) => set({ method: event.target.value })} />
              <datalist id="rice-methods">{options.methods.map((value) => <option key={value} value={value} />)}</datalist>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid min-w-0 gap-1"><Label className="text-xs text-slate">Price (₹ per quintal)</Label>
              <Input className={inputClass} inputMode="decimal" value={form.price} onChange={(event) => set({ price: event.target.value })} />
              {price > 0 && !warning && <p className="text-[11px] text-slate">{inrPrecise(price / 100)} per kg</p>}
            </div>
            <div className="grid min-w-0 gap-1"><Label className="text-xs text-slate">Available (quintal)</Label>
              <Input className={inputClass} inputMode="decimal" value={form.quantity} onChange={(event) => set({ quantity: event.target.value })} />
            </div>
          </div>
          {warning && <p className="rounded-md bg-amber-50 px-2 py-1.5 text-xs font-medium text-amber-800">{warning}</p>}
          <div className="grid gap-1"><Label className="text-xs text-slate">Arrived on</Label>
            <Input type="date" className={inputClass} max={todayLocal()} value={form.arrivalDate} onChange={(event) => set({ arrivalDate: event.target.value })} />
          </div>
          <div className="grid gap-1"><Label className="text-xs text-slate">Who brought it</Label>
            <div className="grid grid-cols-2 gap-2">
              {(["broker", "seller"] as PartyRole[]).map((role) => (
                <button key={role} type="button" className={cn("h-10 rounded-md border text-sm font-semibold", form.partyRole === role ? "border-navy bg-navy text-white" : "border-border bg-white text-navy")} onClick={() => set({ partyRole: role })}>{PARTY_LABEL[role]}</button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid min-w-0 gap-1"><Label className="text-xs text-slate">{PARTY_LABEL[form.partyRole]}'s name</Label>
              <Input className={inputClass} value={form.partyName} onChange={(event) => set({ partyName: event.target.value })} />
            </div>
            <div className="grid min-w-0 gap-1"><Label className="text-xs text-slate">Phone</Label>
              <Input className={inputClass} inputMode="tel" value={form.partyPhone} onChange={(event) => set({ partyPhone: event.target.value })} />
            </div>
          </div>
          {form.partyRole === "broker" && (
            <div className="grid gap-1"><Label className="text-xs text-slate">Seller or mill behind the broker (if known)</Label>
              <Input className={inputClass} value={form.sellerName} onChange={(event) => set({ sellerName: event.target.value })} />
            </div>
          )}
          <div className="grid gap-1"><Label className="text-xs text-slate">Notes</Label>
            <Textarea rows={2} className="bg-white text-base sm:text-sm" value={form.notes} onChange={(event) => set({ notes: event.target.value })} />
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="h-11 flex-1" onClick={onClose}>Cancel</Button>
            <Button className="h-11 flex-1 bg-navy text-white hover:bg-navy/90" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save sample"}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T | ""; options: Record<T, string>; onChange: (value: T) => void }) {
  const keys = Object.keys(options) as T[];
  return (
    <div className="grid gap-1">
      <Label className="text-xs text-slate">{label}</Label>
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${keys.length}, minmax(0, 1fr))` }}>
        {keys.map((key) => (
          <button key={key} type="button" aria-pressed={value === key} className={cn("min-h-11 rounded-md border px-1 text-xs font-semibold", value === key ? "border-navy bg-navy text-white" : "border-border bg-white text-navy")} onClick={() => onChange(key)}>{options[key]}</button>
        ))}
      </div>
    </div>
  );
}

/**
 * Five taps and it is done, in the godown. The fields that decide a rice purchase: the score (what the list sorts by), whether cooked
 * grains stay separate (what customers notice first), swelling (how far a bag goes), taste and smell (off means old or badly stored,
 * whatever the score), and broken grains (what the price should reflect). The reasoning is in docs/rice-samples.md.
 */
function measureText(test: Pick<RiceTest, "moisture_percent" | "glazing">) {
  return [test.moisture_percent !== null ? `Moisture ${Number(test.moisture_percent)}%` : "", test.glazing ? `Glazing ${test.glazing}` : ""].filter(Boolean).join(", ");
}

function TestDialog({ sample, adminName, glazingOptions, onClose, onSaved }: { sample: RiceSample; glazingOptions: string[]; adminName: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const [score, setScore] = useState(0);
  const [grain, setGrain] = useState<GrainResult | "">("");
  const [swelling, setSwelling] = useState<SwellingResult | "">("");
  const [taste, setTaste] = useState<TasteResult | "">("");
  const [broken, setBroken] = useState<BrokenResult | "">("");
  const [moisture, setMoisture] = useState("");
  const [glazing, setGlazing] = useState("");
  const [notes, setNotes] = useState("");
  const [testedBy, setTestedBy] = useState(adminName);
  const [testedAt, setTestedAt] = useState(nowLocal());
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!score) { toast.error("Choose a score from 1 to 10"); return; }
    if (!grain || !swelling || !taste || !broken) { toast.error("Choose grain, swelling, taste and broken grains"); return; }
    if (!testedBy.trim()) { toast.error("Enter who tested it"); return; }
    const moistureValue = parseMoisture(moisture);
    if (moistureValue === "bad") { toast.error("Enter moisture as a percentage from 0 to 100"); return; }
    if (STATIC_DATA_MODE) { toast("Preview only: nothing is saved"); onClose(); return; }
    setSaving(true);
    const { error } = await supabase.rpc("rice_sample_add_measured_test", {
      _moisture_percent: moistureValue, _glazing: glazing.trim(), _sample_id: sample.id, _tested_at: testedAt ? new Date(testedAt).toISOString() : null, _tested_by_name: testedBy, _score: score, _grain: grain, _swelling: swelling, _taste: taste, _broken: broken, _notes: notes,
    });
    setSaving(false);
    if (error) { toast.error("Could not save the test", { description: error.message }); return; }
    toast.success(`Cook test saved: ${score}/10`);
    onClose();
    await onSaved();
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className={dialogClass} {...keepOpen}>
        <DialogHeader>
          <DialogTitle>Cook test: {sampleLabel(sample.sample_no)}</DialogTitle>
          <DialogDescription>{sample.variety}{sample.method ? ` · ${sample.method}` : ""} from {sample.party_name}. Earlier tests stay on record.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label className="text-xs text-slate">Score (10 is best)</Label>
            <div className="grid grid-cols-5 gap-2">
              {Array.from({ length: 10 }, (_, index) => index + 1).map((value) => (
                <button key={value} type="button" aria-pressed={score === value} className={cn("h-11 rounded-md border text-base font-bold", score === value ? "border-navy bg-navy text-white" : "border-border bg-white text-navy")} onClick={() => setScore(value)}>{value}</button>
              ))}
            </div>
          </div>
          <Choice label="Grain after cooking" value={grain} options={GRAIN_LABELS} onChange={setGrain} />
          <Choice label="Swelling after cooking" value={swelling} options={SWELLING_LABELS} onChange={setSwelling} />
          <Choice label="Taste and smell" value={taste} options={TASTE_LABELS} onChange={setTaste} />
          <Choice label="Broken grains" value={broken} options={BROKEN_LABELS} onChange={setBroken} />
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1"><Label className="text-xs text-slate">Moisture %</Label>
              <Input className={inputClass} type="number" inputMode="decimal" min="0" max="100" step="0.01" placeholder="e.g. 12.5" value={moisture} onChange={(event) => setMoisture(event.target.value)} />
            </div>
            <div className="grid gap-1"><Label className="text-xs text-slate">Glazing</Label>
              <Input className={inputClass} list="rice-glazing-options" maxLength={60} placeholder="Type or pick" value={glazing} onChange={(event) => setGlazing(event.target.value)} />
              <datalist id="rice-glazing-options">{glazingOptions.map((value) => <option key={value} value={value} />)}</datalist>
            </div>
          </div>
          <div className="grid gap-1"><Label className="text-xs text-slate">Notes</Label>
            <Textarea rows={2} className="bg-white text-base sm:text-sm" placeholder="Water used, cooking time, anything else" value={notes} onChange={(event) => setNotes(event.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid min-w-0 gap-1"><Label className="text-xs text-slate">Tested by</Label>
              <Input className={inputClass} value={testedBy} onChange={(event) => setTestedBy(event.target.value)} />
            </div>
            <div className="grid min-w-0 gap-1"><Label className="text-xs text-slate">When</Label>
              <Input type="datetime-local" className={cn(inputClass, "min-w-0 px-1.5 text-xs")} value={testedAt} onChange={(event) => setTestedAt(event.target.value)} />
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="h-11 flex-1" onClick={onClose}>Cancel</Button>
            <Button className="h-11 flex-1 bg-navy text-white hover:bg-navy/90" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save test"}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function StatusDialog({ sample, action, onClose, onSaved }: { sample: RiceSample; action: StatusAction; onClose: () => void; onSaved: () => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const copy = {
    discard: { title: "Discard this sample", help: "Why is it out? This stays on the sample's history.", label: "Reason (required)", button: "Discard sample", done: "Sample discarded" },
    unavailable: { title: "Mark unavailable", help: `Use this when the ${sample.party_role} says the rice is gone. You can reopen it if it comes back.`, label: "What they said (optional)", button: "Mark unavailable", done: "Marked unavailable" },
    reopen: { title: "Reopen this sample", help: "It goes back in play, with its tests.", label: "Note (optional)", button: "Reopen sample", done: "Sample reopened" },
    delete: { title: "Delete this card", help: "It disappears from every list. Its tests and history are kept, and you can restore it from Deleted cards.", label: "Why (optional)", button: "Delete card", done: "Card deleted" },
    restore: { title: "Restore this card", help: "It goes back to the lists as it was.", label: "Note (optional)", button: "Restore card", done: "Card restored" },
  }[action];
  const save = async () => {
    if (action === "discard" && reason.trim().length < 3) { toast.error("Enter why this sample is discarded"); return; }
    if (STATIC_DATA_MODE) { toast("Preview only: nothing is saved"); onClose(); return; }
    setSaving(true);
    const { error } = await supabase.rpc("rice_sample_set_status", { _sample_id: sample.id, _action: action, _reason: reason });
    setSaving(false);
    if (error) { toast.error("Could not change the sample", { description: error.message }); return; }
    toast.success(copy.done);
    onClose();
    await onSaved();
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className={dialogClass} {...keepOpen}>
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{sample.variety}{sample.method ? ` · ${sample.method}` : ""} from {sample.party_name}. {copy.help}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1"><Label className="text-xs text-slate">{copy.label}</Label>
          <Textarea rows={2} className="bg-white text-base sm:text-sm" value={reason} onChange={(event) => setReason(event.target.value)} />
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="h-11 flex-1" onClick={onClose}>Cancel</Button>
          <Button className="h-11 flex-1 bg-navy text-white hover:bg-navy/90" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : copy.button}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function HistoryDialog({ sample, tests, events, po, onClose }: { sample: RiceSample; tests: RiceTest[]; events: RiceDesk["events"]; po: RicePo | null; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className={dialogClass}>
        <DialogHeader>
          <DialogTitle>{sampleLabel(sample.sample_no)}: {sample.variety}{sample.method ? ` · ${sample.method}` : ""}</DialogTitle>
          <DialogDescription>Reference in Zoho: {po?.reference ?? poReference(sample.id)}</DialogDescription>
        </DialogHeader>
        <div>
          <h4 className="mb-1 text-xs font-bold tracking-wide text-navy uppercase">Cook tests ({tests.length})</h4>
          {tests.length === 0 ? <p className="text-sm text-slate">Not tested yet.</p> : (
            <ul className="grid gap-2">
              {tests.map((test) => (
                <li key={test.id} className="rounded-md bg-ivory px-3 py-2 text-xs text-navy">
                  <p className="text-sm font-bold">{test.score}/10 <span className="text-xs font-normal text-slate">{test.tested_by_name}, {when(test.tested_at)}</span></p>
                  <p>Grain {GRAIN_LABELS[test.grain].toLowerCase()}, swelling {SWELLING_LABELS[test.swelling].toLowerCase()}, taste {TASTE_LABELS[test.taste].toLowerCase()}, {BROKEN_LABELS[test.broken].toLowerCase()} broken</p>
                  {(test.moisture_percent !== null || test.glazing) && <p>{measureText(test)}</p>}
                  {test.notes && <p className="mt-0.5 break-words text-slate">{test.notes}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h4 className="mb-1 text-xs font-bold tracking-wide text-navy uppercase">History</h4>
          {events.length === 0 ? <p className="text-sm text-slate">Nothing yet.</p> : (
            <ul className="grid gap-1.5">
              {events.map((event) => (
                <li key={event.id} className="border-l-2 border-gold/50 pl-2 text-xs text-navy">
                  <p className="font-semibold">{eventLabel(event.action)}{event.action === "reopen" && STATUS_LABELS[event.to_status as SampleStatus] ? `: back to ${STATUS_LABELS[event.to_status as SampleStatus]}` : ""}</p>
                  {event.detail && <p className="break-words text-slate">{event.detail}</p>}
                  <p className="text-slate">{event.actor_name || "System"}, {when(event.at)}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
        <Button variant="outline" className="h-11" onClick={onClose}>Close</Button>
      </DialogContent>
    </Dialog>
  );
}

const eventLabel = (action: string) => ({
  arrived: "Sample recorded", edited: "Edited", tested: "Cook test", discard: "Discarded", unavailable: "Marked unavailable", reopen: "Reopened",
  po_cancel_asked: "Asked Zoho to cancel", po_started: "Purchase order started", po_retry: "Purchase order sent again", po_rejected: "Zoho refused the purchase order", po_uncertain: "No clear answer from Zoho", po_released: "Zoho has no purchase order: sample freed", po_dead: "Purchase order ended in Zoho", deleted: "Card deleted", restored: "Card restored",
  po_raised: "Purchase order raised", po_duplicate: "Second purchase order found", po_status: "Zoho status",
}[action] ?? action);

type BuyStep = "vendor" | "item" | "figures" | "confirm" | "result";

/** vendor, item, figures, then a confirmation of exactly what will be sent. Nothing reaches Zoho before that last step, except a vendor or item the admin chose to create. */
function BuyDialog({ sample, tests, desk, po, onReload, onClose }: { sample: RiceSample; tests: RiceTest[]; desk: RiceDesk; po: RicePo | null; onReload: () => Promise<void>; onClose: () => void }) {
  const [step, setStep] = useState<BuyStep>("vendor");
  const [access, setAccess] = useState("");
  // The vendor is who bills you, which is normally the seller when one is on record.
  const [vendorRole, setVendorRole] = useState<PartyRole>(sample.seller_name ? "seller" : sample.party_role);
  const [vendor, setVendor] = useState<ZohoVendorMatch | null>(null);
  const [item, setItem] = useState<ZohoItemMatch | null>(null);
  const [kgPerUnit, setKgPerUnit] = useState("");
  const defaultGodown = desk.godowns.find((godown) => godown.isDefault && godown.locationId) ?? desk.godowns.find((godown) => godown.locationId);
  const [branchId, setBranchId] = useState(defaultGodown?.id ?? "");
  const [quantity, setQuantity] = useState(String(sample.quantity_qntl));
  const [rate, setRate] = useState(String(sample.price_per_qntl));
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [result, setResult] = useState<RaiseResult | null>(null);
  const [tax, setTax] = useState<PoTax | null>(null);
  const [taxProblem, setTaxProblem] = useState("");
  const [checkingTax, setCheckingTax] = useState(false);

  useEffect(() => {
    if (STATIC_DATA_MODE) return;
    void import("@/lib/rice-samples.functions").then(({ checkZohoPurchaseAccess }) => checkZohoPurchaseAccess()).then((answer) => { if (!answer.ok) setAccess(answer.message); }).catch((cause: unknown) => setAccess(errorText(cause)));
  }, []);

  const godown: RiceGodown | undefined = desk.godowns.find((entry) => entry.id === branchId);
  const kg = num(kgPerUnit);
  const quantityQntl = num(quantity), ratePerQntl = num(rate);
  const unitLabel = item?.unit || "unit";
  const problem = !item ? "Choose the Zoho item first." : poLineProblem({ quantityQntl, ratePerQntl, kgPerUnit: kg, availableQntl: Number(sample.quantity_qntl), unit: item.unit, itemName: item.name }) ?? (godown?.locationId ? null : "Choose a godown that is linked to Zoho. Link one in Admin > Branches.");
  const rateWarning = priceUnitWarning(ratePerQntl);
  const line = kg > 0 ? planPoLine({ quantityQntl, ratePerQntl, kgPerUnit: kg }) : null;
  const gstAmount = tax && line ? poTaxAmount(line.subTotal, tax.percent) : null;

  const chooseItem = (match: ZohoItemMatch) => { setItem(match); setKgPerUnit(match.kgPerUnit ? String(match.kgPerUnit) : ""); };

  // Read from Zoho as it is now, each time, because the vendor, item or godown may have changed. If it can't be worked out, this stays here and says why.
  const review = async () => {
    if (!vendor || !item || !godown) return;
    if (STATIC_DATA_MODE) { setStep("confirm"); return; }
    setCheckingTax(true);
    setTaxProblem("");
    setTax(null);
    try {
      const { previewRicePoTax } = await import("@/lib/rice-samples.functions");
      const answer = await previewRicePoTax({ data: { vendorId: vendor.id, itemId: item.id, branchId: godown.id } });
      if (answer.ok) { setTax(answer.tax); setStep("confirm"); } else setTaxProblem(answer.message);
    } catch (cause) {
      setTaxProblem(`The tax could not be read from Zoho (${errorText(cause)}). Try again.`);
    } finally {
      setCheckingTax(false);
    }
  };

  const raise = async () => {
    if (sendingRef.current || !vendor || !item || !line || !godown || !tax) return;
    sendingRef.current = true;
    setSending(true);
    try {
      const { raiseRiceSamplePurchaseOrder } = await import("@/lib/rice-samples.functions");
      const answer = await raiseRiceSamplePurchaseOrder({ data: {
        sampleId: sample.id, vendorRole, vendorId: vendor.id, itemId: item.id, kgPerUnit: kg, quantityQntl, ratePerQntl, branchId: godown.id,
        confirmed: { vendorName: vendor.name, itemName: item.name, itemUnit: item.unit, poQuantity: line.poQuantity, poRate: line.poRate, subTotal: line.subTotal, issueOnCreate: desk.issueOnCreate, sampleUpdatedAt: sample.updated_at, taxId: tax.taxId, taxKind: tax.kind, taxPercent: tax.percent, sourceOfSupply: tax.sourceOfSupply, destinationOfSupply: tax.destinationOfSupply },
      } });
      setResult(answer);
    } catch (cause) {
      // The request itself failed: it may have reached the server, so this is never reported as safe to resend.
      setResult({ kind: "uncertain", retryAfterSeconds: 0, message: `The website lost contact while sending this (${errorText(cause)}). Close this and press Check Zoho on the sample before anything else. Do not create it by hand in Zoho.` });
    } finally {
      sendingRef.current = false;
      setSending(false);
      setStep("result");
      // A refused request often means something changed: the next review must show it as it is now.
      void onReload();
    }
  };

  const check = async () => {
    setSending(true);
    try {
      const { checkRiceSamplePurchaseOrder } = await import("@/lib/rice-samples.functions");
      setResult(await checkRiceSamplePurchaseOrder({ data: { sampleId: sample.id } }));
      void onReload();
    } catch (cause) {
      toast.error("Could not check Zoho", { description: errorText(cause) });
    } finally {
      setSending(false);
    }
  };

  const zohoUrl = result?.kind === "raised" && desk.zoho ? zohoPoUrl(desk.zoho.region, desk.zoho.organizationId, result.poId) : "";
  const steps: BuyStep[] = ["vendor", "item", "figures", "confirm"];
  const stepIndex = steps.indexOf(step);

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !sending) onClose(); }}>
      <DialogContent className={dialogClass} {...keepOpen}>
        <DialogHeader>
          <DialogTitle>Buy this sample</DialogTitle>
          <DialogDescription>{sampleLabel(sample.sample_no)}: {sample.variety}{sample.method ? ` · ${sample.method}` : ""}. {step === "result" ? "" : `Step ${stepIndex + 1} of 4. Nothing is raised until you confirm on the last step.`}</DialogDescription>
        </DialogHeader>

        {access && step !== "result" && (
          <div className="rounded-md border border-danger/30 bg-danger/5 p-3 text-xs text-danger">
            <p className="font-semibold">Zoho is not ready for purchase orders.</p>
            <p className="mt-1 break-words">{access}</p>
            <Link to="/admin/zoho" className="mt-1 inline-block font-semibold underline">Open Admin &gt; Zoho Commerce</Link>
          </div>
        )}
        {STATIC_DATA_MODE && <p className="rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800">Preview only: no Zoho here, so the steps cannot be completed.</p>}

        {step === "vendor" && (
          <VendorStep sample={sample} role={vendorRole} onRole={(role) => { setVendorRole(role); setVendor(null); }} vendor={vendor} onVendor={setVendor} onNext={() => setStep("item")} onCancel={onClose} />
        )}
        {step === "item" && (
          <ItemStep sample={sample} item={item} onItem={chooseItem} kgPerUnit={kgPerUnit} onKgPerUnit={setKgPerUnit} ratePerQntl={num(rate)} onBack={() => setStep("vendor")} onNext={() => setStep("figures")} />
        )}
        {step === "figures" && item && (
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid min-w-0 gap-1"><Label className="text-xs text-slate">Quantity to buy (quintal)</Label>
                <Input className={inputClass} inputMode="decimal" value={quantity} onChange={(event) => setQuantity(event.target.value)} />
                <p className="text-[11px] text-slate">{qty(sample.quantity_qntl)} available</p>
              </div>
              <div className="grid min-w-0 gap-1"><Label className="text-xs text-slate">Agreed price (₹ per quintal)</Label>
                <Input className={inputClass} inputMode="decimal" value={rate} onChange={(event) => setRate(event.target.value)} />
                {ratePerQntl !== Number(sample.price_per_qntl) && <p className="text-[11px] text-amber-700">The sample says {inrPrecise(sample.price_per_qntl)}</p>}
              </div>
            </div>
            {rateWarning && <p className="rounded-md bg-amber-50 px-2 py-1.5 text-xs font-medium text-amber-800">{rateWarning}</p>}
            <div className="grid gap-1"><Label className="text-xs text-slate">Receiving godown</Label>
              <select aria-label="Receiving godown" disabled={checkingTax} className="h-10 min-w-0 rounded-md border border-input bg-white px-2 text-sm" value={branchId} onChange={(event) => { setBranchId(event.target.value); setTaxProblem(""); }}>
                <option value="">Choose…</option>
                {desk.godowns.map((entry) => <option key={entry.id} value={entry.id} disabled={!entry.locationId}>{entry.name}{entry.locationId ? "" : " (not linked to Zoho)"}</option>)}
              </select>
            </div>
            {line && !problem && <p className="rounded-md bg-ivory px-3 py-2 text-sm text-navy">{poUnitsSentence(line.poQuantity, unitLabel, kg, item.unit)} at {inrPrecise(line.poRate)} each = <strong>{inrPrecise(line.subTotal)}</strong> before GST</p>}
            {problem && <p className="rounded-md bg-amber-50 px-2 py-1.5 text-xs font-medium text-amber-800">{problem}</p>}
            {taxProblem && <p className="break-words rounded-md bg-danger/5 px-2 py-1.5 text-xs font-medium text-danger">{taxProblem} Nothing has been sent to Zoho.</p>}
            <div className="flex gap-2">
              <Button variant="outline" className="h-11 flex-1" disabled={checkingTax} onClick={() => { setTaxProblem(""); setStep("item"); }}>Back</Button>
              <Button className="h-11 flex-1 bg-navy text-white hover:bg-navy/90" disabled={Boolean(problem) || checkingTax} onClick={() => void review()}>{checkingTax ? "Checking the tax…" : "Review"}</Button>
            </div>
          </div>
        )}
        {step === "confirm" && vendor && item && line && godown && (
          <div className="grid gap-3">
            <dl className="grid gap-2 rounded-md border border-border bg-white p-3 text-sm">
              <ConfirmRow label="Vendor" value={<>{vendor.name}<span className="block text-xs font-normal text-slate">This is the {vendorRole}{vendorRole === "seller" && sample.party_role === "broker" ? `, not the broker ${sample.party_name}` : ""}. The purchase order and the later bill are in this name.</span></>} />
              <ConfirmRow label="Item" value={<>{item.name}<span className="block text-xs font-normal text-slate">Zoho item, unit {item.unit || "not set"}{item.hsn ? `, HSN ${item.hsn}` : ""}</span></>} />
              <ConfirmRow label="Quantity" value={<>{qty(quantityQntl)} quintal<span className="block text-xs font-normal text-slate">{poUnitsSentence(line.poQuantity, unitLabel, kg, item.unit)} in Zoho</span></>} />
              <ConfirmRow label="Rate" value={<>{inrPrecise(ratePerQntl)} per quintal<span className="block text-xs font-normal text-slate">{inrPrecise(line.poRate)} per {unitLabel} in Zoho</span></>} />
              <ConfirmRow label="Total before GST" value={<span className="text-base">{inrPrecise(line.subTotal)}</span>} />
              <ConfirmRow label="GST" value={tax?.kind === "none" ? <>{NO_GST_WORDS}<span className="block text-xs font-normal text-slate">{poTaxReason(tax)}</span></> : tax && gstAmount !== null ? <>{inrPrecise(gstAmount)}<span className="block text-xs font-normal text-slate">{poTaxLabel(tax)}. {poTaxReason(tax)}</span></> : <span className="font-normal">Not available in this preview.</span>} />
              {gstAmount !== null && <ConfirmRow label={tax?.kind === "none" ? "Total" : "Total with GST"} value={<span className="text-base">{inrPrecise(line.subTotal + gstAmount)}<span className="block text-xs font-normal text-slate">{tax?.kind === "none" ? "You are told if Zoho shows any GST on it." : "Zoho works out the exact figure. You are told if its figure differs."}</span></span>} />}
              <ConfirmRow label="Receiving godown" value={<>{godown.name}<span className="block text-xs font-normal text-slate">Zoho location {godown.locationName || godown.locationId}</span></>} />
              <ConfirmRow label="Created as" value={desk.issueOnCreate ? "Issued" : <>Draft<span className="block text-xs font-normal text-slate">You check it and issue it in Zoho.</span></>} />
            </dl>
            {tax?.percent === 0 && tax.kind !== "none" && <p className="rounded-md bg-amber-50 px-2 py-1.5 text-xs font-medium text-amber-800">"{item.name}" is set to {tax.taxName}, 0% tax, in Zoho. If that is wrong, correct the item in Zoho first.</p>}
            {!isBulkUnit(item.unit) && <p className="rounded-md bg-amber-50 px-2 py-1.5 text-xs font-medium text-amber-800">"{item.name}" is counted in {item.unit || "units"}, not by weight. When this is received in Zoho, its stock goes up by {qty(line.poQuantity)} {item.unit || "units"}. Is that what you want?</p>}
            {rateWarning && <p className="rounded-md bg-amber-50 px-2 py-1.5 text-xs font-medium text-amber-800">{rateWarning}</p>}
            {po?.state === "dead" && <p className="rounded-md bg-amber-50 px-2 py-1.5 text-xs font-medium text-amber-800">This makes a new purchase order with its own reference. The earlier {po.retired_pos[po.retired_pos.length - 1]?.number} stays on record as {PO_DEATH_WORDS[po.retired_pos[po.retired_pos.length - 1]?.reason ?? "deleted"]}.</p>}
            {tests.length === 0 && <p className="rounded-md bg-amber-50 px-2 py-1.5 text-xs font-medium text-amber-800">This sample has no cook test on record.</p>}
            {tests[0]?.taste === "off" && <p className="rounded-md bg-amber-50 px-2 py-1.5 text-xs font-medium text-amber-800">The latest test found the taste or smell off.</p>}
            {po?.state === "rejected" && <p className="break-words rounded-md bg-danger/5 px-2 py-1.5 text-xs text-danger">Last attempt: {po.last_error}</p>}
            <p className="text-xs text-slate">This goes into the official Zoho books as soon as you press the button.</p>
            <div className="flex gap-2">
              <Button variant="outline" className="h-11 flex-1" disabled={sending} onClick={() => setStep("figures")}>Back</Button>
              <Button className="h-11 flex-1 bg-gold font-bold text-midnight hover:bg-gold/90" disabled={sending || STATIC_DATA_MODE || !tax} onClick={() => void raise()}>{sending ? "Raising…" : "Raise purchase order"}</Button>
            </div>
          </div>
        )}
        {step === "result" && result && (
          <div className="grid gap-3">
            {result.kind === "raised" && (
              <div className="rounded-md border border-success/30 bg-success/5 p-3 text-sm text-navy">
                <p className="flex items-center gap-1.5 font-bold"><CheckCircle2 className="h-4 w-4 text-success" />{result.already ? "Already in Zoho" : "Purchase order raised"}: {result.poNumber}</p>
                <p className="mt-1 text-xs text-slate">Status in Zoho: {zohoStatusLabel(result.poStatus)}{result.total !== null ? (tax?.kind === "none" ? `. ${NO_GST_WORDS}. Total ${inrPrecise(result.total)}.` : `. Total with GST ${inrPrecise(result.total)}.`) : "."} Carry on in Zoho; this sample is now locked here.</p>
                {result.warnings.map((warning) => <p key={warning} className="mt-1 break-words text-xs font-semibold text-danger">{warning}</p>)}
                {zohoUrl && <a href={zohoUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex h-10 items-center gap-1 rounded-md bg-navy px-3 text-xs font-semibold text-white"><ExternalLink className="h-3.5 w-3.5" />Open in Zoho</a>}
              </div>
            )}
            {result.kind === "rejected" && (
              <div className="rounded-md border border-danger/30 bg-danger/5 p-3 text-sm text-danger">
                <p className="flex items-center gap-1.5 font-bold"><XCircle className="h-4 w-4" />Not raised</p>
                <p className="mt-1 break-words text-xs">{result.message}</p>
              </div>
            )}
            {(result.kind === "uncertain" || result.kind === "in_progress") && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                <p className="flex items-center gap-1.5 font-bold"><AlertTriangle className="h-4 w-4" />{result.kind === "uncertain" ? "Not confirmed yet" : "Already being raised"}</p>
                <p className="mt-1 break-words text-xs">{result.message}</p>
              </div>
            )}
            {result.kind === "absent" && (
              <div className="rounded-md border border-border bg-ivory p-3 text-sm text-navy">
                <p className="font-bold">Zoho has no purchase order for this sample</p>
                <p className="mt-1 break-words text-xs">{result.message}</p>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {(result.kind === "uncertain" || result.kind === "in_progress") && <Button className="h-11 flex-1 bg-navy text-white hover:bg-navy/90" disabled={sending} onClick={() => void check()}>{sending ? "Checking…" : "Check Zoho"}</Button>}
              {(result.kind === "rejected" || result.kind === "absent") && vendor && item && <Button className="h-11 flex-1 bg-navy text-white hover:bg-navy/90" onClick={() => { setTax(null); setStep("figures"); }}>Review and try again</Button>}
              <Button variant="outline" className="h-11 flex-1" disabled={sending} onClick={onClose}>Close</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

const poUnitsSentence = (poQuantity: number, unitLabel: string, kg: number, unit: string) =>
  isBulkUnit(unit) ? `${qty(poQuantity)} ${unitLabel}` : `${qty(poQuantity)} × ${kg} kg ${unit || "units"}`;

const ConfirmRow = ({ label, value }: { label: string; value: ReactNode }) => (
  <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2">
    <dt className="text-xs text-slate">{label}</dt>
    <dd className="font-semibold break-words text-navy">{value}</dd>
  </div>
);

function VendorStep({ sample, role, onRole, vendor, onVendor, onNext, onCancel }: {
  sample: RiceSample; role: PartyRole; onRole: (role: PartyRole) => void; vendor: ZohoVendorMatch | null; onVendor: (vendor: ZohoVendorMatch | null) => void; onNext: () => void; onCancel: () => void;
}) {
  const nameForRole = role === "seller" && sample.party_role === "broker" ? sample.seller_name : sample.party_name;
  const phoneForRole = role === "seller" && sample.party_role === "broker" ? "" : sample.party_phone;
  const [term, setTerm] = useState(nameForRole);
  const [matches, setMatches] = useState<ZohoVendorMatch[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirmCreate, setConfirmCreate] = useState(false);
  const [newName, setNewName] = useState(nameForRole);
  const [newPhone, setNewPhone] = useState(phoneForRole);
  const [gstin, setGstin] = useState("");
  const [placeOfContact, setPlaceOfContact] = useState("KA");
  const [message, setMessage] = useState("");

  const search = useCallback(async (name: string, phone: string) => {
    if (STATIC_DATA_MODE) { setMatches([]); return; }
    setBusy(true); setError("");
    try {
      const { searchZohoVendors } = await import("@/lib/rice-samples.functions");
      setMatches(await searchZohoVendors({ data: { name, phone } }));
    } catch (cause) {
      setError(errorText(cause)); setMatches([]);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    setTerm(nameForRole); setNewName(nameForRole); setNewPhone(phoneForRole); setCreating(false); setConfirmCreate(false); setMessage("");
    void search(nameForRole, phoneForRole);
  }, [nameForRole, phoneForRole, search]);

  const create = async () => {
    setBusy(true); setMessage("");
    try {
      const { createZohoVendorForSample } = await import("@/lib/rice-samples.functions");
      const result = await createZohoVendorForSample({ data: { name: newName, phone: newPhone, gstin, placeOfContact, confirmed: true } });
      if (result.kind === "created" || result.kind === "exists") {
        setMessage(result.kind === "exists" ? result.message : "Vendor created in Zoho.");
        const { searchZohoVendors } = await import("@/lib/rice-samples.functions");
        const fresh = await searchZohoVendors({ data: { name: newName, phone: newPhone } });
        setMatches(fresh);
        onVendor(fresh.find((match) => match.id === result.id) ?? null);
        setCreating(false); setConfirmCreate(false);
      } else {
        setMessage(result.message); setConfirmCreate(false);
      }
    } catch (cause) {
      setMessage(errorText(cause)); setConfirmCreate(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <Label className="text-xs text-slate">Who is this purchase order made out to?</Label>
        {sample.party_role === "broker" ? (
          <div className="grid grid-cols-2 gap-2">
            <button type="button" aria-pressed={role === "broker"} className={cn("min-h-11 rounded-md border px-2 text-xs font-semibold break-words", role === "broker" ? "border-navy bg-navy text-white" : "border-border bg-white text-navy")} onClick={() => onRole("broker")}>Broker: {sample.party_name}</button>
            <button type="button" aria-pressed={role === "seller"} disabled={!sample.seller_name} className={cn("min-h-11 rounded-md border px-2 text-xs font-semibold break-words disabled:opacity-50", role === "seller" ? "border-navy bg-navy text-white" : "border-border bg-white text-navy")} onClick={() => onRole("seller")}>Seller: {sample.seller_name || "not recorded"}</button>
          </div>
        ) : (
          <p className="rounded-md bg-ivory px-3 py-2 text-sm font-semibold text-navy">Seller: {sample.party_name}</p>
        )}
        <p className="text-[11px] text-slate">The vendor on the purchase order is who bills you. {sample.party_role === "broker" ? "Choose the broker only if the broker bills you." : ""}</p>
        {sample.party_role === "broker" && !sample.seller_name && <p className="text-[11px] font-medium text-amber-700">To buy from the seller, close this and edit the sample to add the seller's name.</p>}
      </div>
      <div className="grid gap-1"><Label className="text-xs text-slate">Find the vendor in Zoho</Label>
        <div className="flex gap-2">
          <Input className={inputClass} value={term} onChange={(event) => setTerm(event.target.value)} />
          <Button variant="outline" className="h-10 shrink-0" disabled={busy} onClick={() => void search(term, phoneForRole)}>{busy ? "…" : "Search"}</Button>
        </div>
      </div>
      {error && <p className="break-words text-xs text-danger">{error}</p>}
      {matches && matches.length === 0 && !busy && !error && <p className="text-sm text-slate">Zoho has no vendor matching this name or phone.</p>}
      {matches && matches.length > 0 && (
        <ul className="grid gap-2">
          {matches.map((match) => {
            const usable = match.contactType === "vendor" && match.active;
            return (
              <li key={match.id}>
                <button type="button" disabled={!usable} aria-pressed={vendor?.id === match.id} className={cn("w-full rounded-md border p-2.5 text-left text-sm disabled:opacity-60", vendor?.id === match.id ? "border-navy bg-navy/5 ring-1 ring-navy" : "border-border bg-white")} onClick={() => onVendor(match)}>
                  <span className="block font-semibold break-words text-navy">{match.name}</span>
                  <span className="block text-xs break-words text-slate">{[match.company && match.company !== match.name ? match.company : "", match.phone, match.gstNo ? `GSTIN ${match.gstNo}` : "No GSTIN in Zoho"].filter(Boolean).join(" · ")}</span>
                  {match.byPhone && <span className="mt-0.5 block text-xs font-semibold text-success">Same phone number as this sample</span>}
                  {usable && !match.gstNo && (match.gstTreatment === "business_none"
                    ? <span className="mt-0.5 block text-xs font-semibold text-navy">Not registered for GST in Zoho, so the purchase order carries no GST.</span>
                    : <span className="mt-0.5 block text-xs font-semibold text-amber-700">Zoho doesn't say plainly whether this vendor is registered for GST, so this will stop at Review.</span>)}
                  {match.contactType !== "vendor" && <span className="mt-0.5 block text-xs font-semibold text-danger">A customer in Zoho, not a vendor: cannot be used</span>}
                  {match.contactType === "vendor" && !match.active && <span className="mt-0.5 block text-xs font-semibold text-danger">Inactive in Zoho</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {message && <p className="break-words rounded-md bg-ivory px-2 py-1.5 text-xs text-navy">{message}</p>}
      {!creating ? (
        <button type="button" className="justify-self-start text-sm font-semibold text-navy underline" disabled={STATIC_DATA_MODE} onClick={() => { setCreating(true); onVendor(null); }}>None of these: add a new vendor to Zoho</button>
      ) : (
        <div className="grid gap-2 rounded-md border border-border bg-ivory p-3">
          <p className="text-xs font-semibold text-navy">New vendor in the official Zoho</p>
          <div className="grid gap-1"><Label className="text-xs text-slate">Name</Label><Input className={inputClass} value={newName} onChange={(event) => { setNewName(event.target.value); setConfirmCreate(false); }} /></div>
          <div className="grid grid-cols-2 gap-2">
            <div className="grid min-w-0 gap-1"><Label className="text-xs text-slate">Phone (optional)</Label><Input className={inputClass} inputMode="tel" value={newPhone} onChange={(event) => { setNewPhone(event.target.value); setConfirmCreate(false); }} /></div>
            <div className="grid min-w-0 gap-1"><Label className="text-xs text-slate">State</Label>
              <select aria-label="Vendor state" className="h-10 min-w-0 rounded-md border border-input bg-white px-2 text-sm" value={placeOfContact} onChange={(event) => { setPlaceOfContact(event.target.value); setConfirmCreate(false); }}>
                {[["KA", "Karnataka"], ["AD", "Andhra Pradesh"], ["TS", "Telangana"], ["TN", "Tamil Nadu"], ["KL", "Kerala"], ["MH", "Maharashtra"], ["GA", "Goa"]].map(([code, name]) => <option key={code} value={code}>{name}</option>)}
              </select>
            </div>
          </div>
          <div className="grid gap-1"><Label className="text-xs text-slate">GSTIN (if registered)</Label><Input className={inputClass} value={gstin} onChange={(event) => { setGstin(event.target.value.toUpperCase()); setConfirmCreate(false); }} />
            <p className="text-[11px] text-slate">Without a GSTIN this vendor is added as not registered for GST, and their purchase orders carry no GST.</p>
          </div>
          {!confirmCreate ? (
            <div className="flex gap-2">
              <Button variant="outline" className="h-10 flex-1" onClick={() => setCreating(false)}>Cancel</Button>
              <Button className="h-10 flex-1 bg-navy text-white hover:bg-navy/90" disabled={newName.trim().length < 2 || (Boolean(newPhone.trim()) && !isSamplePhone(newPhone))} onClick={() => setConfirmCreate(true)}>Add vendor</Button>
            </div>
          ) : (
            <div className="grid gap-2 rounded-md bg-amber-50 p-2">
              <p className="text-xs font-medium text-amber-900">Add "{newName.trim()}" as a new vendor in the official Zoho? Check the list above first: a second vendor for the same person splits their bills and payments.</p>
              <div className="flex gap-2">
                <Button variant="outline" className="h-10 flex-1" onClick={() => setConfirmCreate(false)}>No</Button>
                <Button className="h-10 flex-1 bg-navy text-white hover:bg-navy/90" disabled={busy} onClick={() => void create()}>{busy ? "Adding…" : "Yes, add to Zoho"}</Button>
              </div>
            </div>
          )}
        </div>
      )}
      <div className="flex gap-2">
        <Button variant="outline" className="h-11 flex-1" onClick={onCancel}>Cancel</Button>
        <Button className="h-11 flex-1 bg-navy text-white hover:bg-navy/90" disabled={!vendor} onClick={onNext}>Next: item</Button>
      </div>
    </div>
  );
}

function ItemStep({ sample, item, onItem, kgPerUnit, onKgPerUnit, ratePerQntl, onBack, onNext }: {
  sample: RiceSample; item: ZohoItemMatch | null; onItem: (item: ZohoItemMatch) => void; kgPerUnit: string; onKgPerUnit: (value: string) => void; ratePerQntl: number; onBack: () => void; onNext: () => void;
}) {
  const [term, setTerm] = useState("rice");
  const [matches, setMatches] = useState<ZohoItemMatch[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirmCreate, setConfirmCreate] = useState(false);
  const [newName, setNewName] = useState([sample.variety, sample.method].filter(Boolean).join(" "));
  const [unit, setUnit] = useState<"qtl" | "kg">("qtl");
  const [hsn, setHsn] = useState("100630");
  const [gstRate, setGstRate] = useState<"" | "5" | "later">("");
  const [message, setMessage] = useState("");

  /** Each word list is one search, then merged: "rice" alone would miss a bulk item named "HMT Raw", and it would get added twice. */
  const search = useCallback(async (values: string[]) => {
    if (STATIC_DATA_MODE) { setMatches([]); return; }
    const texts = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
    if (!texts.length) return;
    setBusy(true); setError("");
    try {
      const { searchZohoItems } = await import("@/lib/rice-samples.functions");
      const lists = await Promise.all(texts.map((text) => searchZohoItems({ data: { text } })));
      const merged = new Map(lists.flat().map((match) => [match.id, match]));
      setMatches([...merged.values()].sort((a, b) => Number(isBulkUnit(b.unit)) - Number(isBulkUnit(a.unit)) || a.name.localeCompare(b.name)));
    } catch (cause) {
      setError(errorText(cause)); setMatches([]);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => { void search(["rice", sample.variety]); }, [search, sample.variety]);

  const create = async () => {
    setBusy(true); setMessage("");
    try {
      const { createZohoItemForSample } = await import("@/lib/rice-samples.functions");
      const { result, item: fresh } = await createZohoItemForSample({ data: {
        name: newName, unit, hsn, purchaseRate: unit === "qtl" ? ratePerQntl : Math.round(ratePerQntl) / 100, gstRate: gstRate === "5" ? 5 : null, confirmed: true,
      } });
      if (result.kind === "created" || result.kind === "exists") {
        setMessage(result.kind === "exists" ? result.message : "Item created in Zoho.");
        if (fresh) { onItem(fresh); setMatches((current) => [fresh, ...(current ?? []).filter((match) => match.id !== fresh.id)]); }
        setCreating(false); setConfirmCreate(false);
      } else {
        setMessage(result.message); setConfirmCreate(false);
      }
    } catch (cause) {
      setMessage(errorText(cause)); setConfirmCreate(false);
    } finally {
      setBusy(false);
    }
  };

  const bulk = item ? isBulkUnit(item.unit) : false;
  return (
    <div className="grid gap-3">
      <div className="grid gap-1"><Label className="text-xs text-slate">Which Zoho item is this rice?</Label>
        <div className="flex gap-2">
          <Input className={inputClass} value={term} onChange={(event) => setTerm(event.target.value)} />
          <Button variant="outline" className="h-10 shrink-0" disabled={busy} onClick={() => void search([term])}>{busy ? "…" : "Search"}</Button>
        </div>
      </div>
      {error && <p className="break-words text-xs text-danger">{error}</p>}
      {matches && matches.length === 0 && !busy && !error && <p className="text-sm text-slate">No Zoho item matches.</p>}
      {matches && matches.length > 0 && (
        <ul className="grid gap-2">
          {matches.map((match) => (
            <li key={match.id}>
              <button type="button" aria-pressed={item?.id === match.id} className={cn("w-full rounded-md border p-2.5 text-left text-sm", item?.id === match.id ? "border-navy bg-navy/5 ring-1 ring-navy" : "border-border bg-white")} onClick={() => onItem(match)}>
                <span className="block font-semibold break-words text-navy">{match.name}</span>
                <span className="block text-xs text-slate">{[`Unit ${match.unit || "not set"}`, match.hsn ? `HSN ${match.hsn}` : "No HSN", match.gstLabel ? `GST ${match.gstLabel}` : ""].filter(Boolean).join(" · ")}</span>
                {!isBulkUnit(match.unit) && <span className="mt-0.5 block text-xs font-medium text-amber-700">A retail item, counted in {match.unit || "units"}: buying into it adds to its shop stock</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {item && (
        <div className="rounded-md border border-border bg-ivory p-3">
          {bulk ? (
            <p className="text-sm text-navy">This item is sold by weight in Zoho ({item.unit}): the purchase order will be in {item.unit}.</p>
          ) : (
            <div className="grid gap-1">
              <Label className="text-xs text-navy">One {item.unit || "unit"} of "{item.name}" weighs how many kg?</Label>
              <Input className={inputClass} inputMode="decimal" value={kgPerUnit} onChange={(event) => onKgPerUnit(event.target.value)} />
              <p className="text-[11px] text-slate">Zoho counts this item in {item.unit || "units"}, not quintals. Your quantity and price are converted using this, and you see the result before anything is raised.</p>
            </div>
          )}
          {!item.hsn && <p className="mt-2 text-xs font-medium text-amber-800">This item has no HSN code in Zoho. Zoho may block the purchase order or later edits until it has one.</p>}
        </div>
      )}
      {message && <p className="break-words rounded-md bg-ivory px-2 py-1.5 text-xs text-navy">{message}</p>}
      {!creating ? (
        <button type="button" className="justify-self-start text-sm font-semibold text-navy underline" disabled={STATIC_DATA_MODE} onClick={() => setCreating(true)}>None of these: add a new item to Zoho</button>
      ) : (
        <div className="grid gap-2 rounded-md border border-border bg-ivory p-3">
          <p className="text-xs font-semibold text-navy">New item in the official Zoho</p>
          <div className="grid gap-1"><Label className="text-xs text-slate">Name</Label><Input className={inputClass} value={newName} onChange={(event) => { setNewName(event.target.value); setConfirmCreate(false); }} /></div>
          <div className="grid grid-cols-2 gap-2">
            <div className="grid min-w-0 gap-1"><Label className="text-xs text-slate">Bought by</Label>
              <select aria-label="Item unit" className="h-10 min-w-0 rounded-md border border-input bg-white px-2 text-sm" value={unit} onChange={(event) => { setUnit(event.target.value as "qtl" | "kg"); setConfirmCreate(false); }}>
                <option value="qtl">Quintal (qtl)</option><option value="kg">Kg</option>
              </select>
            </div>
            <div className="grid min-w-0 gap-1"><Label className="text-xs text-slate">HSN code</Label><Input className={inputClass} inputMode="numeric" value={hsn} onChange={(event) => { setHsn(event.target.value.trim()); setConfirmCreate(false); }} /></div>
          </div>
          <div className="grid gap-1"><Label className="text-xs text-slate">GST</Label>
            <select aria-label="Item GST" className="h-10 min-w-0 rounded-md border border-input bg-white px-2 text-sm" value={gstRate} onChange={(event) => { setGstRate(event.target.value as "" | "5" | "later"); setConfirmCreate(false); }}>
              <option value="">Choose…</option><option value="5">5%, as your other rice items in Zoho</option><option value="later">Set GST later in Zoho (a purchase order stops at Review until then)</option>
            </select>
            <p className="text-[11px] text-slate">Bulk rice can be taxed differently from packed rice. If unsure, ask your accountant and set it later in Zoho.</p>
          </div>
          {!confirmCreate ? (
            <div className="flex gap-2">
              <Button variant="outline" className="h-10 flex-1" onClick={() => setCreating(false)}>Cancel</Button>
              <Button className="h-10 flex-1 bg-navy text-white hover:bg-navy/90" disabled={newName.trim().length < 2 || !/^\d{6,8}$/.test(hsn) || !(ratePerQntl > 0) || !gstRate} onClick={() => setConfirmCreate(true)}>Add item</Button>
            </div>
          ) : (
            <div className="grid gap-2 rounded-md bg-amber-50 p-2">
              <p className="text-xs font-medium text-amber-900">Add "{newName.trim()}" as a new item in the official Zoho? Check the list above first: a second item for the same rice splits its stock.</p>
              <div className="flex gap-2">
                <Button variant="outline" className="h-10 flex-1" onClick={() => setConfirmCreate(false)}>No</Button>
                <Button className="h-10 flex-1 bg-navy text-white hover:bg-navy/90" disabled={busy} onClick={() => void create()}>{busy ? "Adding…" : "Yes, add to Zoho"}</Button>
              </div>
            </div>
          )}
        </div>
      )}
      <div className="flex gap-2">
        <Button variant="outline" className="h-11 flex-1" onClick={onBack}>Back</Button>
        <Button className="h-11 flex-1 bg-navy text-white hover:bg-navy/90" disabled={!item || !(num(kgPerUnit) > 0)} onClick={onNext}>Next: quantity</Button>
      </div>
    </div>
  );
}
