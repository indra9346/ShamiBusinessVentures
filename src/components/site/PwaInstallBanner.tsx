import { useEffect, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { X } from "lucide-react";
import { BrandLogo } from "@/components/brand/Logo";
import { INSTALL_DISMISSED_KEY, showsInstallOffer } from "@/lib/pwa";

type InstallPrompt = Event & { prompt: () => Promise<void> };

/**
 * Shown only when the phone's browser says the shop can be installed. It floats, so it never pushes the page about,
 * and sits above the cart bar. "Not now" is remembered on this device.
 */
export function PwaInstallBanner() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [offer, setOffer] = useState<InstallPrompt | null>(null);

  useEffect(() => {
    const onOffer = (event: Event) => {
      // Always stop the browser's own mini bar: the offer below is the one customers see, and only on browsing pages.
      event.preventDefault();
      try {
        if (window.localStorage.getItem(INSTALL_DISMISSED_KEY) === "1") return;
      } catch {
        /* storage blocked: still offer */
      }
      setOffer(event as InstallPrompt);
    };
    const onInstalled = () => setOffer(null);
    window.addEventListener("beforeinstallprompt", onOffer);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onOffer);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!offer || !showsInstallOffer(pathname)) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(INSTALL_DISMISSED_KEY, "1");
    } catch {
      /* storage blocked: it simply asks again on the next visit */
    }
    setOffer(null);
  };

  return (
    <div
      role="region"
      aria-label="Install Grain Bazar"
      className="fixed inset-x-3 bottom-20 z-40 flex items-center gap-3 rounded-xl border border-border bg-card p-3 shadow-card sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-96"
    >
      <BrandLogo shape="mark" className="h-10 w-10 shrink-0" sizes="40px" />
      <p className="min-w-0 flex-1 text-sm font-semibold text-navy">Install Grain Bazar on your phone for quicker shopping.</p>
      <button
        type="button"
        onClick={() => {
          const chosen = offer;
          setOffer(null);
          void chosen.prompt().catch(() => undefined);
        }}
        className="shrink-0 rounded-md bg-navy px-3 py-2 text-sm font-semibold text-white hover:bg-midnight"
      >
        Install
      </button>
      <button type="button" onClick={dismiss} aria-label="Not now" title="Not now" className="shrink-0 rounded p-1 text-slate hover:text-navy">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
