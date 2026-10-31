-- Attendance v2 (client feedback, 31 Oct 2026 evening):
--   * Staff sign in with mobile number + password (set by head office), not an SMS code. Their login
--     is a separate staff-only account (login_email = <mobile>@staff.grainbazar.com).
--   * Selfies come from the godown's own registered device (godown_devices): head office makes a
--     one-time code, the godown's phone/tablet registers with it, and the server accepts attendance
--     only from an active device of the employee's own godown.
--   * Check-in and check-out work only inside the godown's radius; no approval step for check-ins.
--     Late (after shift start + grace) and early leave (before shift end) are recorded in minutes.
--   * While checked in, a live geotagged selfie is due every presence_interval_min minutes.
--   * Staff records can't be edited once created: only active / inactive can change.
--   * Leave keeps its approval by head office and the godown's channel partner.

ALTER TABLE public.branches
  ADD COLUMN IF NOT EXISTS shift_end time NOT NULL DEFAULT '18:30',
  ADD COLUMN IF NOT EXISTS presence_interval_min integer NOT NULL DEFAULT 120
    CHECK (presence_interval_min = 0 OR presence_interval_min BETWEEN 30 AND 480);

ALTER TABLE public.attendance_days
  ADD COLUMN IF NOT EXISTS early_leave_minutes integer NOT NULL DEFAULT 0 CHECK (early_leave_minutes >= 0),
  ADD COLUMN IF NOT EXISTS in_device_id uuid,
  ADD COLUMN IF NOT EXISTS out_device_id uuid;

-- Check-ins need no approval any more: a day still waiting counts as present (its flags stay on record).
UPDATE public.attendance_days SET status = 'present', updated_at = now() WHERE status = 'pending';

ALTER TABLE public.staff_employees ADD COLUMN IF NOT EXISTS login_email text UNIQUE;

-- The godown's own attendance devices. The device keeps a random token; only its hash is stored.
CREATE TABLE IF NOT EXISTS public.godown_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id text NOT NULL REFERENCES public.branches(id),
  label text NOT NULL DEFAULT '',
  token_hash text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  registered_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS godown_devices_branch_idx ON public.godown_devices (branch_id, active);

-- One-time codes head office makes to register a device (15 minutes, single use). Server only.
CREATE TABLE IF NOT EXISTS public.godown_device_codes (
  code_hash text PRIMARY KEY,
  branch_id text NOT NULL REFERENCES public.branches(id),
  label text NOT NULL DEFAULT '',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  device_id uuid
);

-- Presence photos taken while checked in (live selfie + the device's GPS position).
CREATE TABLE IF NOT EXISTS public.attendance_presence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attendance_day_id uuid NOT NULL REFERENCES public.attendance_days(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.staff_employees(id) ON DELETE CASCADE,
  branch_id text NOT NULL REFERENCES public.branches(id),
  taken_at timestamptz NOT NULL DEFAULT now(),
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  accuracy_m numeric(10,1) NOT NULL,
  distance_m integer,
  inside boolean NOT NULL,
  selfie text NOT NULL,
  device_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attendance_presence_day_idx ON public.attendance_presence (attendance_day_id, taken_at);
CREATE INDEX IF NOT EXISTS attendance_presence_branch_idx ON public.attendance_presence (branch_id, taken_at DESC);

ALTER TABLE public.godown_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.godown_device_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_presence ENABLE ROW LEVEL SECURITY;

-- Admins see every godown's devices (not the token hashes); devices are added and revoked by the server.
DROP POLICY IF EXISTS godown_devices_admin ON public.godown_devices;
CREATE POLICY godown_devices_admin ON public.godown_devices FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- Presence photos: admins all; a channel partner their godown; an employee their own.
DROP POLICY IF EXISTS attendance_presence_admin ON public.attendance_presence;
CREATE POLICY attendance_presence_admin ON public.attendance_presence FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS attendance_presence_partner ON public.attendance_presence;
CREATE POLICY attendance_presence_partner ON public.attendance_presence FOR SELECT TO authenticated
  USING (branch_id = public.current_partner_branch());
DROP POLICY IF EXISTS attendance_presence_self ON public.attendance_presence;
CREATE POLICY attendance_presence_self ON public.attendance_presence FOR SELECT TO authenticated
  USING (employee_id IN (SELECT id FROM public.staff_employees WHERE user_id = auth.uid()));

REVOKE ALL ON public.godown_devices, public.godown_device_codes, public.attendance_presence FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, branch_id, label, active, created_at, last_seen_at, revoked_at) ON public.godown_devices TO authenticated;
GRANT SELECT ON public.attendance_presence TO authenticated;
GRANT ALL ON public.godown_devices, public.godown_device_codes, public.attendance_presence TO service_role;

-- Staff records are fixed once created: admins can only switch an employee active / inactive.
REVOKE UPDATE ON public.staff_employees FROM authenticated;
GRANT UPDATE (status, updated_at) ON public.staff_employees TO authenticated;

NOTIFY pgrst, 'reload schema';
