import { Link } from "@tanstack/react-router";
import { ScanLine } from "lucide-react";

/** The big button to the delivery QR scanner, on the partner's dashboard and Delivery notes page. */
export function ScanQrCard({ godown }: { godown: string }) {
  return (
    <Link to="/slip" className="flex items-center gap-3 rounded-2xl border-2 border-navy bg-card p-4 shadow-sm hover:border-gold">
      <ScanLine className="h-8 w-8 shrink-0 text-navy" />
      <span className="min-w-0">
        <span className="block text-sm font-extrabold text-navy">Scan the QR on the customer's invoice</span>
        <span className="block text-xs text-slate">{`See the released delivery note of an order at ${godown}. Printing and handing over follow the head office's rules; the godown in-charge does both.`}</span>
      </span>
    </Link>
  );
}
