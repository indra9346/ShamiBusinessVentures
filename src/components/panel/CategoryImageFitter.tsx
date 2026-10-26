import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Move, RotateCcw, ZoomIn } from "lucide-react";
import { CategoryImage } from "@/components/site/CategoryImage";
import { Button } from "@/components/ui/button";
import { defaultCategoryImageFit, normalizeCategoryImageFit, type CategoryImageFit } from "@/lib/data";

/**
 * Lets the admin frame a category image for the square storefront tiles: drag the big square to
 * choose what stays in view, zoom in so the product fills it, and check the live previews of
 * the category strip and homepage card before saving.
 */
export function CategoryImageFitter({
  src,
  fit,
  onChange,
}: {
  src: string;
  fit: CategoryImageFit | undefined;
  onChange: (fit: CategoryImageFit) => void;
}) {
  const value = normalizeCategoryImageFit(fit);
  const drag = useRef<{ x: number; y: number; fit: CategoryImageFit; size: number } | null>(null);
  // Width ÷ height of the photo: decides how far it can slide inside the square frame.
  const [aspect, setAspect] = useState(1);
  useEffect(() => {
    const probe = new Image();
    probe.onload = () => setAspect(probe.naturalWidth / Math.max(1, probe.naturalHeight) || 1);
    probe.src = src;
  }, [src]);
  // Overflow (in frame widths) the photo has on each axis once covered and zoomed.
  const spareX = value.zoom * Math.max(1, aspect) - 1;
  const spareY = value.zoom * Math.max(1, 1 / aspect) - 1;
  const canMove = spareX > 0.01 || spareY > 0.01;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, fit: value, size: event.currentTarget.clientWidth };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    // Dragging the photo right brings its left side into view, so the focus point moves left.
    // A 100 % change in focus slides the photo by its whole overflow on that axis.
    const sx = start.fit.zoom * Math.max(1, aspect) - 1;
    const sy = start.fit.zoom * Math.max(1, 1 / aspect) - 1;
    onChange(
      normalizeCategoryImageFit({
        zoom: start.fit.zoom,
        x: sx > 0.01 ? start.fit.x - ((event.clientX - start.x) / (start.size * sx)) * 100 : start.fit.x,
        y: sy > 0.01 ? start.fit.y - ((event.clientY - start.y) / (start.size * sy)) * 100 : start.fit.y,
      }),
    );
  };
  const endDrag = () => {
    drag.current = null;
  };

  return (
    <div className="grid gap-3 rounded-md border border-border bg-ivory/50 p-3">
      <div className="flex flex-wrap items-center gap-4">
        <div
          role="img"
          aria-label="Drag to position the category image"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          className="relative h-40 w-40 shrink-0 cursor-grab touch-none overflow-hidden rounded-lg border-4 border-gold/60 bg-card shadow-card active:cursor-grabbing"
        >
          <CategoryImage src={src} fit={value} loading="eager" />
          <span className="pointer-events-none absolute inset-x-0 bottom-2 mx-auto flex w-max items-center gap-1 rounded-full bg-midnight/60 px-2 py-0.5 text-[10px] font-semibold text-white">
            <Move className="h-3 w-3" /> {canMove ? "Drag" : "Zoom in to move"}
          </span>
        </div>

        <div className="grid gap-2 text-center">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate">Storefront preview</p>
          <div className="flex items-end gap-4">
            <div className="grid justify-items-center gap-1">
              <span className="block h-16 w-16 overflow-hidden rounded-md border-2 border-gold/70 bg-card">
                <CategoryImage src={src} fit={value} loading="eager" />
              </span>
              <span className="text-[10px] text-slate">Category strip</span>
            </div>
            <div className="grid justify-items-center gap-1">
              <span className="block h-24 w-24 overflow-hidden rounded-md bg-ivory">
                <CategoryImage src={src} fit={value} loading="eager" />
              </span>
              <span className="text-[10px] text-slate">Homepage</span>
            </div>
          </div>
        </div>
      </div>

      <label className="grid gap-1 text-xs font-semibold text-navy">
        <span className="flex items-center justify-between">
          <span className="flex items-center gap-1">
            <ZoomIn className="h-3.5 w-3.5" /> Zoom
          </span>
          <span className="tabular-nums text-slate">{value.zoom.toFixed(2)}×</span>
        </span>
        <input
          type="range"
          min={1}
          max={3}
          step={0.05}
          value={value.zoom}
          onChange={(event) => onChange({ ...value, zoom: Number(event.target.value) })}
          className="w-full accent-[var(--navy)]"
          aria-label="Zoom category image"
        />
      </label>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] leading-snug text-slate">
          Best results: a square photo (at least 800 × 800 px) where the product fills the frame. Drag and zoom until only the product shows.
        </p>
        <Button type="button" size="sm" variant="outline" onClick={() => onChange(defaultCategoryImageFit)}>
          <RotateCcw className="mr-1 h-3.5 w-3.5" /> Reset
        </Button>
      </div>
    </div>
  );
}
