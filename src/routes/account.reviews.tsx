import { createFileRoute, Link } from "@tanstack/react-router";
import { Star } from "lucide-react";
import { toast } from "sonner";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel, StatCard, StatusBadge } from "@/components/panel/widgets";
import { accountNav } from "@/lib/account-nav";
import { useApp } from "@/lib/store";
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
  const mine = (user ? reviews.filter((r) => r.customer === user.name) : []).length
    ? reviews.filter((r) => r.customer === user!.name)
    : reviews.slice(0, 6);
  const avg = mine.length ? Math.round((mine.reduce((s, r) => s + r.rating, 0) / mine.length) * 10) / 10 : 0;

  return (
    <PanelLayout items={accountNav} tone="customer" title="Reviews & Ratings" subtitle="Feedback you have shared">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Reviews Written" value={String(mine.length)} icon={Star} highlight />
        <StatCard label="Average Rating Given" value={mine.length ? `${avg} / 5` : "—"} icon={Star} />
        <StatCard label="5-Star Reviews" value={String(mine.filter((r) => r.rating === 5).length)} icon={Star} />
      </div>

      <Panel title="My Reviews" className="mt-6">
        <div className="space-y-3">
          {mine.map((r) => (
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
              <div className="mt-3 flex gap-2">
                <Button variant="outline" size="sm" onClick={() => toast.success("Review editing opens after moderation")}>
                  Edit
                </Button>
                <Button variant="outline" size="sm" onClick={() => toast.success(`Review ${r.id} deletion requested`)}>
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </PanelLayout>
  );
}