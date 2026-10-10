-- Seed initial storefront categories and approved catalog products.
-- Ensures live database queries return enabled categories and published products.

-- 1. Store categories
INSERT INTO public.store_categories (id, name, enabled, sort_order, payload, updated_at)
VALUES
  ('C1', 'Rice', true, 1, '{"id":"C1","name":"Rice","tagline":"Raw, steam & premium grades","grades":["Raw Rice","Steam Rice","Premium Rice"],"enabled":true,"order":1}'::jsonb, now()),
  ('C2', 'Sugar', true, 2, '{"id":"C2","name":"Sugar","tagline":"Mill-fresh refined sugar","grades":["Grade S1","S1 Sugar"],"enabled":true,"order":2}'::jsonb, now()),
  ('C3', 'Oil', true, 3, '{"id":"C3","name":"Oil","tagline":"Edible oils in every pack size","grades":["Sunflower Oil","Groundnut Oil","Palm Oil"],"enabled":true,"order":3}'::jsonb, now()),
  ('C4', 'Pulses', false, 4, '{"id":"C4","name":"Pulses","tagline":"Everyday dals and pulses","grades":["Toor Dal","Urad Dal","Chana Dal","Moong Dal"],"enabled":false,"order":4}'::jsonb, now()),
  ('C5', 'Flours', false, 5, '{"id":"C5","name":"Flours","tagline":"Fresh staples for every kitchen","grades":["Chakki Atta","Maida","Besan"],"enabled":false,"order":5}'::jsonb, now()),
  ('C6', 'Spices', false, 6, '{"id":"C6","name":"Spices","tagline":"Quality spices and seasonings","grades":["Turmeric","Chilli Powder","Coriander"],"enabled":false,"order":6}'::jsonb, now()),
  ('C7', 'Dry Fruits', false, 7, '{"id":"C7","name":"Dry Fruits","tagline":"Carefully sourced dry fruits","grades":["Cashew","Almond","Raisins"],"enabled":false,"order":7}'::jsonb, now()),
  ('C8', 'Tea & Coffee', false, 8, '{"id":"C8","name":"Tea & Coffee","tagline":"Tea and coffee for every day","grades":["CTC Tea","Filter Coffee"],"enabled":false,"order":8}'::jsonb, now()),
  ('C9', 'Jaggery', false, 9, '{"id":"C9","name":"Jaggery","tagline":"Traditional jaggery products","grades":["Organic Jaggery","Jaggery Powder"],"enabled":false,"order":9}'::jsonb, now()),
  ('C10', 'Salt & Sweeteners', false, 10, '{"id":"C10","name":"Salt & Sweeteners","tagline":"Salt and natural sweeteners","grades":["Iodised Salt","Rock Salt"],"enabled":false,"order":10}'::jsonb, now())
ON CONFLICT (id) DO UPDATE SET
  enabled = EXCLUDED.enabled,
  sort_order = EXCLUDED.sort_order,
  payload = EXCLUDED.payload,
  updated_at = now();

-- Products are created through authenticated admin/vendor workflows so every active product has a real vendor owner.

-- 3. Enhance handle_new_user() trigger to save phone number from auth.users column if not in metadata
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, email, phone, company, gstin, vendor_id)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    COALESCE(NEW.email, ''),
    COALESCE(NEW.raw_user_meta_data->>'phone', NEW.phone, ''),
    NEW.raw_user_meta_data->>'company',
    NEW.raw_user_meta_data->>'gstin',
    NULL
  )
  ON CONFLICT (id) DO UPDATE SET
    phone = CASE WHEN public.profiles.phone IS NULL OR public.profiles.phone = ''
                 THEN COALESCE(NEW.raw_user_meta_data->>'phone', NEW.phone, '')
                 ELSE public.profiles.phone END,
    full_name = CASE WHEN public.profiles.full_name IS NULL OR public.profiles.full_name = ''
                     THEN COALESCE(NEW.raw_user_meta_data->>'full_name', '')
                     ELSE public.profiles.full_name END;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'customer'::public.app_role)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
