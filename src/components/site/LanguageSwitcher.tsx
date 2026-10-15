import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useLanguage, type Language } from "@/lib/i18n";

export function LanguageSwitcher({
  light = false,
  compact = false,
  className,
}: {
  light?: boolean;
  /** Short labels (EN / ಕ) for tight spaces such as the phone header. */
  compact?: boolean;
  className?: string;
}) {
  const { language, setLanguage } = useLanguage();
  const option = (value: Language, label: string, name: string) => (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => setLanguage(value)}
      aria-pressed={language === value}
      aria-label={name}
      className={cn(
        "h-7 rounded font-semibold",
        compact ? "min-w-7 px-1.5 text-[11px]" : "px-2 text-[11px]",
        light
          ? language === value ? "bg-white/10 text-gold hover:bg-white/10 hover:text-gold" : "text-white/70 hover:bg-white/5 hover:text-white"
          : language === value ? "bg-navy/10 text-navy hover:bg-navy/10" : "text-slate hover:text-navy",
      )}
    >
      {label}
    </Button>
  );

  return (
    <div
      data-no-translate
      className={cn("inline-flex shrink-0 items-center rounded-md border p-0.5", light ? "border-white/15" : "border-border", className)}
      aria-label="Language"
    >
      {option("en", compact ? "EN" : "English", "English")}
      <span className={light ? "text-white/20" : "text-border"}>|</span>
      {option("kn", compact ? "ಕ" : "ಕನ್ನಡ", "ಕನ್ನಡ")}
    </div>
  );
}