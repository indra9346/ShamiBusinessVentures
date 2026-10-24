-- Admin pricing dashboard: purchase lots and their selling price, as in Shami's "Shami Summary"
-- sheet. The white columns are entered; the green ones are calculated here so every screen and
-- report agrees:
--   GST            = (price + commission) x GST rate (5%)
--   Landing price  = price + commission + GST + transport + amali (transport, usually negative)
--                    + amali (Shami) + driver tips + unloading            (per quintal)
--   Selling (qntl) = landing price + Shami margin
--   Selling (bag)  = selling (qntl) x bag size (kg) / 100                 (50 kg bag = half)
-- "Set as godown price" copies the bag price to a godown (its Zoho price list) or to the item's
-- normal price; applied_* records when and where.

CREATE TABLE IF NOT EXISTS public.price_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_code text NOT NULL DEFAULT '',
  purchase_date date,
  order_folio text NOT NULL DEFAULT '',
  factory text NOT NULL DEFAULT '',
  item text NOT NULL DEFAULT '',
  product_id text REFERENCES public.catalog_products(id) ON DELETE SET NULL,
  branch_id text REFERENCES public.branches(id) ON DELETE SET NULL,
  quantity_qntl numeric(14,3) NOT NULL DEFAULT 0 CHECK (quantity_qntl >= 0),
  price numeric(14,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  commission numeric(14,2) NOT NULL DEFAULT 0,
  gst_rate numeric(5,2) NOT NULL DEFAULT 5 CHECK (gst_rate >= 0 AND gst_rate <= 40),
  transport numeric(14,2) NOT NULL DEFAULT 0,
  amali_transport numeric(14,2) NOT NULL DEFAULT 0,
  amali_shami numeric(14,2) NOT NULL DEFAULT 0,
  driver_tips numeric(14,2) NOT NULL DEFAULT 0,
  unloading numeric(14,2) NOT NULL DEFAULT 0,
  margin numeric(14,2) NOT NULL DEFAULT 0,
  bag_kg numeric(8,3) NOT NULL DEFAULT 50 CHECK (bag_kg > 0),
  gst numeric(14,2) GENERATED ALWAYS AS (round((price + commission) * gst_rate / 100, 2)) STORED,
  landing_price numeric(14,2) GENERATED ALWAYS AS (round(
    price + commission + round((price + commission) * gst_rate / 100, 2)
    + transport + amali_transport + amali_shami + driver_tips + unloading, 2)) STORED,
  selling_qntl numeric(14,2) GENERATED ALWAYS AS (round(
    price + commission + round((price + commission) * gst_rate / 100, 2)
    + transport + amali_transport + amali_shami + driver_tips + unloading + margin, 2)) STORED,
  selling_bag numeric(14,2) GENERATED ALWAYS AS (round(
    (price + commission + round((price + commission) * gst_rate / 100, 2)
     + transport + amali_transport + amali_shami + driver_tips + unloading + margin) * bag_kg / 100, 2)) STORED,
  applied_price numeric(14,2),
  applied_branch_id text,
  applied_at timestamptz,
  notes text NOT NULL DEFAULT '',
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS price_lots_date_idx ON public.price_lots (purchase_date DESC NULLS LAST, created_at DESC);
CREATE INDEX IF NOT EXISTS price_lots_product_idx ON public.price_lots (product_id);

ALTER TABLE public.price_lots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS price_lots_admin_all ON public.price_lots;
CREATE POLICY price_lots_admin_all ON public.price_lots FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.price_lots TO authenticated;

DROP TRIGGER IF EXISTS price_lots_touch ON public.price_lots;
CREATE TRIGGER price_lots_touch BEFORE UPDATE ON public.price_lots
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

NOTIFY pgrst, 'reload schema';
