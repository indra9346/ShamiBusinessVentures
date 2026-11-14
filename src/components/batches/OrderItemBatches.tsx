import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { arrivalState, istToday } from "@/lib/preorder";

type ItemBatch = { code: string; qty: number };

/**
 * Batch / stock numbers of each line of an order (customer: own orders; admin: any). Pass
 * `linesKey` (the lines and quantities) so an edited quantity is read again.
 */
export function useOrderItemBatches(dbOrderId: string | undefined, linesKey = "") {
  const [byItem, setByItem] = useState<Map<string, ItemBatch[]>>(new Map());
  useEffect(() => {
    if (!dbOrderId || STATIC_DATA_MODE) return;
    let live = true;
    const load = () => void supabase.rpc("order_item_batches", { _order_id: dbOrderId }).then(({ data }) => {
      if (!live) return;
      const map = new Map<string, ItemBatch[]>();
      for (const row of data ?? []) map.set(row.order_item_id, [...(map.get(row.order_item_id) ?? []), { code: row.batch_code, qty: Number(row.qty) }]);
      setByItem(map);
    });
    load();
    // A cancel or quantity change shows on the page before the server has saved it: read again shortly after.
    const again = window.setTimeout(load, 3000);
    return () => { live = false; window.clearTimeout(again); };
  }, [dbOrderId, linesKey]);
  return byItem;
}

/** A pre-ordered line (14 Nov 2026): units still to come, when, and the day they arrived. No codes or costs. */
export type ItemArrival = { preorderQty: number; waiting: number; expectedDate: string | null; arrivedOn: string | null };

/** The order's pre-ordered lines (order_item_arrivals), read again when the lines change. */
export function useOrderItemArrivals(dbOrderId: string | undefined, linesKey = "") {
  const [byItem, setByItem] = useState<Map<string, ItemArrival>>(new Map());
  useEffect(() => {
    if (!dbOrderId || STATIC_DATA_MODE) return;
    let live = true;
    void supabase.rpc("order_item_arrivals", { _order_id: dbOrderId }).then(({ data, error }) => {
      // Before the pre-order migration the function does not exist: no line is pre-ordered.
      if (!live || error) return;
      setByItem(new Map((data ?? []).map((row) => [row.order_item_id, {
        preorderQty: Number(row.preorder_qty) || 0, waiting: Number(row.waiting) || 0, expectedDate: row.expected_date, arrivedOn: row.arrived_on,
      }])));
    });
    return () => { live = false; };
  }, [dbOrderId, linesKey]);
  return byItem;
}

/** Admin: the codes of the pre-order batches the order's waiting lines hold (admins read batches and allocations). */
export function useWaitingLotCodes(arrivals: Map<string, ItemArrival>) {
  const [codes, setCodes] = useState<string[]>([]);
  const waitingIds = [...arrivals.entries()].filter(([, a]) => a.waiting > 0).map(([id]) => id).sort().join(",");
  useEffect(() => {
    if (!waitingIds || STATIC_DATA_MODE) { setCodes([]); return; }
    let live = true;
    void (async () => {
      const { data: allocations } = await supabase.from("order_item_batch_allocations").select("batch_id,reserved_quantity,released_quantity")
        .in("order_item_id", waitingIds.split(","));
      const ids = [...new Set((allocations ?? []).filter((a) => Number(a.reserved_quantity) > Number(a.released_quantity)).map((a) => a.batch_id))];
      const { data: lots } = ids.length ? await supabase.from("batches").select("batch_code").in("id", ids).eq("stage", "incoming") : { data: [] };
      if (live) setCodes((lots ?? []).map((lot) => lot.batch_code).sort());
    })();
    return () => { live = false; };
  }, [waitingIds]);
  return codes;
}

/** Admin: orders waiting for goods (their lines hold units of pre-order batches not matched yet), with the latest date. */
export function useWaitingOrders(reloadKey = "") {
  const [byOrder, setByOrder] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (STATIC_DATA_MODE) return;
    let live = true;
    void (async () => {
      const { data: lots, error } = await supabase.from("batches").select("id,expected_date").eq("stage", "incoming");
      if (error || !lots?.length) { if (live) setByOrder(new Map()); return; }
      const dateOf = new Map(lots.map((lot) => [lot.id, lot.expected_date ?? ""]));
      const { data: allocations } = await supabase.from("order_item_batch_allocations").select("order_item_id,batch_id,reserved_quantity,released_quantity")
        .in("batch_id", lots.map((lot) => lot.id));
      const live_ = (allocations ?? []).filter((a) => Number(a.reserved_quantity) > Number(a.released_quantity));
      const itemIds = [...new Set(live_.map((a) => a.order_item_id))];
      const { data: items } = itemIds.length ? await supabase.from("order_items").select("id,order_id").in("id", itemIds) : { data: [] };
      const orderOf = new Map((items ?? []).map((item) => [item.id, item.order_id]));
      const map = new Map<string, string>();
      for (const a of live_) {
        const orderId = orderOf.get(a.order_item_id);
        if (!orderId) continue;
        const by = dateOf.get(a.batch_id) ?? "";
        if (by > (map.get(orderId) ?? "")) map.set(orderId, by); else if (!map.has(orderId)) map.set(orderId, by);
      }
      if (live) setByOrder(map);
    })();
    return () => { live = false; };
  }, [reloadKey]);
  return byOrder;
}

/** A customer's orders still waiting for pre-order goods (their own orders only: order_items and order_item_arrivals). */
export function useCustomerWaitingOrders(dbOrderIds: string[]) {
  const [waiting, setWaiting] = useState<Set<string>>(new Set());
  const key = [...dbOrderIds].sort().join(",");
  useEffect(() => {
    if (!key || STATIC_DATA_MODE) return;
    let live = true;
    void (async () => {
      const { data, error } = await supabase.from("order_items").select("order_id").gt("preorder_qty", 0).in("order_id", key.split(","));
      // Before the pre-order migration the column does not exist: no order waits.
      if (error) return;
      const out = new Set<string>();
      for (const orderId of new Set((data ?? []).map((row) => row.order_id))) {
        const { data: rows } = await supabase.rpc("order_item_arrivals", { _order_id: orderId });
        if ((rows ?? []).some((row) => Number(row.waiting) > 0)) out.add(orderId);
      }
      if (live) setWaiting(out);
    })();
    return () => { live = false; };
  }, [key]);
  return waiting;
}

/** Units of the order still to come and the latest expected date: 0 when nothing waits. */
export function orderWaiting(arrivals: Map<string, ItemArrival>) {
  let waiting = 0;
  let by = "";
  for (const a of arrivals.values()) {
    waiting += a.waiting;
    if (a.waiting > 0 && (a.expectedDate ?? "") > by) by = a.expectedDate ?? "";
  }
  return { waiting, by };
}

/**
 * "Waiting for goods · arriving by 20 Nov", "Arrived on 19 Nov · ready to collect" or "Running late" under a line. With
 * the order (review fix): nothing once it is delivered or cancelled, and just "Arrived on 19 Nov" for home delivery or an
 * unpaid checkout.
 */
export function ItemArrivalNote({ arrival, order }: { arrival: ItemArrival | undefined; order?: { status?: string | null; delivery?: string | null } }) {
  if (!arrival) return null;
  const state = arrivalState({ waiting: arrival.waiting, expected_date: arrival.expectedDate, arrived_on: arrival.arrivedOn }, istToday(),
    order ? { status: order.status ?? "", pickup: /^pickup/i.test(order.delivery ?? "") } : undefined);
  if (state.state === "none") return null;
  return (
    <p className={`mt-0.5 text-[11px] font-semibold ${state.state === "arrived" ? "text-emerald-700" : "text-amber-800"}`}>{state.text}</p>
  );
}

/** "Batch CLK-311026-01" under an order line; admins can open the batch. */
export function ItemBatchCodes({ batches, admin }: { batches: ItemBatch[] | undefined; admin?: boolean }) {
  if (!batches?.length) return null;
  return (
    <p className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-slate">
      <span>{batches.length === 1 ? "Batch" : "Batches"}</span>
      {batches.map((b) => (
        <span key={b.code} className="rounded bg-ivory px-1.5 py-0.5 font-mono font-semibold text-navy">
          {admin
            ? <Link to="/admin/batches" search={{ q: b.code }} className="hover:underline">{b.code}</Link>
            : b.code}
          {batches.length > 1 && <span className="font-sans font-normal text-slate"> ×{b.qty}</span>}
        </span>
      ))}
    </p>
  );
}
