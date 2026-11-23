import { inrPrecise } from "@/lib/data";

/** UPI apps refuse more than this when the QR is picked from the phone's gallery (NPCI "QR share & pay" limit). */
export const GALLERY_QR_LIMIT = 2000;

/**
 * Sandesh, 19 Nov 2026: a customer saved the QR and opened it from the gallery, and the app said "You can pay up to
 * ₹2,000 with QR codes via gallery". On the phone that shows this page the QR can't be scanned live, so above ₹2,000
 * point them to the app buttons or Pay by UPI ID, which have no such cap.
 */
export function GalleryQrLimitNote({ amount }: { amount: number }) {
  if (!(amount > GALLERY_QR_LIMIT)) return null;
  return (
    <p className="rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-950">
      <span className="font-bold">{`Paying ${inrPrecise(amount)} on this phone?`}</span>{" "}
      {`Don't save the QR and open it from your gallery: UPI apps allow only up to ${inrPrecise(GALLERY_QR_LIMIT)} that way. Tap your UPI app below, or pay by our UPI ID. Scanning the QR with another phone's camera also works.`}
    </p>
  );
}
