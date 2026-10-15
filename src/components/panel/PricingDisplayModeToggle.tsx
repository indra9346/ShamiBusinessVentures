import { BadgePercent, Tag } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { inr, type PricingDisplayMode } from "@/lib/data";
import { cn } from "@/lib/utils";

/**
 * Admin control for how a product's price is presented on the storefront.
 * OFF  → "Direct MRP Only"   (single price, no strike-through / % OFF / savings)
 * ON   → "Discounted with Strikethrough" (MRP struck through + selling price + Save X%)
 */
export function PricingDisplayModeToggle({
  value,
  onChange,
  mrp,
  price,
  id = "pricing-display-mode",
}: {
  value: PricingDisplayMode;
  onChange: (next: PricingDisplayMode) => void;
  mrp?: number;
  price?: number;
  id?: string;
}) {
  const strike = value === "strike_through";
  const safeMrp = Number(mrp) || 0;
  const safePrice = Number(price) || 0;
  const off =
    safeMrp > safePrice && safeMrp > 0 ? Math.round(((safeMrp - safePrice) / safeMrp) * 100) : 0;

  return (
    <div className="rounded-xl border border-border bg-muted/30 p-3 sm:p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <label htmlFor={id} className="text-sm font-semibold text-foreground">
            Pricing Display Mode
          </label>
          <p className="text-xs text-muted-foreground">
            Choose how customers see the price on the storefront.
          </p>
        </div>
        <Switch
          id={id}
          checked={strike}
          onCheckedChange={(checked) => onChange(checked ? "strike_through" : "mrp_only")}
          aria-label={strike ? "Discounted with Strikethrough" : "Direct MRP Only"}
          className="mt-0.5 data-[state=checked]:bg-emerald-600"
        />
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => onChange("mrp_only")}
          aria-pressed={!strike}
          className={cn(
            "flex min-h-10 items-start gap-2 rounded-lg border p-2.5 text-left transition-all duration-200",
            !strike
              ? "border-navy bg-navy/5 ring-1 ring-navy/30"
              : "border-border bg-background hover:border-navy/40",
          )}
        >
          <Tag
            className={cn(
              "mt-0.5 h-4 w-4 shrink-0",
              !strike ? "text-navy" : "text-muted-foreground",
            )}
          />
          <span className="min-w-0">
            <span className="block text-xs font-semibold text-foreground">Direct MRP Only</span>
            <span className="block text-[11px] leading-snug text-muted-foreground">
              Shows only the direct selling price without any strike-through or discount percentage.
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={() => onChange("strike_through")}
          aria-pressed={strike}
          className={cn(
            "flex min-h-10 items-start gap-2 rounded-lg border p-2.5 text-left transition-all duration-200",
            strike
              ? "border-emerald-600 bg-emerald-50 ring-1 ring-emerald-600/30"
              : "border-border bg-background hover:border-emerald-600/40",
          )}
        >
          <BadgePercent
            className={cn(
              "mt-0.5 h-4 w-4 shrink-0",
              strike ? "text-emerald-700" : "text-muted-foreground",
            )}
          />
          <span className="min-w-0">
            <span className="block text-xs font-semibold text-foreground">
              Discounted with Strikethrough
            </span>
            <span className="block text-[11px] leading-snug text-muted-foreground">
              Shows original MRP with a strike-through line, current selling price, and Save X%
              discount badge.
            </span>
          </span>
        </button>
      </div>

      {safePrice > 0 && (
        <div className="mt-3 flex flex-wrap items-baseline gap-2 rounded-lg border border-dashed border-border bg-background px-3 py-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Preview
          </span>
          <span className="text-sm font-bold text-navy">{inr(safePrice)}</span>
          {strike ? (
            off > 0 ? (
              <>
                <span className="text-xs text-muted-foreground line-through">{inr(safeMrp)}</span>
                <span className="rounded-sm bg-emerald-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
                  {off}% OFF
                </span>
              </>
            ) : (
              <span className="text-[11px] text-muted-foreground">
                (MRP equals price — no discount to show)
              </span>
            )
          ) : (
            <span className="text-[11px] font-medium text-muted-foreground">MRP</span>
          )}
        </div>
      )}
    </div>
  );
}
