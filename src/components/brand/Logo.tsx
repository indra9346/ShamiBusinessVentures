import { Link } from "@tanstack/react-router";
// A 176 px copy (4 KB) for the header and footer; invoices and SEO use the full-size PNG.
import grainbazarLogo from "@/assets/grainbazar-logo-176.webp";
import { cn } from "@/lib/utils";

export function Logo({
  to = "/",
  className,
  variant = "light",
}: {
  to?: string;
  className?: string;
  variant?: "light" | "dark";
}) {
  return (
    <Link
      to={to}
      className={cn("inline-flex shrink-0 items-center gap-2 sm:gap-2.5", className)}
      aria-label="Grain Bazar home"
    >
      <img
        src={grainbazarLogo}
        alt="Grain Bazar"
        width={176}
        height={176}
        className="h-9 w-9 rounded-lg bg-white object-contain p-1 shadow-sm sm:h-11 sm:w-11"
      />
      <span
        className={cn(
          "whitespace-nowrap text-xs font-extrabold tracking-wide sm:text-base",
          variant === "light" ? "text-white" : "text-navy",
        )}
      >
        GRAIN BAZAR
      </span>
    </Link>
  );
}

export function LogoMark({ className }: { className?: string }) {
  return (
    <img
      src={grainbazarLogo}
      alt="Grain Bazar"
      width={176}
      height={176}
      className={cn("h-10 w-auto rounded-lg bg-white object-contain p-1 shadow-sm", className)}
    />
  );
}
