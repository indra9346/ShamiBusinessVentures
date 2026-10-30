import { useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  Bean,
  Candy,
  Droplets,
  Flame,
  LayoutGrid,
  ShoppingBasket,
  Wheat,
  type LucideIcon,
} from "lucide-react";
import { useVisibleCategories } from "@/components/site/CategoryCards";
import { categorySlug } from "@/lib/category-tree";
import type { StoreCategory } from "@/lib/data";
import { cn } from "@/lib/utils";
import { CategoryImage } from "@/components/site/CategoryImage";

/** URL slug used by /categories/$slug for a store category ("Cooking Oil" lives at /categories/oil). */
function storeCategoryRouteSlug(name: string) {
  return categorySlug(name === "Cooking Oil" ? "Oil" : name);
}

function iconFor(name: string): LucideIcon {
  const n = name.toLowerCase();
  if (n.includes("oil")) return Droplets;
  if (n.includes("sugar") || n.includes("jaggery")) return Candy;
  if (n.includes("pulse") || n.includes("dal") || n.includes("bean")) return Bean;
  if (n.includes("spice") || n.includes("masala") || n.includes("chilli")) return Flame;
  if (
    n.includes("rice") ||
    n.includes("grain") ||
    n.includes("wheat") ||
    n.includes("atta") ||
    n.includes("millet")
  )
    return Wheat;
  return ShoppingBasket;
}

type Props = {
  /**
   * "category" → each badge opens /categories/$slug (default).
   * "shop"     → each badge filters the shop listing via /shop?category=…
   */
  target?: "category" | "shop";
  /** Route slug (category mode) or category name (shop mode) of the active badge. */
  active?: string | undefined;
  /** Show a leading "All" badge (links to /shop or /categories). */
  showAll?: boolean;
  className?: string | undefined;
};

/**
 * Flipkart-style compact horizontal category strip: circular thumbnail + crisp label,
 * smooth horizontal scroll on mobile, centred on wide screens.
 */
export function FlipkartCategoryBar({
  target = "category",
  active,
  showAll = true,
  className,
}: Props) {
  const categories = useVisibleCategories();
  if (categories.length === 0) return null;

  const activeKey = active?.trim().toLowerCase();
  const isActive = (c: StoreCategory) =>
    !!activeKey &&
    (activeKey === c.name.toLowerCase() ||
      activeKey === storeCategoryRouteSlug(c.name) ||
      activeKey === categorySlug(c.name));

  return (
    <nav
      aria-label="Shop by category"
      className={cn(
        "border-b border-stone-200 bg-card shadow-[0_1px_2px_rgba(60,45,20,0.08)]",
        className,
      )}
    >
      <div className="mx-auto max-w-7xl overflow-x-auto scrollbar-none overscroll-x-contain">
        <ul className="mx-auto flex w-max min-w-full justify-start gap-4 px-4 py-3 sm:justify-center sm:gap-6 sm:px-6">
          {showAll && (
            <li className="shrink-0">
              {target === "shop" ? (
                <Link
                  to="/shop"
                  search={{}}
                  className="block"
                  aria-current={!activeKey ? "page" : undefined}
                >
                  <BadgeBody label="All" Icon={LayoutGrid} active={!activeKey} />
                </Link>
              ) : (
                <Link
                  to="/categories"
                  className="block"
                  aria-current={!activeKey ? "page" : undefined}
                >
                  <BadgeBody label="All" Icon={LayoutGrid} active={!activeKey} />
                </Link>
              )}
            </li>
          )}
          {categories.map((c) => {
            const on = isActive(c);
            const body = (
              <BadgeBody label={c.name} image={c.image} fit={c.imageFit} Icon={iconFor(c.name)} active={on} />
            );
            return (
              <li key={c.id} className="shrink-0">
                {target === "shop" ? (
                  <Link
                    to="/shop"
                    search={{ category: c.name }}
                    className="block"
                    aria-current={on ? "page" : undefined}
                  >
                    {body}
                  </Link>
                ) : (
                  <Link
                    to="/categories/$slug"
                    params={{ slug: storeCategoryRouteSlug(c.name) }}
                    className="block"
                    aria-current={on ? "page" : undefined}
                  >
                    {body}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}

function BadgeBody({
  label,
  image,
  fit,
  Icon,
  active,
}: {
  label: string;
  image?: string;
  fit?: StoreCategory["imageFit"];
  Icon: LucideIcon;
  active: boolean;
}) {
  const [broken, setBroken] = useState(false);
  const showImage = !!image && !broken;

  return (
    <span className="group flex w-[4.5rem] flex-col items-center gap-1.5 transition-all duration-200 hover:-translate-y-1 sm:w-24">
      {/* Square tile with a brand-colour frame; the photo fills the whole tile. */}
      <span
        className={cn(
          "rounded-lg p-[2px] shadow-xs transition-all duration-200",
          active
            ? "bg-gradient-to-br from-gold to-amber-500 shadow-[0_2px_8px_rgba(212,175,55,0.35)]"
            : "bg-gradient-to-br from-gold to-gold/60 group-hover:to-amber-500 group-hover:shadow-md",
        )}
      >
      <span
        className={cn(
          "relative grid h-16 w-16 place-items-center overflow-hidden rounded-md sm:h-20 sm:w-20",
          active ? "bg-amber-50" : "bg-card",
        )}
      >
        {showImage ? (
          <CategoryImage
            src={image}
            fit={fit}
            width={80}
            height={80}
            onError={() => setBroken(true)}
            className=""
          />
        ) : (
          <Icon
            className={cn("h-6 w-6 sm:h-7 sm:w-7", active ? "text-gold" : "text-navy")}
            aria-hidden
          />
        )}
      </span>
      </span>
      <span
        className={cn(
          "w-full truncate text-center text-xs font-semibold",
          active ? "text-navy" : "text-stone-800 group-hover:text-navy",
        )}
      >
        {label}
      </span>
      <span
        aria-hidden
        className={cn(
          "h-0.5 rounded-full bg-gold transition-all duration-200",
          active ? "w-6" : "w-0",
        )}
      />
    </span>
  );
}
