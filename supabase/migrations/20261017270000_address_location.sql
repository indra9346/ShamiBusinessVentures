-- The map point a customer captured for an address ("Use my current location"): used for
-- directions, delivery and finding the nearest godown.
ALTER TABLE public.addresses
  ADD COLUMN IF NOT EXISTS latitude double precision CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  ADD COLUMN IF NOT EXISTS longitude double precision CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  ADD COLUMN IF NOT EXISTS location_accuracy_m numeric(10,1) CHECK (location_accuracy_m IS NULL OR location_accuracy_m >= 0),
  ADD COLUMN IF NOT EXISTS located_at timestamptz;
