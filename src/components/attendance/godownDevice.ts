import { useCallback, useEffect, useState } from "react";

/*
 * The godown's attendance device: after registration with a one-time code from head office, the
 * device keeps its secret token here and sends it with every check-in, check-out and presence
 * photo. Signing staff in and out does not touch it.
 */

const KEY = "gb-godown-device";

export type GodownDevice = { token: string; branchId: string; godown: string; label: string };

export function readGodownDevice(): GodownDevice | null {
  try {
    const raw = localStorage.getItem(KEY);
    const value = raw ? (JSON.parse(raw) as Partial<GodownDevice>) : null;
    return value?.token && value.branchId ? { token: value.token, branchId: value.branchId, godown: value.godown ?? "", label: value.label ?? "" } : null;
  } catch {
    return null;
  }
}

export function saveGodownDevice(device: GodownDevice) {
  try { localStorage.setItem(KEY, JSON.stringify(device)); } catch { /* storage blocked */ }
}

export function forgetGodownDevice() {
  try { localStorage.removeItem(KEY); } catch { /* storage blocked */ }
}

/**
 * This device's registration, checked with the server (a removed device comes back as null).
 * `checked` is false until the server answered.
 */
export function useGodownDevice() {
  const [device, setDevice] = useState<GodownDevice | null>(null);
  const [checked, setChecked] = useState(false);
  const check = useCallback(async () => {
    const stored = readGodownDevice();
    if (!stored) { setDevice(null); setChecked(true); return; }
    try {
      const { describeGodownDevice } = await import("@/lib/attendance.functions");
      const live = await describeGodownDevice({ data: { token: stored.token } });
      if (!live) { setDevice(null); setChecked(true); return; }
      const fresh = { ...stored, ...live };
      saveGodownDevice(fresh);
      setDevice(fresh);
    } catch {
      setDevice(stored); // offline: trust the stored registration; the server checks it again on every photo
    }
    setChecked(true);
  }, []);
  useEffect(() => { void check(); }, [check]);
  return { device, checked, recheck: check };
}
