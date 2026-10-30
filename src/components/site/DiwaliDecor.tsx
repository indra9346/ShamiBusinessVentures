import { useEffect, useRef, useState, type CSSProperties } from "react";
import { cn } from "@/lib/utils";

/*
 * Deepavali decorations for the storefront (shown by useFestiveTheme, switched off in Admin > Ad Banners).
 * The pictures are photoreal renders (clay diyas, marigolds, mango leaves, powder rangoli) in
 * public/festive/diwali; flames and floating lights move with CSS transforms and opacity only (GPU), and
 * everything is an overlay with pointer-events off, so the page never moves and every tap still lands.
 * The .gb-festive class lets the <head> script hide them all before the first paint (see lib/festive.ts).
 */

const ART = "/festive/diwali";

/** Marigold-and-mango-leaf toran hanging along the top edge of the nearest positioned parent. */
export function DiwaliToran({ className }: { className?: string }) {
  return <div aria-hidden className={cn("gb-festive gb-toran pointer-events-none absolute inset-x-0 top-0 z-10", className)} />;
}

// [left %, size px, seconds to rise, start offset s, sideways drift px]
const LIGHTS: [number, number, number, number, number][] = [
  [4, 10, 11, 1, 18], [11, 7, 14, 6, -12], [19, 12, 12, 9, 10], [27, 6, 15, 3, -8], [35, 9, 13, 11, 14], [43, 7, 16, 5, -16],
  [51, 11, 12, 2, 12], [59, 6, 14, 8, -10], [66, 10, 13, 12, 16], [73, 7, 15, 4, -14], [80, 12, 11, 7, 8], [87, 6, 16, 10, -12],
  [93, 9, 12, 0, 10], [97, 7, 14, 13, -6],
];

/** Warm festive light behind the offers band: saffron-rose wash, faint rangoli pattern, rising lamp sparks. */
export function DiwaliBackdrop() {
  return (
    <div aria-hidden className="gb-festive pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-[#fff4e2] via-[#ffe8cf] to-[#fde6ea]" />
      <div className="gb-rangoli-pattern absolute inset-0 opacity-[0.07]" />
      <div className="absolute -left-40 -top-44 h-[28rem] w-[28rem] bg-[radial-gradient(closest-side,rgba(255,179,71,0.35),rgba(255,179,71,0))]" />
      <div className="absolute -bottom-44 -right-32 h-[28rem] w-[28rem] bg-[radial-gradient(closest-side,rgba(232,69,122,0.15),rgba(232,69,122,0))]" />
      <div className="absolute left-1/4 top-1/4 h-[24rem] w-[24rem] bg-[radial-gradient(closest-side,rgba(255,210,122,0.25),rgba(255,210,122,0))]" />
      {LIGHTS.map(([left, size, rise, offset, drift], i) => (
        <span
          key={i}
          className="gb-spark"
          style={{ left: `${left}%`, width: size, height: size, animationDuration: `${rise}s`, animationDelay: `-${offset}s`, "--drift": `${drift}px` } as CSSProperties}
        />
      ))}
    </div>
  );
}

/** One clay diya with a flickering flame and a breathing glow. `size` is the lamp's width in px; `flip` turns its spout to the left. */
export function Diya({ size = 46, delay = 0, flip = false, className }: { size?: number; delay?: number; flip?: boolean; className?: string }) {
  return (
    <span aria-hidden className={cn("gb-diya inline-block", flip && "-scale-x-100", className)} style={{ "--w": `${size}px`, "--d": `${delay}s` } as CSSProperties}>
      <span className="gb-diya-glow" />
      <img src={`${ART}/diya.webp`} alt="" width={240} height={104} loading="lazy" decoding="async" draggable={false} className="gb-diya-body" />
      <span className="gb-diya-flame" />
    </span>
  );
}

/**
 * A row of lit diyas with the Deepavali greeting in the middle, sitting on the line between two
 * sections (the parent must be `relative`). Half of it sits in each section's padding.
 */
export function DiyaLedge() {
  const lamps = (side: "l" | "r") => [0, 1, 2, 3].map((i) => (
    <Diya key={`${side}${i}`} size={i < 2 ? 34 : 46} flip={side === "r"} delay={(i * 0.37 + (side === "r" ? 0.2 : 0)) % 1.3} className={cn(i === 2 && "hidden sm:inline-block", i === 3 && "hidden lg:inline-block")} />
  ));
  return (
    <div className="gb-festive pointer-events-none absolute inset-x-0 top-0 z-10 -translate-y-1/2">
      <div className="mx-auto flex max-w-7xl items-end justify-between gap-2 px-4 sm:px-6">
        <div className="flex items-end gap-2 sm:gap-8">{lamps("l")}</div>
        <p className="gb-plaque">
          <img src={`${ART}/marigold.webp`} alt="" width={158} height={151} loading="lazy" decoding="async" className="hidden h-6 w-6 sm:block" />
          <span className="gb-plaque-title">Shubh Deepavali</span>
          <span lang="kn" className="hidden text-[13px] font-semibold text-[#7a2e12] md:inline">ದೀಪಾವಳಿಯ ಶುಭಾಶಯಗಳು</span>
          <img src={`${ART}/marigold.webp`} alt="" width={158} height={151} loading="lazy" decoding="async" className="hidden h-6 w-6 sm:block" />
        </p>
        <div className="flex flex-row-reverse items-end gap-2 sm:gap-8">{lamps("r")}</div>
      </div>
    </div>
  );
}

/** Soft powder-rangoli watermarks in a section's corners (the section needs `relative isolate`). */
export function RangoliCorners() {
  return (
    <div aria-hidden className="gb-festive pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <img src={`${ART}/rangoli.webp`} alt="" width={320} height={320} loading="lazy" decoding="async" className="absolute -bottom-20 -left-20 w-56 opacity-[0.18] sm:w-72" />
      <img src={`${ART}/rangoli.webp`} alt="" width={320} height={320} loading="lazy" decoding="async" className="absolute -right-16 top-16 hidden w-56 opacity-[0.14] md:block" />
    </div>
  );
}

/**
 * Two marigold garlands hanging from the ends of the toran down the sides of the offers banner, each
 * ending in a brass-bell tassel, swinging gently from the top. The parent must be `relative`.
 */
export function SideGarlands() {
  return (
    <>
      <span aria-hidden className="gb-festive gb-garland gb-garland-l" />
      <span aria-hidden className="gb-festive gb-garland gb-garland-r" />
    </>
  );
}

/**
 * Crackers over Karnataka's lit heritage (Mysuru Palace, Hampi gopurams, the temple) behind the header:
 * a short looping video already painted on the header's green, so the browser only plays it (no live
 * blending). It starts after the page is idle (the first paint never waits for it), pauses in
 * background tabs, and stays a still picture for reduced motion or data saver.
 */
export function HeaderCrackers() {
  const [src, setSrc] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return;
    const start = () => setSrc(`${ART}/header-crackers.mp4`);
    const idle = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    if (idle.requestIdleCallback) {
      const id = idle.requestIdleCallback(start, { timeout: 2500 });
      return () => idle.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(start, 1200);
    return () => window.clearTimeout(id);
  }, []);
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const onVisibility = () => { if (document.hidden) v.pause(); else void v.play().catch(() => undefined); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [src]);
  return (
    <div aria-hidden className="gb-festive pointer-events-none absolute inset-0 -z-10 overflow-hidden bg-navy">
      <img src={`${ART}/header-crackers.webp`} alt="" decoding="async" draggable={false} className={cn("gb-crackers", playing && "opacity-0")} />
      {src && <video ref={video} src={src} autoPlay muted loop playsInline preload="auto" onPlaying={() => setPlaying(true)} className="gb-crackers" />}
    </div>
  );
}

/** A thin glowing gold "zari" line along the bottom of the header. */
export function HeaderZari() {
  return <span aria-hidden className="gb-festive gb-zari pointer-events-none absolute inset-x-0 bottom-0 h-[2px]" />;
}
