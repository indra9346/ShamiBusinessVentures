import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, RefreshCw, Smartphone } from "lucide-react";
import { AuthCard } from "@/components/site/AuthCard";
import { Input } from "@/components/ui/input";
import { forgetGodownDevice, saveGodownDevice, useGodownDevice } from "@/components/attendance/godownDevice";

export const Route = createFileRoute("/staff/device")({
  head: () => ({ meta: [{ title: "Register Attendance Device | Grain Bazar" }, { name: "robots", content: "noindex" }] }),
  component: RegisterDevice,
});

/**
 * Registers this phone / tablet as a godown's attendance device with a one-time code from head
 * office (Admin > Attendance > Godown devices). Only registered devices can mark attendance.
 */
function RegisterDevice() {
  const { device, checked, recheck } = useGodownDevice();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const register = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const { registerGodownDevice } = await import("@/lib/attendance.functions");
      const result = await registerGodownDevice({ data: { code: code.trim().toUpperCase() } });
      saveGodownDevice({ token: result.token, branchId: result.branchId, godown: result.godown, label: result.label });
      toast.success("Device registered", { description: `${result.godown} · ${result.label}` });
      setCode("");
      await recheck();
    } catch (cause) {
      toast.error("Could not register this device", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Godown Attendance Device" subtitle="Staff mark attendance only on their godown's registered phone or tablet. Head office gives a one-time code in Admin > Attendance > Godown devices.">
      {!checked ? (
        <p className="flex items-center gap-2 text-sm text-slate"><RefreshCw className="h-4 w-4 animate-spin" /> Checking this device…</p>
      ) : device ? (
        <div className="space-y-4">
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
            <p className="flex items-center gap-2 font-bold text-emerald-800"><CheckCircle2 className="h-5 w-5" /> This device is registered</p>
            <p className="mt-1 text-sm text-emerald-900">{`${device.godown} · ${device.label}`}</p>
          </div>
          <Link to="/staff/login" className="block w-full rounded-md bg-navy py-3 text-center text-sm font-semibold text-white">Go to staff sign-in</Link>
          <button type="button" onClick={() => { forgetGodownDevice(); void recheck(); }} className="w-full text-xs font-semibold text-red-700 underline">Unregister this device</button>
        </div>
      ) : (
        <form onSubmit={(event) => void register(event)} className="space-y-4">
          <p className="flex items-start gap-2 text-sm text-slate"><Smartphone className="mt-0.5 h-4 w-4 shrink-0" /> Do this once, on the godown's own attendance phone or tablet.</p>
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-charcoal">Device code from head office</span>
            <Input value={code} onChange={(event) => setCode(event.target.value.replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 8))} placeholder="ABCD2345" className="h-12 text-center text-lg font-bold tracking-[0.3em]" />
          </label>
          <button disabled={busy || code.length !== 8} className="w-full rounded-md bg-navy py-3 text-sm font-semibold text-white disabled:opacity-60">
            {busy ? "Registering…" : "Register this device"}
          </button>
        </form>
      )}
    </AuthCard>
  );
}
