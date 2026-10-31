import type { ReactEventHandler } from "react";
import { normalizeCategoryImageFit, type CategoryImageFit } from "@/lib/data";
import { cn } from "@/lib/utils";
import { responsiveImage, showOriginalImage } from "@/lib/image-url";

/**
 * A category image cropped to its square tile or card using the admin's saved fit:
 * the focus point is kept in view and the zoom scales around it. The outer span clips, so
 * callers can add hover effects on `className` without fighting the fit transform.
 */
export function CategoryImage({
  src,
  alt = "",
  fit,
  className,
  imgClassName,
  width,
  height,
  loading = "lazy",
  sizes = "(min-width: 1280px) 400px, 33vw",
  onError,
}: {
  src: string;
  alt?: string;
  fit?: Partial<CategoryImageFit> | undefined;
  className?: string;
  imgClassName?: string;
  width?: number;
  height?: number;
  loading?: "lazy" | "eager";
  /** How wide the picture is shown (as for <img sizes>), so a small tile downloads a small copy. */
  sizes?: string;
  onError?: ReactEventHandler<HTMLImageElement>;
}) {
  const { zoom, x, y } = normalizeCategoryImageFit(fit);
  // A zoomed-in picture shows part of it larger, so it takes a copy that much wider
  // (each size at the end of a "condition size" entry; the media conditions stay as they are).
  const shownSizes = zoom > 1
    ? sizes.split(",").map((entry) => entry.replace(/(\d+)(px|vw)\s*$/, (_, n: string, unit: string) => `${Math.ceil(Number(n) * zoom)}${unit}`)).join(",")
    : sizes;
  return (
    <span className={cn("block h-full w-full overflow-hidden", className)}>
      <img
        {...responsiveImage(src, [160, 320, 640, 960], shownSizes)}
        alt={alt}
        loading={loading}
        width={width}
        height={height}
        onError={(event) => { if (!showOriginalImage(event)) onError?.(event); }}
        draggable={false}
        style={{ objectPosition: `${x}% ${y}%`, transform: `scale(${zoom})`, transformOrigin: `${x}% ${y}%` }}
        className={cn("h-full w-full select-none object-cover", imgClassName)}
      />
    </span>
  );
}
