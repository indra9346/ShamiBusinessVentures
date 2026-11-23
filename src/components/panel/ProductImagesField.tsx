import { useId, useState, type ChangeEvent } from "react";
import { ArrowLeft, ArrowRight, ImagePlus, Star, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { uploadCatalogImage } from "@/lib/catalog-images";
import { resizedImage } from "@/lib/image-url";
import {
  MAX_PRODUCT_IMAGES,
  addImages,
  isImageAddress,
  makeMainImage,
  moveImage,
  removeImage,
  type ImagesUpdate,
} from "@/lib/product-images";
import { cn } from "@/lib/utils";

const ACCEPT = "image/jpeg,image/png,image/webp,image/gif,image/avif";

/**
 * A product's pictures in the Add/Edit product forms: upload several at once, paste an address, move
 * them, choose the main one and remove any. The first picture is the main picture (cards, cart,
 * Google and Zoho show only that one); the product page shows all of them as a gallery.
 */
export function ProductImagesField({
  images,
  onChange,
  onUploadingChange,
  disabled = false,
  className,
}: {
  /** All pictures, the main one first. */
  images: string[];
  onChange: (update: ImagesUpdate) => void;
  /** Told when uploads start and end, so the form can wait before saving. */
  onUploadingChange?: (uploading: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  const inputId = useId();
  const [address, setAddress] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const uploading = progress !== null;
  const room = MAX_PRODUCT_IMAGES - images.length;
  const full = room <= 0;

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (files.length === 0) return;
    const picked = files.slice(0, Math.max(0, room));
    if (picked.length < files.length) {
      toast.warning(
        `A product can have ${MAX_PRODUCT_IMAGES} pictures. Only the first ${picked.length} of ${files.length} were added.`,
      );
    }
    if (picked.length === 0) return;
    setProgress({ done: 0, total: picked.length });
    onUploadingChange?.(true);
    let uploaded = 0;
    try {
      // One at a time, in the order chosen, so the pictures keep that order and each one is kept as soon as it is up.
      for (const [index, file] of picked.entries()) {
        setProgress({ done: index, total: picked.length });
        try {
          const url = await uploadCatalogImage(file, "products");
          onChange((current) => addImages(current, [url]).images);
          uploaded += 1;
        } catch (error) {
          toast.error(`Could not upload ${file.name}`, {
            description: error instanceof Error ? error.message : "Try again.",
          });
        }
      }
    } finally {
      setProgress(null);
      onUploadingChange?.(false);
    }
    if (uploaded > 0)
      toast.success(uploaded === 1 ? "Picture uploaded" : `${uploaded} pictures uploaded`);
  };

  const addAddress = () => {
    const url = address.trim();
    if (!isImageAddress(url)) {
      toast.error("Paste a full picture address starting with https://");
      return;
    }
    if (images.includes(url)) {
      toast.info("This picture is already on the product");
      return;
    }
    onChange((current) => addImages(current, [url]).images);
    setAddress("");
  };

  return (
    <div className={cn("min-w-0", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <Label htmlFor={inputId}>Product pictures</Label>
        <span className="text-xs text-slate">{`${images.length} of ${MAX_PRODUCT_IMAGES}`}</span>
      </div>
      {images.length === 0 ? (
        <p className="mt-1 text-xs text-slate">
          No picture yet. The first picture is the main picture on product cards.
        </p>
      ) : (
        <ul className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Product pictures">
          {images.map((src, index) => {
            const main = index === 0;
            return (
              <li
                key={src}
                className={cn(
                  "min-w-0 rounded-md border bg-card p-1.5",
                  main ? "border-gold ring-1 ring-gold/60" : "border-border",
                )}
              >
                <div className="relative">
                  <img
                    src={resizedImage(src, 240)}
                    alt={main ? "Main picture" : `Picture ${index + 1}`}
                    loading="lazy"
                    className="aspect-square w-full rounded bg-ivory object-contain"
                  />
                  <span
                    className={cn(
                      "absolute top-1 left-1 rounded px-1.5 py-0.5 text-[10px] font-bold",
                      main ? "bg-gold text-midnight" : "bg-white/90 text-navy",
                    )}
                  >
                    {main ? "Main" : index + 1}
                  </span>
                  {!disabled && (
                    <button
                      type="button"
                      className="absolute top-1 right-1 flex h-7 w-7 items-center justify-center rounded-full bg-white/95 text-danger shadow-sm ring-1 ring-border hover:bg-danger hover:text-white"
                      title="Remove"
                      aria-label={main ? "Remove the main picture" : `Remove picture ${index + 1}`}
                      onClick={() =>
                        onChange((current) => removeImage(current, current.indexOf(src)))
                      }
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                {!disabled && images.length > 1 && (
                  <div className="mt-1.5 flex items-center justify-center gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-8 w-8"
                      title="Move earlier"
                      aria-label={`Move picture ${index + 1} earlier`}
                      disabled={index === 0}
                      onClick={() =>
                        onChange((current) =>
                          moveImage(current, current.indexOf(src), current.indexOf(src) - 1),
                        )
                      }
                    >
                      <ArrowLeft className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className={cn(
                        "h-8 w-8",
                        main && "border-gold bg-gold/10 text-gold disabled:opacity-100",
                      )}
                      title={main ? "Main picture" : "Set as main picture"}
                      aria-label={
                        main
                          ? "This is the main picture"
                          : `Set picture ${index + 1} as the main picture`
                      }
                      aria-pressed={main}
                      disabled={main}
                      onClick={() =>
                        onChange((current) => makeMainImage(current, current.indexOf(src)))
                      }
                    >
                      <Star className={cn("h-3.5 w-3.5", main && "fill-gold")} />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-8 w-8"
                      title="Move later"
                      aria-label={`Move picture ${index + 1} later`}
                      disabled={index === images.length - 1}
                      onClick={() =>
                        onChange((current) =>
                          moveImage(current, current.indexOf(src), current.indexOf(src) + 1),
                        )
                      }
                    >
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!disabled && (
        <div className="mt-2 space-y-2">
          <label
            className={cn(
              "inline-flex h-10 max-w-full items-center gap-2 rounded-md border border-dashed border-gold/70 px-3 text-sm font-semibold text-navy",
              uploading || full ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-ivory",
            )}
          >
            <ImagePlus className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="truncate">
              {progress
                ? `Uploading ${progress.done + 1} of ${progress.total}…`
                : full
                  ? `${MAX_PRODUCT_IMAGES} pictures added (the most)`
                  : images.length === 0
                    ? "Browse local files"
                    : "Add more pictures"}
            </span>
            <input
              id={inputId}
              className="sr-only"
              type="file"
              multiple
              accept={ACCEPT}
              disabled={uploading || full}
              onChange={(event) => void upload(event)}
            />
          </label>
          {!full && (
            <div className="flex gap-2">
              <Input
                className="h-10 min-w-0 flex-1"
                aria-label="Paste a picture address"
                placeholder="Or paste a picture address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addAddress();
                  }
                }}
              />
              <Button
                type="button"
                variant="outline"
                className="h-10"
                disabled={!address.trim()}
                onClick={addAddress}
              >
                Add
              </Button>
            </div>
          )}
          <p className="text-xs text-slate">
            You can choose several files at once. The star marks the main picture: product cards,
            the cart and Zoho show only that one; the product page shows them all in this order.
          </p>
        </div>
      )}
    </div>
  );
}
