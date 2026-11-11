import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { NO_CONTACT_NUMBERS, contactNumbersFrom, type ContactNumbers } from "@/lib/zoho-contact-numbers";

/*
 * Zoho's customer and vendor numbers the signed-in account may see (public.zoho_contact_numbers: an admin everyone's,
 * anyone else only their own). Read at most once a minute per account and shared by every page that shows them. Before
 * the 12 Nov 2026 database update the function is not there: the pages then show no numbers and work as before.
 */
const KEEP_MS = 60_000;
let kept: { account: string; at: number; read: Promise<ContactNumbers> } | null = null;

function readNumbers(account: string): Promise<ContactNumbers> {
  if (kept && kept.account === account && Date.now() - kept.at < KEEP_MS) return kept.read;
  const read = (async () => {
    try {
      const { data, error } = await supabase.rpc("zoho_contact_numbers");
      return error ? NO_CONTACT_NUMBERS : contactNumbersFrom(data);
    } catch {
      return NO_CONTACT_NUMBERS;
    }
  })();
  kept = { account, at: Date.now(), read };
  return read;
}

/** Forgets the kept numbers, so the next page reads them again (after the admin fetched new ones from Zoho). */
export function forgetZohoContactNumbers() {
  kept = null;
}

/** `account`: the signed-in account's id (useApp().user?.id). No account, no numbers. */
export function useZohoContactNumbers(account: string | null | undefined): ContactNumbers {
  const [numbers, setNumbers] = useState<ContactNumbers>(NO_CONTACT_NUMBERS);
  useEffect(() => {
    if (STATIC_DATA_MODE || !account) {
      setNumbers(NO_CONTACT_NUMBERS);
      return undefined;
    }
    let live = true;
    void readNumbers(account).then((next) => { if (live) setNumbers(next); });
    return () => { live = false; };
  }, [account]);
  return numbers;
}
