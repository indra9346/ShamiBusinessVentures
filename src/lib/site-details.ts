import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { afterPageLoad, snapshotIsFresh, useStorefrontSnapshot } from "@/lib/storefront-snapshot";
import {
  DEFAULT_SITE_DETAILS,
  SITE_DETAILS_KEY,
  parseSiteDetails,
  visibleSiteDetails,
  type SiteDetails,
  type VisibleSiteDetails,
} from "@/lib/site-details-rules";

let cached: SiteDetails = DEFAULT_SITE_DETAILS;
let request: Promise<SiteDetails> | null = null;
const listeners = new Set<(value: SiteDetails) => void>();

function load() {
  request ??= Promise.resolve(
    supabase.from("settings").select("value").eq("key", SITE_DETAILS_KEY).eq("is_public", true).maybeSingle(),
  )
    .then(({ data, error }) => (error ? DEFAULT_SITE_DETAILS : parseSiteDetails(data?.value)))
    .catch(() => DEFAULT_SITE_DETAILS)
    .then((value) => {
      setSiteDetails(value);
      return value;
    });
  return request;
}

/** Applies a new value everywhere at once (used after the admin saves the panel). */
export function setSiteDetails(value: SiteDetails) {
  cached = value;
  for (const listener of listeners) listener(value);
}

/** The company details to show customers; one shared fetch per page load (none when the page brought them). */
export function useSiteDetails(): VisibleSiteDetails {
  const snapshot = useStorefrontSnapshot();
  const [value, setValue] = useState(() =>
    !request && snapshot ? parseSiteDetails(snapshot.settings[SITE_DETAILS_KEY]) : cached);
  useEffect(() => {
    listeners.add(setValue);
    if (!request && snapshot) {
      setSiteDetails(parseSiteDetails(snapshot.settings[SITE_DETAILS_KEY]));
      request = Promise.resolve(cached);
      if (!snapshotIsFresh(snapshot)) afterPageLoad(() => { request = null; void load(); });
    }
    setValue(cached);
    void load();
    return () => {
      listeners.delete(setValue);
    };
  }, []);
  return visibleSiteDetails(value);
}
