import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Download, Trash2 } from "lucide-react";
import { DataTable, Panel } from "@/components/panel/widgets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import {
  CUSTOMER_DELETE_WORD, customerDataFileName, customerDataSheets, deletionBlockerText, keptLines, removedLines,
  type CustomerDataFile, type DeletionPreview,
} from "@/lib/customer-data";
import { deleteCustomerData } from "@/lib/customer-data.functions";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { downloadXlsx } from "@/lib/xlsx";

type RequestRow = Database["public"]["Tables"]["customer_data_requests"]["Row"];

const when = (value: string) =>
  new Date(value).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

const actionLabel = (row: RequestRow) => {
  if (row.kind !== "delete") return "Information downloaded";
  return row.login_removed_at ? "Information deleted" : "Information deleted, login still to remove";
};

/** Who downloaded or deleted a customer's information. It outlives the customer, so the Customers page lists it too. */
export function CustomerDataLog({ customerId, refresh = 0 }: { customerId?: string; refresh?: number }) {
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (STATIC_DATA_MODE) return;
    let active = true;
    let query = supabase.from("customer_data_requests").select("*").order("created_at", { ascending: false }).limit(100);
    if (customerId) query = query.eq("customer_id", customerId);
    void query.then(({ data, error }) => {
      if (!active) return;
      setFailed(Boolean(error));
      setRows(data ?? []);
    });
    return () => { active = false; };
  }, [customerId, refresh]);

  if (failed) return <p className="text-sm text-slate">The record of information requests could not be loaded.</p>;
  if (!rows.length) return <p className="text-sm text-slate">No information requests yet</p>;
  return (
    <DataTable
      columns={customerId ? ["When", "Action", "By"] : ["When", "Action", "Customer", "By"]}
      minWidth={customerId ? 420 : 560}
      rows={rows.map((row) => [
        when(row.created_at),
        // The customer's page is the only place to finish it, and their name is gone from the list.
        !customerId && row.kind === "delete" && !row.login_removed_at
          ? <Link to="/admin/customers/$id" params={{ id: row.customer_id }} className="font-semibold text-navy hover:text-gold">{actionLabel(row)}</Link>
          : actionLabel(row),
        ...(customerId ? [] : [<span data-no-translate>{row.customer_label || "—"}</span>]),
        <span data-no-translate>{row.actor_name || row.actor_email || "—"}</span>,
      ])}
    />
  );
}

function ZohoNote({ contacts }: { contacts?: string[] }) {
  return (
    <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
      <span className="font-semibold">Zoho is not changed.</span>{" "}
      <span>Zoho keeps its own copy of any contact, sales orders and invoices it has for this customer, and the admin panel's Zoho sales order list shows them again when it next refreshes.</span>
      {contacts?.length ? <> <span>Zoho contact:</span> <span data-no-translate>{contacts.join(", ")}</span></> : null}
    </p>
  );
}

function CountedList({ lines }: { lines: { text: string; count: number }[] }) {
  return (
    <ul className="mt-1 space-y-1">
      {lines.map((line) => (
        <li key={line.text} className="flex items-start justify-between gap-3 text-sm text-charcoal">
          <span>{line.text}</span>
          <span className="shrink-0 font-semibold text-navy">{line.count}</span>
        </li>
      ))}
    </ul>
  );
}

function DeleteDialog({ customerId, customerName, open, onOpenChange, onFinished }: {
  customerId: string;
  customerName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFinished: () => void;
}) {
  const [preview, setPreview] = useState<DeletionPreview | null>(null);
  const [loadFailed, setLoadFailed] = useState("");
  const [typed, setTyped] = useState("");
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState("");

  useEffect(() => {
    if (!open) return;
    let active = true;
    setPreview(null);
    setLoadFailed("");
    setTyped("");
    setProblem("");
    void supabase.rpc("admin_customer_deletion_preview", { _customer_id: customerId }).then(({ data, error }) => {
      if (!active) return;
      if (error || !data) { setLoadFailed(error?.message ?? "Nothing came back."); return; }
      const next = data as unknown as DeletionPreview;
      // An earlier try got through the database step and its reply was lost: only the login is left.
      if (next.already_deleted) { onFinished(); onOpenChange(false); return; }
      setPreview(next);
    });
    return () => { active = false; };
    // Runs once each time the dialog opens; the two callbacks change on every render of the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, customerId]);

  const submit = async () => {
    setWorking(true);
    setProblem("");
    try {
      const result = await deleteCustomerData({ data: { customerId, confirmation: CUSTOMER_DELETE_WORD } });
      if (result.loginRemoved) {
        toast.success("The customer's information has been deleted");
        window.location.assign("/admin/customers");
        return;
      }
      setProblem(result.problem ?? "Their login could not be removed.");
      onFinished();
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "The information could not be deleted.");
    }
    // Not on success: the page is already leaving, and the button must not come back.
    setWorking(false);
  };

  const blockers = preview?.blockers ?? [];
  const ready = preview !== null && blockers.length === 0 && !problem;
  const unproved = preview?.plan.unproved_enquiries ?? 0;

  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!working) onOpenChange(next); }}>
      <AlertDialogContent className="max-h-[90vh] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this customer's information?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="text-sm"><span data-no-translate className="font-semibold text-navy">{customerName}</span></div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        {!preview && !loadFailed && <p className="text-sm text-slate">Checking what can be deleted…</p>}
        {loadFailed && <p className="text-sm text-destructive">Could not check this customer: <span data-no-translate>{loadFailed}</span></p>}

        {blockers.length > 0 && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <p className="text-sm font-semibold text-destructive">This cannot be deleted yet</p>
            <ul className="mt-2 space-y-2 text-sm text-charcoal">
              {blockers.map((blocker) => (
                <li key={blocker.code}>
                  <span>{deletionBlockerText(blocker.code)}</span>
                  {blocker.orders.length > 0 && <p data-no-translate className="mt-0.5 break-words text-xs font-semibold text-navy">{blocker.orders.join(", ")}</p>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {ready && preview && (
          <div className="space-y-4">
            <div>
              <p className="text-sm font-semibold text-navy">Removed for good</p>
              <CountedList lines={[{ text: "Login and profile", count: 1 }, ...removedLines(preview.plan)]} />
              {unproved > 0 && <p className="mt-1 text-xs text-slate">{`Other enquiries that use a phone or email from their profile or orders: ${unproved}. We can't tell they are theirs, so they stay. Check them in Admin > Enquiries.`}</p>}
            </div>
            <div>
              <p className="text-sm font-semibold text-navy">Kept</p>
              {keptLines(preview.plan).length ? (
                <>
                  <CountedList lines={keptLines(preview.plan)} />
                  <p className="mt-1 text-xs text-slate">Sales records may have to be kept by law. Phone and email come off them. They stay until the owner sets an end date.</p>
                </>
              ) : <p className="mt-1 text-sm text-charcoal">No sales records to keep.</p>}
            </div>
            <ZohoNote contacts={preview.plan.zoho_contacts} />
            <p className="text-sm font-semibold text-destructive">This cannot be undone. If the customer asked for a copy, download it first.</p>
            <div>
              <label htmlFor="customer-delete-word" className="text-sm font-medium text-navy">{`Type ${CUSTOMER_DELETE_WORD} to confirm`}</label>
              <Input id="customer-delete-word" data-no-translate autoComplete="off" value={typed} onChange={(event) => setTyped(event.target.value)} className="mt-1" />
            </div>
          </div>
        )}

        {problem && <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive" data-no-translate>{problem}</p>}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={working}>Close</AlertDialogCancel>
          {ready && (
            <Button variant="destructive" disabled={working || typed !== CUSTOMER_DELETE_WORD} onClick={() => void submit()}>
              {working ? "Deleting…" : "Delete their information"}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** A customer asked to see, or to delete, what the store holds on them. */
export function CustomerDataPanel({ customerId, customerName, deleted }: { customerId: string; customerName: string; deleted: boolean }) {
  const [justDeleted, setJustDeleted] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const bumpLog = useCallback(() => setRefresh((value) => value + 1), []);

  const download = useCallback(async () => {
    setDownloading(true);
    try {
      const { data, error } = await supabase.rpc("admin_export_customer_data", { _customer_id: customerId });
      if (error || !data) throw new Error(error?.message ?? "Nothing came back.");
      const file = data as unknown as CustomerDataFile;
      downloadXlsx(customerDataFileName(file), customerDataSheets(file));
      toast.success("The file has been downloaded");
      bumpLog();
    } catch (cause) {
      toast.error("Could not download the information", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setDownloading(false);
    }
  }, [customerId, bumpLog]);

  const finish = async () => {
    setFinishing(true);
    try {
      const result = await deleteCustomerData({ data: { customerId, confirmation: CUSTOMER_DELETE_WORD, retry: true } });
      if (!result.loginRemoved) throw new Error(result.problem ?? undefined);
      toast.success("The customer's login has been removed");
      window.location.assign("/admin/customers");
    } catch (cause) {
      toast.error("Their login could not be removed", { description: cause instanceof Error ? cause.message : undefined });
      setFinishing(false);
    }
  };

  return (
    <Panel title="Information Requests" className="mt-5">
      {deleted || justDeleted ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
          <p className="text-sm text-amber-900">This customer's information has been deleted, but their login could not be removed.</p>
          <Button size="sm" className="mt-2" disabled={finishing} onClick={() => void finish()}>
            {finishing ? "Removing…" : "Try removing the login again"}
          </Button>
        </div>
      ) : (
        <>
          <p className="text-sm text-charcoal">Use this when a customer asks to see or delete the information we hold on them.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => void download()} disabled={downloading || STATIC_DATA_MODE}>
              <Download className="mr-1.5 h-4 w-4" /> {downloading ? "Preparing the file…" : "Download all their information"}
            </Button>
            <Button variant="outline" size="sm" className="border-destructive/50 text-destructive hover:bg-destructive/5 hover:text-destructive" onClick={() => setDeleteOpen(true)} disabled={STATIC_DATA_MODE}>
              <Trash2 className="mr-1.5 h-4 w-4" /> Delete their information
            </Button>
          </div>
          <p className="mt-3 text-xs text-slate">The Excel file holds their profile, saved addresses with map positions, orders, payments, enquiries, reviews, returns and notifications.</p>
          <div className="mt-3"><ZohoNote /></div>
        </>
      )}
      <DeleteDialog customerId={customerId} customerName={customerName} open={deleteOpen} onOpenChange={setDeleteOpen} onFinished={() => { setJustDeleted(true); bumpLog(); }} />
      <div className="mt-4">
        <CustomerDataLog customerId={customerId} refresh={refresh} />
      </div>
    </Panel>
  );
}
