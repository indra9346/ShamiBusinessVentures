import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Panel } from "@/components/panel/widgets";
import { Switch } from "@/components/ui/switch";
import { loadPartnerPaymentApproval, setPartnerPaymentApproval, type PartnerPaymentApproval } from "@/lib/upi-store";

const istTime = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

/**
 * Admin > UPI & Bank Payments (16 Nov 2026): whether the channel partner of each godown may approve the customer UTRs of
 * their own godown's checkouts (partner_approve_payment). On from the owner's request; off, only our office approves.
 */
export function PartnerPaymentApprovalPanel() {
  const [value, setValue] = useState<PartnerPaymentApproval | null>(null);
  const [failed, setFailed] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    void loadPartnerPaymentApproval().then(setValue, (cause: unknown) => setFailed(cause instanceof Error ? cause.message : "Could not read the setting"));
  }, []);
  const change = async (enabled: boolean) => {
    setSaving(true);
    try {
      setValue(await setPartnerPaymentApproval(enabled));
      toast.success(enabled ? "Channel partners can approve payments" : "Only our office approves payments now");
    } catch (cause) {
      toast.error("Could not save", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Panel title="Channel partners approving payments" className="mb-6">
      {failed ? <p className="text-sm text-danger">{failed}</p> : (
        <div className="grid gap-2">
          <label className="flex items-center gap-3 text-sm">
            <Switch checked={value?.enabled ?? false} disabled={!value || saving} onCheckedChange={(enabled) => void change(enabled)} />
            <span className="font-semibold text-navy">Channel partners can approve their own godown's payments</span>
          </label>
          <p className="text-xs text-slate">On: the channel partner of each godown can approve a customer's UTR for their own godown's checkouts, after seeing the money arrive. Since 19 Nov they can also reject a wrong UTR with a reason. Our office is told of every approval and rejection, shown under Approved by. Off: only our office approves payments.</p>
          {value?.changedAt && <p className="text-[11px] text-slate">{`Last changed by ${value.changedBy || "an admin"} on ${istTime(value.changedAt)}`}</p>}
        </div>
      )}
    </Panel>
  );
}
