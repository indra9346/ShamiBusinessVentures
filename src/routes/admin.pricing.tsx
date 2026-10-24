import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Calculator, IndianRupee, Layers, Tag } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel, StatCard } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { inrPrecise } from "@/lib/data";
import { priceLotTotals } from "@/lib/pricing";
import { useApp } from "@/lib/store";
import { reloadBranches, useBranches } from "@/lib/branches";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export const Route = createFileRoute("/admin/pricing")({
  head: () => ({ meta: [{ title: "Pricing | Grain Bazar Admin" }, { name: "robots", content: "noindex" }] }),
  component: AdminPricing,
});

type Lot = Database["public"]["Tables"]["price_lots"]["Row"];

/** The white (entered) columns, as text while editing. */
type Form = {
  id: string; lotCode: string; purchaseDate: string; orderFolio: string; factory: string; item: string;
  productId: string; branchId: string; quantityQntl: string; price: string; commission: string; gstRate: string;
  transport: string; amaliTransport: string; amaliShami: string; driverTips: string; unloading: string; margin: string; bagKg: string;
};

const emptyForm = (branchId = ""): Form => ({
  id: "", lotCode: "", purchaseDate: new Date().toISOString().slice(0, 10), orderFolio: "1", factory: "", item: "S1",
  productId: "", branchId, quantityQntl: "", price: "", commission: "", gstRate: "5", transport: "",
  amaliTransport: "-7", amaliShami: "", driverTips: "", unloading: "7", margin: "", bagKg: "50",
});

const num = (value: string) => {
  const parsed = Number(value.replace(/,/g, "").replace(/^\((.*)\)$/, "-$1"));
  return Number.isFinite(parsed) ? parsed : 0;
};

const formFrom = (lot: Lot): Form => ({
  id: lot.id, lotCode: lot.lot_code, purchaseDate: lot.purchase_date ?? "", orderFolio: lot.order_folio, factory: lot.factory,
  item: lot.item, productId: lot.product_id ?? "", branchId: lot.branch_id ?? "", quantityQntl: String(lot.quantity_qntl ?? ""),
  price: String(lot.price), commission: String(lot.commission), gstRate: String(lot.gst_rate), transport: String(lot.transport),
  amaliTransport: String(lot.amali_transport), amaliShami: String(lot.amali_shami), driverTips: String(lot.driver_tips),
  unloading: String(lot.unloading), margin: String(lot.margin), bagKg: String(lot.bag_kg),
});

/** Brackets for deductions, as in the sheet: -7 shows as (7). */
const money = (value: number) => (value < 0 ? `(${inrPrecise(-value).replace("₹", "")})` : inrPrecise(value).replace("₹", ""));

function AdminPricing() {
  const { products, updateProduct } = useApp();
  const { branches, ready } = useBranches();
  const godowns = branches.filter((branch) => !branch.vendorId);
  const [lots, setLots] = useState<Lot[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [form, setForm] = useState<Form>(() => emptyForm());
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState<Lot | null>(null);
  const [busyApply, setBusyApply] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("price_lots").select("*")
      .order("purchase_date", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false });
    if (error) { setLoadError(error.message); setLots([]); return; }
    setLoadError("");
    setLots(data ?? []);
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!form.branchId && ready) setForm((current) => ({ ...current, branchId: godowns.find((branch) => branch.isDefault)?.id ?? "" }));
  }, [ready, godowns, form.branchId]);

  const live = priceLotTotals({
    price: num(form.price), commission: num(form.commission), gstRate: num(form.gstRate), transport: num(form.transport),
    amaliTransport: num(form.amaliTransport), amaliShami: num(form.amaliShami), driverTips: num(form.driverTips),
    unloading: num(form.unloading), margin: num(form.margin), bagKg: num(form.bagKg) || 50,
  });

  const productName = (id: string | null) => products.find((product) => product.id === id)?.name ?? "—";
  const godownName = (id: string | null) => branches.find((branch) => branch.id === id)?.name ?? "—";
  const latest = lots?.[0];
  const stats = useMemo(() => ({
    count: lots?.length ?? 0,
    applied: lots?.filter((lot) => lot.applied_at).length ?? 0,
  }), [lots]);

  const save = async () => {
    if (num(form.price) <= 0) { toast.error("Enter the purchase price per quintal"); return; }
    if (num(form.bagKg) <= 0) { toast.error("Enter the bag size in kg"); return; }
    const row = {
      lot_code: form.lotCode.trim(), purchase_date: form.purchaseDate || null, order_folio: form.orderFolio.trim(),
      factory: form.factory.trim(), item: form.item.trim(), product_id: form.productId || null, branch_id: form.branchId || null,
      quantity_qntl: num(form.quantityQntl), price: num(form.price), commission: num(form.commission), gst_rate: num(form.gstRate),
      transport: num(form.transport), amali_transport: num(form.amaliTransport), amali_shami: num(form.amaliShami),
      driver_tips: num(form.driverTips), unloading: num(form.unloading), margin: num(form.margin), bag_kg: num(form.bagKg),
    };
    setSaving(true);
    const { error } = form.id
      ? await supabase.from("price_lots").update(row).eq("id", form.id)
      : await supabase.from("price_lots").insert(row);
    setSaving(false);
    if (error) { toast.error("Could not save the lot", { description: error.message }); return; }
    toast.success(form.id ? "Lot updated" : "Lot added", { description: `Selling price ${inrPrecise(live.sellingBag)} per ${num(form.bagKg)} kg bag` });
    setForm(emptyForm(form.branchId));
    await load();
  };

  const remove = async (lot: Lot) => {
    const { error } = await supabase.from("price_lots").delete().eq("id", lot.id);
    if (error) { toast.error("Could not delete the lot", { description: error.message }); return; }
    toast.success("Lot deleted");
    await load();
  };

  /** Copies the lot's bag price to its godown: the godown's Zoho price list, or the item's normal price. */
  const applyPrice = async (lot: Lot) => {
    const branch = branches.find((item) => item.id === lot.branch_id);
    const product = products.find((item) => item.id === lot.product_id);
    if (!branch || !product) { toast.error("Choose the website product and the godown for this lot first"); return; }
    setBusyApply(true);
    try {
      if (branch.zohoPricebookId) {
        const { error } = await supabase.rpc("admin_set_branch_price", { _branch_id: branch.id, _product_id: product.id, _price: Number(lot.selling_bag), _listed: true });
        if (error) throw new Error(error.message);
        // Send it to the godown's Zoho price list now rather than at the next 15-minute sync.
        const { syncZohoGodownsNow } = await import("@/lib/zoho-commerce.functions");
        const result = await syncZohoGodownsNow();
        if (result.prices.errors.length) toast.warning("Saved on the website; Zoho will be updated at the next sync", { description: result.prices.errors[0] });
        await reloadBranches();
      } else if (!(await updateProduct(product.id, { price: Number(lot.selling_bag) }))) {
        throw new Error("The product price could not be saved");
      }
      await supabase.from("price_lots").update({ applied_price: Number(lot.selling_bag), applied_branch_id: branch.id, applied_at: new Date().toISOString() }).eq("id", lot.id);
      toast.success(`${product.name} at ${branch.name}: ${inrPrecise(Number(lot.selling_bag))}`, {
        description: branch.zohoPricebookId ? `Godown price list "${branch.zohoPricebookName}" updated` : "Normal price updated (godowns without a price list)",
      });
      setApplying(null);
      await load();
    } catch (cause) {
      toast.error("Could not set the price", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusyApply(false);
    }
  };

  const field = (key: keyof Form, label: string, props: { numeric?: boolean; placeholder?: string } = {}) => (
    <div className="grid gap-1">
      <Label className="text-[11px] text-slate">{label}</Label>
      <Input
        className="h-8 bg-white text-sm"
        inputMode={props.numeric ? "decimal" : undefined}
        placeholder={props.placeholder}
        value={form[key]}
        onChange={(event) => setForm({ ...form, [key]: event.target.value })}
      />
    </div>
  );
  const result = (label: string, value: string) => (
    <div className="rounded-md bg-emerald-50 px-3 py-2 ring-1 ring-emerald-200">
      <p className="text-[11px] font-medium text-emerald-800">{label}</p>
      <p className="text-base font-bold text-navy">{value}</p>
    </div>
  );

  const selectedProduct = products.find((product) => product.id === form.productId);
  const bagMismatch = selectedProduct && num(form.bagKg) > 0 && !new RegExp(`\\b${num(form.bagKg)}\\s*kg`, "i").test(`${selectedProduct.name} ${selectedProduct.weight}`);

  return (
    <PanelLayout items={adminNav} tone="admin" title="Pricing" subtitle="Purchase lots → landing cost → selling price per godown">
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Purchase lots" value={String(stats.count)} icon={Layers} />
        <StatCard label="Latest selling price (bag)" value={latest ? inrPrecise(Number(latest.selling_bag)) : "—"} icon={Tag} />
        <StatCard label="Latest landing price (qntl)" value={latest ? inrPrecise(Number(latest.landing_price)) : "—"} icon={IndianRupee} />
        <StatCard label="Prices set on godowns" value={String(stats.applied)} icon={Calculator} />
      </div>

      <Panel title={form.id ? "Edit purchase lot" : "New purchase lot"} className="mb-6">
        <p className="mb-3 text-xs text-slate">Enter the white fields per quintal (Qntl); the green results are calculated as in the Shami summary sheet. Use a minus sign (or brackets) for deductions such as the transporter's amali.</p>
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {field("lotCode", "Unique ID")}
          <div className="grid gap-1"><Label className="text-[11px] text-slate">Date</Label>
            <Input type="date" className="h-8 bg-white text-sm" value={form.purchaseDate} onChange={(event) => setForm({ ...form, purchaseDate: event.target.value })} /></div>
          {field("orderFolio", "Order folio")}
          {field("factory", "Factory", { placeholder: "Belgaum Sugars" })}
          {field("item", "Item", { placeholder: "S1" })}
          {field("quantityQntl", "Quantity purchased (Qntl)", { numeric: true })}
          {field("price", "Price (₹/Qntl)", { numeric: true })}
          {field("commission", "Commission", { numeric: true })}
          {field("gstRate", "GST %", { numeric: true })}
          {field("transport", "Transport", { numeric: true })}
          {field("amaliTransport", "Amali (Transport)", { numeric: true, placeholder: "-7" })}
          {field("amaliShami", "Amali (Shami)", { numeric: true })}
          {field("driverTips", "Driver tips", { numeric: true })}
          {field("unloading", "Unloading charges", { numeric: true })}
          {field("margin", "Shami margin", { numeric: true })}
          {field("bagKg", "Bag size (kg)", { numeric: true })}
          <div className="grid gap-1 sm:col-span-2"><Label className="text-[11px] text-slate">Website product</Label>
            <select className="h-8 rounded-md border border-input bg-white px-2 text-sm" value={form.productId} onChange={(event) => setForm({ ...form, productId: event.target.value })}>
              <option value="">Choose…</option>
              {products.filter((product) => !product.vendorId.startsWith("zoho:")).map((product) => (
                <option key={product.id} value={product.id}>{product.name} ({product.weight})</option>
              ))}
            </select>
          </div>
          <div className="grid gap-1"><Label className="text-[11px] text-slate">Godown</Label>
            <select className="h-8 rounded-md border border-input bg-white px-2 text-sm" value={form.branchId} onChange={(event) => setForm({ ...form, branchId: event.target.value })}>
              <option value="">Choose…</option>
              {godowns.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
            </select>
          </div>
        </div>
        {bagMismatch && <p className="mt-2 text-xs text-amber-700">Check: "{selectedProduct?.name}" is sold as {selectedProduct?.weight}, but this lot's bag size is {num(form.bagKg)} kg.</p>}
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {result(`GST (${num(form.gstRate)}%)`, inrPrecise(live.gst))}
          {result("Landing price (Qntl)", inrPrecise(live.landing))}
          {result("Selling price (Qntl)", inrPrecise(live.sellingQntl))}
          {result(`Selling price (${num(form.bagKg) || 50} kg bag)`, inrPrecise(live.sellingBag))}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button className="bg-navy text-white hover:bg-navy/90" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : form.id ? "Save changes" : "Add lot"}</Button>
          {form.id && <Button variant="outline" onClick={() => setForm(emptyForm(form.branchId))}>Cancel edit</Button>}
        </div>
      </Panel>

      <Panel title="Purchase lots">
        {loadError ? (
          <p className="text-sm text-danger">Lots could not be loaded: {loadError}</p>
        ) : lots === null ? (
          <p className="text-sm text-slate">Loading…</p>
        ) : lots.length === 0 ? (
          <p className="text-sm text-slate">No lots yet. Add the first one above.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1400px] text-right text-xs">
              <thead>
                <tr className="border-b border-border text-[11px] uppercase text-slate">
                  {["Unique ID", "Date", "Folio", "Factory", "Item", "Qty (Qntl)", "Price", "Commission"].map((h) => <th key={h} className="px-2 py-2 text-left first:pl-0">{h}</th>)}
                  <th className="bg-emerald-50 px-2 py-2">GST</th>
                  {["Transport", "Amali (T)", "Amali (Shami)", "Driver tips", "Unloading"].map((h) => <th key={h} className="px-2 py-2">{h}</th>)}
                  <th className="bg-emerald-50 px-2 py-2">Landing</th>
                  <th className="px-2 py-2">Margin</th>
                  <th className="bg-emerald-50 px-2 py-2">Selling (Qntl)</th>
                  <th className="bg-emerald-50 px-2 py-2">Selling (Bag)</th>
                  <th className="px-2 py-2 text-left">Product → godown</th>
                  <th className="px-2 py-2 text-left">Actions</th>
                </tr>
              </thead>
              <tbody>
                {lots.map((lot) => (
                  <tr key={lot.id} className="border-b border-border/60 align-top">
                    <td className="px-2 py-2 pl-0 text-left font-semibold text-navy">{lot.lot_code || "—"}</td>
                    <td className="px-2 py-2 text-left">{lot.purchase_date ? new Date(`${lot.purchase_date}T00:00:00`).toLocaleDateString("en-IN") : "—"}</td>
                    <td className="px-2 py-2 text-left">{lot.order_folio || "—"}</td>
                    <td className="px-2 py-2 text-left">{lot.factory || "—"}</td>
                    <td className="px-2 py-2 text-left">{lot.item || "—"}</td>
                    <td className="px-2 py-2">{Number(lot.quantity_qntl).toLocaleString("en-IN")}</td>
                    <td className="px-2 py-2">{money(Number(lot.price))}</td>
                    <td className="px-2 py-2">{Number(lot.commission) ? money(Number(lot.commission)) : "—"}</td>
                    <td className="bg-emerald-50 px-2 py-2">{money(Number(lot.gst))}</td>
                    <td className="px-2 py-2">{money(Number(lot.transport))}</td>
                    <td className="px-2 py-2">{money(Number(lot.amali_transport))}</td>
                    <td className="px-2 py-2">{Number(lot.amali_shami) ? money(Number(lot.amali_shami)) : "—"}</td>
                    <td className="px-2 py-2">{Number(lot.driver_tips) ? money(Number(lot.driver_tips)) : "—"}</td>
                    <td className="px-2 py-2">{money(Number(lot.unloading))}</td>
                    <td className="bg-emerald-50 px-2 py-2 font-semibold">{money(Number(lot.landing_price))}</td>
                    <td className="px-2 py-2">{money(Number(lot.margin))}</td>
                    <td className="bg-emerald-50 px-2 py-2 font-semibold">{money(Number(lot.selling_qntl))}</td>
                    <td className="bg-emerald-50 px-2 py-2 font-bold text-navy">{money(Number(lot.selling_bag))}</td>
                    <td className="px-2 py-2 text-left">
                      <p>{productName(lot.product_id)}</p>
                      <p className="text-slate">{godownName(lot.branch_id)}</p>
                      {lot.applied_at && <p className="text-emerald-700">Set {inrPrecise(Number(lot.applied_price))} · {new Date(lot.applied_at).toLocaleDateString("en-IN")}</p>}
                    </td>
                    <td className="px-2 py-2 text-left">
                      <div className="flex flex-col gap-1">
                        <Button size="sm" className="h-7 bg-gold text-midnight hover:bg-gold/90" onClick={() => setApplying(lot)}>Set as godown price</Button>
                        <div className="flex gap-1">
                          <Button size="sm" variant="outline" className="h-7" onClick={() => setForm(formFrom(lot))}>Edit</Button>
                          <Button size="sm" variant="outline" className="h-7 text-danger" onClick={() => void remove(lot)}>Delete</Button>
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Dialog open={!!applying} onOpenChange={(open) => { if (!open) setApplying(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Set as godown price</DialogTitle>
            <DialogDescription>Customers of this godown will pay this price. It is also sent to Zoho.</DialogDescription>
          </DialogHeader>
          {applying && (() => {
            const branch = branches.find((item) => item.id === applying.branch_id);
            return (
              <div className="space-y-1 text-sm">
                <p><span className="text-slate">Product:</span> <strong>{productName(applying.product_id)}</strong></p>
                <p><span className="text-slate">Godown:</span> <strong>{godownName(applying.branch_id)}</strong></p>
                <p><span className="text-slate">New price:</span> <strong className="text-navy">{inrPrecise(Number(applying.selling_bag))}</strong> per {Number(applying.bag_kg)} kg bag</p>
                <p className="text-xs text-slate">{branch?.zohoPricebookId
                  ? `Updates the godown's Zoho price list "${branch.zohoPricebookName}".`
                  : "This godown has no Zoho price list: this changes the item's normal price (used by every godown without a price list) and the Zoho item rate."}</p>
              </div>
            );
          })()}
          <DialogFooter>
            <Button variant="outline" onClick={() => setApplying(null)}>Cancel</Button>
            <Button className="bg-navy text-white hover:bg-navy/90" disabled={busyApply} onClick={() => applying && void applyPrice(applying)}>{busyApply ? "Setting…" : "Set price"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PanelLayout>
  );
}
