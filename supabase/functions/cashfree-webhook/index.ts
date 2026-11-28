// Cashfree's payment webhooks arrive here, on Supabase, so they never depend on grainbazar.com accepting a call from a
// server (Hostinger shows servers its "Bot Verification" page). See handler.ts.
//
// Deploy with --no-verify-jwt: Cashfree signs the call; there is no user token. No secrets to add: Supabase provides
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY by itself. The Cashfree secret key stays on the website.

declare const Deno: {
  env: { get(key: string): string | undefined };
  serve(handler: (request: Request) => Response | Promise<Response>): void;
};

import { handleInboxRequest } from "./handler.ts";

Deno.serve((request) =>
  handleInboxRequest(request, {
    url: Deno.env.get("SUPABASE_URL"),
    serviceKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    fetch,
  }));
