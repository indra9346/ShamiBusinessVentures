import { useState } from "react";
import { Pencil, RefreshCw, Save, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  getZohoSalesOrderForEdit,
  updateZohoSalesOrder,
  type ZohoEditableSalesOrder,
} from "@/lib/zoho-commerce.functions";
import { ResizableTable } from "@/hooks/use-column-resize";

type Address = ZohoEditableSalesOrder["billingAddress"];
type StatusAction = "" | "confirmed" | "void" | "cancelled";

const ADDRESS_FIELDS: [keyof Address, string][] = [
  ["attention", "Attention"],
  ["address", "Street"],
  ["city", "City"],
  ["state", "State"],
  ["zip", "PIN / ZIP"],
  ["country", "Country"],
  ["phone", "Phone"],
];

const sameAddress = (a: Address, b: Address) =>
  ADDRESS_FIELDS.every(([key]) => a[key].trim() === b[key].trim());

/**
 * Edits one Zoho sales order from the Grain Bazar admin. Every save reloads the
 * order from Zoho first; if Zoho changed since it was opened, the newer Zoho copy
 * is shown instead of being overwritten.
 */
export function ZohoSalesOrderEditor({
  salesOrderId,
  onSaved,
}: {
  salesOrderId: string;
  /** Called with Zoho's latest copy so the list row updates without a resync. */
  onSaved: (order: ZohoEditableSalesOrder) => void;
}) {
  const [original, setOriginal] = useState<ZohoEditableSalesOrder | null>(null);
  const [draft, setDraft] = useState<ZohoEditableSalesOrder | null>(null);
  const [status, setStatus] = useState<StatusAction>("");
  const [busy, setBusy] = useState<"" | "loading" | "saving">("");
  const [error, setError] = useState("");

  const open = async () => {
    setBusy("loading");
    setError("");
    try {
      const { order } = await getZohoSalesOrderForEdit({ data: { salesOrderId } });
      setOriginal(order);
      setDraft(order);
      setStatus("");
      onSaved(order);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load this order from Zoho");
    } finally {
      setBusy("");
    }
  };

  if (!draft || !original) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={open} disabled={busy === "loading"}>
          {busy === "loading" ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Pencil className="mr-2 h-4 w-4" />}
          {busy === "loading" ? "Loading latest from Zoho…" : "Edit this order"}
        </Button>
        {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      </div>
    );
  }

  const set = <K extends keyof ZohoEditableSalesOrder>(key: K, value: ZohoEditableSalesOrder[K]) =>
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  const setLine = (lineItemId: string, field: "quantity" | "rate", value: number) =>
    setDraft((current) => current ? {
      ...current,
      lineItems: current.lineItems.map((line) => line.lineItemId === lineItemId ? { ...line, [field]: value } : line),
    } : current);
  const setAddress = (kind: "billingAddress" | "shippingAddress", field: keyof Address, value: string) =>
    setDraft((current) => current ? { ...current, [kind]: { ...current[kind], [field]: value } } : current);

  const closed = ["void", "cancelled", "closed"].includes(original.orderStatus.toLowerCase());

  const save = async () => {
    const changes: Record<string, unknown> = {};
    if (draft.date !== original.date) changes["date"] = draft.date;
    if (draft.shipmentDate !== original.shipmentDate) changes["shipmentDate"] = draft.shipmentDate;
    if (draft.referenceNumber !== original.referenceNumber) changes["referenceNumber"] = draft.referenceNumber;
    if (draft.notes !== original.notes) changes["notes"] = draft.notes;
    if (draft.terms !== original.terms) changes["terms"] = draft.terms;
    if (draft.discount !== original.discount) changes["discount"] = draft.discount;
    if (draft.shippingCharge !== original.shippingCharge) changes["shippingCharge"] = draft.shippingCharge;
    if (draft.adjustment !== original.adjustment) changes["adjustment"] = draft.adjustment;
    if (draft.adjustmentDescription !== original.adjustmentDescription) changes["adjustmentDescription"] = draft.adjustmentDescription;
    const lines = draft.lineItems.filter((line) => {
      const before = original.lineItems.find((item) => item.lineItemId === line.lineItemId);
      return before && (before.quantity !== line.quantity || before.rate !== line.rate);
    });
    if (lines.length) changes["lineItems"] = lines.map(({ lineItemId, quantity, rate }) => ({ lineItemId, quantity, rate }));
    if (!sameAddress(draft.billingAddress, original.billingAddress)) changes["billingAddress"] = draft.billingAddress;
    if (!sameAddress(draft.shippingAddress, original.shippingAddress)) changes["shippingAddress"] = draft.shippingAddress;
    if (status) changes["status"] = status;
    if (Object.keys(changes).length === 0) {
      toast.info("Nothing changed");
      return;
    }
    if (draft.lineItems.some((line) => !(line.quantity > 0) || !(line.rate >= 0))) {
      setError("Each item needs a quantity above 0 and a rate of 0 or more");
      return;
    }
    setBusy("saving");
    setError("");
    try {
      const result = await updateZohoSalesOrder({
        data: {
          salesOrderId,
          expectedLastModified: original.lastModified,
          changes: changes as Parameters<typeof updateZohoSalesOrder>[0]["data"]["changes"],
        },
      });
      setOriginal(result.order);
      setDraft(result.order);
      setStatus("");
      onSaved(result.order);
      if (result.conflict) {
        setError("This order was changed in Zoho after you opened it. The latest Zoho version is now shown; reapply your edit and save again.");
      } else {
        toast.success(`Saved ${result.order.salesOrderNumber} in Zoho Commerce`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Zoho rejected the change");
      // Part of a save may have landed; show what Zoho holds now.
      try {
        const { order } = await getZohoSalesOrderForEdit({ data: { salesOrderId } });
        setOriginal(order);
        onSaved(order);
      } catch {
        // keep the error above
      }
    } finally {
      setBusy("");
    }
  };

  const money = (value: number) =>
    `${draft.currencyCode === "INR" ? "₹" : `${draft.currencyCode} `}${value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <section className="space-y-4 rounded-md border border-gold/40 bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="font-semibold text-navy">Edit {draft.salesOrderNumber}</h4>
          <p className="text-xs text-slate">
            Saves go straight to Zoho and show up in Zoho Commerce › Orders. Loaded from Zoho, last changed {original.lastModified || "—"}
            {original.linkedOrderNo ? ` · Grain Bazar order ${original.linkedOrderNo}` : ""}.
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={open} disabled={!!busy}>
            <RefreshCw className={`mr-2 h-4 w-4 ${busy === "loading" ? "animate-spin" : ""}`} /> Reload from Zoho
          </Button>
          <Button size="sm" variant="outline" onClick={() => { setDraft(null); setOriginal(null); setError(""); }} disabled={!!busy}>
            <X className="mr-2 h-4 w-4" /> Close
          </Button>
        </div>
      </div>

      {closed && (
        <p className="rounded-md bg-panel px-3 py-2 text-sm text-slate">
          This order is {original.orderStatus} in Zoho, so Zoho may refuse field changes.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div><Label htmlFor={`so-date-${salesOrderId}`}>Order date</Label>
          <Input id={`so-date-${salesOrderId}`} type="date" value={draft.date} onChange={(e) => set("date", e.target.value)} /></div>
        <div><Label htmlFor={`so-ship-${salesOrderId}`}>Expected shipment date</Label>
          <Input id={`so-ship-${salesOrderId}`} type="date" value={draft.shipmentDate} onChange={(e) => set("shipmentDate", e.target.value)} /></div>
        <div><Label htmlFor={`so-ref-${salesOrderId}`}>Reference #</Label>
          <Input id={`so-ref-${salesOrderId}`} value={draft.referenceNumber} maxLength={100} onChange={(e) => set("referenceNumber", e.target.value)} /></div>
        <div><Label htmlFor={`so-status-${salesOrderId}`}>Change status (now {original.orderStatus || "—"})</Label>
          <select
            id={`so-status-${salesOrderId}`}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={status}
            onChange={(e) => setStatus(e.target.value as StatusAction)}
          >
            <option value="">Keep current status</option>
            <option value="confirmed">Mark as Confirmed</option>
            <option value="void">Mark as Void (declined)</option>
            <option value="cancelled">Mark as Cancelled</option>
          </select></div>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <ResizableTable tableId="zoho-so-editor" className="w-full min-w-[560px] text-left text-sm">
          <thead className="bg-panel text-[11px] uppercase tracking-wide text-slate">
            <tr><th className="px-3 py-2">Item</th><th className="px-3 py-2 text-right">Quantity</th><th className="px-3 py-2 text-right">Rate</th><th className="px-3 py-2 text-right">Amount</th></tr>
          </thead>
          <tbody className="divide-y divide-border">
            {draft.lineItems.map((line) => (
              <tr key={line.lineItemId}>
                <td className="px-3 py-2 font-medium text-navy">{line.name}{line.sku && <span className="ml-1 font-mono text-xs text-slate">{line.sku}</span>}</td>
                <td className="px-3 py-2 text-right">
                  <Input aria-label={`Quantity for ${line.name}`} type="number" min={0} step="any" className="ml-auto h-8 w-24 text-right"
                    value={Number.isFinite(line.quantity) ? line.quantity : ""} onChange={(e) => setLine(line.lineItemId, "quantity", Number(e.target.value))} />
                </td>
                <td className="px-3 py-2 text-right">
                  <Input aria-label={`Rate for ${line.name}`} type="number" min={0} step="0.01" className="ml-auto h-8 w-28 text-right"
                    value={Number.isFinite(line.rate) ? line.rate : ""} onChange={(e) => setLine(line.lineItemId, "rate", Number(e.target.value))} />
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{money(line.quantity * line.rate)}</td>
              </tr>
            ))}
          </tbody>
        </ResizableTable>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div><Label htmlFor={`so-disc-${salesOrderId}`}>Discount {draft.discountIsPercent ? "(%)" : "(₹)"}</Label>
          <Input id={`so-disc-${salesOrderId}`} type="number" min={0} step="0.01" disabled={draft.discountType !== "entity_level"}
            title={draft.discountType !== "entity_level" ? "This order uses per-item discounts; change them in Zoho" : undefined}
            value={draft.discount} onChange={(e) => set("discount", Number(e.target.value))} /></div>
        <div><Label htmlFor={`so-shipc-${salesOrderId}`}>Shipping charge (₹)</Label>
          <Input id={`so-shipc-${salesOrderId}`} type="number" min={0} step="0.01" value={draft.shippingCharge} onChange={(e) => set("shippingCharge", Number(e.target.value))} /></div>
        <div><Label htmlFor={`so-adj-${salesOrderId}`}>Adjustment (₹)</Label>
          <Input id={`so-adj-${salesOrderId}`} type="number" step="0.01" value={draft.adjustment} onChange={(e) => set("adjustment", Number(e.target.value))} /></div>
        <div><Label htmlFor={`so-adjd-${salesOrderId}`}>Adjustment note</Label>
          <Input id={`so-adjd-${salesOrderId}`} maxLength={100} value={draft.adjustmentDescription} onChange={(e) => set("adjustmentDescription", e.target.value)} /></div>
      </div>
      <p className="text-xs text-slate">Zoho recalculates tax and the total ({money(original.total)} now) when you save.</p>

      <div className="grid gap-4 lg:grid-cols-2">
        {(["billingAddress", "shippingAddress"] as const).map((kind) => (
          <fieldset key={kind} className="rounded-md border border-border p-3">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate">
              {kind === "billingAddress" ? "Billing address" : "Shipping address"}
            </legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {ADDRESS_FIELDS.map(([field, label]) => (
                <div key={field} className={field === "address" ? "sm:col-span-2" : undefined}>
                  <Label htmlFor={`so-${kind}-${field}-${salesOrderId}`}>{label}</Label>
                  <Input id={`so-${kind}-${field}-${salesOrderId}`} value={draft[kind][field]}
                    onChange={(e) => setAddress(kind, field, e.target.value)} />
                </div>
              ))}
            </div>
          </fieldset>
        ))}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div><Label htmlFor={`so-notes-${salesOrderId}`}>Customer notes</Label>
          <Textarea id={`so-notes-${salesOrderId}`} rows={3} maxLength={5000} value={draft.notes} onChange={(e) => set("notes", e.target.value)} /></div>
        <div><Label htmlFor={`so-terms-${salesOrderId}`}>Terms & conditions</Label>
          <Textarea id={`so-terms-${salesOrderId}`} rows={3} maxLength={5000} value={draft.terms} onChange={(e) => set("terms", e.target.value)} /></div>
      </div>

      {error && <p className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger" role="alert">{error}</p>}

      <div className="flex justify-end">
        <Button onClick={save} disabled={!!busy}>
          {busy === "saving" ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
          {busy === "saving" ? "Saving to Zoho…" : "Save to Zoho"}
        </Button>
      </div>
    </section>
  );
}
