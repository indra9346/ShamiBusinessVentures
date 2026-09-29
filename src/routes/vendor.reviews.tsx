import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Flag, MessageSquare, Star } from "lucide-react";
import { toast } from "sonner";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel, StatCard, StatusBadge } from "@/components/panel/widgets";
import { vendorNav } from "@/lib/panel-nav";
import { useVendorScope } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

export const Route = createFileRoute("/vendor/reviews")({
  head: () => ({
    meta: [
      { title: "Reviews | Shami Vendor Panel" },
      { name: "description", content: "Customer reviews and ratings for your products." },
      { property: "og:title", content: "Vendor Reviews | Shami" },
      { property: "og:description", content: "Manage and respond to customer reviews." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: VendorReviews,
});

function VendorReviews() {
  const { vendorReviews } = useVendorScope();
  const [rating, setRating] = useState("all");
  const [replying, setReplying] = useState<(typeof vendorReviews)[number] | null>(null);
  const [reply, setReply] = useState("");
  const [replies, setReplies] = useState<Record<string, string>>({});

  const filtered = useMemo(
    () => vendorReviews.filter((r) => rating === "all" || String(r.rating) === rating),
    [vendorReviews, rating],
  );

  const avg = vendorReviews.length ? vendorReviews.reduce((s, r) => s + r.rating, 0) / vendorReviews.length : 0;
  const distribution = [5, 4, 3, 2, 1].map((star) => ({
    star,
    count: vendorReviews.filter((r) => r.rating === star).length,
  }));

  return (
    <PanelLayout items={vendorNav} tone="vendor" title="Reviews" subtitle="Customer feedback on Shami Sugar Mills products">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total Reviews" value={String(vendorReviews.length)} icon={MessageSquare} highlight />
        <StatCard label="Average Rating" value={vendorReviews.length ? `${Math.round(avg * 10) / 10} / 5` : "—"} icon={Star} />
        <StatCard label="5-Star Reviews" value={String(distribution[0]!.count)} icon={Star} />
        <StatCard label="Low Ratings (≤2★)" value={String(distribution[3]!.count + distribution[4]!.count)} icon={Flag} />
      </div>

      <Panel title="Rating Distribution" className="mt-6">
        <div className="space-y-2">
          {distribution.map((d) => (
            <div key={d.star} className="flex items-center gap-3">
              <span className="w-12 text-xs font-semibold text-navy">{d.star} ★</span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-navy/8">
                <div
                  className="h-full rounded-full bg-gold"
                  style={{ width: `${vendorReviews.length ? (d.count / vendorReviews.length) * 100 : 0}%` }}
                />
              </div>
              <span className="w-8 text-right text-xs text-slate">{d.count}</span>
            </div>
          ))}
        </div>
      </Panel>

      <Panel
        title="All Reviews"
        className="mt-6"
        action={
          <Select value={rating} onValueChange={setRating}>
            <SelectTrigger className="h-9 w-36"><SelectValue placeholder="Rating" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Ratings</SelectItem>
              {[5, 4, 3, 2, 1].map((r) => (
                <SelectItem key={r} value={String(r)}>{r} Star</SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      >
        <DataTable
          columns={["Product", "Customer", "Rating", "Review", "Reply", "Status", "Actions"]}
          rows={filtered.map((r) => [
            <span className="font-semibold text-navy">{r.product}</span>,
            r.customer,
            `${r.rating} ★`,
            <div className="max-w-xs">
              <p className="font-medium text-navy">{r.title}</p>
              <p className="truncate text-xs text-slate">{r.body}</p>
            </div>,
            replies[r.id] ? <p className="max-w-xs truncate text-xs text-slate">{replies[r.id]}</p> : <span className="text-xs text-slate">No reply yet</span>,
            <StatusBadge status={r.status} />,
            <div className="flex gap-1.5">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setReplying(r);
                  setReply(replies[r.id] ?? "");
                }}
              >
                Reply
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => toast.success(`Review ${r.id} reported to admin for moderation`)}
              >
                Report
              </Button>
            </div>,
          ])}
        />
      </Panel>

      <Dialog open={!!replying} onOpenChange={(v) => !v && setReplying(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reply to {replying?.customer}</DialogTitle>
          </DialogHeader>
          <Textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={4} placeholder="Write your response..." />
          <DialogFooter>
            <Button variant="outline" onClick={() => setReplying(null)}>Cancel</Button>
            <Button
              className="bg-navy text-white hover:bg-navy/90"
              onClick={() => {
                if (!replying) return;
                if (!reply.trim()) {
                  toast.error("Reply cannot be empty");
                  return;
                }
                setReplies((r) => ({ ...r, [replying.id]: reply.trim() }));
                toast.success(`Reply posted for ${replying.customer}'s review`);
                setReplying(null);
              }}
            >
              Post Reply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PanelLayout>
  );
}
