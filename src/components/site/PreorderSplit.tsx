import type { Product } from "@/lib/data";
import { cartLineSplit, dayLabel, preorderText } from "@/lib/preorder";

/**
 * A cart or checkout line that takes pre-order units (14 Nov 2026): how many are ready now and how many arrive later,
 * ready units first as the database takes them. Nothing for a line of ready units only.
 */
export function PreorderSplit({ product, qty, className }: { product: Product; qty: number; className?: string }) {
  const arriving = Math.max(0, Number(product.incoming) || 0);
  if (arriving <= 0) return null;
  const split = cartLineSplit(qty, Math.max(0, Math.floor((Number(product.stock) || 0) - (Number(product.reserved) || 0))));
  if (split.preorder <= 0) return null;
  const by = dayLabel(product.incomingBy);
  return (
    <p className={className ?? "max-w-[14rem] text-[11px] font-semibold text-amber-800"}>
      {split.ready > 0 ? preorderText.cartSplit(split.ready, split.preorder, by) : preorderText.allArriving(split.preorder, by)}
    </p>
  );
}

/** The units of these lines that arrive later, and the latest date among them. */
export function preorderPart(lines: { product: Product; qty: number }[]) {
  let qty = 0;
  let by = "";
  let godown = "";
  for (const line of lines) {
    const arriving = Math.max(0, Number(line.product.incoming) || 0);
    if (arriving <= 0) continue;
    const split = cartLineSplit(line.qty, Math.max(0, Math.floor((Number(line.product.stock) || 0) - (Number(line.product.reserved) || 0))));
    if (split.preorder <= 0) continue;
    qty += split.preorder;
    if ((line.product.incomingBy ?? "") > by) by = line.product.incomingBy ?? "";
    godown ||= line.product.incomingGodown ?? "";
  }
  return { qty, by, godown };
}
