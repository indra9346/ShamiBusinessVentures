import { Button } from "@/components/ui/button";

export function Pager({
  page,
  pages,
  onPage,
  total,
}: {
  page: number;
  pages: number;
  onPage: (p: number) => void;
  total: number;
}) {
  if (pages <= 1) return null;
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
      <p className="text-xs text-slate">
        Page {page} of {pages} · {total} records
      </p>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}
