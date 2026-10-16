import { useId } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  computeRatePrice,
  defaultRatePricing,
  deriveRatePricing,
  formatPackSize,
  inrPrecise,
  isMeasureUnit,
  isVolumeUnit,
  ratePerBaseUnit,
  toBaseQuantity,
  type MeasureUnit,
  type Product,
  type RatePricing,
} from "@/lib/data";

/** Form state for the trade-rate and Zoho item fields (inputs stay strings while typing). */
export type TradeFieldsState = {
  useRate: boolean;
  packQty: string;
  packUnit: MeasureUnit;
  basisQty: string;
  basisUnit: MeasureUnit;
  basisRate: string;
  brand: string;
  manufacturer: string;
  unit: string;
  hsn: string;
};

const SELLING_UNITS = ["bag", "tin", "jar", "pouch", "carton", "box", "pcs", "kg", "L"];
/** Pack sizes are entered in these units; the rate is always per QTL (weights) or per litre. */
const PACK_UNITS: MeasureUnit[] = ["kg", "g", "L", "ml"];

/** The fixed rate basis for a pack unit: 1 QTL (100 kg) for weights, 1 L for volumes. */
function basisFor(packUnit: MeasureUnit): { basisQty: string; basisUnit: MeasureUnit } {
  return isVolumeUnit(packUnit) ? { basisQty: "1", basisUnit: "L" } : { basisQty: "1", basisUnit: "QTL" };
}

const paise = (n: number) => Math.round(n * 100) / 100;
/** Suggested pack sizes; any other value can be typed. */
const PACK_SIZES_MASS = [1, 5, 10, 25, 26, 30, 50, 100];
const PACK_SIZES_VOLUME = [1, 2, 5, 15];

export function emptyTradeFields(category: string): TradeFieldsState {
  const rate = defaultRatePricing(category);
  return {
    useRate: true,
    packQty: String(rate.packQty),
    packUnit: rate.packUnit,
    basisQty: String(rate.basisQty),
    basisUnit: rate.basisUnit,
    basisRate: "",
    brand: "",
    manufacturer: "",
    unit: /oil/i.test(category) ? "tin" : "bag",
    hsn: "",
  };
}

export function tradeFieldsFromProduct(product: Product): TradeFieldsState {
  // Older products open with the rate worked out from their price and pack weight.
  const rate = product.ratePricing ?? deriveRatePricing(product) ?? defaultRatePricing(product.category);
  const storedPackUnit = isMeasureUnit(rate.packUnit) ? rate.packUnit : "kg";
  // A pack entered as QTL or tonne opens in kg (1 QTL → 100 kg).
  const packUnit = PACK_UNITS.includes(storedPackUnit) ? storedPackUnit : isVolumeUnit(storedPackUnit) ? "L" : "kg";
  const packQty = packUnit === storedPackUnit ? rate.packQty : toBaseQuantity(rate.packQty, storedPackUnit);
  const basis = basisFor(packUnit);
  const perUnit = ratePerBaseUnit(rate);
  const basisRate = perUnit ? paise(perUnit.rate * toBaseQuantity(1, basis.basisUnit)) : rate.basisRate;
  return {
    useRate: !!product.ratePricing,
    packQty: String(packQty),
    packUnit,
    ...basis,
    basisRate: basisRate ? String(basisRate) : "",
    brand: product.brand ?? "",
    manufacturer: product.manufacturer ?? "",
    unit: product.unit ?? "",
    hsn: product.hsn ?? "",
  };
}

export function ratePricingFromFields(fields: TradeFieldsState): RatePricing | null {
  if (!fields.useRate) return null;
  return {
    packQty: Number(fields.packQty),
    packUnit: fields.packUnit,
    basisQty: Number(fields.basisQty),
    basisUnit: fields.basisUnit,
    basisRate: Number(fields.basisRate),
  };
}

/** Checks the fields before save; returns an error message or null. */
export function validateTradeFields(fields: TradeFieldsState): string | null {
  if (fields.hsn.trim() && !/^\d{4,8}$/.test(fields.hsn.trim()))
    return "HSN/SAC must be 4 to 8 digits";
  if (!fields.useRate) return null;
  const pricing = ratePricingFromFields(fields);
  if (computeRatePrice(pricing) === null) {
    const units = pricing ? [pricing.packUnit, pricing.basisUnit] : [];
    const mixed = units.some((u) => u === "L" || u === "ml") && units.some((u) => u !== "L" && u !== "ml");
    return mixed
      ? "Pack size and rate must both be by weight or both by volume"
      : "Enter the pack size and the rate (both above 0)";
  }
  return null;
}

/** The Product fields these inputs set, ready to merge into a new or updated product. */
export function productPatchFromFields(fields: TradeFieldsState) {
  const pricing = ratePricingFromFields(fields);
  return {
    ratePricing: pricing ?? undefined,
    brand: fields.brand.trim() || "Shami Select",
    manufacturer: fields.manufacturer.trim() || undefined,
    unit: fields.unit.trim() || undefined,
    hsn: fields.hsn.trim() || undefined,
  } satisfies Partial<Product>;
}

function UnitSelect({ id, value, onChange, label }: { id: string; value: MeasureUnit; onChange: (unit: MeasureUnit) => void; label: string }) {
  return (
    <select
      id={id}
      aria-label={label}
      className="h-9 w-24 shrink-0 rounded-md border border-input bg-background px-2 text-sm"
      value={value}
      onChange={(e) => onChange(e.target.value as MeasureUnit)}
    >
      {PACK_UNITS.map((unit) => (
        <option key={unit} value={unit}>{unit}</option>
      ))}
    </select>
  );
}

/**
 * Trade-rate pricing (e.g. 50 kg at ₹5,300 per QTL = ₹2,650) and the Zoho item details
 * (brand, manufacturer, unit, HSN/SAC). Every rate change hands the worked-out selling price
 * and pack size to `onPrice`, so the form's Price and Weight fields follow it.
 */
export function ProductTradeFields({
  value,
  onChange,
  onPrice,
  brands,
  manufacturers,
}: {
  value: TradeFieldsState;
  onChange: (next: TradeFieldsState) => void;
  onPrice: (price: number, packSize: string) => void;
  brands: string[];
  manufacturers: string[];
}) {
  const id = useId();
  const pricing = ratePricingFromFields(value);
  const price = computeRatePrice(pricing);
  const perUnit = ratePerBaseUnit(pricing);

  const update = (patch: Partial<TradeFieldsState>) => {
    const next = { ...value, ...patch };
    if (patch.packUnit) {
      // The rate follows the pack: per QTL for weights, per litre for volumes. A per-QTL rate
      // means nothing for litres, so switching between weight and volume clears it.
      Object.assign(next, basisFor(patch.packUnit));
      if (isVolumeUnit(patch.packUnit) !== isVolumeUnit(value.packUnit)) next.basisRate = "";
    }
    onChange(next);
    const nextPricing = ratePricingFromFields(next);
    const nextPrice = computeRatePrice(nextPricing);
    if (nextPricing && nextPrice !== null) onPrice(nextPrice, formatPackSize(nextPricing));
  };

  return (
    <div className="space-y-3">
      <fieldset className="space-y-3 rounded-md border border-border p-3">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate">Pack & trade rate</legend>
        <label className="flex items-center gap-2 text-sm text-charcoal">
          <input
            type="checkbox"
            checked={value.useRate}
            onChange={(e) => update({ useRate: e.target.checked })}
          />
          Work out the selling price from the rate per quintal (QTL)
        </label>
        {value.useRate && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor={`${id}-pack`}>Pack size</Label>
                <div className="flex gap-1.5">
                  <Input id={`${id}-pack`} type="number" inputMode="decimal" min={0} step="any" className="min-w-20 flex-1"
                    list={`${id}-pack-sizes`} placeholder="Type or pick"
                    value={value.packQty} onChange={(e) => update({ packQty: e.target.value })} />
                  <datalist id={`${id}-pack-sizes`}>
                    {(value.packUnit === "L" || value.packUnit === "ml" ? PACK_SIZES_VOLUME : PACK_SIZES_MASS).map((size) => (
                      <option key={size} value={size} />
                    ))}
                  </datalist>
                  <UnitSelect id={`${id}-pack-unit`} label="Pack size unit" value={value.packUnit} onChange={(packUnit) => update({ packUnit })} />
                </div>
              </div>
              <div>
                <Label htmlFor={`${id}-rate`}>
                  {isVolumeUnit(value.packUnit) ? "Rate (₹ per litre)" : "Rate (₹ per QTL = 100 kg)"}
                </Label>
                <Input id={`${id}-rate`} type="number" inputMode="decimal" min={0} step="0.01" placeholder="e.g. 5300"
                  value={value.basisRate} onChange={(e) => update({ basisRate: e.target.value })} />
              </div>
            </div>
            <p className="rounded-md bg-panel px-3 py-2 text-sm text-charcoal" aria-live="polite">
              {price !== null && pricing && perUnit ? (
                <>
                  {inrPrecise(pricing.basisRate)} per {pricing.basisUnit === "QTL" ? "QTL (100 kg)" : "litre"} ={" "}
                  <span className="font-semibold">{inrPrecise(perUnit.rate)} per {perUnit.unit}</span> × {formatPackSize(pricing)} ={" "}
                  <span className="font-bold text-stone-900">{inrPrecise(price)}</span>. Shown to customers as{" "}
                  {inrPrecise(price)} ({inrPrecise(pricing.basisRate)}/{pricing.basisUnit}).
                </>
              ) : (
                validateTradeFields(value) ?? "Enter the rate to work out the price."
              )}
            </p>
          </>
        )}
      </fieldset>

      <fieldset className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate">Zoho item details</legend>
        <div>
          <Label htmlFor={`${id}-brand`}>Brand</Label>
          <Input id={`${id}-brand`} list={`${id}-brands`} placeholder="Select or type a brand" maxLength={100}
            value={value.brand} onChange={(e) => update({ brand: e.target.value })} />
          <datalist id={`${id}-brands`}>{brands.map((brand) => <option key={brand} value={brand} />)}</datalist>
        </div>
        <div>
          <Label htmlFor={`${id}-manufacturer`}>Manufacturer</Label>
          <Input id={`${id}-manufacturer`} list={`${id}-manufacturers`} placeholder="Select or type a manufacturer" maxLength={100}
            value={value.manufacturer} onChange={(e) => update({ manufacturer: e.target.value })} />
          <datalist id={`${id}-manufacturers`}>{manufacturers.map((name) => <option key={name} value={name} />)}</datalist>
        </div>
        <div>
          <Label htmlFor={`${id}-unit`}>Unit</Label>
          <Input id={`${id}-unit`} list={`${id}-units`} placeholder="bag, tin, pcs…" maxLength={30}
            value={value.unit} onChange={(e) => update({ unit: e.target.value })} />
          <datalist id={`${id}-units`}>{SELLING_UNITS.map((unit) => <option key={unit} value={unit} />)}</datalist>
        </div>
        <div>
          <Label htmlFor={`${id}-hsn`}>HSN/SAC</Label>
          <Input id={`${id}-hsn`} inputMode="numeric" placeholder="e.g. 17019910" maxLength={8}
            value={value.hsn} onChange={(e) => update({ hsn: e.target.value.replace(/\D/g, "") })} />
        </div>
      </fieldset>
    </div>
  );
}
