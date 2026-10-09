import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, CheckCircle2, ChevronRight, Layers, Package, Search, Tag, X } from "lucide-react";
import { useApp } from "@/lib/store";
import { inr } from "@/lib/data";
import { cn } from "@/lib/utils";
import { getSearchAutosuggestions, type SearchSuggestionItem } from "@/lib/search";

interface SearchAutosuggestProps {
  value?: string;
  defaultValue?: string;
  onChange?: (val: string) => void;
  onSearch?: (val: string) => void;
  placeholder?: string;
  variant?: "home" | "header" | "shop";
  className?: string;
  id?: string;
}

export function SearchAutosuggest({
  value: controlledValue,
  defaultValue = "",
  onChange,
  onSearch,
  placeholder = "Search category, product, code or brand…",
  variant = "home",
  className,
  id = "site-search",
}: SearchAutosuggestProps) {
  const { products, categories } = useApp();
  const navigate = useNavigate();
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const query = controlledValue !== undefined ? controlledValue : internalValue;

  const suggestions = query.trim().length >= 1
    ? getSearchAutosuggestions(products, categories, query, 7)
    : [];

  useEffect(() => {
    if (controlledValue !== undefined) {
      setInternalValue(controlledValue);
    }
  }, [controlledValue]);

  // Click outside listener
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value;
    if (controlledValue === undefined) setInternalValue(next);
    onChange?.(next);
    setIsOpen(true);
    setActiveIndex(-1);
  };

  const handleClear = () => {
    if (controlledValue === undefined) setInternalValue("");
    onChange?.("");
    setIsOpen(false);
    setActiveIndex(-1);
    inputRef.current?.focus();
  };

  const handlePerformSearch = (searchQuery: string) => {
    const clean = searchQuery.trim();
    setIsOpen(false);
    if (onSearch) {
      onSearch(clean);
    } else {
      if (clean) {
        navigate({ to: "/shop", search: { q: clean } });
      } else {
        navigate({ to: "/shop" });
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!isOpen || suggestions.length === 0) {
      if (e.key === "Enter") {
        e.preventDefault();
        handlePerformSearch(query);
      }
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((prev) => (prev < suggestions.length - 1 ? prev + 1 : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((prev) => (prev > 0 ? prev - 1 : suggestions.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIndex >= 0 && activeIndex < suggestions.length) {
        const item = suggestions[activeIndex];
        if (!item) return;
        if (item.kind === "product" || item.kind === "direct_sku") {
          setIsOpen(false);
          navigate({ to: "/product/$id", params: { id: item.product.id } });
        } else if (item.kind === "category") {
          setIsOpen(false);
          navigate({ to: "/categories/$slug", params: { slug: item.category.name.toLowerCase() } });
        } else if (item.kind === "subcategory") {
          setIsOpen(false);
          navigate({ to: "/shop", search: { q: item.subcategory } });
        }
      } else {
        handlePerformSearch(query);
      }
    } else if (e.key === "Escape") {
      setIsOpen(false);
    }
  };

  return (
    <div ref={wrapperRef} className={cn("relative w-full", className)}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handlePerformSearch(query);
        }}
        className={cn(
          "relative flex items-center transition-all",
          variant === "home" && "gap-2",
          variant === "header" && "w-full",
          variant === "shop" && "w-full",
        )}
      >
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-slate transition-colors" />
          <input
            ref={inputRef}
            id={id}
            type="text"
            inputMode="search"
            value={query}
            onChange={handleInputChange}
            onFocus={() => {
              if (query.trim().length >= 1) setIsOpen(true);
            }}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck="false"
            aria-autocomplete="list"
            aria-expanded={isOpen && suggestions.length > 0}
            className={cn(
              "w-full text-sm outline-none transition-all placeholder:text-slate/70",
              variant === "home" &&
                "h-11 rounded-full border border-border/80 bg-card pl-10 pr-10 text-charcoal shadow-sm hover:border-gold/60 focus:border-gold focus:ring-2 focus:ring-gold/20 sm:h-12",
              variant === "header" &&
                "h-9 rounded-full border border-white/20 bg-card pl-9 pr-9 text-charcoal shadow-inner focus:border-gold focus:ring-2 focus:ring-gold/30",
              variant === "shop" &&
                "h-11 rounded-lg border border-border bg-card pl-10 pr-9 text-navy shadow-xs focus:border-gold focus:ring-2 focus:ring-gold/20",
            )}
          />
          {query.trim().length > 0 && (
            <button
              type="button"
              onClick={handleClear}
              className="absolute top-1/2 right-3 -translate-y-1/2 p-1 text-slate hover:text-navy transition-colors"
              aria-label="Clear search"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {variant === "home" && (
          <button
            type="submit"
            className="flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-full bg-navy px-5 font-bold text-white shadow-sm transition-all hover:bg-midnight hover:shadow-md sm:h-12 sm:px-6"
          >
            <Search className="h-4 w-4" />
            <span className="hidden sm:inline">Search</span>
          </button>
        )}
      </form>

      {/* Floating Real-Time Autosuggestions Dropdown */}
      {isOpen && suggestions.length > 0 && (
        <div
          role="listbox"
          className="absolute top-full left-0 z-50 mt-1.5 w-full overflow-hidden rounded-xl border border-border bg-card shadow-elevated animate-in fade-in-50 zoom-in-95 duration-150"
        >
          {/* Header query quick action */}
          <div className="border-b border-border/60 bg-ivory/80 px-3.5 py-2 text-xs font-semibold text-slate flex items-center justify-between">
            <span className="flex items-center gap-1.5 truncate">
              <Search className="h-3 w-3 text-gold" />
              Suggestions for <span className="text-navy font-bold">"{query}"</span>
            </span>
            <span className="text-[11px] text-slate/80 font-normal">
              {suggestions.length} match{suggestions.length === 1 ? "" : "es"}
            </span>
          </div>

          <div className="max-h-[380px] overflow-y-auto py-1 divide-y divide-border/40">
            {suggestions.map((item, idx) => {
              const isSelected = activeIndex === idx;

              if (item.kind === "direct_sku") {
                const { product } = item;
                const availableStock = Math.max(0, product.stock - (product.reserved || 0));
                return (
                  <Link
                    key={`sku-${product.id}`}
                    to="/product/$id"
                    params={{ id: product.id }}
                    onClick={() => setIsOpen(false)}
                    className={cn(
                      "flex items-center gap-3 px-3.5 py-2.5 transition-colors bg-gold/10 hover:bg-gold/20",
                      isSelected && "bg-gold/25 ring-1 ring-gold",
                    )}
                  >
                    <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-md border border-gold/40 bg-white">
                      <img
                        src={product.image || `/products/${product.category.toLowerCase()}.jpg`}
                        alt={product.name}
                        className="h-full w-full object-cover"
                        loading="lazy"
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="inline-flex items-center gap-1 rounded bg-navy px-1.5 py-0.5 text-[10px] font-bold text-gold uppercase tracking-wider">
                          <CheckCircle2 className="h-3 w-3 text-amber-400" /> Exact Code / SKU Match
                        </span>
                        <span className="rounded bg-ivory px-1.5 py-0.5 text-[11px] font-mono font-bold text-navy">
                          {product.sku}
                        </span>
                      </div>
                      <p className="mt-1 truncate text-sm font-bold text-navy">{product.name}</p>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-slate">
                        <span>{product.category}</span>
                        <span>•</span>
                        <span className="font-semibold text-navy">{inr(product.price)}</span>
                        {product.mrp > product.price && (
                          <span className="line-through text-slate/70 text-[11px]">{inr(product.mrp)}</span>
                        )}
                        <span>•</span>
                        <span className={cn("text-[11px]", availableStock > 0 ? "text-emerald-700 font-semibold" : "text-danger")}>
                          {availableStock > 0 ? `In Stock (${availableStock})` : "Out of Stock"}
                        </span>
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 shrink-0 text-gold" />
                  </Link>
                );
              }

              if (item.kind === "product") {
                const { product } = item;
                const availableStock = Math.max(0, product.stock - (product.reserved || 0));
                return (
                  <Link
                    key={`prod-${product.id}`}
                    to="/product/$id"
                    params={{ id: product.id }}
                    onClick={() => setIsOpen(false)}
                    className={cn(
                      "flex items-center gap-3 px-3.5 py-2.5 transition-colors hover:bg-ivory",
                      isSelected && "bg-ivory ring-1 ring-gold/40",
                    )}
                  >
                    <div className="relative h-11 w-11 shrink-0 overflow-hidden rounded-md border border-border bg-white">
                      <img
                        src={product.image || `/products/${product.category.toLowerCase()}.jpg`}
                        alt={product.name}
                        className="h-full w-full object-cover"
                        loading="lazy"
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-sm font-semibold text-navy">{product.name}</p>
                        <span className="shrink-0 text-sm font-bold text-navy">{inr(product.price)}</span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-slate">
                        <span className="font-mono text-[11px] font-semibold text-navy/80 bg-slate/10 px-1 rounded">
                          SKU: {product.sku}
                        </span>
                        <span>•</span>
                        <span className="truncate">{product.category}</span>
                        {product.vendor && (
                          <>
                            <span>•</span>
                            <span className="truncate">{product.vendor}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 shrink-0 text-slate/50" />
                  </Link>
                );
              }

              if (item.kind === "category") {
                const { category } = item;
                return (
                  <Link
                    key={`cat-${category.id}`}
                    to="/categories/$slug"
                    params={{ slug: category.name.toLowerCase() }}
                    onClick={() => setIsOpen(false)}
                    className={cn(
                      "flex items-center justify-between px-3.5 py-2 text-sm text-charcoal transition-colors hover:bg-ivory",
                      isSelected && "bg-ivory ring-1 ring-gold/40",
                    )}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gold/15 text-navy">
                        <Layers className="h-3.5 w-3.5 text-gold" />
                      </span>
                      <span className="truncate font-medium text-navy">
                        Browse Category: <strong className="font-bold">{category.name}</strong>
                      </span>
                    </div>
                    <span className="shrink-0 text-xs font-semibold text-gold">View Category →</span>
                  </Link>
                );
              }

              if (item.kind === "subcategory") {
                return (
                  <Link
                    key={`sub-${item.subcategory}`}
                    to="/shop"
                    search={{ q: item.subcategory }}
                    onClick={() => setIsOpen(false)}
                    className={cn(
                      "flex items-center justify-between px-3.5 py-2 text-sm text-charcoal transition-colors hover:bg-ivory",
                      isSelected && "bg-ivory ring-1 ring-gold/40",
                    )}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-navy/10 text-navy">
                        <Tag className="h-3.5 w-3.5 text-navy" />
                      </span>
                      <span className="truncate font-medium text-navy">
                        {item.category.name} → <strong className="font-bold">{item.subcategory}</strong>
                      </span>
                    </div>
                    <span className="shrink-0 text-xs text-slate">Filter →</span>
                  </Link>
                );
              }

              return null;
            })}
          </div>

          {/* Search all products footer */}
          <button
            type="button"
            onClick={() => handlePerformSearch(query)}
            className="flex w-full items-center justify-between border-t border-border bg-ivory/90 px-3.5 py-2.5 text-left text-xs font-semibold text-navy transition-colors hover:bg-gold/15"
          >
            <span className="flex items-center gap-2 truncate">
              <Package className="h-3.5 w-3.5 text-gold" />
              View all results for <strong className="text-gold truncate">"{query}"</strong> in Shop
            </span>
            <span className="flex items-center gap-1 shrink-0 text-gold font-bold">
              Press Enter <ArrowRight className="h-3.5 w-3.5" />
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
