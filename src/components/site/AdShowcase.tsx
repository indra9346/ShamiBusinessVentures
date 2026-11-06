import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useLiveAdBanners, type AdBanner } from "@/lib/ad-banners";
import { flickStep, stripCopies, wrapStrip } from "@/lib/ad-banner-rules";
import { useFestiveTheme } from "@/lib/festive";
import { DiwaliBackdrop, DiwaliLanterns, DiwaliToran, SideGarlands } from "@/components/site/DiwaliDecor";
import { cn } from "@/lib/utils";
import { responsiveImage, showOriginalImage } from "@/lib/image-url";
import { afterPageLoad } from "@/lib/storefront-snapshot";

/*
 * The home page's advertising band (offers, hot deals, new products, festival banners, promo
 * videos), managed in Admin > Ad Banners. A large sliding banner with swipe and auto-play, smaller
 * tiles beside it (a looping strip you can swipe on phones), and the category strip on a frosted
 * card in front of the band. With no live banners only the category strip shows, as before.
 */

const SLIDE_MS = 3500;
const VIDEO_MAX_MS = 12000;

/** How fast the phone strip moves on its own, in pixels per second. */
const STRIP_PX_PER_SECOND = 85;
/** How long the strip rests after a finger lifts before it moves on its own again. */
const STRIP_REST_MS = 1500;
/** A finger that moves less than this is a tap, not a swipe. */
const STRIP_TAP_PX = 8;
/** A flick loses about two thirds of its speed in this time. */
const STRIP_FLICK_DECAY_MS = 325;
/** Flick speeds, in pixels per millisecond: the fastest allowed, and the slowest worth moving for. */
const STRIP_FLICK_MAX = 4;
const STRIP_FLICK_MIN = 0.02;

/** Whether a media query matches; `initial` is what the server and the browser's first render assume. */
function useMediaQuery(media: string, initial = false) {
  const [matches, setMatches] = useState(initial);
  useEffect(() => {
    const query = window.matchMedia?.(media);
    if (!query) return;
    setMatches(query.matches);
    const onChange = () => setMatches(query.matches);
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, [media]);
  return matches;
}

function usePrefersReducedMotion() {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}

/** Opens a banner's link: pages on this site without a reload, other sites in a new tab. */
function BannerLink({ banner, className, children, tabIndex }: { banner: AdBanner; className?: string; children: ReactNode; tabIndex?: number | undefined }) {
  const navigate = useNavigate();
  const link = banner.linkUrl;
  if (!link) return <div className={className}>{children}</div>;
  const internal = link.startsWith("/");
  return (
    <a
      href={link}
      tabIndex={tabIndex}
      target={internal ? undefined : "_blank"}
      rel={internal ? undefined : "noopener noreferrer"}
      aria-label={banner.title || banner.ctaLabel || "Offer"}
      onClick={(event) => {
        if (!internal || event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        void navigate({ href: link });
      }}
      className={className}
    >
      {children}
    </a>
  );
}

/** A phone version of a video banner, when the admin uploaded one (a video, not a picture). */
function phoneVideoOf(banner: AdBanner) {
  const url = banner.mobileMediaUrl;
  if (banner.mediaKind !== "video" || !url) return null;
  return /^data:image\//.test(url) || /\.(jpe?g|png|webp|gif|avif)([?#]|$)/i.test(url) ? null : url;
}

/** How wide a banner shows: the big slide, or a tile beside it (desktop) / in the strip (phones). */
const MAIN_SIZES = "(min-width: 1280px) 840px, (min-width: 1024px) 66vw, 100vw";
const TILE_SIZES = "(min-width: 1280px) 420px, (min-width: 1024px) 33vw, (min-width: 640px) 32vw, 46vw";
const BANNER_WIDTHS = [480, 800, 1200, 1600];

/** False until the page has loaded (its first pictures included), or at most 2.5 s, then true. */
function usePageLoaded() {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const done = () => setLoaded(true);
    const cancel = afterPageLoad(done);
    // On a slow connection the page's "load" can take long; the banners should not wait for all of it.
    const timer = window.setTimeout(done, 2500);
    return () => { cancel(); window.clearTimeout(timer); };
  }, []);
  return loaded;
}

/**
 * `later`: a slide not on screen yet, whose picture can wait until the page has loaded, so the
 * first slide and the product pictures get the connection first. Videos always wait for that too
 * (except a video first slide).
 */
function BannerMedia({ banner, active, eager, later = false, onVideoEnd, kenBurns, sizes }: {
  banner: AdBanner; active: boolean; eager: boolean; later?: boolean; onVideoEnd?: (() => void) | undefined; kenBurns: boolean; sizes: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const pageLoaded = usePageLoaded();
  // The screen size is known in the browser only: a video gets its file once the page is running (the
  // server-rendered page has none), so a phone never starts downloading the large desktop video.
  const [phone, setPhone] = useState<boolean | null>(null);
  useEffect(() => setPhone(!!window.matchMedia?.("(max-width: 639px)").matches), []);
  const videoSrc = banner.mediaKind !== "video" || phone === null || !(eager || pageLoaded)
    ? undefined
    : (phone && phoneVideoOf(banner)) || banner.mediaUrl;
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoSrc) return;
    if (active) {
      video.currentTime = 0;
      void video.play().catch(() => undefined);
    } else {
      video.pause();
    }
  }, [active, videoSrc]);
  const fitClass = banner.fit === "contain" ? "object-contain" : "object-cover";
  if (banner.mediaKind === "video") {
    return (
      <video
        ref={videoRef}
        src={videoSrc}
        muted
        playsInline
        loop={!onVideoEnd}
        preload={eager ? "auto" : "metadata"}
        onEnded={onVideoEnd}
        className={cn("h-full w-full", fitClass)}
      />
    );
  }
  const waiting = later && !pageLoaded;
  const image = (
    <img
      {...(waiting ? {} : responsiveImage(banner.mediaUrl, BANNER_WIDTHS, sizes, 80))}
      alt={banner.title || "Offer"}
      // Slides and tiles sit off-screen sideways, where lazy loading never starts; the first
      // slide comes first, the rest once the page has loaded, well before they move in.
      loading="eager"
      fetchPriority={eager ? "high" : "low"}
      decoding="async"
      draggable={false}
      onError={showOriginalImage}
      className={cn("h-full w-full select-none", fitClass, kenBurns && active && banner.fit === "cover" && "animate-ad-kenburns")}
    />
  );
  if (!banner.mobileMediaUrl || waiting) return image;
  const phoneImage = responsiveImage(banner.mobileMediaUrl, BANNER_WIDTHS, sizes, 80);
  return (
    <picture className="block h-full w-full">
      <source media="(max-width: 639px)" srcSet={phoneImage.srcSet ?? phoneImage.src} sizes={phoneImage.sizes} />
      {image}
    </picture>
  );
}

function BannerCaption({ banner, large }: { banner: AdBanner; large?: boolean }) {
  if (!banner.title && !banner.subtitle && !banner.ctaLabel) return null;
  return (
    <div className="pointer-events-none absolute inset-0 flex items-end bg-gradient-to-t from-black/55 via-black/10 to-transparent">
      <div className={cn("max-w-[85%] text-white", large ? "p-4 sm:p-7" : "p-3")}>
        {banner.title && (
          <p className={cn("font-bold leading-tight drop-shadow", large ? "text-lg sm:text-3xl" : "text-sm sm:text-base")}>{banner.title}</p>
        )}
        {banner.subtitle && (
          <p className={cn("mt-1 line-clamp-2 text-white/90 drop-shadow", large ? "text-xs sm:text-base" : "text-[11px] sm:text-xs")}>{banner.subtitle}</p>
        )}
        {banner.ctaLabel && banner.linkUrl && (
          <span className={cn("mt-2 inline-flex items-center rounded-full bg-gold font-bold text-midnight shadow", large ? "px-4 py-1.5 text-xs sm:text-sm" : "px-3 py-1 text-[11px]")}>
            {banner.ctaLabel}
          </span>
        )}
      </div>
    </div>
  );
}

function MainCarousel({ banners }: { banners: AdBanner[] }) {
  const reducedMotion = usePrefersReducedMotion();
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const count = banners.length;
  const current = banners[index % count];
  const go = useCallback((next: number) => setIndex(((next % count) + count) % count), [count]);

  // Auto-advance: pictures after a few seconds, videos when they end (or at most 20 s).
  useEffect(() => {
    if (count < 2 || paused || reducedMotion) return;
    const wait = current?.mediaKind === "video" ? VIDEO_MAX_MS : SLIDE_MS;
    const timer = window.setTimeout(() => go(index + 1), wait);
    return () => window.clearTimeout(timer);
  }, [index, count, paused, reducedMotion, current?.mediaKind, go]);

  useEffect(() => { if (index >= count) setIndex(0); }, [count, index]);

  // Swipe on touch screens.
  const start = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (event: React.PointerEvent) => { start.current = { x: event.clientX, y: event.clientY }; };
  const onPointerUp = (event: React.PointerEvent) => {
    const from = start.current;
    start.current = null;
    if (!from) return;
    const dx = event.clientX - from.x;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(event.clientY - from.y)) go(index + (dx < 0 ? 1 : -1));
  };

  return (
    <div
      // touch-pan-y: without it the browser claims every finger for scrolling and the swipe never arrives.
      className="group/ad relative h-full touch-pan-y touch-pinch-zoom overflow-hidden rounded-2xl shadow-elevated ring-1 ring-black/5"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { start.current = null; }}
      aria-roledescription="carousel"
      aria-label="Offers"
    >
      <div
        className="flex h-full w-full transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
        style={{ transform: `translateX(-${(index % count) * 100}%)` }}
      >
        {banners.map((banner, i) => (
          <div
            key={banner.id}
            className="relative h-full w-full shrink-0 overflow-hidden"
            style={{ backgroundColor: banner.background }}
            aria-hidden={i !== index}
            aria-roledescription="slide"
            aria-label={`${i + 1} of ${count}`}
          >
            <BannerLink banner={banner} className="block h-full w-full" tabIndex={i === index ? 0 : -1}>
              <BannerMedia
                banner={banner}
                active={i === index}
                eager={i === 0}
                later={i !== 0 && i !== index}
                kenBurns={!reducedMotion}
                sizes={MAIN_SIZES}
                onVideoEnd={count > 1 ? () => go(i + 1) : undefined}
              />
              <BannerCaption banner={banner} large />
            </BannerLink>
          </div>
        ))}
      </div>

      {count > 1 && (
        <>
          <button
            type="button"
            onClick={() => go(index - 1)}
            aria-label="Previous offer"
            className="absolute left-2 top-1/2 hidden h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-white/85 text-navy shadow-md opacity-0 transition-opacity hover:bg-white group-hover/ad:opacity-100 sm:grid"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={() => go(index + 1)}
            aria-label="Next offer"
            className="absolute right-2 top-1/2 hidden h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-white/85 text-navy shadow-md opacity-0 transition-opacity hover:bg-white group-hover/ad:opacity-100 sm:grid"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
          {/* Story-style progress: the current bar fills while its slide shows. */}
          <div className="absolute inset-x-0 top-0 flex gap-1 p-2 sm:p-3">
            {banners.map((banner, i) => (
              <button
                key={banner.id}
                type="button"
                onClick={() => go(i)}
                aria-label={`Show offer ${i + 1}`}
                aria-current={i === index}
                className="h-1 flex-1 overflow-hidden rounded-full bg-white/40"
              >
                <span
                  key={i === index ? `on-${index}-${paused}` : "off"}
                  className={cn(
                    "block h-full rounded-full bg-white",
                    i < index ? "w-full" : i === index && !paused && !reducedMotion ? "animate-ad-progress" : i === index ? "w-full" : "w-0",
                  )}
                  style={i === index && !paused && !reducedMotion
                    ? { animationDuration: `${banner.mediaKind === "video" ? VIDEO_MAX_MS : SLIDE_MS}ms` }
                    : undefined}
                />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** `copy`: a repeat of a tile in the looping strip, skipped by the keyboard and screen readers. */
function SideTile({ banner, className, copy }: { banner: AdBanner; className?: string; copy?: boolean }) {
  return (
    <div
      className={cn("relative overflow-hidden rounded-xl shadow-card ring-1 ring-black/5", className)}
      style={{ backgroundColor: banner.background }}
      aria-hidden={copy || undefined}
      // A tap still opens a copy's link, but focus must not land inside something hidden from screen readers.
      onMouseDown={copy ? (event) => event.preventDefault() : undefined}
    >
      <BannerLink banner={banner} className="block h-full w-full" tabIndex={copy ? -1 : undefined}>
        <BannerMedia banner={banner} active eager={false} kenBurns={false} sizes={TILE_SIZES} />
        <BannerCaption banner={banner} />
      </BannerLink>
    </div>
  );
}

/** Desktop: up to two tiles stacked beside the big banner, taking turns when there are more. */
function SideColumn({ banners }: { banners: AdBanner[] }) {
  const reducedMotion = usePrefersReducedMotion();
  // Below desktop width the column is hidden: it would keep rebuilding its tiles and playing their videos unseen.
  const shows = useMediaQuery("(min-width: 1024px)", true);
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    if (!shows || banners.length <= 2 || reducedMotion) return;
    const timer = window.setInterval(() => setOffset((o) => (o + 1) % banners.length), SLIDE_MS + 1000);
    return () => window.clearInterval(timer);
  }, [shows, banners.length, reducedMotion]);
  if (!shows) return null;
  const shown = banners.length <= 2 ? banners : [banners[offset % banners.length]!, banners[(offset + 1) % banners.length]!];
  return (
    <div className="hidden h-full min-h-0 flex-col gap-3 lg:flex">
      {shown.map((banner) => (
        <SideTile key={`${banner.id}-${offset}`} banner={banner} className="min-h-0 flex-1 animate-ad-fade-in" />
      ))}
    </div>
  );
}

/**
 * Phones and tablets: the tiles move left in an endless loop, and a finger can drag and flick them
 * either way. One animation holds the strip's position: left running, the browser moves it without
 * any script; a swipe moves it by setting its time. So nothing re-renders while it moves, and since
 * the time simply wraps there is no end to reach or to jump back from.
 */
function SideMarquee({ banners }: { banners: AdBanner[] }) {
  const count = banners.length;
  const [copies, setCopies] = useState(2);
  const stripRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const strip = stripRef.current;
    const track = trackRef.current;
    if (!strip || !track || count < 2) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const listeners = new AbortController();
    const { signal } = listeners;
    let anim: Animation | null = null;
    let loopWidth = 0;
    let drag: { id: number; startX: number; x: number; time: number; velocity: number; swiping: boolean } | null = null;
    let flickFrame = 0;
    let restTimer = 0;
    let onScreen = false;
    let mouseOver = false;
    let keyboardFocus = false;
    let skipClick = false;

    const pxToMs = (px: number) => (px / STRIP_PX_PER_SECOND) * 1000;
    const position = () => ((anim?.currentTime as number) / 1000) * STRIP_PX_PER_SECOND;
    const place = (px: number) => { if (anim) anim.currentTime = pxToMs(wrapStrip(px, loopWidth)); };
    const syncPlaying = () => {
      if (drag || flickFrame || restTimer || mouseOver || keyboardFocus || !onScreen || document.hidden || reduced?.matches) anim?.pause();
      else anim?.play();
    };
    const rest = () => {
      window.clearTimeout(restTimer);
      restTimer = window.setTimeout(() => { restTimer = 0; syncPlaying(); }, STRIP_REST_MS);
    };

    // Tile widths follow the screen, so this runs again when a phone turns (and when a window narrows
    // from desktop width, where the strip is hidden and has nothing to measure).
    const measure = () => {
      const first = track.children[0] as HTMLElement | undefined;
      const repeat = track.children[count] as HTMLElement | undefined;
      // Not offsetLeft: it rounds, and half a pixel off would show as a small jump at every wrap.
      const width = first && repeat ? repeat.getBoundingClientRect().left - first.getBoundingClientRect().left : 0;
      if (width) setCopies(stripCopies(strip.clientWidth, width));
      if (Math.abs(width - loopWidth) < 0.01) return;
      const part = anim ? position() / loopWidth : 0;
      anim?.cancel();
      anim = null;
      loopWidth = width;
      if (!width) return;
      anim = track.animate(
        [{ transform: "translate3d(0, 0, 0)" }, { transform: `translate3d(${-width}px, 0, 0)` }],
        { duration: pxToMs(width), iterations: Infinity },
      );
      place(part * width);
      syncPlaying();
    };
    const resized = new ResizeObserver(measure);
    resized.observe(strip);
    const seen = new IntersectionObserver((entries) => {
      onScreen = !!entries[entries.length - 1]?.isIntersecting;
      syncPlaying();
    });
    seen.observe(strip);
    document.addEventListener("visibilitychange", syncPlaying, { signal });
    reduced?.addEventListener?.("change", syncPlaying, { signal });

    const flick = (start: number) => {
      let velocity = start;
      let last = performance.now();
      const step = (now: number) => {
        const next = flickStep(velocity, now - last, STRIP_FLICK_DECAY_MS);
        last = now;
        velocity = next.velocity;
        place(position() + next.distance);
        flickFrame = Math.abs(velocity) > STRIP_FLICK_MIN ? requestAnimationFrame(step) : 0;
        if (!flickFrame) syncPlaying();
      };
      flickFrame = requestAnimationFrame(step);
    };

    const release = (event: PointerEvent) => {
      if (drag?.id !== event.pointerId) return;
      const { swiping, velocity, time } = drag;
      drag = null;
      // (a cancel means the browser took the finger, to scroll the page up or down)
      if (swiping && event.type === "pointerup") {
        skipClick = true;
        // A finger that came to rest before lifting does not flick.
        const speed = event.timeStamp - time > 80 ? 0 : Math.max(-STRIP_FLICK_MAX, Math.min(STRIP_FLICK_MAX, velocity));
        if (Math.abs(speed) > STRIP_FLICK_MIN) flick(speed);
      }
      rest();
      syncPlaying();
    };
    // On the window: a mouse pressed on the strip can be released anywhere.
    window.addEventListener("pointerup", release, { signal });
    window.addEventListener("pointercancel", release, { signal });

    strip.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !event.isPrimary) return;
      // A finger that stops a flick only stops it, it does not open the tile under it.
      skipClick = flickFrame !== 0;
      cancelAnimationFrame(flickFrame);
      flickFrame = 0;
      window.clearTimeout(restTimer);
      restTimer = 0;
      drag = { id: event.pointerId, startX: event.clientX, x: event.clientX, time: event.timeStamp, velocity: 0, swiping: false };
      syncPlaying();
    }, { signal });

    strip.addEventListener("pointermove", (event) => {
      if (drag?.id !== event.pointerId) return;
      // The mouse was released outside the browser window.
      if (event.pointerType === "mouse" && !event.buttons) return release(event);
      if (!drag.swiping) {
        if (Math.abs(event.clientX - drag.startX) < STRIP_TAP_PX) return;
        drag.swiping = true;
        drag.x = event.clientX;
        drag.time = event.timeStamp;
        strip.setPointerCapture(event.pointerId);
        return;
      }
      const moved = drag.x - event.clientX;
      const ms = event.timeStamp - drag.time;
      place(position() + moved);
      // The finger's speed over about the last 50 ms, at any touch-screen rate.
      if (ms > 0) drag.velocity += (1 - Math.exp(-ms / 50)) * (moved / ms - drag.velocity);
      drag.x = event.clientX;
      drag.time = event.timeStamp;
    }, { signal });

    // The click a mouse makes at the end of a swipe. Enter on a focused tile (no pointer, detail 0) still opens it.
    strip.addEventListener("click", (event) => {
      if (!skipClick || event.detail === 0) return;
      skipClick = false;
      event.preventDefault();
      event.stopPropagation();
    }, { capture: true, signal });
    strip.addEventListener("dragstart", (event) => event.preventDefault(), { signal });
    // The browser can scroll a clipped box by itself (find in page, focus); the animation alone places the strip.
    strip.addEventListener("scroll", () => { strip.scrollLeft = 0; }, { signal });

    const onMouse = (event: PointerEvent, over: boolean) => {
      if (event.pointerType !== "mouse") return;
      mouseOver = over;
      syncPlaying();
    };
    strip.addEventListener("pointerenter", (event) => onMouse(event, true), { signal });
    strip.addEventListener("pointerleave", (event) => onMouse(event, false), { signal });

    // Keyboard: hold still and bring the tile into view (only the first set can take focus, so it always fits).
    strip.addEventListener("focusin", (event) => {
      const link = event.target as HTMLElement;
      if (!link.matches(":focus-visible")) return;
      keyboardFocus = true;
      syncPlaying();
      const tile = [...track.children].find((child) => child.contains(link)) as HTMLElement | undefined;
      if (tile) place(tile.offsetLeft);
    }, { signal });
    strip.addEventListener("focusout", () => {
      if (!keyboardFocus) return;
      keyboardFocus = false;
      rest();
      syncPlaying();
    }, { signal });

    return () => {
      listeners.abort();
      resized.disconnect();
      seen.disconnect();
      cancelAnimationFrame(flickFrame);
      window.clearTimeout(restTimer);
      anim?.cancel();
    };
  }, [count]);

  if (count === 0) return null;
  const items = count > 1 ? Array.from({ length: copies }, () => banners).flat() : banners;
  return (
    <div
      ref={stripRef}
      role="group"
      // (the focus ring sits inside the tile: the tile's rounded clipping would cut off one drawn outside it)
      className={cn(
        "relative mt-3 overflow-hidden lg:hidden [&_a:focus-visible]:outline-2 [&_a:focus-visible]:-outline-offset-4 [&_a:focus-visible]:outline-white",
        count > 1 && "touch-pan-y touch-pinch-zoom select-none",
      )}
      aria-label="More offers"
    >
      <div ref={trackRef} className={cn("flex w-max gap-3", count > 1 && "will-change-transform")}>
        {items.map((banner, i) => (
          <SideTile key={`${banner.id}-${i}`} banner={banner} copy={i >= count} className="aspect-[16/9] w-[46vw] max-w-[16rem] shrink-0 sm:w-[32vw]" />
        ))}
      </div>
    </div>
  );
}

/** A soft placeholder the size of the big banner, so the band holds its place until the banners arrive. */
function BandPlaceholder() {
  return <div aria-hidden className="h-full w-full animate-pulse rounded-2xl bg-white/45 ring-1 ring-black/5" />;
}

export function AdShowcase({ children }: { children?: ReactNode }) {
  const { main, side, ready } = useLiveAdBanners();
  const festive = useFestiveTheme();
  const hasAds = main.length > 0 || side.length > 0;
  // Only once the list is known to be empty does the band go away (just the category strip then).
  if (!hasAds && ready) return <>{children}</>;
  // Until then (the server render and the first paint) the band keeps its place with placeholders the
  // size of the banners, so the page does not jump down when they arrive.
  const pending = !hasAds;
  const hero = main.length > 0 ? main : side;
  const tiles = main.length > 0 ? side : [];
  const withTiles = tiles.length > 0 || pending;
  return (
    <section className="relative isolate overflow-hidden">
      {/* Soft moving brand-coloured backdrop behind the banners and the category strip. */}
      {/* (twice the band's size and slid, so the browser moves it without repainting; still while the festival backdrop covers it) */}
      <div aria-hidden className={cn("absolute left-0 top-0 -z-10 h-[200%] w-[200%] bg-gradient-to-br from-[#e9f2ec] via-[#fbf5e6] to-[#eef4ef] motion-reduce:animate-none", !festive.on && "animate-ad-backdrop")} />
      <div aria-hidden className="absolute -left-24 -top-24 -z-10 h-72 w-72 rounded-full bg-gold/20 blur-3xl" />
      <div aria-hidden className="absolute -bottom-24 -right-16 -z-10 h-72 w-72 rounded-full bg-emerald-700/10 blur-3xl" />
      {/* Festival dates: warm Deepavali light and a marigold toran hanging in the band's top padding. */}
      {festive.on && <><DiwaliBackdrop /><DiwaliLanterns place="sides" /><DiwaliToran /></>}

      <div className="mx-auto max-w-7xl px-4 pt-3 sm:px-6 sm:pt-5">
        <div className={cn("relative grid gap-3", withTiles && "lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]")}>
          {festive.on && <SideGarlands />}
          <div className="aspect-[16/9] sm:aspect-[21/9] lg:aspect-auto lg:h-[min(23rem,32vw)]">
            {pending ? <BandPlaceholder /> : <MainCarousel banners={hero} />}
          </div>
          {pending && (
            <div aria-hidden className="hidden h-[min(23rem,32vw)] flex-col gap-3 lg:flex">
              <div className="min-h-0 flex-1 animate-pulse rounded-xl bg-white/45" />
              <div className="min-h-0 flex-1 animate-pulse rounded-xl bg-white/45" />
            </div>
          )}
          {tiles.length > 0 && <div className="hidden lg:block lg:h-[min(23rem,32vw)]"><SideColumn banners={tiles} /></div>}
        </div>
        {pending ? (
          <div aria-hidden className="mt-3 flex gap-3 overflow-hidden lg:hidden">
            {[0, 1, 2].map((i) => <div key={i} className="aspect-[16/9] w-[46vw] max-w-[16rem] shrink-0 animate-pulse rounded-xl bg-white/45 sm:w-[32vw]" />)}
          </div>
        ) : (
          <SideMarquee banners={tiles} />
        )}
      </div>

      {/* The category strip on a frosted card in front of the band. */}
      {children && (
        <div className="mx-auto max-w-7xl px-4 pb-1 pt-3 sm:px-6">
          <div className="overflow-hidden rounded-2xl border border-white/70 bg-white/75 shadow-card backdrop-blur-md [&>nav]:border-0 [&>nav]:bg-transparent [&>nav]:shadow-none">{children}</div>
        </div>
      )}
    </section>
  );
}
