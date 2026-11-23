import { createFileRoute, Link } from "@tanstack/react-router";
import { Phone, PlayCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel } from "@/components/panel/widgets";
import { accountNav } from "@/lib/account-nav";
import { useLanguage } from "@/lib/i18n";
import { HOW_TO_ORDER_STEPS, tutorialVideo, type TutorialLanguage } from "@/lib/tutorial-video";

/*
 * The customer's "How to order and pay" video (13 Nov 2026): sign in, order, pay by UPI and send the UTR, in English and
 * Kannada. The video follows the site language and can be switched here without changing the site's language.
 */
export const Route = createFileRoute("/account/how-to-order")({
  head: () => ({
    meta: [
      { title: "How to order | Shami Business Ventures" },
      { name: "description", content: "A short video: sign in, order, pay by UPI and send your UTR." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: HowToOrder,
});

function HowToOrder() {
  const { language } = useLanguage();
  const [videoLanguage, setVideoLanguage] = useState<TutorialLanguage>(language === "kn" ? "kn" : "en");
  // A customer who changes the site language here gets the video in that language too.
  useEffect(() => setVideoLanguage(language === "kn" ? "kn" : "en"), [language]);
  const video = tutorialVideo(videoLanguage);

  return (
    <PanelLayout
      items={accountNav}
      tone="customer"
      title="How to order and pay"
      subtitle="A short video: sign in, order, pay by UPI and send your UTR."
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)] lg:items-start">
        <Panel id="how-to-order-video">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-semibold text-navy">Video language</span>
            <div role="group" aria-label="Video language" className="inline-flex overflow-hidden rounded-md border border-gold/50">
              {(["en", "kn"] as const).map((lang) => (
                <button
                  key={lang}
                  type="button"
                  aria-pressed={videoLanguage === lang}
                  onClick={() => setVideoLanguage(lang)}
                  className={`px-3 py-1.5 text-sm font-semibold transition-colors ${
                    videoLanguage === lang ? "bg-navy text-white" : "bg-ivory text-navy hover:bg-gold/20"
                  }`}
                >
                  <span translate="no">{lang === "en" ? "English" : "ಕನ್ನಡ"}</span>
                </button>
              ))}
            </div>
          </div>
          <video
            key={video.src}
            controls
            playsInline
            preload="metadata"
            poster={video.poster}
            className="mx-auto aspect-[9/16] w-full max-w-[380px] rounded-lg bg-ivory shadow-card"
          >
            <source src={video.src} type="video/mp4" />
            Your browser can't play this video.
          </video>
          <a
            href={video.src}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-navy underline"
          >
            <PlayCircle className="h-4 w-4" /> Open the video
          </a>
        </Panel>

        <Panel id="how-to-order-steps" title="The steps">
          <ol className="grid gap-3">
            {HOW_TO_ORDER_STEPS.map((step, i) => (
              <li key={step} className="flex gap-3 rounded-lg border border-gold/30 bg-ivory p-3">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-navy text-sm font-bold text-white">{i + 1}</span>
                <span className="text-sm leading-relaxed text-navy">{step}</span>
              </li>
            ))}
          </ol>
          <div className="mt-4 flex flex-col gap-2 rounded-lg border border-gold/40 bg-gold/10 p-4 sm:flex-row sm:items-center sm:justify-between">
            <span className="min-w-0">
              <span className="block font-bold text-navy">Need help?</span>
              <span className="block text-sm text-slate">Monday to Saturday, 9 am to 6 pm</span>
            </span>
            <a href="tel:+919845966288" className="inline-flex items-center gap-2 self-start rounded-md bg-navy px-4 py-2.5 text-sm font-semibold text-white hover:bg-midnight sm:self-auto">
              <Phone className="h-4 w-4" /> Call +91 98459 66288
            </a>
          </div>
          <Link to="/shop" className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-navy underline">
            Browse products
          </Link>
        </Panel>
      </div>
    </PanelLayout>
  );
}
