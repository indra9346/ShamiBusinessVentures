import { useEffect, useRef, useState } from "react";
import { AlertCircle, AlertTriangle, Info, X } from "lucide-react";

/**
 * Sign-in messages (wrong password, wrong code, account not allowed, ...) for every role.
 * Shown as a calm card fixed to the top-right corner: it fades in, stays readable for a few
 * seconds (longer while hovered), then fades out slowly. No sliding.
 */
export type NoticeTone = "error" | "warning" | "info";
type Notice = { id: number; title: string; description?: string | undefined; tone: NoticeTone };

let nextId = 1;
const listeners = new Set<(notice: Notice) => void>();

export function showAuthNotice(title: string, description?: string, tone: NoticeTone = "error") {
  const notice: Notice = { id: nextId++, title, description, tone };
  for (const listener of listeners) listener(notice);
}

const VISIBLE_MS = 6000;
const TONES = {
  error: { frame: "border-red-200 border-l-red-600", icon: AlertCircle, iconColor: "text-red-600" },
  warning: { frame: "border-amber-200 border-l-amber-500", icon: AlertTriangle, iconColor: "text-amber-600" },
  info: { frame: "border-sky-200 border-l-sky-600", icon: Info, iconColor: "text-sky-600" },
} as const;
const FADE_MS = 900;

export function AuthNoticeHost() {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [visible, setVisible] = useState(false);
  const [hovered, setHovered] = useState(false);
  const timers = useRef<number[]>([]);

  const clearTimers = () => {
    for (const timer of timers.current) window.clearTimeout(timer);
    timers.current = [];
  };

  const dismiss = () => {
    clearTimers();
    setVisible(false);
    timers.current.push(window.setTimeout(() => setNotice(null), FADE_MS));
  };

  useEffect(() => {
    const listener = (next: Notice) => {
      clearTimers();
      setNotice(next);
      // Next frame, so the fade-in transition runs.
      timers.current.push(window.setTimeout(() => setVisible(true), 20));
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      clearTimers();
    };
  }, []);

  useEffect(() => {
    if (!notice || !visible || hovered) return;
    const timer = window.setTimeout(dismiss, VISIBLE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notice, visible, hovered]);

  if (!notice) return null;
  return (
    <div className="pointer-events-none fixed inset-x-4 top-4 z-[100] flex justify-end sm:inset-x-auto sm:right-4">
      <div
        role="alert"
        aria-live="assertive"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{ transitionDuration: `${visible ? 300 : FADE_MS}ms` }}
        className={`pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border border-l-4 bg-white p-4 shadow-lg transition-opacity ease-out ${TONES[notice.tone].frame} ${visible ? "opacity-100" : "opacity-0"}`}
      >
        {(() => { const Icon = TONES[notice.tone].icon; return <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${TONES[notice.tone].iconColor}`} aria-hidden="true" />; })()}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-stone-900">{notice.title}</p>
          {notice.description && <p className="mt-0.5 text-sm text-stone-600">{notice.description}</p>}
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="-m-1 rounded p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-700"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
