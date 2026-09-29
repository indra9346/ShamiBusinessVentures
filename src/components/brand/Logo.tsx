import { Link } from "@tanstack/react-router";
import shamiLogo from "@/assets/shami-logo.png";
import grainbazarLogo from "@/assets/grainbazar-logo.png";
import { cn } from "@/lib/utils";

export function Logo({
  to = "/",
  className,
}: {
  to?: string;
  className?: string;
  variant?: "light" | "dark";
}) {
  return (
    <Link
      to={to}
      className={cn("inline-flex shrink-0 items-center", className)}
      aria-label="Shami Business Ventures home"
    >
      <img
        src={shamiLogo}
        alt="Shami Business Ventures Pvt. Ltd."
        width={512}
        height={512}
        className="h-11 w-auto rounded-lg bg-white object-contain p-1 shadow-sm sm:h-12"
      />
    </Link>
  );
}

export function LogoMark({ className }: { className?: string }) {
  return (
    <img
      src={shamiLogo}
      alt="Shami Business Ventures"
      width={512}
      height={512}
      className={cn("h-10 w-auto rounded-lg bg-white object-contain p-1 shadow-sm", className)}
    />
  );
}

