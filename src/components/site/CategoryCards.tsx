import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { isStorefrontProduct, type StoreCategory } from "@/lib/data";
import { categorySlug, getCategoryNode } from "@/lib/category-tree";
import { useApp } from "@/lib/store";

/** Enabled storefront categories in admin-defined display order. */
export function useVisibleCategories(): StoreCategory[] {
  const { categories } = useApp();
  return [...categories].filter((c) => c.enabled).sort((a, b) => a.order - b.order);
}

export function CategoryCards({ limit }: { limit?: number }) {
  const cats = useVisibleCategories();
  const { products } = useApp();
  const list = limit ? cats.slice(0, limit) : cats;

  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-3">
      {list.map((c, i) => {
        const count = products.filter((p) => p.category === c.name && isStorefrontProduct(p)).length;
        const slug = categorySlug(c.name === "Cooking Oil" ? "Oil" : c.name);
        const node = getCategoryNode(slug);
        return node ? (
          <Link
            key={c.id}
            to="/categories/$slug"
            params={{ slug }}
            style={{ animationDelay: `${i * 70}ms` }}
            className="card-premium animate-rise group relative flex flex-col overflow-hidden active:scale-[0.98] active:transition-transform"
          >
            <CardBody c={c} count={count} />
          </Link>
        ) : (
          <Link
            key={c.id}
            to="/shop"
            search={{ category: c.name }}
            style={{ animationDelay: `${i * 70}ms` }}
            className="card-premium animate-rise group relative flex flex-col overflow-hidden active:scale-[0.98] active:transition-transform"
          >
            <div className="relative overflow-hidden bg-ivory">
              <img
                src={c.image}
                alt={`${c.name} category`}
                loading="lazy"
                width={800}
                height={800}
                className="aspect-[4/3] w-full object-cover transition-transform duration-500 group-hover:scale-105 sm:aspect-square"
              />
              <span className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-midnight/70 to-transparent" />
              <span className="absolute bottom-2 left-3 rounded-full bg-gold px-2.5 py-1 text-[10px] font-bold text-midnight sm:bottom-3 sm:left-4 sm:text-[11px]">
                {count} products
              </span>
            </div>
            <div className="flex min-w-0 flex-1 flex-col p-3 sm:p-5">
              <h3 className="truncate text-base font-bold text-navy transition-colors group-hover:text-gold sm:text-xl">
                {c.name}
              </h3>
              <p className="mt-1 line-clamp-2 text-[11px] text-slate sm:text-xs">{c.tagline}</p>
              <ul className="mt-2 hidden flex-wrap gap-1.5 sm:mt-3 sm:flex">
                {c.grades.map((g) => (
                  <li
                    key={g}
                    className="rounded-full border border-border bg-ivory px-2.5 py-1 text-[11px] font-medium text-navy"
                  >
                    {g}
                  </li>
                ))}
              </ul>
              <span className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-gold sm:mt-4 sm:text-sm">
                Shop {c.name} <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
              </span>
            </div>
          </Link>
        );
      })}
    </div>
  );
}

function CardBody({ c, count }: { c: StoreCategory; count: number }) {
  return (
    <>
      <div className="relative overflow-hidden bg-ivory">
        <img
          src={c.image}
          alt={`${c.name} category`}
          loading="lazy"
          width={800}
          height={800}
          className="aspect-[4/3] w-full object-cover transition-transform duration-500 group-hover:scale-105 sm:aspect-square"
        />
        <span className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-midnight/70 to-transparent" />
        <span className="absolute bottom-2 left-3 rounded-full bg-gold px-2.5 py-1 text-[10px] font-bold text-midnight sm:bottom-3 sm:left-4 sm:text-[11px]">
          {count} products
        </span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col p-3 sm:p-5">
        <h3 className="truncate text-base font-bold text-navy transition-colors group-hover:text-gold sm:text-xl">
          {c.name}
        </h3>
        <p className="mt-1 line-clamp-2 text-[11px] text-slate sm:text-xs">{c.tagline}</p>
        <ul className="mt-2 hidden flex-wrap gap-1.5 sm:mt-3 sm:flex">
          {c.grades.map((g) => (
            <li
              key={g}
              className="rounded-full border border-border bg-ivory px-2.5 py-1 text-[11px] font-medium text-navy"
            >
              {g}
            </li>
          ))}
        </ul>
        <span className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-gold sm:mt-4 sm:text-sm">
          Shop {c.name} <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
        </span>
      </div>
    </>
  );
}
