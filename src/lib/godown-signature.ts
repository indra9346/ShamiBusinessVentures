/*
 * A godown's signature, printed in the "Authorized Signatory" space of its invoices. Whatever picture is chosen is drawn
 * onto a canvas and stored as a small PNG: that proves it really is a picture, keeps transparency, and is the one kind
 * of file the PDF and the private bucket both accept.
 */
export const GODOWN_SIGNATURE_BUCKET = "godown-signatures";
export const SIGNATURE_MAX_BYTES = 2 * 1024 * 1024;
export const SIGNATURE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_WIDTH = 900;
const MAX_HEIGHT = 300;

/** Why this file will not do, or null. */
export function signatureFileProblem(file: { type: string; size: number }) {
  if (!SIGNATURE_TYPES.includes(file.type)) return "Choose a PNG, JPG or WebP picture";
  if (file.size > SIGNATURE_MAX_BYTES) return "Choose a picture under 2 MB";
  if (file.size === 0) return "This file is empty";
  return null;
}

/** The chosen picture as a PNG no larger than the signature space needs. */
export async function signatureToPng(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error("This file could not be read as a picture");
  const scale = Math.min(1, MAX_WIDTH / bitmap.width, MAX_HEIGHT / bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser could not prepare the picture");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("This browser could not prepare the picture");
  if (blob.size > 1024 * 1024) throw new Error("The picture is still too large. Use a simpler scan of the signature.");
  return blob;
}
