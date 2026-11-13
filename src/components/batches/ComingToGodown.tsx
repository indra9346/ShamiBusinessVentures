import { useEffect, useState } from "react";
import { Truck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { dayLabel, istToday, preorderText } from "@/lib/preorder";

type Coming = { product_id: string; product_name: string; expected: number; sold: number; waiting_orders: number; expected_date: string; paused: boolean };

/**
 * Staff app and channel partner page: the pre-order batches on their way to this godown (14 Nov 2026, spec 17.6),
 * without costs, suppliers or bills (godown_incoming_lots). Nothing when none is coming.
 */
export function ComingToGodown({ branchId }: { branchId: string }) {
  const [rows, setRows] = useState<Coming[]>([]);
  useEffect(() => {
    if (!branchId || STATIC_DATA_MODE) return;
    let live = true;
    const load = () => void supabase.rpc("godown_incoming_lots", { _branch_id: branchId }).then(({ data, error }) => {
      // Before the pre-order migration the function does not exist: nothing is coming.
      if (live && !error) setRows((data ?? []) as Coming[]);
    });
    load();
    const timer = window.setInterval(load, 5 * 60_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [branchId]);
  if (!rows.length) return null;
  const today = istToday();
  return (
    <section className="rounded-xl border border-amber-300 bg-amber-50/70 p-4">
      <h2 className="flex items-center gap-2 text-sm font-bold text-amber-950"><Truck className="h-4 w-4" />{preorderText.comingTitle}</h2>
      <ul className="mt-2 grid gap-1.5 text-sm">
        {rows.map((row) => (
          <li key={`${row.product_id}-${row.expected_date}-${row.expected}`} className="min-w-0 rounded-md bg-white px-3 py-2">
            <p className="break-words font-semibold text-navy">{row.product_name}</p>
            <p className="text-xs text-slate">{preorderText.comingLine(row.expected, dayLabel(row.expected_date, { todayIst: today }), row.sold)}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
