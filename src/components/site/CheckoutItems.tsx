import { getProductImageFallback, type Product } from "@/lib/data";
import { cn } from "@/lib/utils";

type Line = { productId: string; qty: number; name?: string | undefined };

/**
 * The products in a checkout, the way shopping sites show an order: a small picture, the name and the quantity for each
 * item (the first few), and "+ N more" for the rest. Pictures come from the catalogue; a product no longer in it gets the
 * category picture.
 */
export function CheckoutItems({ lines, products, max = 3, className }: { lines: readonly Line[]; products: readonly Product[]; max?: number; className?: string }) {
  const shown = lines.slice(0, max);
  const more = lines.length - shown.length;
  return (
    <ul className={cn("space-y-2", className)}>
      {shown.map((line) => {
        const product = products.find((item) => item.id === line.productId);
        const name = product?.name || line.name || line.productId;
        const image = product?.image || getProductImageFallback(product?.category, name);
        return (
          <li key={line.productId} className="flex items-center gap-3">
            <img src={image} alt="" loading="lazy" className="h-12 w-12 shrink-0 rounded-md border border-border bg-white object-contain p-0.5" />
            <div className="min-w-0">
              <p className="line-clamp-2 text-sm font-semibold leading-snug text-charcoal">{name}</p>
              <p className="text-xs text-slate"><span>Qty:</span> {`${line.qty}${product?.weight ? ` · ${product.weight}` : ""}`}</p>
            </div>
          </li>
        );
      })}
      {more > 0 && <li className="pl-[3.75rem] text-xs font-semibold text-slate">{`+ ${more}`} <span>more item(s)</span></li>}
    </ul>
  );
}
