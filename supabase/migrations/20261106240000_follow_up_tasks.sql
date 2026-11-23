-- Admin follow-ups (client's note, 6 Nov 2026): "Follow ups. Assigned employees to-do task list. Like licence renewals."
--
-- A task has a title, a type (licence renewal, payment follow-up, ...), an assigned employee (or the office), an
-- optional godown, a due date, how early it shows as "due soon", and how often it repeats (licences renew every year).
-- Admins add, change and delete tasks. The assigned employee sees their own open tasks on their staff page and can
-- mark one done, with a note; nobody else sees them. Marking a repeating task done makes the next one, with the same
-- details, due one period later. The admins are told when an employee finishes a task.

BEGIN;

CREATE TABLE IF NOT EXISTS public.follow_up_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 2 AND 150),
  details text NOT NULL DEFAULT '' CHECK (char_length(details) <= 1000),
  kind text NOT NULL DEFAULT 'other'
    CHECK (kind IN ('licence_renewal', 'payment_follow_up', 'customer_follow_up', 'supplier_follow_up', 'maintenance', 'other')),
  employee_id uuid REFERENCES public.staff_employees(id) ON DELETE SET NULL,
  branch_id text REFERENCES public.branches(id) ON DELETE SET NULL,
  due_on date NOT NULL,
  repeat_every text NOT NULL DEFAULT 'none' CHECK (repeat_every IN ('none', 'month', 'quarter', 'half_year', 'year')),
  remind_days integer NOT NULL DEFAULT 7 CHECK (remind_days BETWEEN 0 AND 90),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  done_at timestamptz,
  done_by uuid,
  done_note text NOT NULL DEFAULT '' CHECK (char_length(done_note) <= 500),
  next_task_id uuid REFERENCES public.follow_up_tasks(id) ON DELETE SET NULL,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS follow_up_tasks_open_due ON public.follow_up_tasks (status, due_on);
CREATE INDEX IF NOT EXISTS follow_up_tasks_employee ON public.follow_up_tasks (employee_id, status);

ALTER TABLE public.follow_up_tasks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.follow_up_tasks FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.follow_up_tasks TO authenticated;
GRANT ALL ON public.follow_up_tasks TO service_role;

DROP POLICY IF EXISTS follow_up_tasks_admin ON public.follow_up_tasks;
CREATE POLICY follow_up_tasks_admin ON public.follow_up_tasks FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
-- An employee reads only the tasks assigned to them, while they are an active employee. Changes go through the function.
DROP POLICY IF EXISTS follow_up_tasks_assignee_read ON public.follow_up_tasks;
CREATE POLICY follow_up_tasks_assignee_read ON public.follow_up_tasks FOR SELECT TO authenticated
  USING (employee_id IN (SELECT e.id FROM public.staff_employees e WHERE e.user_id = auth.uid() AND e.status = 'active'));

DROP TRIGGER IF EXISTS follow_up_tasks_touch ON public.follow_up_tasks;
CREATE TRIGGER follow_up_tasks_touch BEFORE UPDATE ON public.follow_up_tasks FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Done, by an admin or by the assigned employee. A repeating task makes its next one.
CREATE OR REPLACE FUNCTION public.complete_follow_up_task(_id uuid, _note text DEFAULT '')
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  t public.follow_up_tasks%ROWTYPE;
  is_admin boolean := public.has_role(auth.uid(), 'admin');
  who text;
  next_due date;
  next_id uuid;
  note text := left(btrim(COALESCE(_note, '')), 500);
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in first'; END IF;
  SELECT * INTO t FROM public.follow_up_tasks WHERE id = _id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This task is not on record'; END IF;
  IF NOT is_admin THEN
    SELECT e.name INTO who FROM public.staff_employees e WHERE e.id = t.employee_id AND e.user_id = auth.uid() AND e.status = 'active';
    IF who IS NULL THEN RAISE EXCEPTION 'This task is not assigned to you'; END IF;
  END IF;
  IF t.status <> 'open' THEN RAISE EXCEPTION 'This task is already %', t.status; END IF;
  UPDATE public.follow_up_tasks SET status = 'done', done_at = now(), done_by = auth.uid(), done_note = note WHERE id = t.id;
  IF t.repeat_every <> 'none' THEN
    next_due := (t.due_on + CASE t.repeat_every
      WHEN 'month' THEN interval '1 month' WHEN 'quarter' THEN interval '3 months'
      WHEN 'half_year' THEN interval '6 months' ELSE interval '1 year' END)::date;
    INSERT INTO public.follow_up_tasks (title, details, kind, employee_id, branch_id, due_on, repeat_every, remind_days, created_by)
    VALUES (t.title, t.details, t.kind, t.employee_id, t.branch_id, next_due, t.repeat_every, t.remind_days, auth.uid())
    RETURNING id INTO next_id;
    UPDATE public.follow_up_tasks SET next_task_id = next_id WHERE id = t.id;
  END IF;
  IF NOT is_admin THEN
    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
    SELECT NULL, NULL, ur.user_id, 'admin', 'Follow-up done',
      format('%s marked "%s" done%s.%s', who, t.title, COALESCE(': ' || NULLIF(note, ''), ''),
        COALESCE(' Next one due ' || to_char(next_due, 'DD Mon YYYY') || '.', '')),
      'info'
    FROM public.user_roles ur WHERE ur.role = 'admin';
  END IF;
  RETURN jsonb_build_object('status', 'done', 'next_task_id', next_id, 'next_due', next_due);
END;
$function$;
REVOKE ALL ON FUNCTION public.complete_follow_up_task(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_follow_up_task(uuid, text) TO authenticated, service_role;

COMMIT;
