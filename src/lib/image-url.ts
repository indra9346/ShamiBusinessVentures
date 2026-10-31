import type { SyntheticEvent } from "react";

/*
 * Pictures in Supabase Storage are kept as uploaded (product and category photos are often
 * 0.4–0.7 MB). The storefront asks Supabase's image service for a copy at the width it is shown,
 * as WebP for browsers that take it, so a product card downloads ~20 KB instead of ~600 KB. Any
 * other address (the site's own files, data: URLs) is used as it is. If a resized copy ever fails
 * to load, `showOriginalImage` switches the picture back to the original file.
 */
const OBJECT_PATH = "/storage/v1/object/public/";
const RENDER_PATH = "/storage/v1/render/image/public/";

function resizable(src: string | null | undefined): src is string {
  return !!src && src.startsWith("https://") && src.includes(OBJECT_PATH) && !/\.(gif|svg)([?#]|$)/i.test(src);
}

/**
 * The address of the picture at `width` pixels wide, never cropped and never enlarged (the original
 * for pictures not in Supabase Storage). Supabase keeps the original height and crops the sides when
 * only a width is given, so "contain" is always asked for.
 */
export function resizedImage(src: string, width: number, quality = 75): string {
  if (!resizable(src)) return src;
  const url = src.replace(OBJECT_PATH, RENDER_PATH);
  return `${url}${url.includes("?") ? "&" : "?"}width=${Math.round(width)}&resize=contain&quality=${quality}`;
}

/**
 * `src`, `srcSet` and `sizes` for an <img>: the browser picks the smallest copy that is sharp on
 * its screen. `sizes` is how wide the picture is shown (CSS media conditions, as for <img sizes>).
 */
export function responsiveImage(src: string, widths: number[], sizes: string, quality = 75) {
  if (!resizable(src)) return { src };
  const sorted = [...widths].sort((a, b) => a - b);
  return {
    src: resizedImage(src, sorted[Math.min(1, sorted.length - 1)]!, quality),
    srcSet: sorted.map((width) => `${resizedImage(src, width, quality)} ${width}w`).join(", "),
    sizes,
    "data-original-src": src,
  };
}

/**
 * For an <img onError>: if a resized copy failed, shows the original file and returns true (the
 * caller's own fallback then waits for the original to fail too).
 */
export function showOriginalImage(event: SyntheticEvent<HTMLImageElement>): boolean {
  const image = event.currentTarget;
  const original = image.getAttribute("data-original-src");
  if (!original || image.getAttribute("src") === original) return false;
  image.removeAttribute("srcset");
  image.removeAttribute("sizes");
  image.src = original;
  return true;
}
