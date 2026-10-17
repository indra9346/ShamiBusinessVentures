import { Warehouse } from "lucide-react";
import { useAdminBranch, useBranches } from "@/lib/branches";
import { cn } from "@/lib/utils";

/**
 * The godown an administrator is working in. "All branches" shows everything; choosing one
 * branch limits orders, stock, dashboard and reports to it, and stock changes go to it.
 */
export function AdminBranchSelect({ className }: { className?: string }) {
  const { branches, ready } = useBranches();
  const [branchId, setBranchId] = useAdminBranch();
  const known = branchId === "all" || branches.some((branch) => branch.id === branchId);
  if (!ready || branches.length === 0) return null;
  return (
    <label className={cn("flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-sm", className)}>
      <Warehouse className="h-4 w-4 shrink-0 text-gold" aria-hidden="true" />
      <span className="sr-only">Branch</span>
      <select
        aria-label="Branch you are working in"
        value={known ? branchId : "all"}
        onChange={(event) => setBranchId(event.target.value)}
        className="max-w-[9.5rem] bg-transparent font-semibold text-navy outline-none sm:max-w-[14rem]"
      >
        <option value="all">All branches</option>
        {branches.map((branch) => (
          <option key={branch.id} value={branch.id}>
            {branch.vendorId ? `Vendor point · ${branch.vendorId}` : branch.name}{branch.active ? "" : " (inactive)"}
          </option>
        ))}
      </select>
    </label>
  );
}
