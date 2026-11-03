-- One push at a time per order. Two pushes of one order at once can make two sales orders, or two
-- invoices and two payments, and the queue's own row lock can't stop that: it covers one row, and a
-- direct push and a second queue run don't go through that row.
--
-- The claim is a lease on a row here, so it holds across server processes. The push renews it before
-- each write to Zoho (zoho-commerce.functions.ts). A push that dies stops renewing, so the claim runs
-- out by itself and the order is never stuck.
CREATE TABLE IF NOT EXISTS public.zoho_order_push_claims (
  order_id uuid PRIMARY KEY REFERENCES public.orders(id) ON DELETE CASCADE,
  holder uuid,
  locked_until timestamptz,
  -- A create was sent to Zoho and has no clear answer yet, so Zoho may have made it, or may still be making it.
  create_attempted_at timestamptz,
  -- Another POST for this order (an invoice, a payment, a package) got no clear answer at this time.
  write_unanswered_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.zoho_order_push_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.zoho_order_push_claims FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.zoho_order_push_claims TO service_role;

-- The queue entries a direct push has read. An order change clears the mark (enqueue_zoho_sync), so
-- the push leaves that entry for the queue instead of marking a change it never saw as complete.
ALTER TABLE public.zoho_sync_outbox ADD COLUMN IF NOT EXISTS push_holder uuid;

CREATE OR REPLACE FUNCTION public.enqueue_zoho_sync(_entity_type text, _entity_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.zoho_sync_outbox (entity_type, entity_id, event_type)
  VALUES (_entity_type, _entity_id, 'upsert')
  ON CONFLICT (entity_type, entity_id, event_type) WHERE status = 'pending'
  DO UPDATE SET available_at = now(), updated_at = now(), last_error = NULL, push_holder = NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.enqueue_zoho_sync(text, text) FROM PUBLIC, anon, authenticated;

-- Atomic: of any number of callers, one gets the claim. create_wait_over says the 10 minutes given to
-- Zoho to finish an unanswered create have passed; writes_held_back, that it may still be finishing another write.
CREATE OR REPLACE FUNCTION public.claim_zoho_order_push(_order_id uuid, _holder uuid)
RETURNS TABLE (claimed boolean, create_attempted_at timestamptz, create_wait_over boolean, writes_held_back boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  got public.zoho_order_push_claims%ROWTYPE;
BEGIN
  -- A deleted order has nothing to push: the caller finds that out itself.
  IF NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.id = _order_id) THEN
    RETURN QUERY SELECT true, NULL::timestamptz, false, false;
    RETURN;
  END IF;
  INSERT INTO public.zoho_order_push_claims AS c (order_id, holder, locked_until)
  VALUES (_order_id, _holder, now() + interval '3 minutes')
  ON CONFLICT (order_id) DO UPDATE
    SET holder = EXCLUDED.holder, locked_until = EXCLUDED.locked_until, updated_at = now()
    WHERE c.locked_until IS NULL OR c.locked_until < now()
  RETURNING c.* INTO got;
  IF got.order_id IS NULL THEN
    RETURN QUERY SELECT false, NULL::timestamptz, false, false;
    RETURN;
  END IF;
  UPDATE public.zoho_sync_outbox q SET push_holder = _holder
    WHERE q.entity_type = 'order' AND q.entity_id = _order_id::text
      AND q.status IN ('pending', 'failed', 'needs_review');
  RETURN QUERY SELECT true, got.create_attempted_at,
    COALESCE(got.create_attempted_at <= now() - interval '10 minutes', false),
    COALESCE(got.write_unanswered_at > now() - interval '10 minutes', false);
END;
$$;
REVOKE ALL ON FUNCTION public.claim_zoho_order_push(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_zoho_order_push(uuid, uuid) TO service_role;

-- False means another push took the claim after this one's ran out: this one must not write to Zoho.
CREATE OR REPLACE FUNCTION public.renew_zoho_order_push(_order_id uuid, _holder uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.zoho_order_push_claims
    SET locked_until = now() + interval '3 minutes', updated_at = now()
    WHERE order_id = _order_id AND holder = _holder;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.renew_zoho_order_push(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.renew_zoho_order_push(uuid, uuid) TO service_role;

-- Noted just before a create is sent (true), and taken back when Zoho clearly said no (false).
CREATE OR REPLACE FUNCTION public.note_zoho_order_create(_order_id uuid, _holder uuid, _sent boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.zoho_order_push_claims
    SET create_attempted_at = CASE WHEN _sent THEN now() END,
        locked_until = now() + interval '3 minutes', updated_at = now()
    WHERE order_id = _order_id AND holder = _holder;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.note_zoho_order_create(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.note_zoho_order_create(uuid, uuid, boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.note_zoho_order_write_unanswered(_order_id uuid, _holder uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.zoho_order_push_claims
    SET write_unanswered_at = now(), updated_at = now()
    WHERE order_id = _order_id AND holder = _holder;
END;
$$;
REVOKE ALL ON FUNCTION public.note_zoho_order_write_unanswered(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.note_zoho_order_write_unanswered(uuid, uuid) TO service_role;

-- A linked order has its sales order, so its create is answered, however that was found out.
CREATE OR REPLACE FUNCTION public.release_zoho_order_push(_order_id uuid, _holder uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.zoho_order_push_claims c
    SET holder = NULL, locked_until = NULL, updated_at = now(),
        create_attempted_at = CASE
          WHEN EXISTS (SELECT 1 FROM public.orders o WHERE o.id = _order_id AND o.zoho_salesorder_id IS NOT NULL) THEN NULL
          ELSE c.create_attempted_at END
    WHERE c.order_id = _order_id AND c.holder = _holder;
END;
$$;
REVOKE ALL ON FUNCTION public.release_zoho_order_push(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_zoho_order_push(uuid, uuid) TO service_role;

-- Another push has this order: not a failure, so the row goes back in line without using up an attempt.
CREATE OR REPLACE FUNCTION public.defer_zoho_sync_job(_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.zoho_sync_outbox
    SET status = 'pending', attempts = GREATEST(attempts - 1, 0), available_at = now() + interval '1 minute',
        locked_until = NULL, updated_at = now()
    WHERE id = _id AND status = 'processing';
EXCEPTION WHEN unique_violation THEN
  -- One pending row per order: a newer one is already queued, and it brings Zoho up to date.
  UPDATE public.zoho_sync_outbox
    SET status = 'complete', last_error = 'Superseded by a newer pending sync job', locked_until = NULL, updated_at = now()
    WHERE id = _id AND status = 'processing';
END;
$$;
REVOKE ALL ON FUNCTION public.defer_zoho_sync_job(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.defer_zoho_sync_job(uuid) TO service_role;

-- A person who was asked to look for an unanswered create in Zoho pressed Retry on that entry: that
-- is the go-ahead to create. The server calls this only for the entry that asked (retryZohoSyncJob).
-- "Retry all" and any other entry stay on retry_zoho_sync_job, because nobody looked. Nor does pressing
-- Retry during the 10 minutes skip them: Zoho may still be making it.
CREATE OR REPLACE FUNCTION public.retry_zoho_sync_job_checked(_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  selected_job public.zoho_sync_outbox%ROWTYPE;
BEGIN
  SELECT * INTO selected_job FROM public.zoho_sync_outbox WHERE id = _id;
  IF FOUND AND selected_job.entity_type = 'order' AND selected_job.status = 'needs_review' THEN
    UPDATE public.zoho_order_push_claims
      SET create_attempted_at = NULL, updated_at = now()
      WHERE order_id = selected_job.entity_id::uuid AND create_attempted_at <= now() - interval '10 minutes';
  END IF;
  PERFORM public.retry_zoho_sync_job(_id);
END;
$$;
REVOKE ALL ON FUNCTION public.retry_zoho_sync_job_checked(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retry_zoho_sync_job_checked(uuid) TO service_role;

-- The approval is a change a running push may not have seen, so it clears that push's mark like any other.
CREATE OR REPLACE FUNCTION public.enqueue_zoho_invoice_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.admin_approved AND (TG_OP = 'INSERT' OR NOT OLD.admin_approved) THEN
    PERFORM public.enqueue_zoho_sync('order', NEW.order_id::text);
  END IF;
  RETURN NEW;
END;
$function$;

-- A run that dies on a row's last attempt left it 'processing' for ever, with no Retry: show it as failed.
CREATE OR REPLACE FUNCTION public.claim_zoho_sync_jobs(_limit integer DEFAULT 20)
RETURNS SETOF public.zoho_sync_outbox
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.zoho_sync_outbox
    SET status = 'failed', locked_until = NULL, updated_at = now(),
        last_error = COALESCE(last_error, 'The sync stopped part-way through this entry on its last attempt.')
    WHERE status = 'processing' AND locked_until < now() AND attempts >= 12;
  RETURN QUERY
  WITH ready AS (
    SELECT id FROM public.zoho_sync_outbox
    WHERE ((status IN ('pending', 'failed') AND available_at <= now())
      OR (status = 'processing' AND locked_until < now()))
      AND attempts < 12
    ORDER BY available_at, created_at
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(_limit, 1), 50)
  )
  UPDATE public.zoho_sync_outbox q
    SET status = 'processing', attempts = q.attempts + 1,
        locked_until = now() + interval '3 minutes', updated_at = now()
  FROM ready WHERE q.id = ready.id
  RETURNING q.*;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_zoho_sync_jobs(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_zoho_sync_jobs(integer) TO service_role;

NOTIFY pgrst, 'reload schema';
