import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Copy, Handshake, IndianRupee, KeyRound, Target, Timer, Trash2, UserPlus } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel, StatCard } from "@/components/panel/widgets";
import { CommissionLinesTable, PartnerLeaderboard, commissionTotals, usePartnerData } from "@/components/partners/PartnerWidgets";
import { PartnerHistoryPanel } from "@/components/partners/PartnerHistory";
import { adminNav } from "@/lib/panel-nav";
import { useApp } from "@/lib/store";
import { useBranches } from "@/lib/branches";
import { inrPrecise } from "@/lib/data";
import { describeRate, monthLabel, monthStart, partnerPasswordProblem, suggestPartnerPassword, type CommissionKind } from "@/lib/partners";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/admin/partners")({
  head: () => ({ meta: [{ title: "Channel Partners | Grain Bazar Admin" }, { name: "robots", content: "noindex" }] }),
  component: AdminPartners,
});

type Partner = Database["public"]["Tables"]["channel_partners"]["Row"];
type Rule = Database["public"]["Tables"]["partner_commission_rules"]["Row"];
const PARTNER_LOGIN_URL = "https://grainbazar.com/partner/login";

/** Channel Partner Commission Platform (admin): partner logins, rates, targets, leaderboard, ledger. */
function AdminPartners() {
  const { branches } = useBranches();
  const godowns = branches.filter((branch) => !branch.vendorId);
  const [partners, setPartners] = useState<Partner[] | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [month, setMonth] = useState(monthStart());
  const { leaders, lines } = usePartnerData(month);
  // Bumped after a partner is added, suspended or reactivated, so the history reloads.
  const [historyKey, setHistoryKey] = useState(0);
  const firstLoad = useRef(true);

  const load = useCallback(async () => {
    const [p, r] = await Promise.all([
      supabase.from("channel_partners").select("*").order("created_at"),
      supabase.from("partner_commission_rules").select("*"),
    ]);
    setPartners((p.data as Partner[] | null) ?? []);
    setRules((r.data as Rule[] | null) ?? []);
    if (!firstLoad.current) setHistoryKey((key) => key + 1);
    firstLoad.current = false;
  }, []);
  useEffect(() => { void load(); }, [load]);

  const totals = useMemo(() => commissionTotals(lines), [lines]);
  const partnerNames = useMemo(() => new Map((partners ?? []).map((p) => [p.id, p.name])), [partners]);

  return (
    <PanelLayout items={adminNav} tone="admin" title="Channel Partners" subtitle="Channel Partner Commission Platform: godown distributors, commissions and targets">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate">Partners sign in at <a className="font-semibold text-navy underline" href={PARTNER_LOGIN_URL} target="_blank" rel="noreferrer">{PARTNER_LOGIN_URL}</a></p>
        <input type="month" value={month.slice(0, 7)} max={monthStart().slice(0, 7)} aria-label="Month"
          onChange={(event) => event.target.value && setMonth(`${event.target.value}-01`)}
          className="h-9 rounded-md border border-input bg-white px-2 text-sm" />
      </div>
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Active partners" value={String((partners ?? []).filter((p) => p.status === "active").length)} icon={Handshake} />
        <StatCard label={`Earned · ${monthLabel(month)}`} value={inrPrecise(totals.earned)} icon={IndianRupee} description="Delivered and fully paid" />
        <StatCard label="Pending" value={inrPrecise(totals.pending)} icon={Timer} description="Open orders" />
        <StatCard label="Partner sales (excl. GST)" value={inrPrecise(totals.sales)} icon={Target} description={`${totals.orders} orders`} />
      </div>

      <div className="space-y-6">
        {godowns.map((godown) => (
          <GodownPartnerCard key={godown.id} godownId={godown.id} godownName={godown.name}
            partner={(partners ?? []).find((p) => p.branch_id === godown.id && p.status === "active") ?? null}
            pastPartners={(partners ?? []).filter((p) => p.branch_id === godown.id && p.status !== "active")}
            rules={rules.filter((rule) => rule.branch_id === godown.id)} month={month} onChange={load} />
        ))}
      </div>

      <div className="mt-6"><PartnerHistoryPanel refreshKey={historyKey} /></div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
        <Panel title={`Leaderboard · ${monthLabel(month)}`}><PartnerLeaderboard leaders={leaders} /></Panel>
        <Panel title={`All partner commissions · ${monthLabel(month)}`}>
          <CommissionLinesTable lines={lines} showPartner partnerNames={partnerNames} />
        </Panel>
      </div>
    </PanelLayout>
  );
}

function GodownPartnerCard({ godownId, godownName, partner, pastPartners, rules, month, onChange }: {
  godownId: string; godownName: string; partner: Partner | null; pastPartners: Partner[]; rules: Rule[]; month: string; onChange: () => Promise<void>;
}) {
  return (
    <Panel title={`${godownName}`}>
      <div className="grid gap-6 xl:grid-cols-2">
        <div className="min-w-0">
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate">Channel partner</h3>
          {partner ? <PartnerAccount partner={partner} onChange={onChange} /> : <CreatePartnerForm godownId={godownId} godownName={godownName} onChange={onChange} />}
          {pastPartners.length > 0 && (
            <div className="mt-3 text-xs text-slate">
              Suspended: {pastPartners.map((p) => (
                <span key={p.id} className="mr-2 inline-flex items-center gap-1">{p.name}
                  {!partner && <button type="button" className="font-semibold text-gold hover:underline" onClick={() => void setStatus(p.id, "active", onChange)}>reactivate</button>}
                </span>
              ))}
            </div>
          )}
          {partner && <TargetEditor partnerId={partner.id} month={month} />}
        </div>
        <div className="min-w-0">
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate">Commission rates</h3>
          <RateEditor godownId={godownId} rules={rules} onChange={onChange} />
        </div>
      </div>
    </Panel>
  );
}

async function setStatus(partnerId: string, status: "active" | "suspended", onChange: () => Promise<void>) {
  try {
    const { setChannelPartnerStatus } = await import("@/lib/partners.functions");
    await setChannelPartnerStatus({ data: { partnerId, status } });
    toast.success(status === "active" ? "Partner reactivated" : "Partner suspended: they can no longer open the dashboard");
    await onChange();
  } catch (cause) {
    toast.error("Could not change the partner", { description: cause instanceof Error ? cause.message : undefined });
  }
}

function CreatePartnerForm({ godownId, godownName, onChange }: { godownId: string; godownName: string; onChange: () => Promise<void> }) {
  const [form, setForm] = useState({ name: "", email: "", phone: "", password: suggestPartnerPassword() });
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);
  const passwordProblem = partnerPasswordProblem(form.password);

  const submit = async () => {
    setBusy(true);
    try {
      const { createChannelPartner } = await import("@/lib/partners.functions");
      await createChannelPartner({ data: { branchId: godownId, ...form } });
      setCreated({ email: form.email.trim().toLowerCase(), password: form.password });
      toast.success(`Partner login created for ${godownName}`);
      await onChange();
    } catch (cause) {
      toast.error("The partner login was not created", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  if (created) return <CredentialsBox email={created.email} password={created.password} godownName={godownName} />;
  return (
    <div className="space-y-2 rounded-lg border border-dashed border-border p-3">
      <p className="text-sm text-slate">No partner yet. Create their login and share it with them.</p>
      <div className="grid gap-2 md:grid-cols-2 [&>*]:min-w-0">
        <div className="grid gap-1"><Label className="text-xs">Full name</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
        <div className="grid gap-1"><Label className="text-xs">Phone</Label><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
        <div className="grid gap-1"><Label className="text-xs">Login email</Label><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
        <div className="grid gap-1"><Label className="text-xs">Password</Label>
          <div className="flex gap-1">
            <Input value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className="min-w-0 font-mono" />
            <Button type="button" variant="outline" size="sm" onClick={() => setForm({ ...form, password: suggestPartnerPassword() })}>New</Button>
          </div>
          {passwordProblem && <span className="text-[11px] text-amber-700">{passwordProblem}</span>}
        </div>
      </div>
      <Button className="bg-navy text-white hover:bg-navy/90" disabled={busy || !form.name.trim() || !form.email.trim() || Boolean(passwordProblem)} onClick={() => void submit()}>
        <UserPlus className="mr-1.5 h-4 w-4" /> {busy ? "Creating…" : "Create partner login"}
      </Button>
    </div>
  );
}

function CredentialsBox({ email, password, godownName }: { email: string; password: string; godownName: string }) {
  const text = `Grain Bazar Channel Partner Commission Platform (${godownName})\nLogin: ${PARTNER_LOGIN_URL}\nEmail: ${email}\nPassword: ${password}`;
  return (
    <div className="space-y-2 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm">
      <p className="font-semibold text-emerald-900">Login created. Share these with the partner (shown once):</p>
      <pre className="whitespace-pre-wrap rounded bg-white p-2 font-mono text-xs text-navy">{text}</pre>
      <Button size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(text).then(() => toast.success("Copied"))}>
        <Copy className="mr-1.5 h-3.5 w-3.5" /> Copy
      </Button>
    </div>
  );
}

function PartnerAccount({ partner, onChange }: { partner: Partner; onChange: () => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reset = async () => {
    const next = password || suggestPartnerPassword();
    const problem = partnerPasswordProblem(next);
    if (problem) { toast.error(problem); return; }
    setBusy(true);
    try {
      const { resetChannelPartnerPassword } = await import("@/lib/partners.functions");
      await resetChannelPartnerPassword({ data: { partnerId: partner.id, password: next } });
      setShown(next);
      setPassword("");
      toast.success("New password set");
    } catch (cause) {
      toast.error("Could not set the password", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 text-sm">
      <p className="font-semibold text-navy">{partner.name}</p>
      <p className="text-slate">{partner.email}{partner.phone ? ` · ${partner.phone}` : ""}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Input placeholder="New password (blank = suggest)" value={password} onChange={(e) => setPassword(e.target.value)} className="h-8 max-w-[220px] font-mono text-xs" />
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void reset()}><KeyRound className="mr-1.5 h-3.5 w-3.5" /> Set new password</Button>
        <Button size="sm" variant="outline" className="text-danger" onClick={() => void setStatus(partner.id, "suspended", onChange)}>Suspend</Button>
      </div>
      {shown && <CredentialsBox email={partner.email} password={shown} godownName="new password" />}
    </div>
  );
}

function TargetEditor({ partnerId, month }: { partnerId: string; month: string }) {
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState<number | null>(null);
  useEffect(() => {
    void supabase.from("partner_targets").select("target_sales").eq("partner_id", partnerId).eq("month", month).maybeSingle()
      .then(({ data }) => { setSaved(data ? Number(data.target_sales) : null); setValue(data ? String(data.target_sales) : ""); });
  }, [partnerId, month]);
  const save = async () => {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) { toast.error("Enter the target in rupees"); return; }
    const { error } = await supabase.from("partner_targets").upsert({ partner_id: partnerId, month, target_sales: amount, updated_at: new Date().toISOString() });
    if (error) { toast.error("Could not save the target", { description: error.message }); return; }
    setSaved(amount);
    toast.success("Target saved");
  };
  return (
    <div className="mt-4">
      <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate">Sales target · {monthLabel(month)}</h3>
      <div className="flex items-center gap-2">
        <Input type="number" min={0} placeholder="₹ sales (excl. GST)" value={value} onChange={(e) => setValue(e.target.value)} className="h-8 max-w-[200px]" />
        <Button size="sm" variant="outline" onClick={() => void save()}>Save target</Button>
        {saved !== null && <span className="text-xs text-slate">Current: {inrPrecise(saved)}</span>}
      </div>
    </div>
  );
}

function RateEditor({ godownId, rules, onChange }: { godownId: string; rules: Rule[]; onChange: () => Promise<void> }) {
  const { products } = useApp();
  const real = products.filter((product) => !product.vendorId.startsWith("zoho:") && product.active);
  const [draft, setDraft] = useState({ productId: "", kind: "per_unit" as CommissionKind, value: "" });
  const save = async () => {
    const value = Number(draft.value);
    if (!Number.isFinite(value) || value < 0 || (draft.kind === "percent" && value > 100)) { toast.error("Enter a valid rate"); return; }
    const existing = rules.find((rule) => (rule.product_id ?? "") === draft.productId);
    const row = { branch_id: godownId, product_id: draft.productId || null, kind: draft.kind, value, updated_at: new Date().toISOString() };
    const { error } = existing
      ? await supabase.from("partner_commission_rules").update(row).eq("id", existing.id)
      : await supabase.from("partner_commission_rules").insert(row);
    if (error) { toast.error("Could not save the rate", { description: error.message }); return; }
    toast.success("Rate saved. It applies to orders placed from now on.");
    setDraft({ productId: "", kind: draft.kind, value: "" });
    await onChange();
  };
  const remove = async (rule: Rule) => {
    const { error } = await supabase.from("partner_commission_rules").delete().eq("id", rule.id);
    if (error) { toast.error("Could not remove the rate", { description: error.message }); return; }
    await onChange();
  };
  const nameOf = (id: string | null) => (id ? real.find((p) => p.id === id)?.name ?? products.find((p) => p.id === id)?.name ?? id : "Default (all other products)");
  const sorted = [...rules].sort((a, b) => (a.product_id ? 1 : 0) - (b.product_id ? 1 : 0) || nameOf(a.product_id).localeCompare(nameOf(b.product_id)));
  return (
    <div className="space-y-3">
      {sorted.length ? (
        <ul className="space-y-1 text-sm">
          {sorted.map((rule) => (
            <li key={rule.id} className="flex items-center justify-between gap-2 border-b border-border/60 pb-1">
              <span className={rule.product_id ? "text-charcoal" : "font-semibold text-navy"}>{nameOf(rule.product_id)}</span>
              <span className="flex items-center gap-2">
                <span className="font-semibold text-navy">{describeRate(rule.kind as CommissionKind, Number(rule.value))}</span>
                <button type="button" aria-label="Remove rate" className="text-slate hover:text-danger" onClick={() => void remove(rule)}><Trash2 className="h-3.5 w-3.5" /></button>
              </span>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-amber-700">No rates yet: this godown's partner earns nothing until a rate is set.</p>}
      <div className="grid gap-2 rounded-lg bg-ivory/60 p-2 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end [&>*]:min-w-0">
        <div className="grid gap-1"><Label className="text-xs">Product</Label>
          <select className="h-8 w-full min-w-0 rounded-md border border-input bg-white px-2 text-sm" value={draft.productId} onChange={(e) => setDraft({ ...draft, productId: e.target.value })}>
            <option value="">Default (all other products)</option>
            {real.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
          </select>
        </div>
        <div className="grid gap-1"><Label className="text-xs">Type</Label>
          <select className="h-8 rounded-md border border-input bg-white px-2 text-sm" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as CommissionKind })}>
            <option value="per_unit">₹ per unit</option>
            <option value="percent">% of price</option>
          </select>
        </div>
        <div className="grid gap-1"><Label className="text-xs">{draft.kind === "percent" ? "Percent" : "Rupees"}</Label>
          <Input type="number" min={0} step="0.01" value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} className="h-8" />
        </div>
        <Button size="sm" className="bg-navy text-white hover:bg-navy/90" disabled={!draft.value} onClick={() => void save()}>Save rate</Button>
      </div>
      <p className="text-[11px] text-slate">A product's own rate wins over the default. Each order line keeps the rate it was placed at.</p>
    </div>
  );
}
