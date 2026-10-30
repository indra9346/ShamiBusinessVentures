import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useLiveAdBanners, type AdBanner } from "@/lib/ad-banners";
import { useFestiveTheme } from "@/lib/festive";
import { DiwaliBackdrop, DiwaliToran, SideGarlands } from "@/components/site/DiwaliDecor";
import { cn } from "@/lib/utils";

/*
 * The home page's advertising band (offers, hot deals, new products, festival banners, promo
 * videos), managed in Admin > Ad Banners. A large sliding banner with swipe and auto-play, smaller
 * tiles beside it (a looping strip on phones), and the category strip on a frosted card in front
 * of the band. With no live banners only the category strip shows, as before.
 */

const SLIDE_MS = 5500;
const VIDEO_MAX_MS = 20000;

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    setReduced(query.matches);
    const onChange = () => setReduced(query.matches);
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

/** Opens a banner's link: pages on this site without a reload, other sites in a new tab. */
function BannerLink({ banner, className, children, tabIndex }: { banner: AdBanner; className?: string; children: ReactNode; tabIndex?: number }) {
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

function BannerMedia({ banner, active, eager, onVideoEnd, kenBurns }: {
  banner: AdBanner; active: boolean; eager: boolean; onVideoEnd?: (() => void) | undefined; kenBurns: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // Banners render in the browser only (from the cached or live list), so the screen size is known here.
  const [phone] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.("(max-width: 639px)").matches);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (active) {
      video.currentTime = 0;
      void video.play().catch(() => undefined);
    } else {
      video.pause();
    }
  }, [active]);
  const fitClass = banner.fit === "contain" ? "object-contain" : "object-cover";
  if (banner.mediaKind === "video") {
    return (
      <video
        ref={videoRef}
        src={(phone && phoneVideoOf(banner)) || banner.mediaUrl}
        muted
        playsInline
        loop={!onVideoEnd}
        preload={eager ? "auto" : "metadata"}
        onEnded={onVideoEnd}
        className={cn("h-full w-full", fitClass)}
      />
    );
  }
  const image = (
    <img
      src={banner.mediaUrl}
      alt={banner.title || "Offer"}
      // Slides and tiles sit off-screen sideways, where lazy loading never starts; the first
      // slide comes first, the rest right after, so no slide is blank when it moves in.
      loading="eager"
      fetchPriority={eager ? "high" : "low"}
      decoding="async"
      draggable={false}
      className={cn("h-full w-full select-none", fitClass, kenBurns && active && banner.fit === "cover" && "animate-ad-kenburns")}
    />
  );
  if (!banner.mobileMediaUrl) return image;
  return (
    <picture className="block h-full w-full">
      <source media="(max-width: 639px)" srcSet={banner.mobileMediaUrl} />
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
      className="group/ad relative h-full overflow-hidden rounded-2xl shadow-elevated ring-1 ring-black/5"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { start.current = null; }}
      aria-roledescription="carousel"
      aria-label="Offers"
    >
      <div
        className="flex h-full w-full transition-transform duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
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
                kenBurns={!reducedMotion}
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

function SideTile({ banner, className }: { banner: AdBanner; className?: string }) {
  return (
    <div className={cn("relative overflow-hidden rounded-xl shadow-card ring-1 ring-black/5", className)} style={{ backgroundColor: banner.background }}>
      <BannerLink banner={banner} className="block h-full w-full">
        <BannerMedia banner={banner} active eager={false} kenBurns={false} />
        <BannerCaption banner={banner} />
      </BannerLink>
    </div>
  );
}

/** Desktop: up to two tiles stacked beside the big banner, taking turns when there are more. */
function SideColumn({ banners }: { banners: AdBanner[] }) {
  const reducedMotion = usePrefersReducedMotion();
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    if (banners.length <= 2 || reducedMotion) return;
    const timer = window.setInterval(() => setOffset((o) => (o + 1) % banners.length), SLIDE_MS + 1500);
    return () => window.clearInterval(timer);
  }, [banners.length, reducedMotion]);
  const shown = banners.length <= 2 ? banners : [banners[offset % banners.length]!, banners[(offset + 1) % banners.length]!];
  return (
    <div className="hidden h-full min-h-0 flex-col gap-3 lg:flex">
      {shown.map((banner) => (
        <SideTile key={`${banner.id}-${offset}`} banner={banner} className="min-h-0 flex-1 animate-ad-fade-in" />
      ))}
    </div>
  );
}

/** Phones and tablets: the tiles move left in an endless loop (pauses while touched). */
function SideMarquee({ banners }: { banners: AdBanner[] }) {
  const reducedMotion = usePrefersReducedMotion();
  if (banners.length === 0) return null;
  const loop = !reducedMotion && banners.length > 1;
  const items = loop ? [...banners, ...banners] : banners;
  return (
    <div className="relative mt-3 overflow-hidden lg:hidden" aria-label="More offers">
      <div
        className={cn("flex w-max gap-3 hover:[animation-play-state:paused] active:[animation-play-state:paused]", loop && "animate-ad-marquee")}
        style={loop ? { animationDuration: `${Math.max(18, banners.length * 7)}s` } : undefined}
      >
        {items.map((banner, i) => (
          <SideTile key={`${banner.id}-${i}`} banner={banner} className="aspect-[16/9] w-[46vw] max-w-[16rem] shrink-0 sm:w-[32vw]" />
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
      {/* (still while the festival backdrop covers it, so nothing under it repaints every frame) */}
      <div aria-hidden className={cn("absolute inset-0 -z-10 bg-[length:200%_200%] bg-gradient-to-br from-[#e9f2ec] via-[#fbf5e6] to-[#eef4ef] motion-reduce:animate-none", !festive.on && "animate-ad-backdrop")} />
      <div aria-hidden className="absolute -left-24 -top-24 -z-10 h-72 w-72 rounded-full bg-gold/20 blur-3xl" />
      <div aria-hidden className="absolute -bottom-24 -right-16 -z-10 h-72 w-72 rounded-full bg-emerald-700/10 blur-3xl" />
      {/* Festival dates: warm Deepavali light and a marigold toran hanging in the band's top padding. */}
      {festive.on && <><DiwaliBackdrop /><DiwaliToran /></>}

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
