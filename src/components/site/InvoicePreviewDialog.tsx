import { useEffect, useState } from "react";
import { Download, ExternalLink, FileText, Printer } from "lucide-react";
import { toast } from "sonner";
import type { Order } from "@/lib/data";
import { useApp } from "@/lib/store";
import type { InvoiceCopy } from "@/lib/invoice";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * "View invoice" for every panel: shows the exact PDF that will be downloaded, with
 * Download, Print and Open-in-new-tab (phones that cannot show a PDF inside a page).
 */
export function InvoicePreviewButton({ order, copy = "customer", label = "View Invoice", variant = "outline", size }: {
  order: Order;
  copy?: InvoiceCopy;
  label?: string;
  variant?: "outline" | "default" | "ghost";
  size?: "sm" | "default";
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} size={size} onClick={() => setOpen(true)}>
        <FileText className="mr-1.5 h-4 w-4" /> {label}
      </Button>
      {open && <InvoicePreviewDialog order={order} copy={copy} open={open} onOpenChange={setOpen} />}
    </>
  );
}

export function InvoicePreviewDialog({ order, copy = "customer", open, onOpenChange }: {
  order: Order;
  copy?: InvoiceCopy;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { products } = useApp();
  const [state, setState] = useState<{ url: string; fileName: string; invoiceNo: string } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let url = "";
    let active = true;
    setFailed(false);
    void import("@/lib/invoice")
      .then(({ buildInvoicePdf }) => buildInvoicePdf(order, { copy, catalog: products }))
      .then(({ pdf, fileName, invoiceNo }) => {
        url = URL.createObjectURL(pdf.output("blob"));
        if (active) setState({ url, fileName, invoiceNo });
        else URL.revokeObjectURL(url);
      })
      .catch((error: unknown) => {
        console.error("Invoice preview failed", error);
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
      setState(null);
    };
    // Rebuild only when the dialog opens for an order.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, order.id, copy]);

  const download = () => {
    if (!state) return;
    const link = document.createElement("a");
    link.href = state.url;
    link.download = state.fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    toast.success(`Invoice ${state.invoiceNo} downloaded`);
  };
  const print = () => {
    if (!state) return;
    const frame = document.getElementById("invoice-preview-frame") as HTMLIFrameElement | null;
    try {
      frame?.contentWindow?.focus();
      frame?.contentWindow?.print();
    } catch {
      window.open(state.url, "_blank", "noopener");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[92vh] max-w-4xl flex-col gap-3 p-4 sm:p-5">
        <DialogHeader>
          <DialogTitle className="pr-6">
            Tax invoice {state ? state.invoiceNo : ""} · {order.id}
            {copy === "office" && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-900">Office copy</span>}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap gap-2">
          <Button className="bg-navy text-white hover:bg-navy/90" disabled={!state} onClick={download}>
            <Download className="mr-1.5 h-4 w-4" /> Download PDF
          </Button>
          <Button variant="outline" disabled={!state} onClick={print}>
            <Printer className="mr-1.5 h-4 w-4" /> Print
          </Button>
          <Button variant="outline" disabled={!state} onClick={() => state && window.open(state.url, "_blank", "noopener")}>
            <ExternalLink className="mr-1.5 h-4 w-4" /> Open in new tab
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-stone-100">
          {failed && <p className="p-6 text-sm text-danger">The invoice could not be prepared. Please try again.</p>}
          {!failed && !state && <p className="p-6 text-sm text-slate">Preparing the invoice…</p>}
          {state && (
            <iframe
              id="invoice-preview-frame"
              title={`Invoice ${state.invoiceNo}`}
              src={`${state.url}#view=FitH`}
              className="h-full w-full"
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
