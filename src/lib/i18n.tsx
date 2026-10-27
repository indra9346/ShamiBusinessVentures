import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { translateText, type Language } from "./i18n-core.ts";

export { translateText, type Language };

const STORAGE_KEY = "sbv-language";

/**
 * The English source for a node we may already have translated. The cached source is only
 * trusted while the live value is still that source or our translation of it; anything else
 * means React re-rendered new content (e.g. a cart count), which becomes the new source.
 * Without this, a stale cache rewrites fresh values back to old ones.
 */
function currentSource(cached: string | undefined, live: string) {
  if (cached === undefined) return live;
  return live === cached || live === translateText(cached, "kn") ? cached : live;
}

type LanguageContextValue = {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (value: string) => string;
};

const LanguageContext = createContext<LanguageContextValue | null>(null);

const translatedAttributes = ["placeholder", "aria-label", "title", "alt"] as const;

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>("en");
  const languageRef = useRef<Language>("en");
  const textSources = useRef(new WeakMap<Text, string>());
  const attributeSources = useRef(new WeakMap<Element, Map<string, string>>());

  const applyLanguage = useCallback((root: ParentNode, nextLanguage: Language) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const text = node as Text;
      const parent = text.parentElement;
      if (parent && !parent.closest("[data-no-translate]") && !["SCRIPT", "STYLE"].includes(parent.tagName)) {
        const source = currentSource(textSources.current.get(text), text.nodeValue ?? "");
        textSources.current.set(text, source);
        const translated = translateText(source, nextLanguage);
        if (text.nodeValue !== translated) text.nodeValue = translated;
      }
      node = walker.nextNode();
    }

    const elements = root instanceof Element ? [root, ...root.querySelectorAll("*")] : [...root.querySelectorAll("*")];
    for (const element of elements) {
      if (element.closest("[data-no-translate]")) continue;
      let sources = attributeSources.current.get(element);
      if (!sources) {
        sources = new Map<string, string>();
        attributeSources.current.set(element, sources);
      }
      for (const attribute of translatedAttributes) {
        const current = element.getAttribute(attribute);
        if (current === null) continue;
        const source = currentSource(sources.get(attribute), current);
        sources.set(attribute, source);
        element.setAttribute(attribute, translateText(source, nextLanguage));
      }
    }
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    const initial: Language = saved === "kn" ? "kn" : "en";
    languageRef.current = initial;
    setLanguageState(initial);
    document.documentElement.lang = initial === "kn" ? "kn" : "en";
    applyLanguage(document.body, initial);

    const observer = new MutationObserver((mutations) => {
      observer.disconnect();
      for (const mutation of mutations) {
        if (mutation.type === "characterData") {
          const text = mutation.target as Text;
          const previous = textSources.current.get(text);
          const expected = previous ? translateText(previous, languageRef.current) : undefined;
          if (!previous || text.nodeValue !== expected) textSources.current.set(text, text.nodeValue ?? "");
          if (text.parentNode) applyLanguage(text.parentNode, languageRef.current);
        } else {
          for (const added of mutation.addedNodes) {
            if (added.nodeType === Node.TEXT_NODE) {
              const text = added as Text;
              textSources.current.set(text, text.nodeValue ?? "");
              if (text.parentNode) applyLanguage(text.parentNode, languageRef.current);
            } else if (added instanceof Element) {
              applyLanguage(added, languageRef.current);
            }
          }
        }
      }
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [applyLanguage]);

  const setLanguage = useCallback((nextLanguage: Language) => {
    languageRef.current = nextLanguage;
    setLanguageState(nextLanguage);
    localStorage.setItem(STORAGE_KEY, nextLanguage);
    document.documentElement.lang = nextLanguage === "kn" ? "kn" : "en";
    applyLanguage(document.body, nextLanguage);
  }, [applyLanguage]);

  const value = useMemo<LanguageContextValue>(() => ({
    language,
    setLanguage,
    t: (text) => translateText(text, language),
  }), [language, setLanguage]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) throw new Error("useLanguage must be used inside LanguageProvider");
  return context;
}
