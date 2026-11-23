import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";

/** Zoho's sales order number (CLK-SO-…) and invoice number (CLKINV…) of an order, when Zoho has them. */
export type ZohoNumbers = { salesOrder: string; invoice: string; invoiceStatus: string };

/**
 * The Zoho sales order and invoice numbers of some orders, by order number (Sandesh, 21 Nov 2026: "make it show Sales
 * Order Number and Invoice number in our portal"). Read-only; an order Zoho hasn't numbered yet is simply missing.
 */
export function useZohoNumbers(orderNos: readonly string[]) {
  const key = useMemo(() => [...new Set(orderNos.filter(Boolean))].sort().join(","), [orderNos]);
  const [numbers, setNumbers] = useState<Map<string, ZohoNumbers>>(new Map());
  useEffect(() => {
    if (STATIC_DATA_MODE || !key) return;
    const list = key.split(",");
    let active = true;
    const untyped = supabase as unknown as { from: (table: string) => { select: (columns: string) => { in: (column: string, values: string[]) => Promise<{ data: Record<string, unknown>[] | null }> } } };
    void (async () => {
      const found = new Map<string, ZohoNumbers>();
      for (let i = 0; i < list.length; i += 150) {
        const part = list.slice(i, i + 150);
        const [invoices, orders] = await Promise.all([
          untyped.from("zoho_order_invoices").select("order_no,invoice_number,status").in("order_no", part).catch(() => ({ data: null })),
          untyped.from("order_zoho_numbers").select("order_no,salesorder_number").in("order_no", part).catch(() => ({ data: null })),
        ]);
        for (const row of orders.data ?? []) {
          const no = String(row["order_no"] ?? "");
          found.set(no, { ...(found.get(no) ?? { salesOrder: "", invoice: "", invoiceStatus: "" }), salesOrder: String(row["salesorder_number"] ?? "") });
        }
        for (const row of invoices.data ?? []) {
          const no = String(row["order_no"] ?? "");
          if (!row["invoice_number"]) continue;
          found.set(no, { ...(found.get(no) ?? { salesOrder: "", invoice: "", invoiceStatus: "" }), invoice: String(row["invoice_number"]), invoiceStatus: String(row["status"] ?? "") });
        }
      }
      if (active) setNumbers(found);
    })();
    return () => { active = false; };
  }, [key]);
  return numbers;
}

/** "SO CLK-SO-2111260469 · Invoice CLKINV2011260384", or "" when Zoho has neither yet. */
export function zohoNumbersText(numbers: ZohoNumbers | undefined) {
  if (!numbers) return "";
  return [numbers.salesOrder && `SO ${numbers.salesOrder}`, numbers.invoice && `Invoice ${numbers.invoice}`].filter(Boolean).join(" · ");
}
