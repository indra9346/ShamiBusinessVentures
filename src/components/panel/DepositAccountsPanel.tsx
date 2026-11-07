import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Landmark, RefreshCw } from "lucide-react";
import { Panel } from "@/components/panel/widgets";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useBranches } from "@/lib/branches";
import {
  DEPOSIT_ACCOUNTS_KEY, depositAccountFor, depositAccountState, parseDepositAccounts,
  type DepositAccounts, type ZohoDepositAccountOption,
} from "@/lib/deposit-accounts";

/** The saved choices, read from the private setting (admins only). Asks nothing of Zoho. */
export function useDepositAccounts(): [DepositAccounts | null, (next: DepositAccounts) => void, boolean] {
  const [accounts, setAccounts] = useState<DepositAccounts | null>(null);
  // Not read is not "none chosen": show that it failed rather than "Undeposited Funds".
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void supabase.from("settings").select("value").eq("key", DEPOSIT_ACCOUNTS_KEY).maybeSingle().then(({ data, error }) => {
      if (!live) return;
      if (error) setFailed(true);
      else setAccounts(parseDepositAccounts(data?.value));
    });
    return () => { live = false; };
  }, []);
  const set = (next: DepositAccounts) => { setFailed(false); setAccounts(next); };
  return [accounts, set, failed];
}

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : undefined);

/**
 * Admin > Payments & Matching: the Zoho Books bank account each godown's website payments are
 * deposited to. The list of accounts comes from Zoho; nothing chosen = Zoho's Undeposited Funds.
 */
export function DepositAccountsPanel({ className }: { className?: string }) {
  const { branches, ready } = useBranches();
  const godowns = branches.filter((branch) => !branch.vendorId);
  const [chosen, setChosen, readFailed] = useDepositAccounts();
  const [options, setOptions] = useState<ZohoDepositAccountOption[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const { listZohoDepositAccounts } = await import("@/lib/zoho-commerce.functions");
      const result = await listZohoDepositAccounts();
      setChosen(result.chosen);
      setOptions(result.accounts);
      setProblem(result.problem);
      if (result.problem) toast.error("Could not load the bank accounts from Zoho", { description: result.problem });
    } catch (cause) {
      toast.error("Could not load the bank accounts from Zoho", { description: errorText(cause) });
    } finally {
      setLoading(false);
    }
  };

  const startEdit = (branchId: string) => {
    setEditing(branchId);
    setDraft(chosen?.[branchId]?.accountId ?? "");
    if (!options) void load();
  };

  const save = async (branchId: string, name: string) => {
    setSaving(true);
    try {
      const { saveGodownDepositAccount } = await import("@/lib/zoho-commerce.functions");
      const result = await saveGodownDepositAccount({ data: { branchId, accountId: draft } });
      const next = { ...(chosen ?? {}) };
      if (result.chosen) next[branchId] = result.chosen;
      else delete next[branchId];
      setChosen(next);
      setEditing(null);
      toast.success(`Saved for ${name}`, {
        description: result.chosen ? `New payments go to ${result.chosen.accountName}` : "New payments go to Undeposited Funds",
      });
    } catch (cause) {
      toast.error("Could not save the deposit account", { description: errorText(cause) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel
      id="deposit-accounts"
      title="Zoho bank account for each godown's payments"
      className={className ?? ""}
      action={
        <Button size="sm" variant="outline" disabled={loading} onClick={() => void load()}>
          <RefreshCw className={`mr-1 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          {loading ? "Loading…" : options ? "Reload accounts from Zoho" : "Load accounts from Zoho"}
        </Button>
      }
    >
      <div className="space-y-1 text-sm text-slate">
        <p>Payments confirmed on the website are recorded in Zoho Books against the order's invoice. Choose the Zoho bank account each godown's payments are deposited to. With none chosen, Zoho puts them in Undeposited Funds.</p>
        <p>Only payments recorded from now on use the account. Payments already in Zoho stay where they are; change those in Zoho Books.</p>
      </div>
      {problem && (
        <p className="mt-3 flex items-start gap-1.5 rounded-md border border-danger/25 bg-danger/5 p-2 text-xs text-danger">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{problem}</span>
        </p>
      )}
      <div className="mt-4 divide-y divide-border rounded-md border border-border">
        {readFailed && chosen === null ? (
          <p className="p-3 text-sm text-danger">Could not read the saved accounts. Click "Load accounts from Zoho" or reload the page.</p>
        ) : !ready || chosen === null ? (
          <p className="p-3 text-sm text-slate">Loading…</p>
        ) : godowns.length === 0 ? (
          <p className="p-3 text-sm text-slate">No godowns yet.</p>
        ) : godowns.map((godown) => {
          const account = depositAccountFor(chosen, godown.id);
          const state = depositAccountState(account, options);
          const open = editing === godown.id;
          return (
            <div key={godown.id} className="space-y-2 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-navy">{godown.name}</p>
                  <p className="text-xs text-slate">{godown.zohoLocationName || godown.code}</p>
                </div>
                {!open && (
                  <Button size="sm" variant="outline" onClick={() => startEdit(godown.id)}>Change</Button>
                )}
              </div>
              {!open && (
                <p className="flex min-w-0 items-start gap-1.5 text-sm text-charcoal">
                  <Landmark className="mt-0.5 h-4 w-4 shrink-0 text-slate" />
                  <span className="min-w-0 break-words">
                    {account ? <strong className="text-navy">{account.accountName}</strong> : <span className="text-slate">Undeposited Funds (Zoho's default)</span>}
                  </span>
                </p>
              )}
              {!open && state === "gone" && (
                <p className="flex items-start gap-1.5 text-xs text-danger">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>This account is no longer an active bank account in Zoho Books. Payments for this godown will not be recorded until you choose another.</span>
                </p>
              )}
              {open && (
                <div className="grid gap-2">
                  <label className="grid gap-1 text-xs font-medium text-slate" htmlFor={`deposit-${godown.id}`}>Deposit payments to</label>
                  {options ? (
                    <select
                      id={`deposit-${godown.id}`}
                      className="h-9 w-full min-w-0 max-w-md rounded-md border border-input bg-background px-2 text-sm"
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                    >
                      <option value="">Undeposited Funds (Zoho's default)</option>
                      {options.map((option) => (
                        <option key={option.id} value={option.id}>{option.type === "cash" ? `${option.name} (cash)` : option.name}</option>
                      ))}
                      {account && !options.some((option) => option.id === account.accountId) && (
                        <option value={account.accountId} disabled>{account.accountName} (no longer active in Zoho)</option>
                      )}
                    </select>
                  ) : (
                    <p className="text-xs text-slate">{loading ? "Loading accounts from Zoho…" : "Load the accounts from Zoho first."}</p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      className="bg-navy text-white hover:bg-navy/90"
                      disabled={saving || !options || draft === (account?.accountId ?? "")}
                      onClick={() => void save(godown.id, godown.name)}
                    >
                      {saving ? "Saving…" : "Save"}
                    </Button>
                    <Button size="sm" variant="outline" disabled={saving} onClick={() => setEditing(null)}>Cancel</Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
