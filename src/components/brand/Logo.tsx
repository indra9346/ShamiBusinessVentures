import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

/*
 * The Grain Bazar logo, cut from the one 1920 px original (src/assets/grainbazar-logo.png) by
 * scripts/build-logo-assets.py:
 *  - "mark": the GB ring alone
 *  - "wide": the ring with "GrainBazar" and "Your Business, Our Support." beside it, for headers and side menus
 *  - "full": the original stacked logo, ring above the name and tagline
 * Each comes in the original colours (for light backgrounds) and reversed (navy turned white, gold kept) for the
 * dark green bars, the way Flipkart and Amazon show their logos on their own dark headers. Several widths are
 * shipped so every screen, including 2x and 3x phones, gets a sharp copy without downloading a big one.
 */
type Shape = "mark" | "wide" | "full";
type Source = { src: string; srcSet: string; width: number; height: number };

const files = import.meta.glob<string>("../../assets/brand/gb-*.webp", { eager: true, import: "default" });
// Width over height of each shape, from the built files.
const RATIO: Record<Shape, number> = { mark: 1, wide: 4.6634, full: 1.1852 };

function source(shape: Shape, onDark: boolean): Source {
  const pattern = new RegExp(`/gb-${shape}${onDark ? "-rev" : ""}-(\\d+)\\.webp$`);
  const list = Object.entries(files)
    .map(([path, url]) => {
      const match = path.match(pattern);
      return match ? { width: Number(match[1]), url } : null;
    })
    .filter((entry): entry is { width: number; url: string } => entry !== null)
    .sort((a, b) => a.width - b.width);
  const first = list[0];
  if (!first) throw new Error(`No logo files for ${shape}${onDark ? " (reversed)" : ""}`);
  return {
    src: first.url,
    srcSet: list.map(({ width, url }) => `${url} ${width}w`).join(", "),
    width: first.width,
    height: Math.round(first.width / RATIO[shape]),
  };
}

const SOURCES: Record<Shape, [Source, Source]> = {
  mark: [source("mark", false), source("mark", true)],
  wide: [source("wide", false), source("wide", true)],
  full: [source("full", false), source("full", true)],
};

export function BrandLogo({
  shape,
  onDark = false,
  className,
  sizes,
  eager = false,
}: {
  shape: Shape;
  /** true on the dark green bars: the reversed copy, white and gold. */
  onDark?: boolean;
  className?: string;
  /** The width the logo is shown at, so the browser picks the right file (e.g. "168px"). */
  sizes: string;
  /** Load straight away (top of the page) instead of when it scrolls into view. */
  eager?: boolean;
}) {
  const file = SOURCES[shape][onDark ? 1 : 0];
  return (
    <img
      src={file.src}
      srcSet={file.srcSet}
      sizes={sizes}
      width={file.width}
      height={file.height}
      alt="Grain Bazar"
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      draggable={false}
      className={cn("block max-w-none select-none object-contain", className)}
    />
  );
}

/**
 * The logo as a link home. variant "light" is the white and gold copy for dark backgrounds (site header, footer,
 * sign-in side panel); "dark" is the original navy and gold for light backgrounds.
 */
export function Logo({
  to = "/",
  className,
  variant = "light",
  layout = "wide",
}: {
  to?: string;
  className?: string;
  variant?: "light" | "dark";
  layout?: "wide" | "full";
}) {
  const onDark = variant === "light";
  return (
    <Link to={to} className={cn("inline-flex shrink-0 items-center", className)} aria-label="Grain Bazar home">
      {layout === "wide" ? (
        // 36 px tall on phones, 44 px on tablets, 48 px on computers: the name and tagline stay readable.
        <BrandLogo shape="wide" onDark={onDark} eager className="h-9 w-auto sm:h-11 lg:h-12"
          sizes="(min-width: 1024px) 224px, (min-width: 640px) 206px, 168px" />
      ) : (
        <BrandLogo shape="full" onDark={onDark} className="h-auto w-48 sm:w-52" sizes="(min-width: 640px) 208px, 192px" />
      )}
    </Link>
  );
}

/** The GB ring alone, in its original colours unless onDark. Size it with className (default 40 px). */
export function LogoMark({ className, onDark = false }: { className?: string; onDark?: boolean }) {
  return <BrandLogo shape="mark" onDark={onDark} eager className={cn("h-10 w-10", className)} sizes="44px" />;
}
