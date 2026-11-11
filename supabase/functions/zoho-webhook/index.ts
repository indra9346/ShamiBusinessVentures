// Zoho Books webhooks arrive here, on Supabase, so they never depend on grainbazar.com accepting a call from a server.
// Since 10 Nov 2026 Hostinger shows every server its "Bot Verification" page, which Zoho cannot pass. See handler.ts.
//
// Deploy with --no-verify-jwt: Zoho signs the call; there is no user token. No secrets to add: Supabase provides
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY by itself.

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
