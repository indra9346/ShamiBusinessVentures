import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Copy, HandCoins, Handshake, IndianRupee, KeyRound, Pencil, Target, Timer, Trash2, UserPlus } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { FilterNote, Panel, scrollToSection, StatCard } from "@/components/panel/widgets";
import { CommissionLinesTable, PartnerLeaderboard, commissionTotals, usePartnerData } from "@/components/partners/PartnerWidgets";
import { PartnerHistoryPanel } from "@/components/partners/PartnerHistory";
import { PartnerSignatureField } from "@/components/panel/GodownSignatureField";
import { CommissionMethod } from "@/components/partners/CommissionMethod";
import { adminNav } from "@/lib/panel-nav";
import { useApp } from "@/lib/store";
import { useBranches } from "@/lib/branches";
import { godownProductOptions, godownRateWarning, groupGodownProducts } from "@/lib/godown-products";
import { useLanguage } from "@/lib/i18n";
import { inrPrecise } from "@/lib/data";
import { matchesCommissionStatus } from "@/lib/panel-filters";
import { describeRate, monthLabel, monthStart, normalisePartnerPhone, partnerEmailProblem, partnerPasswordProblem, partnerPhoneProblem, suggestPartnerPassword, type CommissionKind } from "@/lib/partners";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
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
  // The money cards open the commission list below, showing just what they add up.
  const [lineView, setLineView] = useState("all");
  const openLines = (view: string) => {
    setLineView(view);
    scrollToSection("all-commissions");
  };

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
        <Link to="/admin/partner-payouts" className="inline-flex h-9 items-center gap-1.5 rounded-md bg-navy px-3 text-sm font-semibold text-white hover:bg-midnight"><HandCoins className="h-4 w-4" />Settle commissions</Link>
        <input type="month" value={month.slice(0, 7)} max={monthStart().slice(0, 7)} aria-label="Month"
          onChange={(event) => event.target.value && setMonth(`${event.target.value}-01`)}
          className="h-9 rounded-md border border-input bg-white px-2 text-sm" />
      </div>
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard onClick={() => scrollToSection("godown-partners")} label="Active partners" value={String((partners ?? []).filter((p) => p.status === "active").length)} icon={Handshake} />
        <StatCard onClick={() => openLines("earned")} label={`Earned · ${monthLabel(month)}`} value={inrPrecise(totals.earned)} icon={IndianRupee} description="Delivered and fully paid" />
        <StatCard onClick={() => openLines("pending")} label="Pending" value={inrPrecise(totals.pending)} icon={Timer} description="Open orders" />
        <StatCard onClick={() => openLines("sales")} label="Partner sales (excl. GST)" value={inrPrecise(totals.sales)} icon={Target} description={`${totals.orders} orders`} />
      </div>

      <div id="godown-partners" className="scroll-mt-36 space-y-6">
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
        <Panel id="all-commissions" title={`All partner commissions · ${monthLabel(month)}`}>
          {lineView !== "all" && (
            <FilterNote label={lineView === "earned" ? "Earned" : lineView === "pending" ? "Pending" : "Partner sales (excl. GST)"} onClear={() => setLineView("all")} />
          )}
          <CommissionLinesTable lines={lines?.filter((line) => matchesCommissionStatus(line.status, lineView)) ?? null} showPartner partnerNames={partnerNames} />
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
              {/* A former partner's signature stays on the invoices of the orders placed in their time. */}
              {pastPartners.map((p) => (
                <details key={p.id} className="mt-2">
                  <summary className="cursor-pointer font-semibold text-navy">{p.name}: signature on their invoices{p.signature_path ? "" : " (none)"}</summary>
                  <div className="mt-1"><PartnerSignatureField partner={p} onSaved={() => void onChange()} /></div>
                </details>
              ))}
            </div>
          )}
          {partner && <TargetEditor partnerId={partner.id} month={month} />}
        </div>
        <div className="min-w-0">
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate">How the partner is paid</h3>
          <CommissionMethod godownId={godownId} />
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
  const [editing, setEditing] = useState(false);
  const [contact, setContact] = useState({ email: partner.email, phone: partner.phone });
  const contactProblem = partnerEmailProblem(contact.email) ?? partnerPhoneProblem(contact.phone);
  const saveContact = async () => {
    const email = contact.email.trim().toLowerCase();
    const emailChanged = email !== partner.email.toLowerCase();
    if (emailChanged && !window.confirm(`Change the login email to ${email}?\n\nThe partner signs in with the new email from now on. The old one stops working. Their password stays the same.`)) return;
    setBusy(true);
    try {
      const { updateChannelPartnerContact } = await import("@/lib/partners.functions");
      const result = await updateChannelPartnerContact({ data: { partnerId: partner.id, email, phone: normalisePartnerPhone(contact.phone) } });
      toast.success(result.emailChanged ? "Saved. Tell the partner their new login email." : "Saved");
      setEditing(false);
      await onChange();
    } catch (cause) {
      toast.error("Could not save the partner's details", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy(false);
    }
  };
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
      <p className="break-all text-slate">{partner.email}{partner.phone ? ` · ${partner.phone}` : ""}
        <button type="button" onClick={() => { setContact({ email: partner.email, phone: partner.phone }); setEditing((open) => !open); }} className="ml-2 inline-flex items-center gap-1 text-xs font-semibold text-gold hover:underline"><Pencil className="h-3 w-3" />Change</button>
      </p>
      {editing && (
        <div className="grid gap-2 rounded-lg border border-border bg-ivory/40 p-2 md:grid-cols-2 [&>*]:min-w-0">
          <div className="grid gap-1"><Label className="text-xs">Login email</Label><Input type="email" value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} className="h-8" /></div>
          <div className="grid gap-1"><Label className="text-xs">Phone (printed on this godown's invoices)</Label><Input inputMode="tel" value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} className="h-8" /></div>
          {contactProblem && <p className="text-[11px] text-amber-700 md:col-span-2">{contactProblem}</p>}
          <div className="flex gap-2 md:col-span-2">
            <Button size="sm" className="bg-navy text-white hover:bg-navy/90" disabled={busy || Boolean(contactProblem)} onClick={() => void saveContact()}>Save</Button>
            <Button size="sm" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Input placeholder="New password (blank = suggest)" value={password} onChange={(e) => setPassword(e.target.value)} className="h-8 max-w-[220px] font-mono text-xs" />
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void reset()}><KeyRound className="mr-1.5 h-3.5 w-3.5" /> Set new password</Button>
        <Button size="sm" variant="outline" className="text-danger" onClick={() => void setStatus(partner.id, "suspended", onChange)}>Suspend</Button>
      </div>
      {shown && <CredentialsBox email={partner.email} password={shown} godownName="new password" />}
      <PartnerSignatureField partner={partner} onSaved={() => void onChange()} />
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
  const { t } = useLanguage();
  const branchState = useBranches();
  const godown = branchState.branches.find((branch) => branch.id === godownId) ?? null;
  // Every website product, hidden ones too (one rule for every godown screen, lib/godown-products.ts).
  const groups = groupGodownProducts(godownProductOptions(products, godown, branchState.prices));
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
  const setEnabled = async (rule: Rule, enabled: boolean) => {
    const { error } = await supabase.from("partner_commission_rules").update({ enabled, updated_at: new Date().toISOString() }).eq("id", rule.id);
    if (error) { toast.error("Could not change the commission", { description: error.message }); return; }
    toast.success(enabled ? "Commission on. It applies to orders placed from now on." : "Commission off. New orders of this product earn ₹0.");
    await onChange();
  };
  // A product on the default rate has no line of its own yet: this gives it one, switched off, at the default's rate.
  const turnOff = async () => {
    const existing = rules.find((rule) => rule.product_id === draft.productId);
    if (existing) { await setEnabled(existing, false); return; }
    const fallback = rules.find((rule) => rule.product_id === null);
    const { error } = await supabase.from("partner_commission_rules").insert({
      branch_id: godownId, product_id: draft.productId, kind: fallback?.kind ?? "per_unit", value: Number(fallback?.value ?? 0), enabled: false, updated_at: new Date().toISOString(),
    });
    if (error) { toast.error("Could not change the commission", { description: error.message }); return; }
    toast.success("Commission off. New orders of this product earn ₹0.");
    await onChange();
  };
  const nameOf = (id: string | null) => (id ? products.find((p) => p.id === id)?.name ?? id : "Default (all other products)");
  const sorted = [...rules].sort((a, b) => (a.product_id ? 1 : 0) - (b.product_id ? 1 : 0) || nameOf(a.product_id).localeCompare(nameOf(b.product_id)));
  return (
    <div className="space-y-3">
      {sorted.length ? (
        <ul className="space-y-1 text-sm">
          {sorted.map((rule) => (
            <li key={rule.id} className="flex items-center justify-between gap-2 border-b border-border/60 pb-1">
              <span className="min-w-0">
                <span className={rule.product_id ? "text-charcoal" : "font-semibold text-navy"}>{nameOf(rule.product_id)}</span>
                {(() => {
                  const warning = godownRateWarning(rule.product_id, products, godown, branchState.prices);
                  return warning ? <span className="mt-0.5 flex items-start gap-1 text-[11px] leading-snug text-amber-700"><AlertTriangle className="mt-px h-3 w-3 shrink-0" />{warning}</span> : null;
                })()}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {rule.enabled ? <span className="font-semibold text-navy">{describeRate(rule.kind as CommissionKind, Number(rule.value))}</span> : <span className="font-semibold text-slate">Commission off (₹0)</span>}
                <Switch checked={rule.enabled} aria-label={`Commission on or off: ${nameOf(rule.product_id)}`} onCheckedChange={(on) => void setEnabled(rule, on)} />
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
            {groups.map((group) => (
              <optgroup key={group.label} label={t(group.label)}>
                {group.options.map(({ product }) => <option key={product.id} value={product.id}>{product.name}</option>)}
              </optgroup>
            ))}
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
      {draft.productId && <Button size="sm" variant="outline" onClick={() => void turnOff()}>No commission on this product</Button>}
      <p className="text-[11px] text-slate">A product's own rate wins over the default. Each order line keeps the rate it was placed at.</p>
      <p className="text-[11px] text-slate">Switch a line off and new orders of that product earn ₹0. Orders already placed do not change.</p>
      <p className="text-[11px] text-slate">Hidden products are listed too, so a rate can be ready before the product goes on the shop.</p>
    </div>
  );
}
