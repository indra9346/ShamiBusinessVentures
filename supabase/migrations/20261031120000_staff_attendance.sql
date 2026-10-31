-- Godown employee attendance (client request, 31 Oct 2026). Kept on the website, not in Zoho:
-- Zoho Commerce / Inventory / Books have no attendance module (Zoho People is a separate product).
--   * Admin adds each godown employee (name, mobile, godown). The employee signs in at /staff with
--     an SMS code to that mobile (no password) and marks attendance with a live selfie; the server
--     records the time, the phone's GPS position, accuracy and distance from the godown.
--   * Inside the godown's radius and on time -> Present at once. Outside, GPS too rough, late, or
--     the godown has no location yet -> the day waits for approval, with the employee's reason.
--   * Employees request leave in the app.
--   * Leave and those check-ins need head office (admin) AND the godown's active channel partner to
--     approve; either one can reject (a godown with no active partner: head office alone decides).
--     Either can also reject a day that was Present at once (e.g. someone else in the selfie).
-- Selfies sit in the private bucket attendance-selfies; only the server reads and writes them
-- (signed links for people allowed to see that day's record).

ALTER TABLE public.branches
  ADD COLUMN IF NOT EXISTS latitude double precision CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  ADD COLUMN IF NOT EXISTS longitude double precision CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  ADD COLUMN IF NOT EXISTS attendance_radius_m integer NOT NULL DEFAULT 150 CHECK (attendance_radius_m BETWEEN 25 AND 2000),
  ADD COLUMN IF NOT EXISTS shift_start time NOT NULL DEFAULT '09:30',
  ADD COLUMN IF NOT EXISTS late_grace_min integer NOT NULL DEFAULT 15 CHECK (late_grace_min BETWEEN 0 AND 240),
  -- The godown's weekly day off (0 = Sunday … 6 = Saturday; NULL = open every day). Not counted as absent.
  ADD COLUMN IF NOT EXISTS weekly_off smallint DEFAULT 0 CHECK (weekly_off IS NULL OR weekly_off BETWEEN 0 AND 6);

CREATE TABLE IF NOT EXISTS public.staff_employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  branch_id text NOT NULL REFERENCES public.branches(id),
  name text NOT NULL CHECK (length(trim(name)) >= 2),
  -- 10-digit Indian mobile; the SMS sign-in code goes here.
  phone text NOT NULL UNIQUE CHECK (phone ~ '^[6-9][0-9]{9}$'),
  designation text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  joined_on date NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Kolkata')::date,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_employees_branch_idx ON public.staff_employees (branch_id, status);

CREATE TABLE IF NOT EXISTS public.attendance_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES public.staff_employees(id) ON DELETE CASCADE,
  branch_id text NOT NULL REFERENCES public.branches(id),
  work_date date NOT NULL,
  check_in_at timestamptz NOT NULL DEFAULT now(),
  in_lat double precision NOT NULL,
  in_lng double precision NOT NULL,
  in_accuracy_m numeric(10,1) NOT NULL,
  in_distance_m integer,
  in_selfie text NOT NULL,
  late_minutes integer NOT NULL DEFAULT 0 CHECK (late_minutes >= 0),
  -- Why the day needs approval: outside, imprecise, late, no_godown_location (empty: Present at once).
  flags text[] NOT NULL DEFAULT '{}',
  employee_note text NOT NULL DEFAULT '',
  check_out_at timestamptz,
  out_lat double precision,
  out_lng double precision,
  out_accuracy_m numeric(10,1),
  out_distance_m integer,
  out_inside boolean,
  out_selfie text,
  status text NOT NULL CHECK (status IN ('present', 'pending', 'rejected')),
  head_office_decision text CHECK (head_office_decision IN ('approved', 'rejected')),
  head_office_by uuid,
  head_office_at timestamptz,
  head_office_note text NOT NULL DEFAULT '',
  partner_decision text CHECK (partner_decision IN ('approved', 'rejected')),
  partner_by uuid,
  partner_at timestamptz,
  partner_note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, work_date)
);
CREATE INDEX IF NOT EXISTS attendance_days_branch_date_idx ON public.attendance_days (branch_id, work_date DESC);
CREATE INDEX IF NOT EXISTS attendance_days_pending_idx ON public.attendance_days (status) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS public.leave_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES public.staff_employees(id) ON DELETE CASCADE,
  branch_id text NOT NULL REFERENCES public.branches(id),
  from_date date NOT NULL,
  to_date date NOT NULL,
  leave_type text NOT NULL CHECK (leave_type IN ('casual', 'sick', 'festival', 'other')),
  reason text NOT NULL CHECK (length(trim(reason)) >= 3),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  head_office_decision text CHECK (head_office_decision IN ('approved', 'rejected')),
  head_office_by uuid,
  head_office_at timestamptz,
  head_office_note text NOT NULL DEFAULT '',
  partner_decision text CHECK (partner_decision IN ('approved', 'rejected')),
  partner_by uuid,
  partner_at timestamptz,
  partner_note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (to_date >= from_date AND to_date - from_date < 60)
);
CREATE INDEX IF NOT EXISTS leave_requests_employee_idx ON public.leave_requests (employee_id, from_date DESC);
CREATE INDEX IF NOT EXISTS leave_requests_branch_idx ON public.leave_requests (branch_id, status);

/** The caller's active employee record id, or NULL. */
CREATE OR REPLACE FUNCTION public.current_employee_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT id FROM public.staff_employees WHERE user_id = auth.uid() AND status = 'active'
$$;

/** The godown of the caller's active channel partner record, or NULL. */
CREATE OR REPLACE FUNCTION public.current_partner_branch()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT branch_id FROM public.channel_partners WHERE user_id = auth.uid() AND status = 'active'
$$;

/** Same rule as src/lib/attendance.ts reviewStatus(). */
CREATE OR REPLACE FUNCTION public.attendance_review_status(_head text, _partner text, _partner_required boolean)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN _head = 'rejected' OR _partner = 'rejected' THEN 'rejected'
              WHEN _head = 'approved' AND (_partner = 'approved' OR NOT _partner_required) THEN 'approved'
              ELSE 'pending' END
$$;

/**
 * Head office (any admin) or the godown's active channel partner approves or rejects a leave
 * request (_kind 'leave') or an attendance day (_kind 'attendance'). Each side may change its own
 * decision later; the status follows both. Returns the new status.
 */
CREATE OR REPLACE FUNCTION public.attendance_decide(_kind text, _id uuid, _decision text, _note text DEFAULT '')
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  is_admin boolean := auth.uid() IS NOT NULL AND public.has_role(auth.uid(), 'admin');
  my_branch text := public.current_partner_branch();
  rec_branch text;
  cur_status text;
  rec_flags text[];
  head text;
  part text;
  partner_required boolean;
  review text;
  next_status text;
  clean_note text := left(trim(COALESCE(_note, '')), 300);
BEGIN
  IF _decision NOT IN ('approved', 'rejected') THEN RAISE EXCEPTION 'Choose approve or reject'; END IF;
  IF _kind = 'leave' THEN
    SELECT branch_id, status, head_office_decision, partner_decision, '{x}'::text[]
      INTO rec_branch, cur_status, head, part, rec_flags FROM public.leave_requests WHERE id = _id FOR UPDATE;
  ELSIF _kind = 'attendance' THEN
    SELECT branch_id, status, head_office_decision, partner_decision, flags
      INTO rec_branch, cur_status, head, part, rec_flags FROM public.attendance_days WHERE id = _id FOR UPDATE;
  ELSE
    RAISE EXCEPTION 'Unknown request type';
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF cur_status = 'cancelled' THEN RAISE EXCEPTION 'The employee cancelled this request'; END IF;
  IF is_admin THEN
    head := _decision;
  ELSIF my_branch IS NOT NULL AND my_branch = rec_branch THEN
    part := _decision;
  ELSE
    RAISE EXCEPTION 'Only head office or this godown''s channel partner can approve';
  END IF;

  partner_required := EXISTS (SELECT 1 FROM public.channel_partners WHERE branch_id = rec_branch AND status = 'active');
  review := public.attendance_review_status(head, part, partner_required);
  IF _kind = 'leave' THEN
    next_status := review;
    UPDATE public.leave_requests SET status = next_status,
      head_office_decision = head, partner_decision = part,
      head_office_by = CASE WHEN is_admin THEN auth.uid() ELSE head_office_by END,
      head_office_at = CASE WHEN is_admin THEN now() ELSE head_office_at END,
      head_office_note = CASE WHEN is_admin THEN clean_note ELSE head_office_note END,
      partner_by = CASE WHEN is_admin THEN partner_by ELSE auth.uid() END,
      partner_at = CASE WHEN is_admin THEN partner_at ELSE now() END,
      partner_note = CASE WHEN is_admin THEN partner_note ELSE clean_note END,
      updated_at = now()
    WHERE id = _id;
  ELSE
    -- A day that needed no review stays Present unless someone rejects it.
    next_status := CASE WHEN review = 'rejected' THEN 'rejected'
                        WHEN cardinality(rec_flags) = 0 OR review = 'approved' THEN 'present'
                        ELSE 'pending' END;
    UPDATE public.attendance_days SET status = next_status,
      head_office_decision = head, partner_decision = part,
      head_office_by = CASE WHEN is_admin THEN auth.uid() ELSE head_office_by END,
      head_office_at = CASE WHEN is_admin THEN now() ELSE head_office_at END,
      head_office_note = CASE WHEN is_admin THEN clean_note ELSE head_office_note END,
      partner_by = CASE WHEN is_admin THEN partner_by ELSE auth.uid() END,
      partner_at = CASE WHEN is_admin THEN partner_at ELSE now() END,
      partner_note = CASE WHEN is_admin THEN partner_note ELSE clean_note END,
      updated_at = now()
    WHERE id = _id;
  END IF;
  RETURN next_status;
END;
$function$;
REVOKE ALL ON FUNCTION public.attendance_decide(text, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.attendance_decide(text, uuid, text, text) TO authenticated;

/** An active employee asks for leave (same limits as leaveProblem() in src/lib/attendance.ts). */
CREATE OR REPLACE FUNCTION public.request_leave(_from date, _to date, _type text, _reason text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  me public.staff_employees%ROWTYPE;
  today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  new_id uuid;
BEGIN
  SELECT * INTO me FROM public.staff_employees WHERE user_id = auth.uid() AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'Only active godown employees can request leave'; END IF;
  IF _from IS NULL OR _to IS NULL OR _to < _from THEN RAISE EXCEPTION 'The last day is before the first day'; END IF;
  IF _to - _from >= 60 THEN RAISE EXCEPTION 'A request can cover at most 60 days'; END IF;
  IF _from < today - 30 THEN RAISE EXCEPTION 'Leave more than 30 days ago can''t be requested'; END IF;
  IF _from > today + 180 THEN RAISE EXCEPTION 'Request leave at most 6 months ahead'; END IF;
  IF length(trim(COALESCE(_reason, ''))) < 3 THEN RAISE EXCEPTION 'Write the reason'; END IF;
  IF EXISTS (SELECT 1 FROM public.leave_requests WHERE employee_id = me.id AND status IN ('pending', 'approved')
             AND from_date <= _to AND to_date >= _from) THEN
    RAISE EXCEPTION 'You already have a leave request for some of these days';
  END IF;
  INSERT INTO public.leave_requests (employee_id, branch_id, from_date, to_date, leave_type, reason)
  VALUES (me.id, me.branch_id, _from, _to, _type, left(trim(_reason), 500))
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.request_leave(date, date, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_leave(date, date, text, text) TO authenticated;

/** The employee withdraws their own request: while it waits, or approved leave that hasn't started. */
CREATE OR REPLACE FUNCTION public.cancel_leave(_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  UPDATE public.leave_requests SET status = 'cancelled', updated_at = now()
  WHERE id = _id AND employee_id = public.current_employee_id()
    AND (status = 'pending' OR (status = 'approved' AND from_date > today));
  IF NOT FOUND THEN RAISE EXCEPTION 'This request can no longer be cancelled'; END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.cancel_leave(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_leave(uuid) TO authenticated;

/** The auth account already using a mobile number (the server links a new employee to it). Server only. */
CREATE OR REPLACE FUNCTION public.auth_user_id_for_phone(_phone text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'auth' AS $$
  SELECT id FROM auth.users WHERE phone IN ('91' || _phone, '+91' || _phone) LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.auth_user_id_for_phone(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_user_id_for_phone(text) TO service_role;

-- Access: admins read everything and edit employees; a channel partner reads their own godown's
-- employees, days and leave; an employee reads their own. Check-ins are written by the server
-- (service role); decisions and leave go through the functions above.
ALTER TABLE public.staff_employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leave_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_employees_admin ON public.staff_employees;
CREATE POLICY staff_employees_admin ON public.staff_employees FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS staff_employees_partner ON public.staff_employees;
CREATE POLICY staff_employees_partner ON public.staff_employees FOR SELECT TO authenticated
  USING (branch_id = public.current_partner_branch());
DROP POLICY IF EXISTS staff_employees_self ON public.staff_employees;
CREATE POLICY staff_employees_self ON public.staff_employees FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS attendance_days_admin ON public.attendance_days;
CREATE POLICY attendance_days_admin ON public.attendance_days FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS attendance_days_partner ON public.attendance_days;
CREATE POLICY attendance_days_partner ON public.attendance_days FOR SELECT TO authenticated
  USING (branch_id = public.current_partner_branch());
DROP POLICY IF EXISTS attendance_days_self ON public.attendance_days;
CREATE POLICY attendance_days_self ON public.attendance_days FOR SELECT TO authenticated
  USING (employee_id IN (SELECT id FROM public.staff_employees WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS leave_requests_admin ON public.leave_requests;
CREATE POLICY leave_requests_admin ON public.leave_requests FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS leave_requests_partner ON public.leave_requests;
CREATE POLICY leave_requests_partner ON public.leave_requests FOR SELECT TO authenticated
  USING (branch_id = public.current_partner_branch());
DROP POLICY IF EXISTS leave_requests_self ON public.leave_requests;
CREATE POLICY leave_requests_self ON public.leave_requests FOR SELECT TO authenticated
  USING (employee_id IN (SELECT id FROM public.staff_employees WHERE user_id = auth.uid()));

-- Supabase grants every new table to anon and authenticated by default; start from nothing.
REVOKE ALL ON public.staff_employees, public.attendance_days, public.leave_requests FROM PUBLIC, anon, authenticated;
-- Admins change name, designation, godown and status here; a new mobile means a new employee record.
GRANT SELECT ON public.staff_employees TO authenticated;
GRANT UPDATE (name, designation, branch_id, status, updated_at) ON public.staff_employees TO authenticated;
GRANT SELECT ON public.attendance_days, public.leave_requests TO authenticated;
GRANT ALL ON public.staff_employees, public.attendance_days, public.leave_requests TO service_role;

-- Private selfie bucket: no storage policies, so only the server (service role) can read or write.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('attendance-selfies', 'attendance-selfies', false, 2097152, ARRAY['image/jpeg'])
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

NOTIFY pgrst, 'reload schema';
