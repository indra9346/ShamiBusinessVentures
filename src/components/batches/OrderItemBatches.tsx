import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";

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
    void supabase.rpc("order_item_batches", { _order_id: dbOrderId }).then(({ data }) => {
      if (!live) return;
      const map = new Map<string, ItemBatch[]>();
      for (const row of data ?? []) map.set(row.order_item_id, [...(map.get(row.order_item_id) ?? []), { code: row.batch_code, qty: Number(row.qty) }]);
      setByItem(map);
    });
    return () => { live = false; };
  }, [dbOrderId, linesKey]);
  return byItem;
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
