import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import type { Tile } from "@/lib/category-tree";

/** Category / variety / brand cards — same card treatment as the storefront category cards. */
export function TileGrid({ tiles, basePath }: { tiles: Tile[]; basePath: string }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-4">
      {tiles.map((t, i) => {
        const inner = (
          <>
            <div className="relative overflow-hidden bg-ivory">
              <img
                src={t.image}
                alt={t.label}
                loading="lazy"
                width={800}
                height={800}
                className="aspect-[4/3] w-full object-cover transition-transform duration-500 group-hover:scale-105 sm:aspect-square"
              />
              <span className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-midnight/70 to-transparent" />
            </div>
            <div className="flex min-w-0 flex-1 flex-col p-3 sm:p-5">
              <h3 className="truncate text-base font-bold text-navy transition-colors group-hover:text-gold sm:text-lg">
                {t.label}
              </h3>
              {t.caption && <p className="mt-1 line-clamp-2 text-[11px] text-slate sm:text-xs">{t.caption}</p>}
              <span className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-gold sm:mt-4 sm:text-sm">
                View <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
              </span>
            </div>
          </>
        );

        const cls =
          "card-premium animate-rise group relative flex flex-col overflow-hidden active:scale-[0.98] active:transition-transform";

        return t.slug ? (
          <Link
            key={t.label}
            to="/categories/$slug/$child"
            params={{ slug: basePath, child: t.slug }}
            style={{ animationDelay: `${i * 60}ms` }}
            className={cls}
          >
            {inner}
          </Link>
        ) : (
          <Link
            key={t.label}
            to="/shop"
            search={{ category: t.filter ?? t.label }}
            style={{ animationDelay: `${i * 60}ms` }}
            className={cls}
          >
            {inner}
          </Link>
        );
      })}
    </div>
  );
}
