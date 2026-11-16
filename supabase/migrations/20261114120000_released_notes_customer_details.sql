-- 14 Nov 2026 (owner, on the channel partner's "Released delivery notes" list): "need option to view shop name & phone
-- number & address".
--
-- godown_released_notes() now also returns the customer's shop name (the business name on the order), the contact's
-- name, phone and address, as the delivery note recorded them when it was released (delivery_notes.snapshot). They are
-- the same details the full delivery note prints, so they follow the same rule as printing it
-- (delivery_invoice_scan's can_note): admins and the godown in-charge always; ordinary staff when Admin > Delivery
-- QR rules has staff_print_note on; the channel partner when it has partner_print_note on (both on, 14 Nov 2026).
-- Anyone else who may see the list gets them empty, as slips-only printing already does. Everything else is
-- unchanged: own godown only (admins every godown), the last 30 days, newest first, at most 200.
--
-- The columns change, so the function is dropped and created again (CREATE OR REPLACE cannot change a RETURNS TABLE).
-- Built from the live definition, read 14 Nov 2026 (the same as 20261112120000_invoice_delivery_qr.sql).

DROP FUNCTION IF EXISTS public.godown_released_notes();

CREATE FUNCTION public.godown_released_notes()
RETURNS TABLE (note_no text, order_no text, customer text, items integer, to_go integer, released_at timestamptz, released_how text,
  delivered boolean, godown text, shop text, contact text, phone text, address text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  who jsonb := private.delivery_scanner(auth.uid());
  rules jsonb := private.delivery_qr_rules();
  details boolean;
BEGIN
  IF who IS NULL THEN RAISE EXCEPTION 'Only godown staff, channel partners and administrators can see released delivery notes'; END IF;
  -- Who may see the customer's phone and address: whoever may print the full delivery note.
  details := who->>'role' IN ('admin', 'incharge')
    OR (who->>'role' = 'staff' AND COALESCE((rules->>'staff_print_note')::boolean, false))
    OR (who->>'role' = 'partner' AND COALESCE((rules->>'partner_print_note')::boolean, false));
  RETURN QUERY
  SELECT n.note_no, n.order_no,
    COALESCE(NULLIF(n.snapshot->'customer'->>'business_name', ''), n.snapshot->'customer'->>'name', ''),
    jsonb_array_length(n.snapshot->'items'),
    (SELECT count(*)::integer FROM generate_series(1, jsonb_array_length(n.snapshot->'items')) g WHERE NOT private.delivery_line_done(n.id, g)),
    n.generated_at, n.generated_how, o.order_status = 'Delivered', COALESCE(n.snapshot->'godown'->>'name', ''),
    CASE WHEN details THEN btrim(COALESCE(n.snapshot->'customer'->>'business_name', '')) ELSE '' END,
    CASE WHEN details THEN btrim(COALESCE(NULLIF(btrim(n.snapshot->'customer'->>'name'), ''), n.snapshot->'address'->>'name', '')) ELSE '' END,
    CASE WHEN details THEN btrim(COALESCE(NULLIF(btrim(n.snapshot->'customer'->>'phone'), ''), n.snapshot->'address'->>'phone', '')) ELSE '' END,
    CASE WHEN details THEN concat_ws(', ',
      NULLIF(btrim(n.snapshot->'address'->>'line'), ''),
      NULLIF(btrim(n.snapshot->'address'->>'city'), ''),
      NULLIF(btrim(concat_ws(' ', NULLIF(btrim(n.snapshot->'address'->>'state'), ''), NULLIF(btrim(n.snapshot->'address'->>'pin'), ''))), ''))
    ELSE '' END
  FROM public.delivery_notes n JOIN public.orders o ON o.id = n.order_id
  WHERE n.generated_at > now() - interval '30 days'
    AND (who->>'role' = 'admin' OR NULLIF(n.snapshot->'godown'->>'id', '') = who->>'branch_id')
  ORDER BY n.generated_at DESC
  LIMIT 200;
END;
$function$;
REVOKE ALL ON FUNCTION public.godown_released_notes() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.godown_released_notes() TO authenticated;


NOTIFY pgrst, 'reload schema';
