import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/admin/zoho-diagnostics")({
  head: () => ({ meta: [{ title: "Zoho diagnostics | Grain Bazar Admin" }, { name: "robots", content: "noindex" }] }),
  component: ZohoDiagnostics,
});

/** Read-only checks against Zoho, for support. */
function ZohoDiagnostics() {
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <PanelLayout items={adminNav} tone="admin" title="Zoho diagnostics" subtitle="Read-only checks against your Zoho organization">
      <Panel title="Sales channel">
        <p className="mb-3 text-sm text-slate">Shows how Zoho labels the channel on a Grain Bazar order and on a Zoho Commerce order. Nothing is changed.</p>
        <Button
          className="bg-navy text-white hover:bg-navy/90"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const { probeZohoSalesChannel } = await import("@/lib/zoho-commerce.functions");
              setOutput(await probeZohoSalesChannel());
            } catch (cause) {
              setOutput(cause instanceof Error ? cause.message : String(cause));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Checking…" : "Check sales channel"}
        </Button>
        {output && <pre id="zoho-probe-output" className="mt-4 max-h-[60vh] overflow-auto rounded-md bg-stone-900 p-3 text-xs text-stone-100">{output}</pre>}
      </Panel>
    </PanelLayout>
  );
}
