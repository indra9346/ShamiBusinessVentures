-- Cost of goods sold or operating expense, per batch expense (client, 18 Nov 2026: "it is taking tagged expenses after
-- cost of goods sold calculation, give option to update expenses which are cost of goods sold and which are not ...
-- transport cost and amali comes under cost of goods sold").
--
-- cost_kind on every expense: 'cogs' (part of the goods' cost: transport, hamali), 'operating' (after gross profit:
-- driver or partner commission, other) or '' = follow its type (the app's default: transport and hamali are cost of
-- goods, the rest operating). Only how the P&L groups the expense changes; the amounts and the profit after all expenses
-- stay the same. Server only, like the other expense functions. Adds a column, a check and one function. Safe twice.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.zoho_cost_documents ADD COLUMN IF NOT EXISTS cost_kind text NOT NULL DEFAULT '';
ALTER TABLE public.zoho_cost_documents DROP CONSTRAINT IF EXISTS zoho_cost_documents_cost_kind_check;
ALTER TABLE public.zoho_cost_documents ADD CONSTRAINT zoho_cost_documents_cost_kind_check CHECK (cost_kind IN ('', 'cogs', 'operating'));

ALTER TABLE public.batch_cost_tag_events DROP CONSTRAINT IF EXISTS batch_cost_tag_events_action_check;
ALTER TABLE public.batch_cost_tag_events ADD CONSTRAINT batch_cost_tag_events_action_check
  CHECK (action IN ('tag', 'untag', 'accept_change', 'flag', 'split_on_match', 'join', 'manual_save', 'manual_delete', 'category', 'kind'));

/** Sets whether an expense is cost of goods sold ('cogs'), an operating expense ('operating') or follows its type (''). */
CREATE OR REPLACE FUNCTION public.set_cost_document_kind(_document_id bigint, _kind text, _by uuid, _by_name text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  d public.zoho_cost_documents%ROWTYPE;
  k text := btrim(COALESCE(_kind, ''));
BEGIN
  IF NOT private.cost_actor_is_admin(_by) THEN RAISE EXCEPTION 'Only administrators can change batch expenses'; END IF;
  IF k NOT IN ('', 'cogs', 'operating') THEN RAISE EXCEPTION 'Choose cost of goods sold or operating expense'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('batch_cost:' || _document_id));
  SELECT * INTO d FROM public.zoho_cost_documents WHERE id = _document_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF d.cost_kind = k THEN RETURN k; END IF;
  UPDATE public.zoho_cost_documents SET cost_kind = k WHERE id = d.id;
  INSERT INTO public.batch_cost_tag_events (document_id, action, before, after, by_id, by_name)
  VALUES (d.id, 'kind', jsonb_build_object('kind', d.cost_kind), jsonb_build_object('kind', k), _by, left(COALESCE(_by_name, ''), 120));
  RETURN k;
END $function$;
REVOKE ALL ON FUNCTION public.set_cost_document_kind(bigint, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_cost_document_kind(bigint, text, uuid, text) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
