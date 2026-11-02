import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { ShoppingCart } from "lucide-react";
import type { ReorderLine } from "@/lib/payment-rules";
import { useApp } from "@/lib/store";

/**
 * An unpaid checkout's "Reorder": the same items go back in the cart, at today's prices and stock, and
 * the customer goes to the cart to place a new order.
 */
export function ReorderButton({ lines, className }: { lines: ReorderLine[]; className?: string }) {
  const { reorderLines } = useApp();
  const navigate = useNavigate();
  const reorder = () => {
    const result = reorderLines(lines);
    if (result.outOfArea) {
      toast.error("We do not deliver to your PIN code yet", { description: "Your items were not added. Change the delivery PIN code on the cart page." });
      void navigate({ to: "/cart" });
      return;
    }
    if (!result.items.length) {
      toast.error("These items are not available now", { description: result.unavailable.join(", ") });
      return;
    }
    if (result.unavailable.length) toast.warning("Some items are not available now", { description: result.unavailable.join(", ") });
    for (const line of result.reduced) toast.warning(`Only ${line.qty} of ${line.wanted} available`, { description: line.name });
    if (!result.unavailable.length && !result.reduced.length) toast.success("Items are back in your cart", { description: "Prices and stock are as they are today." });
    void navigate({ to: "/cart" });
  };
  return (
    <button type="button" onClick={reorder} className={className ?? "inline-flex items-center gap-1.5 rounded-md bg-gold px-4 py-2 text-sm font-bold text-midnight hover:bg-gold-light"}>
      <ShoppingCart className="h-4 w-4" /> Reorder
    </button>
  );
}
