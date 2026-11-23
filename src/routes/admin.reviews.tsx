import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, MessageSquareText, Star, Trash2, XCircle } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { FilterNote, Panel, scrollToSection, StatCard, StatusBadge } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { useApp } from "@/lib/store";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { BulkBar, BulkDeleteDialog, TickBox, useBulkSelection } from "@/components/panel/BulkSelect";

export const Route = createFileRoute("/admin/reviews")({
  head: () => ({
    meta: [
      { title: "Reviews | Shami Business Ventures Admin" },
      { name: "description", content: "Moderate customer reviews across the marketplace." },
      { property: "og:title", content: "Reviews | Shami Admin" },
      { property: "og:description", content: "Review moderation dashboard." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminReviews,
});

const PAGE_SIZE = 8;

function Stars({ n }: { n: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {Array.from({ length: 5 }, (_, i) => (
        <Star key={i} className={`h-3.5 w-3.5 ${i < n ? "fill-gold text-gold" : "text-slate/30"}`} />
      ))}
    </div>
  );
}

function AdminReviews() {
  const { reviews, setReviewStatus, deleteReview } = useApp();
  const [search, setSearch] = useState("");
  const [rating, setRating] = useState("All");
  const [status, setStatus] = useState("All");
  const [page, setPage] = useState(1);
  const openList = (next: string) => {
    setSearch("");
    setRating("All");
    setStatus(next);
    setPage(1);
    scrollToSection("customer-reviews");
  };

  const stats = useMemo(() => {
    const total = reviews.length;
    const avg = total ? (reviews.reduce((s, r) => s + r.rating, 0) / total).toFixed(1) : "0.0";
    const published = reviews.filter((r) => r.status === "Published").length;
    const pending = reviews.filter((r) => r.status === "Pending").length;
    const rejected = reviews.filter((r) => r.status === "Rejected").length;
    return { total, avg, published, pending, rejected };
  }, [reviews]);

  const filtered = useMemo(
    () =>
      reviews.filter((r) => {
        const matchSearch = [r.product, r.customer, r.title].some((v) => v.toLowerCase().includes(search.toLowerCase()));
        const matchRating = rating === "All" || String(r.rating) === rating;
        const matchStatus = status === "All" || r.status === status;
        return matchSearch && matchRating && matchStatus;
      }),
    [reviews, search, rating, status],
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageItems = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  // 13 Nov 2026 (owner): tick several reviews on this page and delete them together (each as its own Delete does).
  const bulk = useBulkSelection(pageItems.map((r) => String(r.id)));
  const [bulkOpen, setBulkOpen] = useState(false);

  return (
    <PanelLayout items={adminNav} tone="admin" title="Reviews" subtitle="Moderate product reviews">
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard onClick={() => openList("All")} label="Total Reviews" value={String(stats.total)} icon={MessageSquareText} />
        <StatCard onClick={() => openList("All")} label="Average Rating" value={stats.avg} icon={Star} highlight />
        <StatCard onClick={() => openList("Published")} label="Published" value={String(stats.published)} icon={CheckCircle2} />
        <StatCard onClick={() => openList("Pending")} label="Pending" value={String(stats.pending)} icon={MessageSquareText} />
        <StatCard onClick={() => openList("Rejected")} label="Rejected" value={String(stats.rejected)} icon={XCircle} />
      </div>

      <Panel
        id="customer-reviews"
        title="Customer Reviews"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Input placeholder="Search product/customer" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} className="h-9 w-56" />
            <Select value={rating} onValueChange={(v) => { setRating(v); setPage(1); }}>
              <SelectTrigger className="h-9 w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="All">All Ratings</SelectItem>
                {[5, 4, 3, 2, 1].map((n) => <SelectItem key={n} value={String(n)}>{n} Star</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
              <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="All">All Status</SelectItem>
                <SelectItem value="Published">Published</SelectItem>
                <SelectItem value="Pending">Pending</SelectItem>
                <SelectItem value="Rejected">Rejected</SelectItem>
              </SelectContent>
            </Select>
          </div>
        }
      >
        {status !== "All" && <FilterNote label={status} onClear={() => { setStatus("All"); setPage(1); }} />}
        <BulkBar state={bulk.state} count={bulk.count} selectable={pageItems.length} onToggleAll={bulk.toggleAll} onClear={bulk.clear} onDelete={() => setBulkOpen(true)} hint="Tick reviews on this page to delete several together" />
        <div className="grid gap-4">
          {pageItems.length === 0 && <p className="py-10 text-center text-sm text-slate">No reviews match your filters.</p>}
          {pageItems.map((r) => (
            <div key={r.id} className="rounded-lg border border-border p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2">
                  <TickBox checked={bulk.isSelected(String(r.id))} onChange={(on) => bulk.toggle(String(r.id), on)} label={`Select the review by ${r.customer}`} className="-ml-1.5 -mt-0.5" />
                  <Avatar className="h-9 w-9"><AvatarFallback className="bg-navy/10 text-xs font-bold text-navy">{r.avatar}</AvatarFallback></Avatar>
                  <div>
                    <p className="font-semibold text-navy">{r.customer}</p>
                    <p className="text-xs text-slate">{r.product} · {r.date}</p>
                    <div className="mt-1"><Stars n={r.rating} /></div>
                  </div>
                </div>
                <StatusBadge status={r.status} />
              </div>
              <p className="mt-2 text-sm font-semibold text-charcoal">{r.title}</p>
              <p className="text-sm text-slate">{r.body}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {r.status !== "Published" && (
                  <Button size="sm" variant="outline" onClick={() => { void setReviewStatus(r.id, "Published").then((ok) => { if (ok) toast.success(`Review by ${r.customer} approved`); }); }}>Approve</Button>
                )}
                {r.status !== "Rejected" && (
                  <Button size="sm" variant="outline" className="text-danger" onClick={() => { void setReviewStatus(r.id, "Rejected").then((ok) => { if (ok) toast.success(`Review by ${r.customer} rejected`); }); }}>Reject</Button>
                )}
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button size="sm" variant="outline"><Trash2 className="mr-1 h-3.5 w-3.5" /> Delete</Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete this review?</AlertDialogTitle>
                      <AlertDialogDescription>This will permanently remove the review by {r.customer}.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => { void deleteReview(r.id).then((ok) => { if (ok) toast.success("Review deleted"); }); }}>Delete</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4 flex items-center justify-between text-xs text-slate">
          <span>Page {page} of {totalPages} · {filtered.length} reviews</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      </Panel>
      {bulkOpen && (
        <BulkDeleteDialog
          title={(n) => (n === 1 ? "Delete 1 review?" : `Delete ${n} reviews?`)}
          description="They are removed for good from the shop and from each product's rating. To keep one but hide it, use Reject instead."
          items={pageItems.filter((r) => bulk.isSelected(String(r.id))).map((r) => ({ id: String(r.id), label: `${r.customer} · ${r.product} · ${r.title}` }))}
          run={async (id) => { if (!(await deleteReview(id))) throw new Error("Could not delete it"); }}
          onClose={() => setBulkOpen(false)}
          onFinished={(done) => { if (done.length) bulk.clear(); }}
        />
      )}
    </PanelLayout>
  );
}
