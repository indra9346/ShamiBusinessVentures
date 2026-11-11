-- 12 Nov 2026, the owner (11 Nov): "in all respective role pages ... need one interactive search bar ... and need
-- favourites pages so they can add respective pages which they deal with to their favourites and can use those pages".
--
-- Each person's favourite pages and buttons, per panel (admin, vendor, customer, channel partner, godown staff), so
-- they follow the person to any phone or computer. Only the person reads or changes their own; nobody else's rows are
-- visible, not even to an admin. A new table only: nothing existing changes.

CREATE TABLE IF NOT EXISTS public.panel_favourites (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  panel text NOT NULL CHECK (panel IN ('admin', 'vendor', 'customer', 'partner', 'staff')),
  item_key text NOT NULL CHECK (char_length(item_key) BETWEEN 1 AND 330),
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 120),
  -- An address on this site only (never another site): "/admin/attendance", "/partner".
  to_path text NOT NULL CHECK (to_path ~ '^/[A-Za-z0-9/_.-]{0,199}$' AND to_path !~ '^//'),
  -- The button or section to show on that page, as the page says it; empty for the page itself.
  find_text text NOT NULL DEFAULT '' CHECK (char_length(find_text) <= 120),
  position integer NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, panel, item_key)
);

CREATE INDEX IF NOT EXISTS panel_favourites_user_panel_idx ON public.panel_favourites (user_id, panel, position);

ALTER TABLE public.panel_favourites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Own favourites: read" ON public.panel_favourites;
CREATE POLICY "Own favourites: read" ON public.panel_favourites FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "Own favourites: add" ON public.panel_favourites;
CREATE POLICY "Own favourites: add" ON public.panel_favourites FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "Own favourites: change" ON public.panel_favourites;
CREATE POLICY "Own favourites: change" ON public.panel_favourites FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "Own favourites: remove" ON public.panel_favourites;
CREATE POLICY "Own favourites: remove" ON public.panel_favourites FOR DELETE TO authenticated USING (user_id = auth.uid());

REVOKE ALL ON public.panel_favourites FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.panel_favourites TO authenticated;
GRANT ALL ON public.panel_favourites TO service_role;

-- At most 40 per person and panel, so a stuck script cannot fill the table.
-- SECURITY INVOKER (review, 12 Nov 2026): the count runs with the caller's own rights, so it only ever sees the
-- caller's rows. A row in someone else's name counts nothing here and is then refused by the policy, always the same
-- way: nobody can learn anything about another person's favourites from the answer.
CREATE OR REPLACE FUNCTION private.panel_favourites_cap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
BEGIN
  -- The row itself does not count (by its id, or by its key for an upsert of the same favourite): saving the order
  -- again must still work at 40, and so must changing a row in place.
  IF (SELECT count(*) FROM public.panel_favourites
      WHERE user_id = NEW.user_id AND panel = NEW.panel AND item_key <> NEW.item_key AND id IS DISTINCT FROM NEW.id) >= 40 THEN
    RAISE EXCEPTION 'You can keep up to 40 favourites here. Remove one first.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.panel_favourites_cap() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS panel_favourites_cap ON public.panel_favourites;
-- Also when a row is moved to another panel or given another key, so the 40 cannot be passed that way.
CREATE TRIGGER panel_favourites_cap BEFORE INSERT OR UPDATE OF user_id, panel, item_key ON public.panel_favourites
  FOR EACH ROW EXECUTE FUNCTION private.panel_favourites_cap();

NOTIFY pgrst, 'reload schema';
