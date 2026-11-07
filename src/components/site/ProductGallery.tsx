import { useEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { resizedImage, responsiveImage } from "@/lib/image-url";
import { imageAtScroll, stepImage } from "@/lib/product-images";
import { cn } from "@/lib/utils";

const MAIN_WIDTHS = [480, 720, 1080];
// One picture: as the page always showed it (full column width).
const SINGLE_SIZES = "(min-width: 1280px) 600px, (min-width: 1024px) 50vw, 100vw";
// With the thumbnail strip beside it from 640 px; full width below.
const GALLERY_SIZES =
  "(min-width: 1280px) 510px, (min-width: 1024px) calc(50vw - 136px), (min-width: 640px) calc(100vw - 128px), calc(100vw - 32px)";

const smooth = (): ScrollBehavior =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";

/** Scrolls a thumbnail strip (never the page) just enough to show its `index`th thumbnail. */
function reveal(strip: HTMLElement | null, index: number, vertical: boolean) {
  const thumb = strip?.children[index] as HTMLElement | undefined;
  if (!strip || !thumb) return;
  const start = vertical ? thumb.offsetTop : thumb.offsetLeft;
  const end = start + (vertical ? thumb.offsetHeight : thumb.offsetWidth);
  const shown = vertical ? strip.scrollTop : strip.scrollLeft;
  const size = vertical ? strip.clientHeight : strip.clientWidth;
  const to = start < shown ? start : end > shown + size ? end - size : null;
  if (to !== null) strip.scrollTo({ [vertical ? "top" : "left"]: to, behavior: smooth() });
}

/**
 * The product page's pictures, like a quick-commerce product page: a large picture, thumbnails on
 * the left (under it on phones), arrows, and swiping on phones. One picture shows on its own, as
 * before. Pictures load at the size they are shown; ones further than the next are fetched when near.
 */
export function ProductGallery({
  images,
  alt,
  onImageError,
}: {
  /** All pictures, the main one first (at least one). */
  images: string[];
  alt: string;
  /** For a picture that fails to load (puts a fallback in its place). */
  onImageError: (event: SyntheticEvent<HTMLImageElement>) => void;
}) {
  const count = images.length;
  const [active, setActive] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const sideStrip = useRef<HTMLDivElement>(null);
  const underStrip = useRef<HTMLDivElement>(null);
  // While an arrow or thumbnail scrolls the pictures, the scroll passes the pictures in between:
  // keep the chosen one highlighted until the scroll arrives (or stops).
  const target = useRef<number | null>(null);
  const targetTimer = useRef<number | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      window.clearTimeout(targetTimer.current);
      if (frame.current !== undefined) window.cancelAnimationFrame(frame.current);
    },
    [],
  );

  useEffect(() => {
    reveal(sideStrip.current, active, true);
    reveal(underStrip.current, active, false);
  }, [active]);

  if (count <= 1) {
    return (
      <div className="overflow-hidden rounded-xl border border-border bg-ivory">
        <img
          {...responsiveImage(images[0] ?? "", MAIN_WIDTHS, SINGLE_SIZES, 80)}
          alt={alt}
          width={800}
          height={800}
          onError={onImageError}
          className="aspect-square w-full object-cover"
        />
      </div>
    );
  }

  // The list can shrink while the page is open (an admin edit): never point past its end.
  const current = stepImage(active, 0, count);

  const goTo = (index: number) => {
    const el = scroller.current;
    const next = stepImage(index, 0, count);
    setActive(next);
    if (!el) return;
    target.current = next;
    window.clearTimeout(targetTimer.current);
    // A swipe can cut the scroll short: after a moment, go by where the pictures really stopped.
    targetTimer.current = window.setTimeout(() => {
      target.current = null;
      setActive(imageAtScroll(el.scrollLeft, el.clientWidth, count));
    }, 900);
    el.scrollTo({ left: next * el.clientWidth, behavior: smooth() });
  };

  const onScroll = () => {
    if (frame.current !== undefined) return;
    frame.current = window.requestAnimationFrame(() => {
      frame.current = undefined;
      const el = scroller.current;
      if (!el) return;
      const shown = imageAtScroll(el.scrollLeft, el.clientWidth, count);
      if (target.current !== null) {
        if (shown !== target.current) return;
        target.current = null;
      }
      setActive(shown);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    goTo(stepImage(current, event.key === "ArrowLeft" ? -1 : 1, count));
  };

  const thumbs = (vertical: boolean) =>
    images.map((src, index) => (
      <button
        key={src}
        type="button"
        onClick={() => goTo(index)}
        aria-label={`Show picture ${index + 1} of ${count}`}
        aria-current={index === current ? "true" : undefined}
        className={cn(
          "shrink-0 overflow-hidden rounded-lg border-2 bg-ivory transition-[border-color,opacity]",
          vertical ? "h-16 w-16 lg:h-20 lg:w-20" : "h-14 w-14",
          index === current
            ? "border-gold"
            : "border-border opacity-70 hover:border-gold/60 hover:opacity-100",
        )}
      >
        <img
          src={resizedImage(src, 160)}
          alt=""
          loading="lazy"
          width={160}
          height={160}
          className="h-full w-full object-cover"
          draggable={false}
        />
      </button>
    ));

  const arrow = (direction: -1 | 1) => {
    const hidden = direction < 0 ? current === 0 : current === count - 1;
    const Icon = direction < 0 ? ChevronLeft : ChevronRight;
    return (
      <button
        type="button"
        onClick={() => goTo(stepImage(current, direction, count))}
        disabled={hidden}
        aria-label={direction < 0 ? "Previous picture" : "Next picture"}
        className={cn(
          "absolute top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/95 text-navy shadow-md ring-1 ring-black/5 transition-opacity hover:text-gold sm:h-10 sm:w-10",
          direction < 0 ? "left-2 sm:left-3" : "right-2 sm:right-3",
          hidden && "pointer-events-none opacity-0",
        )}
      >
        <Icon className="h-5 w-5" aria-hidden="true" />
      </button>
    );
  };

  return (
    <div className="min-w-0">
      <div className="flex gap-3">
        {/* Thumbnails on the left from 640 px: as tall as the big picture, scrolling if there are more. */}
        <div className="relative hidden w-16 shrink-0 sm:block lg:w-20">
          <div
            ref={sideStrip}
            className="scrollbar-none absolute inset-0 flex flex-col gap-2 overflow-y-auto"
          >
            {thumbs(true)}
          </div>
        </div>
        <div className="relative min-w-0 flex-1">
          <div
            ref={scroller}
            onScroll={onScroll}
            onKeyDown={onKeyDown}
            tabIndex={0}
            role="region"
            aria-roledescription="carousel"
            aria-label={`${alt}: pictures`}
            className="scrollbar-none flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain rounded-xl border border-border bg-ivory outline-none focus-visible:ring-2 focus-visible:ring-gold"
          >
            {images.map((src, index) => (
              <div
                key={src}
                role="group"
                aria-roledescription="slide"
                aria-label={`${index + 1} of ${count}`}
                aria-hidden={index !== current}
                className="w-full shrink-0 snap-center snap-always"
              >
                <img
                  {...responsiveImage(src, MAIN_WIDTHS, GALLERY_SIZES, 80)}
                  alt={index === 0 ? alt : `${alt}, picture ${index + 1}`}
                  width={800}
                  height={800}
                  loading={Math.abs(index - current) <= 1 ? "eager" : "lazy"}
                  draggable={false}
                  onError={onImageError}
                  className="aspect-square w-full object-cover"
                />
              </div>
            ))}
          </div>
          {arrow(-1)}
          {arrow(1)}
          <span
            className="pointer-events-none absolute right-2 bottom-2 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-semibold text-white tabular-nums sm:hidden"
            aria-hidden="true"
          >
            {current + 1} / {count}
          </span>
        </div>
      </div>
      {/* Phones: thumbnails under the picture. */}
      <div
        ref={underStrip}
        className="scrollbar-none relative mt-3 flex gap-2 overflow-x-auto sm:hidden"
      >
        {thumbs(false)}
      </div>
    </div>
  );
}
