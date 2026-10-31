-- Channel partner history (client question, 31 Oct 2026: "if channel partners change, what happens to
-- their history, login, dispatched and commission data?"). Nothing was ever deleted: a replaced partner
-- is suspended, keeps every commission recorded at the time of each order, and the new partner earns
-- only on orders placed after they were added. What was missing is a record of WHEN each partner ran
-- a godown. Every change of a partner's status (or godown) is now logged with the time and the admin,
-- so Admin > Channel Partners can show each godown's partners from - to, with their sales and
-- commission in that time, and the gaps when a godown had no partner.

-- Who changed the status last (set by the admin's server function, read by the log trigger).
ALTER TABLE public.channel_partners
  ADD COLUMN IF NOT EXISTS status_changed_by uuid,
  ADD COLUMN IF NOT EXISTS status_changed_at timestamptz;

CREATE TABLE IF NOT EXISTS public.channel_partner_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES public.channel_partners(id) ON DELETE CASCADE,
  branch_id text NOT NULL,
  event text NOT NULL CHECK (event IN ('added', 'suspended', 'reactivated', 'moved')),
  at timestamptz NOT NULL DEFAULT now(),
  by_user uuid,
  by_name text NOT NULL DEFAULT '',
  -- true for events reconstructed from the records that existed before this log (times approximate)
  backfilled boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS channel_partner_events_partner_idx ON public.channel_partner_events (partner_id, at);
CREATE INDEX IF NOT EXISTS channel_partner_events_branch_idx ON public.channel_partner_events (branch_id, at);

ALTER TABLE public.channel_partner_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.channel_partner_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.channel_partner_events TO authenticated;
GRANT ALL ON public.channel_partner_events TO service_role;
DROP POLICY IF EXISTS channel_partner_events_admin_read ON public.channel_partner_events;
CREATE POLICY channel_partner_events_admin_read ON public.channel_partner_events FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

/** Logs a partner being added, suspended, reactivated or moved to another godown. */
CREATE OR REPLACE FUNCTION private.log_channel_partner_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  actor uuid;
  actor_name text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    actor := COALESCE(NEW.created_by, auth.uid());
  ELSE
    actor := COALESCE(NEW.status_changed_by, auth.uid());
  END IF;
  SELECT COALESCE(full_name, '') INTO actor_name FROM public.profiles WHERE id = actor;
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.channel_partner_events (partner_id, branch_id, event, at, by_user, by_name)
      VALUES (NEW.id, NEW.branch_id, 'added', COALESCE(NEW.created_at, now()), actor, COALESCE(actor_name, ''));
    IF NEW.status = 'suspended' THEN
      INSERT INTO public.channel_partner_events (partner_id, branch_id, event, at, by_user, by_name)
        VALUES (NEW.id, NEW.branch_id, 'suspended', COALESCE(NEW.created_at, now()), actor, COALESCE(actor_name, ''));
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.branch_id IS DISTINCT FROM OLD.branch_id THEN
    INSERT INTO public.channel_partner_events (partner_id, branch_id, event, by_user, by_name)
      VALUES (NEW.id, NEW.branch_id, 'moved', actor, COALESCE(actor_name, ''));
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.channel_partner_events (partner_id, branch_id, event, by_user, by_name)
      VALUES (NEW.id, NEW.branch_id, CASE WHEN NEW.status = 'active' THEN 'reactivated' ELSE 'suspended' END,
        actor, COALESCE(actor_name, ''));
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION private.log_channel_partner_event() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS channel_partners_log_event ON public.channel_partners;
CREATE TRIGGER channel_partners_log_event AFTER INSERT OR UPDATE OF status, branch_id ON public.channel_partners
  FOR EACH ROW EXECUTE FUNCTION private.log_channel_partner_event();

-- Partners from before this log: added when their record was created; a suspended one was suspended
-- at its last update (the closest time on record).
INSERT INTO public.channel_partner_events (partner_id, branch_id, event, at, by_user, by_name, backfilled)
SELECT p.id, p.branch_id, 'added', p.created_at, p.created_by, COALESCE(pr.full_name, ''), true
FROM public.channel_partners p
LEFT JOIN public.profiles pr ON pr.id = p.created_by
WHERE NOT EXISTS (SELECT 1 FROM public.channel_partner_events e WHERE e.partner_id = p.id);

INSERT INTO public.channel_partner_events (partner_id, branch_id, event, at, backfilled)
SELECT p.id, p.branch_id, 'suspended', GREATEST(p.updated_at, p.created_at), true
FROM public.channel_partners p
WHERE p.status = 'suspended'
  AND NOT EXISTS (SELECT 1 FROM public.channel_partner_events e WHERE e.partner_id = p.id AND e.event = 'suspended');

NOTIFY pgrst, 'reload schema';
