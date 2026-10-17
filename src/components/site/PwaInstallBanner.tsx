import { useEffect, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { isStorefrontPath } from "@/lib/pwa";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const DISMISS_KEY = "shami-pwa-install-dismissed";

export function PwaInstallBanner() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    setDismissed(window.localStorage.getItem(DISMISS_KEY) === "1");
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  if (!isStorefrontPath(pathname) || dismissed || !installEvent) return null;

  return (
    <div className="border-b border-gold/40 bg-navy px-4 py-2 text-center text-xs text-white sm:text-sm">
      <span className="mr-3">Install Shami on your phone for faster shopping.</span>
      <button
        type="button"
        className="mr-2 rounded bg-gold px-3 py-1 font-semibold text-navy"
        onClick={() => {
          void installEvent.prompt().finally(() => setInstallEvent(null));
        }}
      >
        Install
      </button>
      <button
        type="button"
        className="font-semibold text-gold underline"
        onClick={() => {
          window.localStorage.setItem(DISMISS_KEY, "1");
          setDismissed(true);
        }}
      >
        Not now
      </button>
    </div>
  );
}
