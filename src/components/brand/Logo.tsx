import { Link } from "@tanstack/react-router";
import grainbazarLogo from "@/assets/grainbazar-logo.png";
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
      className={cn("inline-flex shrink-0 items-center", className)}
      aria-label="Grain Bazar home"
    >
      <img
        src={grainbazarLogo}
        alt="Grain Bazar"
        width={512}
        height={512}
        className="h-10 w-10 rounded-lg bg-white object-contain p-1 shadow-sm sm:h-11 sm:w-11"
      />
      <span
        className={cn(
          "ml-2.5 whitespace-nowrap text-sm font-extrabold tracking-wide sm:text-base",
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
      width={512}
      height={512}
      className={cn("h-10 w-auto rounded-lg bg-white object-contain p-1 shadow-sm", className)}
    />
  );
}
