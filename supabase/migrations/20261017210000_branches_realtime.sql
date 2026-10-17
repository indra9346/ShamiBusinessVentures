-- Live updates for branch changes and per-branch stock (admin selector, storefront availability).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'branches') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.branches;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'branch_stock') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.branch_stock;
  END IF;
END $$;
