/*
 * The customer's "How to order and pay" video (13 Nov 2026), English and Kannada, 720x1280 MP4 with a poster frame.
 * The files live in the live project's public "ad-media" bucket under tutorials/, so they play the same in every build
 * (the local demo too). To replace a video, upload a new file to the same path.
 */
export type TutorialLanguage = "en" | "kn";

const TUTORIAL_BASE = "https://ppziinqjxqpxpmudinfd.supabase.co/storage/v1/object/public/ad-media/tutorials";

export function tutorialVideo(lang: TutorialLanguage): { src: string; poster: string } {
  const name = `how-to-order-${lang === "kn" ? "kn" : "en"}`;
  return { src: `${TUTORIAL_BASE}/${name}.mp4`, poster: `${TUTORIAL_BASE}/${name}.jpg` };
}

/** The video's steps as text, for customers who can't play it (Kannada in i18n-kn.ts). */
export const HOW_TO_ORDER_STEPS = [
  "Sign in with your mobile number and the OTP you get by SMS.",
  "Open the shop, tap Add, choose the number of bags and tap Add to cart.",
  "Tap Checkout, check your items, and save your address once.",
  "Choose how to pay: below ₹1 lakh UPI or NEFT; from ₹1 lakh NEFT; from ₹2 lakh NEFT or RTGS.",
  "Pay within the time shown: scan the QR or tap your UPI app. The amount fills in by itself.",
  "Open the payment receipt in your UPI app and find the 12-digit UPI reference number (UTR).",
  "Come back, type the UTR and tap Send UTR. Do not pay again while we check it.",
  "Once it is confirmed, your order is placed. Follow it in My Orders.",
] as const;
