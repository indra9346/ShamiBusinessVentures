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

-- 2. Initial published, active catalog products
INSERT INTO public.catalog_products (id, vendor_id, category, status, active, payload, created_at, updated_at)
VALUES
  ('P001', 'VENDOR-001', 'Sugar', 'approved', true, '{
    "id": "P001",
    "name": "S1 Refined Sugar 50kg Bag",
    "sku": "SBV-SU-1000",
    "brand": "Shami Select",
    "vendor": "Shami Sugar Mills",
    "vendorId": "VENDOR-001",
    "category": "Sugar",
    "subcategory": "S1 Sugar",
    "image": "/products/sugar.jpg",
    "mrp": 2650,
    "price": 2399,
    "gst": 5,
    "rating": 4.8,
    "reviews": 34,
    "stock": 180,
    "reserved": 0,
    "sold": 420,
    "weight": "50 kg",
    "status": "approved",
    "active": true,
    "tags": ["bestseller", "featured"],
    "description": "Premium commercial Grade S1 refined crystal sugar. Direct from verified sugar mills in Belagavi. Ideal for sweets, bakeries and bulk institutional buyers.",
    "specs": [{"label":"Pack Size","value":"50 kg"},{"label":"Brand","value":"Shami Select"},{"label":"Grade","value":"S1"},{"label":"Shelf Life","value":"24 months"}],
    "created": "01 Oct 2026",
    "updated": "08 Oct 2026"
  }'::jsonb, now(), now()),

  ('P004', 'VENDOR-001', 'Sugar', 'approved', true, '{
    "id": "P004",
    "name": "S1 Sugar Retail Pack 1kg",
    "sku": "SBV-SU-1003",
    "brand": "Shami Select",
    "vendor": "Shami Sugar Mills",
    "vendorId": "VENDOR-001",
    "category": "Sugar",
    "subcategory": "S1 Sugar",
    "image": "/products/sugar.jpg",
    "mrp": 62,
    "price": 54,
    "gst": 5,
    "rating": 4.6,
    "reviews": 22,
    "stock": 250,
    "reserved": 0,
    "sold": 190,
    "weight": "1 kg",
    "status": "approved",
    "active": true,
    "tags": ["recommended"],
    "description": "Double refined sparkling white sugar packaged in moisture-proof food-grade pouches.",
    "specs": [{"label":"Pack Size","value":"1 kg"},{"label":"Brand","value":"Shami Select"},{"label":"Grade","value":"S1"}],
    "created": "02 Oct 2026",
    "updated": "08 Oct 2026"
  }'::jsonb, now(), now()),

  ('P009', 'VENDOR-001', 'Rice', 'approved', true, '{
    "id": "P009",
    "name": "Grade A Raw Rice 25kg",
    "sku": "SBV-RI-1008",
    "brand": "Shami Select",
    "vendor": "Kaveri Agro Traders",
    "vendorId": "VENDOR-001",
    "category": "Rice",
    "subcategory": "Raw Rice",
    "image": "/products/rice.jpg",
    "mrp": 1650,
    "price": 1499,
    "gst": 5,
    "rating": 4.7,
    "reviews": 45,
    "stock": 120,
    "reserved": 0,
    "sold": 310,
    "weight": "25 kg",
    "status": "approved",
    "active": true,
    "tags": ["bestseller", "featured"],
    "description": "Aged raw rice, carefully destoned and sorted. Exceptional aroma, fluffiness and non-sticky texture.",
    "specs": [{"label":"Pack Size","value":"25 kg"},{"label":"Grade","value":"Grade A Raw"},{"label":"Origin","value":"Karnataka"}],
    "created": "02 Oct 2026",
    "updated": "08 Oct 2026"
  }'::jsonb, now(), now()),

  ('P010', 'VENDOR-001', 'Rice', 'approved', true, '{
    "id": "P010",
    "name": "Grade A Steam Rice Sona Masoori 25kg",
    "sku": "SBV-RI-1009",
    "brand": "Shami Select",
    "vendor": "Kaveri Agro Traders",
    "vendorId": "VENDOR-001",
    "category": "Rice",
    "subcategory": "Steam Rice",
    "image": "/products/rice.jpg",
    "mrp": 1750,
    "price": 1585,
    "gst": 5,
    "rating": 4.9,
    "reviews": 60,
    "stock": 160,
    "reserved": 0,
    "sold": 490,
    "weight": "25 kg",
    "status": "approved",
    "active": true,
    "tags": ["bestseller", "featured"],
    "description": "Authentic premium Sona Masoori steam rice. Lightweight and easy to digest, preferred by households and caterers.",
    "specs": [{"label":"Pack Size","value":"25 kg"},{"label":"Variety","value":"Sona Masoori"},{"label":"Processing","value":"Steam"}],
    "created": "03 Oct 2026",
    "updated": "08 Oct 2026"
  }'::jsonb, now(), now()),

  ('P016', 'VENDOR-001', 'Rice', 'approved', true, '{
    "id": "P016",
    "name": "Premium Rice Basmati Classic 5kg",
    "sku": "SBV-RI-1015",
    "brand": "Shami Select",
    "vendor": "Kaveri Agro Traders",
    "vendorId": "VENDOR-001",
    "category": "Rice",
    "subcategory": "Premium Rice",
    "image": "/products/rice.jpg",
    "mrp": 690,
    "price": 615,
    "gst": 5,
    "rating": 4.9,
    "reviews": 38,
    "stock": 90,
    "reserved": 0,
    "sold": 140,
    "weight": "5 kg",
    "status": "approved",
    "active": true,
    "tags": ["featured", "offer"],
    "description": "Extra long grain royal basmati rice with distinctive natural fragrance.",
    "specs": [{"label":"Pack Size","value":"5 kg"},{"label":"Grain","value":"Extra Long Basmati"}],
    "created": "04 Oct 2026",
    "updated": "08 Oct 2026"
  }'::jsonb, now(), now()),

  ('P019', 'VENDOR-001', 'Oil', 'approved', true, '{
    "id": "P019",
    "name": "Sunflower Oil 15L Tin",
    "sku": "SBV-OI-1018",
    "brand": "Shami Select",
    "vendor": "Deccan Oil Company",
    "vendorId": "VENDOR-001",
    "category": "Oil",
    "subcategory": "Sunflower Oil",
    "image": "/products/oil.jpg",
    "mrp": 2250,
    "price": 2049,
    "gst": 5,
    "rating": 4.8,
    "reviews": 52,
    "stock": 85,
    "reserved": 0,
    "sold": 220,
    "weight": "15 L",
    "status": "approved",
    "active": true,
    "tags": ["bestseller", "featured"],
    "description": "Pure refined sunflower cooking oil in a tamper-proof food-grade tin. Fortified with Vitamins A and D.",
    "specs": [{"label":"Volume","value":"15 Litres"},{"label":"Type","value":"Refined Sunflower"}],
    "created": "03 Oct 2026",
    "updated": "08 Oct 2026"
  }'::jsonb, now(), now()),

  ('P020', 'VENDOR-001', 'Oil', 'approved', true, '{
    "id": "P020",
    "name": "Sunflower Oil 1 Litre",
    "sku": "SBV-OI-1019",
    "brand": "Shami Select",
    "vendor": "Deccan Oil Company",
    "vendorId": "VENDOR-001",
    "category": "Oil",
    "subcategory": "Sunflower Oil",
    "image": "/products/oil.jpg",
    "mrp": 165,
    "price": 142,
    "gst": 5,
    "rating": 4.6,
    "reviews": 19,
    "stock": 300,
    "reserved": 0,
    "sold": 410,
    "weight": "1 L",
    "status": "approved",
    "active": true,
    "tags": ["recommended"],
    "description": "Refined sunflower oil in an easy-pour 1L pouch.",
    "specs": [{"label":"Volume","value":"1 Litre"},{"label":"Packaging","value":"Pouch"}],
    "created": "04 Oct 2026",
    "updated": "08 Oct 2026"
  }'::jsonb, now(), now()),

  ('P023', 'VENDOR-001', 'Oil', 'approved', true, '{
    "id": "P023",
    "name": "Groundnut Oil 5L Can",
    "sku": "SBV-OI-1022",
    "brand": "Shami Select",
    "vendor": "Deccan Oil Company",
    "vendorId": "VENDOR-001",
    "category": "Oil",
    "subcategory": "Groundnut Oil",
    "image": "/products/oil.jpg",
    "mrp": 1050,
    "price": 949,
    "gst": 5,
    "rating": 4.8,
    "reviews": 29,
    "stock": 70,
    "reserved": 0,
    "sold": 115,
    "weight": "5 L",
    "status": "approved",
    "active": true,
    "tags": ["offer"],
    "description": "Filtered groundnut oil cold-pressed for traditional flavor, aroma and deep frying.",
    "specs": [{"label":"Volume","value":"5 Litres"},{"label":"Type","value":"Filtered Groundnut"}],
    "created": "05 Oct 2026",
    "updated": "08 Oct 2026"
  }'::jsonb, now(), now())
ON CONFLICT (id) DO NOTHING;

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
