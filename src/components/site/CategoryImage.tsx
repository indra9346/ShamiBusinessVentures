import type { ReactEventHandler } from "react";
import { normalizeCategoryImageFit, type CategoryImageFit } from "@/lib/data";
import { cn } from "@/lib/utils";

/**
 * A category image cropped to its container (circle or card) using the admin's saved fit:
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
  onError?: ReactEventHandler<HTMLImageElement>;
}) {
  const { zoom, x, y } = normalizeCategoryImageFit(fit);
  return (
    <span className={cn("block h-full w-full overflow-hidden", className)}>
      <img
        src={src}
        alt={alt}
        loading={loading}
        width={width}
        height={height}
        onError={onError}
        draggable={false}
        style={{ objectPosition: `${x}% ${y}%`, transform: `scale(${zoom})`, transformOrigin: `${x}% ${y}%` }}
        className={cn("h-full w-full select-none object-cover", imgClassName)}
      />
    </span>
  );
}
