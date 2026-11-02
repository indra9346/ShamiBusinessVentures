-- Attendance rules per godown (owner's request, 2 Nov 2026): head office sets every rule separately
-- for each godown, and a rule change never rewrites the past.
--
--   * godown_rule_versions: every save adds a new, fixed row with the date it starts from. The rules
--     for a date = the newest row that has started by that date. Only head office can add one, and
--     only for today or later (save_godown_rules).
--   * Each attendance day and leave request keeps the version it started under (rule_version_id), so
--     its late and early minutes, half day / absent result, presence photos due and leave approval
--     stay as they were. Days with no record (weekly off, absent) use the version of their date.
--   * The database, not the phone or the server code, works out late and early minutes
--     (attendance_days_apply_rules) and enforces the leave limits (request_leave).
--   * godown_holidays: each godown's own holiday list. A holiday isn't counted as absent.
--
-- Every godown starts with one version holding the values it has today (new rules default to what the
-- code did until now), so nothing changes for it until an admin edits it. The rule columns on branches
-- stay only so the previous site zip works until this one is uploaded; the new code does not read them
-- (latitude and longitude stay on branches: a godown's location is a fact, not a dated rule).

CREATE TABLE IF NOT EXISTS public.godown_rule_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id text NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  effective_from date NOT NULL,
  -- Shift and what counts as late or left early.
  shift_start time NOT NULL,
  shift_end time NOT NULL,
  late_grace_min integer NOT NULL CHECK (late_grace_min BETWEEN 0 AND 240),
  late_counted_from text NOT NULL DEFAULT 'shift_start' CHECK (late_counted_from IN ('shift_start', 'grace_end')),
  early_grace_min integer NOT NULL DEFAULT 0 CHECK (early_grace_min BETWEEN 0 AND 240),
  -- Half day and absent, by minutes worked (0 = off: any check-in counts as present).
  half_day_below_min integer NOT NULL DEFAULT 0 CHECK (half_day_below_min BETWEEN 0 AND 1440),
  absent_below_min integer NOT NULL DEFAULT 0 CHECK (absent_below_min BETWEEN 0 AND 1440),
  missed_checkout text NOT NULL DEFAULT 'present' CHECK (missed_checkout IN ('present', 'half_day', 'absent')),
  -- 0 = Sunday … 6 = Saturday; NULL = open every day.
  weekly_off smallint CHECK (weekly_off IS NULL OR weekly_off BETWEEN 0 AND 6),
  -- Where and on what attendance can be marked.
  radius_m integer NOT NULL CHECK (radius_m BETWEEN 25 AND 2000),
  -- Positions rougher than this are refused. Every godown starts from what the code did: 100 m, or its radius if larger.
  gps_accuracy_limit_m integer NOT NULL DEFAULT 150 CHECK (gps_accuracy_limit_m BETWEEN 10 AND 2000),
  require_device boolean NOT NULL DEFAULT true,
  -- Presence photos (0 = off), and the window around each due time that counts as on time.
  presence_interval_min integer NOT NULL CHECK (presence_interval_min = 0 OR presence_interval_min BETWEEN 30 AND 480),
  presence_early_min integer NOT NULL DEFAULT 15 CHECK (presence_early_min BETWEEN 0 AND 120),
  presence_late_min integer NOT NULL DEFAULT 30 CHECK (presence_late_min BETWEEN 0 AND 240),
  -- Leave.
  leave_types text[] NOT NULL DEFAULT '{casual,sick,festival,other}'
    CHECK (cardinality(leave_types) >= 1 AND leave_types <@ '{casual,sick,festival,other}'::text[]),
  leave_max_days integer NOT NULL DEFAULT 60 CHECK (leave_max_days BETWEEN 1 AND 60),
  leave_back_days integer NOT NULL DEFAULT 30 CHECK (leave_back_days BETWEEN 0 AND 365),
  leave_ahead_days integer NOT NULL DEFAULT 180 CHECK (leave_ahead_days BETWEEN 0 AND 365),
  leave_partner_required boolean NOT NULL DEFAULT true,
  -- Who changed it, and a scheduled change head office called off before it started.
  note text NOT NULL DEFAULT '',
  created_by uuid,
  created_by_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  cancelled_by uuid,
  CHECK (shift_end > shift_start),
  CHECK (half_day_below_min = 0 OR absent_below_min < half_day_below_min),
  CHECK (presence_interval_min = 0 OR presence_early_min + presence_late_min < presence_interval_min)
);
CREATE INDEX IF NOT EXISTS godown_rule_versions_lookup_idx ON public.godown_rule_versions (branch_id, effective_from DESC, created_at DESC);

-- The date every godown's first version starts from.
INSERT INTO public.godown_rule_versions (branch_id, effective_from, shift_start, shift_end, late_grace_min, weekly_off, radius_m, gps_accuracy_limit_m, presence_interval_min, note)
SELECT id, DATE '2000-01-01', shift_start, shift_end, late_grace_min, weekly_off, attendance_radius_m, GREATEST(100, attendance_radius_m), presence_interval_min, 'Starting rules'
FROM public.branches b
WHERE vendor_id IS NULL AND NOT EXISTS (SELECT 1 FROM public.godown_rule_versions v WHERE v.branch_id = b.id);

/** A godown added later starts from its own column defaults, like the ones above. */
CREATE OR REPLACE FUNCTION public.branches_seed_rules()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  INSERT INTO public.godown_rule_versions (branch_id, effective_from, shift_start, shift_end, late_grace_min, weekly_off, radius_m, gps_accuracy_limit_m, presence_interval_min, note)
  VALUES (NEW.id, DATE '2000-01-01', NEW.shift_start, NEW.shift_end, NEW.late_grace_min, NEW.weekly_off, NEW.attendance_radius_m, GREATEST(100, NEW.attendance_radius_m), NEW.presence_interval_min, 'Starting rules');
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS branches_seed_rules ON public.branches;
CREATE TRIGGER branches_seed_rules AFTER INSERT ON public.branches
  FOR EACH ROW WHEN (NEW.vendor_id IS NULL) EXECUTE FUNCTION public.branches_seed_rules();
REVOKE ALL ON FUNCTION public.branches_seed_rules() FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.godown_holidays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id text NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  holiday_date date NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 80),
  created_by uuid,
  created_by_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A removed holiday stays on record: a past one removed means its absent marks came back.
  removed_at timestamptz,
  removed_by uuid
);
CREATE UNIQUE INDEX IF NOT EXISTS godown_holidays_one_per_day ON public.godown_holidays (branch_id, holiday_date) WHERE removed_at IS NULL;

/** The rules for a date: the newest version that has started by then. */
CREATE OR REPLACE FUNCTION public.godown_rules_on(_branch text, _date date)
RETURNS public.godown_rule_versions LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT * FROM public.godown_rule_versions
  WHERE branch_id = _branch AND effective_from <= _date AND cancelled_at IS NULL
  ORDER BY effective_from DESC, created_at DESC, id DESC LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.godown_rules_on(text, date) FROM PUBLIC, anon, authenticated;

/** Minutes since India midnight of an instant. Same as indiaMinutes() in src/lib/attendance.ts. */
CREATE OR REPLACE FUNCTION public.india_minutes(_at timestamptz)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT (EXTRACT(HOUR FROM _at AT TIME ZONE 'Asia/Kolkata') * 60 + EXTRACT(MINUTE FROM _at AT TIME ZONE 'Asia/Kolkata'))::integer
$$;

/** Same rule as lateMinutes() in src/lib/attendance.ts. */
CREATE OR REPLACE FUNCTION public.attendance_late_minutes(_check_in timestamptz, _shift_start time, _grace integer, _counted_from text)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN after_start <= GREATEST(_grace, 0) THEN 0
              WHEN _counted_from = 'grace_end' THEN after_start - GREATEST(_grace, 0)
              ELSE after_start END
  FROM (SELECT public.india_minutes(_check_in) - (EXTRACT(HOUR FROM _shift_start) * 60 + EXTRACT(MINUTE FROM _shift_start))::integer AS after_start) t
$$;

/** Same rule as earlyLeaveMinutes() in src/lib/attendance.ts. */
CREATE OR REPLACE FUNCTION public.attendance_early_minutes(_check_out timestamptz, _shift_end time, _grace integer)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN before_end <= GREATEST(_grace, 0) THEN 0 ELSE before_end END
  FROM (SELECT (EXTRACT(HOUR FROM _shift_end) * 60 + EXTRACT(MINUTE FROM _shift_end))::integer - public.india_minutes(_check_out) AS before_end) t
$$;
REVOKE ALL ON FUNCTION public.india_minutes(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.attendance_late_minutes(timestamptz, time, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.attendance_early_minutes(timestamptz, time, integer) FROM PUBLIC, anon, authenticated;

-- Each day and leave request keeps the rules it started under. Existing ones get the starting version.
ALTER TABLE public.attendance_days ADD COLUMN IF NOT EXISTS rule_version_id uuid REFERENCES public.godown_rule_versions(id);
ALTER TABLE public.leave_requests ADD COLUMN IF NOT EXISTS rule_version_id uuid REFERENCES public.godown_rule_versions(id);
UPDATE public.attendance_days d SET rule_version_id = (public.godown_rules_on(d.branch_id, d.work_date)).id WHERE rule_version_id IS NULL;
UPDATE public.leave_requests l SET rule_version_id = (public.godown_rules_on(l.branch_id, (l.created_at AT TIME ZONE 'Asia/Kolkata')::date)).id WHERE rule_version_id IS NULL;
ALTER TABLE public.attendance_days ALTER COLUMN rule_version_id SET NOT NULL;
ALTER TABLE public.leave_requests ALTER COLUMN rule_version_id SET NOT NULL;

/**
 * Late and early minutes come from the rules of the godown and date, whoever writes the row. Once
 * set, a day's rules and late minutes can't change, and its early minutes only when it checks out.
 */
CREATE OR REPLACE FUNCTION public.attendance_days_apply_rules()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  rules public.godown_rule_versions%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    rules := public.godown_rules_on(NEW.branch_id, NEW.work_date);
    IF rules.id IS NULL THEN RAISE EXCEPTION 'This godown has no attendance rules. Contact head office.'; END IF;
    NEW.rule_version_id := rules.id;
    NEW.late_minutes := public.attendance_late_minutes(NEW.check_in_at, rules.shift_start, rules.late_grace_min, rules.late_counted_from);
    NEW.flags := array_remove(NEW.flags, 'late') || CASE WHEN NEW.late_minutes > 0 THEN ARRAY['late'] ELSE '{}'::text[] END;
    NEW.early_leave_minutes := 0;
    RETURN NEW;
  END IF;
  NEW.rule_version_id := OLD.rule_version_id;
  NEW.late_minutes := OLD.late_minutes;
  NEW.early_leave_minutes := OLD.early_leave_minutes;
  IF OLD.check_out_at IS NULL AND NEW.check_out_at IS NOT NULL THEN
    SELECT * INTO rules FROM public.godown_rule_versions WHERE id = OLD.rule_version_id;
    NEW.early_leave_minutes := public.attendance_early_minutes(NEW.check_out_at, rules.shift_end, rules.early_grace_min);
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS attendance_days_apply_rules ON public.attendance_days;
CREATE TRIGGER attendance_days_apply_rules BEFORE INSERT OR UPDATE ON public.attendance_days
  FOR EACH ROW EXECUTE FUNCTION public.attendance_days_apply_rules();
REVOKE ALL ON FUNCTION public.attendance_days_apply_rules() FROM PUBLIC, anon, authenticated;

/**
 * Head office adds a godown's new rules from a date (today or later). Rules left out keep the value
 * they have on that date. A version holds every rule, so new rules can't start before a scheduled
 * change: they would be undone when it starts.
 */
CREATE OR REPLACE FUNCTION public.save_godown_rules(_branch text, _effective_from date, _rules jsonb, _note text DEFAULT '')
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  merged public.godown_rule_versions%ROWTYPE;
  scheduled date;
  new_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only head office can change attendance rules'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = _branch AND vendor_id IS NULL) THEN RAISE EXCEPTION 'Godown not found'; END IF;
  IF _effective_from IS NULL OR _effective_from < today THEN RAISE EXCEPTION 'New rules can start today or later. Past days keep the rules they had.'; END IF;
  IF _effective_from > today + 366 THEN RAISE EXCEPTION 'New rules can start at most a year ahead'; END IF;
  SELECT max(effective_from) INTO scheduled FROM public.godown_rule_versions WHERE branch_id = _branch AND cancelled_at IS NULL;
  IF scheduled > _effective_from THEN
    RAISE EXCEPTION 'A change is already scheduled from %. Cancel it first, or start these rules on or after that date.', scheduled;
  END IF;
  merged := public.godown_rules_on(_branch, _effective_from);
  merged := jsonb_populate_record(merged, COALESCE(_rules, '{}'::jsonb));
  INSERT INTO public.godown_rule_versions (
    branch_id, effective_from, shift_start, shift_end, late_grace_min, late_counted_from, early_grace_min, half_day_below_min, absent_below_min,
    missed_checkout, weekly_off, radius_m, gps_accuracy_limit_m, require_device, presence_interval_min, presence_early_min, presence_late_min,
    leave_types, leave_max_days, leave_back_days, leave_ahead_days, leave_partner_required, note, created_by, created_by_name
  ) VALUES (
    _branch, _effective_from, merged.shift_start, merged.shift_end, merged.late_grace_min, merged.late_counted_from, merged.early_grace_min, merged.half_day_below_min, merged.absent_below_min,
    merged.missed_checkout, merged.weekly_off, merged.radius_m, merged.gps_accuracy_limit_m, merged.require_device, merged.presence_interval_min, merged.presence_early_min, merged.presence_late_min,
    merged.leave_types, merged.leave_max_days, merged.leave_back_days, merged.leave_ahead_days, merged.leave_partner_required, left(trim(COALESCE(_note, '')), 200), auth.uid(),
    COALESCE((SELECT full_name FROM public.profiles WHERE id = auth.uid()), '')
  ) RETURNING id INTO new_id;
  RETURN new_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.save_godown_rules(text, date, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_godown_rules(text, date, jsonb, text) TO authenticated;

/**
 * Head office calls off a scheduled change before it starts, newest first (a later one was built on
 * it). Rules already in force can only be replaced.
 */
CREATE OR REPLACE FUNCTION public.cancel_godown_rules(_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  target public.godown_rule_versions%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only head office can change attendance rules'; END IF;
  SELECT * INTO target FROM public.godown_rule_versions WHERE id = _id;
  IF EXISTS (SELECT 1 FROM public.godown_rule_versions v WHERE v.branch_id = target.branch_id AND v.cancelled_at IS NULL AND v.id <> target.id
             AND (v.effective_from, v.created_at) > (target.effective_from, target.created_at)) THEN
    RAISE EXCEPTION 'Cancel the later scheduled change first';
  END IF;
  UPDATE public.godown_rule_versions SET cancelled_at = now(), cancelled_by = auth.uid()
  WHERE id = _id AND cancelled_at IS NULL AND effective_from > today;
  IF NOT FOUND THEN RAISE EXCEPTION 'Only a change that has not started can be cancelled'; END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.cancel_godown_rules(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_godown_rules(uuid) TO authenticated;

/** Head office adds a holiday for a godown (or renames one), at most 30 days back. */
CREATE OR REPLACE FUNCTION public.set_godown_holiday(_branch text, _date date, _name text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  clean_name text := left(trim(COALESCE(_name, '')), 80);
  holiday_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only head office can change holidays'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = _branch AND vendor_id IS NULL) THEN RAISE EXCEPTION 'Godown not found'; END IF;
  IF _date IS NULL OR _date < today - 30 THEN RAISE EXCEPTION 'A holiday more than 30 days ago can''t be changed'; END IF;
  IF _date > today + 400 THEN RAISE EXCEPTION 'A holiday can be set at most a year ahead'; END IF;
  IF length(clean_name) < 2 THEN RAISE EXCEPTION 'Write the holiday''s name'; END IF;
  UPDATE public.godown_holidays SET name = clean_name WHERE branch_id = _branch AND holiday_date = _date AND removed_at IS NULL RETURNING id INTO holiday_id;
  IF holiday_id IS NULL THEN
    INSERT INTO public.godown_holidays (branch_id, holiday_date, name, created_by, created_by_name)
    VALUES (_branch, _date, clean_name, auth.uid(), COALESCE((SELECT full_name FROM public.profiles WHERE id = auth.uid()), ''))
    RETURNING id INTO holiday_id;
  END IF;
  RETURN holiday_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.set_godown_holiday(text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_godown_holiday(text, date, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.remove_godown_holiday(_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only head office can change holidays'; END IF;
  UPDATE public.godown_holidays SET removed_at = now(), removed_by = auth.uid()
  WHERE id = _id AND removed_at IS NULL AND holiday_date >= today - 30;
  IF NOT FOUND THEN RAISE EXCEPTION 'A holiday more than 30 days ago can''t be changed'; END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.remove_godown_holiday(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_godown_holiday(uuid) TO authenticated;

/** Same limits as leaveProblem() in src/lib/attendance.ts, from the rules of the employee's godown today. */
CREATE OR REPLACE FUNCTION public.request_leave(_from date, _to date, _type text, _reason text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  me public.staff_employees%ROWTYPE;
  today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  rules public.godown_rule_versions%ROWTYPE;
  new_id uuid;
BEGIN
  SELECT * INTO me FROM public.staff_employees WHERE user_id = auth.uid() AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'Only active godown employees can request leave'; END IF;
  rules := public.godown_rules_on(me.branch_id, today);
  IF rules.id IS NULL THEN RAISE EXCEPTION 'This godown has no attendance rules. Contact head office.'; END IF;
  IF _from IS NULL OR _to IS NULL OR _to < _from THEN RAISE EXCEPTION 'The last day is before the first day'; END IF;
  IF _type IS NULL OR NOT _type = ANY (rules.leave_types) THEN RAISE EXCEPTION 'This type of leave is not available at your godown'; END IF;
  IF _to - _from >= rules.leave_max_days THEN RAISE EXCEPTION 'A request can cover at most % days', rules.leave_max_days; END IF;
  IF _from < today - rules.leave_back_days THEN
    IF rules.leave_back_days = 0 THEN RAISE EXCEPTION 'Leave for past days can''t be requested'; END IF;
    RAISE EXCEPTION 'Leave more than % days ago can''t be requested', rules.leave_back_days;
  END IF;
  IF _from > today + rules.leave_ahead_days THEN RAISE EXCEPTION 'Request leave at most % days ahead', rules.leave_ahead_days; END IF;
  IF length(trim(COALESCE(_reason, ''))) < 3 THEN RAISE EXCEPTION 'Write the reason'; END IF;
  IF EXISTS (SELECT 1 FROM public.leave_requests WHERE employee_id = me.id AND status IN ('pending', 'approved')
             AND from_date <= _to AND to_date >= _from) THEN
    RAISE EXCEPTION 'You already have a leave request for some of these days';
  END IF;
  INSERT INTO public.leave_requests (employee_id, branch_id, from_date, to_date, leave_type, reason, rule_version_id)
  VALUES (me.id, me.branch_id, _from, _to, _type, left(trim(_reason), 500), rules.id)
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$function$;

/**
 * Head office (any admin) or the godown's active channel partner approves or rejects a leave
 * request (_kind 'leave') or an attendance day (_kind 'attendance'). Each side may change its own
 * decision later; the status follows both. Leave follows the godown's rule from when it was
 * requested: where head office alone decides, the partner has no say. Returns the new status.
 */
CREATE OR REPLACE FUNCTION public.attendance_decide(_kind text, _id uuid, _decision text, _note text DEFAULT '')
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  is_admin boolean := auth.uid() IS NOT NULL AND public.has_role(auth.uid(), 'admin');
  my_branch text := public.current_partner_branch();
  rec_branch text;
  cur_status text;
  rec_flags text[];
  rec_rules uuid;
  head text;
  part text;
  partner_required boolean;
  review text;
  next_status text;
  clean_note text := left(trim(COALESCE(_note, '')), 300);
BEGIN
  IF _decision NOT IN ('approved', 'rejected') THEN RAISE EXCEPTION 'Choose approve or reject'; END IF;
  IF _kind = 'leave' THEN
    SELECT branch_id, status, head_office_decision, partner_decision, '{x}'::text[], rule_version_id
      INTO rec_branch, cur_status, head, part, rec_flags, rec_rules FROM public.leave_requests WHERE id = _id FOR UPDATE;
  ELSIF _kind = 'attendance' THEN
    SELECT branch_id, status, head_office_decision, partner_decision, flags
      INTO rec_branch, cur_status, head, part, rec_flags FROM public.attendance_days WHERE id = _id FOR UPDATE;
  ELSE
    RAISE EXCEPTION 'Unknown request type';
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF cur_status = 'cancelled' THEN RAISE EXCEPTION 'The employee cancelled this request'; END IF;

  partner_required := EXISTS (SELECT 1 FROM public.channel_partners WHERE branch_id = rec_branch AND status = 'active');
  IF _kind = 'leave' THEN
    partner_required := partner_required AND COALESCE((SELECT leave_partner_required FROM public.godown_rule_versions WHERE id = rec_rules), true);
  END IF;
  IF is_admin THEN
    head := _decision;
  ELSIF my_branch IS NOT NULL AND my_branch = rec_branch THEN
    IF _kind = 'leave' AND NOT partner_required THEN RAISE EXCEPTION 'Head office alone decides leave at this godown'; END IF;
    part := _decision;
  ELSE
    RAISE EXCEPTION 'Only head office or this godown''s channel partner can approve';
  END IF;

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

-- Access: admins read every godown's rules and holidays; a channel partner and an employee their own
-- godown's. Nobody writes the tables directly: changes go through the head-office functions above.
ALTER TABLE public.godown_rule_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.godown_holidays ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS godown_rule_versions_admin ON public.godown_rule_versions;
CREATE POLICY godown_rule_versions_admin ON public.godown_rule_versions FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS godown_rule_versions_partner ON public.godown_rule_versions;
CREATE POLICY godown_rule_versions_partner ON public.godown_rule_versions FOR SELECT TO authenticated
  USING (branch_id = public.current_partner_branch());
DROP POLICY IF EXISTS godown_rule_versions_staff ON public.godown_rule_versions;
CREATE POLICY godown_rule_versions_staff ON public.godown_rule_versions FOR SELECT TO authenticated
  USING (branch_id IN (SELECT branch_id FROM public.staff_employees WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS godown_holidays_admin ON public.godown_holidays;
CREATE POLICY godown_holidays_admin ON public.godown_holidays FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS godown_holidays_partner ON public.godown_holidays;
CREATE POLICY godown_holidays_partner ON public.godown_holidays FOR SELECT TO authenticated
  USING (branch_id = public.current_partner_branch());
DROP POLICY IF EXISTS godown_holidays_staff ON public.godown_holidays;
CREATE POLICY godown_holidays_staff ON public.godown_holidays FOR SELECT TO authenticated
  USING (branch_id IN (SELECT branch_id FROM public.staff_employees WHERE user_id = auth.uid()));

REVOKE ALL ON public.godown_rule_versions, public.godown_holidays FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.godown_rule_versions, public.godown_holidays TO authenticated;
GRANT ALL ON public.godown_rule_versions, public.godown_holidays TO service_role;

NOTIFY pgrst, 'reload schema';
