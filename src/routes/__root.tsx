import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { AppProvider } from "@/lib/store";
import { absoluteUrl, DEFAULT_DESCRIPTION, DEFAULT_IMAGE, LEGAL_NAME, SITE_NAME } from "@/lib/seo";
import { LanguageProvider } from "@/lib/i18n";
import { Toaster } from "@/components/ui/sonner";
import { CartFloatingNotifier } from "@/components/site/CartFloatingNotification";
import { AuthNoticeHost } from "@/components/site/AuthNotice";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { FESTIVE_HEAD_SCRIPT } from "@/lib/festive";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: unknown; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: `${SITE_NAME} | Rice, Sugar & Cooking Oil from Shami Business Ventures` },
      { name: "description", content: DEFAULT_DESCRIPTION },
      { name: "author", content: LEGAL_NAME },
      { name: "theme-color", content: "#2f5d46" },
      { property: "og:site_name", content: SITE_NAME },
      { property: "og:locale", content: "en_IN" },
      { property: "og:type", content: "website" },
      { property: "og:image", content: absoluteUrl(DEFAULT_IMAGE) },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      // Grain Bazar GB mark. Google shows a square icon in multiples of 48 px next to results.
      { rel: "icon", href: "/favicon.ico", sizes: "48x48" },
      { rel: "icon", href: "/favicon-96x96.png", type: "image/png", sizes: "96x96" },
      { rel: "icon", href: "/icon-192x192.png", type: "image/png", sizes: "192x192" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png", sizes: "180x180" },
      { rel: "manifest", href: "/site.webmanifest" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Manrope:wght@500;600;700;800&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap",
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    // data-festive is set by the script below before the first paint (admin switch for the festival theme)
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: FESTIVE_HEAD_SCRIPT }} />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  // After a new deployment, an open tab may ask for page files that no longer exist; reload
  // once to pick up the new version instead of showing an error.
  useEffect(() => {
    const onPreloadError = (event: Event) => {
      event.preventDefault();
      try {
        if (sessionStorage.getItem("gb-reloaded-for-update") === "1") return;
        sessionStorage.setItem("gb-reloaded-for-update", "1");
      } catch { /* storage blocked */ }
      window.location.reload();
    };
    window.addEventListener("vite:preloadError", onPreloadError);
    try { window.setTimeout(() => sessionStorage.removeItem("gb-reloaded-for-update"), 10000); } catch { /* storage blocked */ }
    return () => window.removeEventListener("vite:preloadError", onPreloadError);
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
      <LanguageProvider>
        <AppProvider>
          {STATIC_DATA_MODE && <div role="status" className="bg-amber-100 px-4 py-2 text-center text-xs font-semibold text-amber-950">Static preview mode: demo data only; no database, email, or payment is used. Customer demo OTPs: email 12345678, phone 123456. Admin/vendor sign-in is simulated in this preview only.</div>}
          <Outlet />
          <CartFloatingNotifier />
          <Toaster position="top-right" richColors />
          <AuthNoticeHost />
        </AppProvider>
      </LanguageProvider>
    </QueryClientProvider>
  );
}
