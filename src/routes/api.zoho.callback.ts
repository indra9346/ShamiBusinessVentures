import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/zoho/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const error = url.searchParams.get("error");
        if (error)
          return Response.redirect(
            new URL(`/admin/zoho?error=${encodeURIComponent(error)}`, url.origin),
            303,
          );
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state)
          return Response.redirect(
            new URL("/admin/zoho?error=missing_callback_parameters", url.origin),
            303,
          );
        try {
          const { completeZohoAuthorization } = await import("@/lib/zoho-commerce.functions");
          await completeZohoAuthorization(code, state);
          return Response.redirect(new URL("/admin/zoho?connected=1", url.origin), 303);
        } catch (cause) {
          console.error("Zoho Commerce authorization failed", cause);
          return Response.redirect(
            new URL("/admin/zoho?error=authorization_failed", url.origin),
            303,
          );
        }
      },
    },
  },
});
