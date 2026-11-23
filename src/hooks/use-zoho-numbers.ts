import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { zohoNumbersByOrder, type ZohoNumbers } from "@/lib/zoho-numbers";

/*
 * The Zoho sales order and invoice numbers of the orders a list shows (client, 17 Nov 2026), keyed by website order
 * number. Administrators read both tables (order_zoho_numbers, zoho_order_invoices). Before the 17 Nov database update
 * the sales order table is missing: lists then show the invoice numbers only, and work as before.
 */
const CHUNK = 150;

export function useZohoNumbers(orderNos: readonly string[]): Map<string, ZohoNumbers> {
  const key = [...new Set(orderNos.filter(Boolean))].sort().join("|");
  const [numbers, setNumbers] = useState<Map<string, ZohoNumbers>>(() => new Map());
  useEffect(() => {
    if (STATIC_DATA_MODE || !key) return;
    let live = true;
    void (async () => {
      const list = key.split("|");
      const salesOrders: { order_no: string; salesorder_number: string | null }[] = [];
      const invoices: { order_no: string; invoice_number: string | null; status: string | null }[] = [];
      for (let start = 0; start < list.length; start += CHUNK) {
        const part = list.slice(start, start + CHUNK);
        const [so, inv] = await Promise.all([
          supabase.from("order_zoho_numbers").select("order_no,salesorder_number").in("order_no", part),
          supabase.from("zoho_order_invoices").select("order_no,invoice_number,status").in("order_no", part),
        ]);
        if (!so.error) salesOrders.push(...(so.data ?? []));
        if (!inv.error) invoices.push(...(inv.data ?? []));
      }
      if (live) setNumbers(zohoNumbersByOrder(salesOrders, invoices));
    })().catch(() => {});
    return () => { live = false; };
  }, [key]);
  return numbers;
}
