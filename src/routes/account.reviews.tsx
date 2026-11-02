import { createFileRoute, Link } from "@tanstack/react-router";
import { Star } from "lucide-react";
import { toast } from "sonner";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { FilterNote, Panel, scrollToSection, StatCard, StatusBadge } from "@/components/panel/widgets";
import { accountNav } from "@/lib/account-nav";
import { useApp } from "@/lib/store";
import { supabase } from "@/integrations/supabase/client";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/account/reviews")({
  head: () => ({
    meta: [
      { title: "Reviews & Ratings | Shami Business Ventures" },
      { name: "description", content: "See the product reviews and ratings you have submitted on Shami." },
      { property: "og:title", content: "My Reviews | Shami" },
      { property: "og:description", content: "Your submitted product reviews and ratings." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AccountReviews,
});

function AccountReviews() {
  const { user, reviews } = useApp();
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const mine = user
    ? reviews.filter((r) => !deletedIds.includes(r.id) && (r.customerId === user.id || (!user.id && (r.customerId === user.email || r.customerId === user.phone))))
    : [];
  const avg = mine.length ? Math.round((mine.reduce((s, r) => s + r.rating, 0) / mine.length) * 10) / 10 : 0;
  const [fiveStarOnly, setFiveStarOnly] = useState(false);
  const shown = fiveStarOnly ? mine.filter((r) => r.rating === 5) : mine;
  const openList = (five: boolean) => {
    setFiveStarOnly(five);
    scrollToSection("my-reviews");
  };

  return (
    <PanelLayout items={accountNav} tone="customer" title="Reviews & Ratings" subtitle="Feedback you have shared">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard onClick={() => openList(false)} label="Reviews Written" value={String(mine.length)} icon={Star} highlight />
        <StatCard onClick={() => openList(false)} label="Average Rating Given" value={mine.length ? `${avg} / 5` : "—"} icon={Star} />
        <StatCard onClick={() => openList(true)} label="5-Star Reviews" value={String(mine.filter((r) => r.rating === 5).length)} icon={Star} />
      </div>

      <Panel id="my-reviews" title="My Reviews" className="mt-6">
        {fiveStarOnly && <FilterNote label="5-Star Reviews" onClear={() => setFiveStarOnly(false)} />}
        {shown.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate">{mine.length === 0 ? "You haven’t written any reviews yet." : "No reviews match your filters."}</p>
        ) : (
          <div className="space-y-3">
            {shown.map((r) => (
              <div key={r.id} className="rounded-lg border border-border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link
                    to="/product/$id"
                    params={{ id: r.productId }}
                    className="font-semibold text-navy hover:text-gold"
                  >
                    {r.product}
                  </Link>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-bold text-gold">{r.rating} ★</span>
                    <StatusBadge status={r.status} />
                  </div>
                </div>
                <p className="mt-2 text-sm font-medium text-charcoal">{r.title}</p>
                <p className="mt-1 text-sm text-slate">{r.body}</p>
                {r.status === "Pending" && <div className="mt-3 flex gap-2"><Button variant="outline" size="sm" onClick={async () => {
                  const { data, error } = await supabase.rpc("customer_delete_own_review", { _id: r.id });
                  if (error || !data) { toast.error("Could not delete this review", { description: error?.message ?? "Review is no longer pending." }); return; }
                  setDeletedIds((ids) => [...ids, r.id]); toast.success("Pending review deleted");
                }}>Delete pending review</Button></div>}
              </div>
            ))}
          </div>
        )}
      </Panel>
    </PanelLayout>
  );
}
