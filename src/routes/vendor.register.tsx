import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { AuthCard } from "@/components/site/AuthCard";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/vendor/register")({
  head: () => ({
    meta: [
      { title: "Become a Vendor | Shami Business Ventures" },
      { name: "description", content: "Register your mill or distribution business and sell on the Shami marketplace." },
      { property: "og:title", content: "Become a Shami Vendor" },
      { property: "og:description", content: "Submit details, get admin approval, start selling." },
    ],
  }),
  component: VendorRegister,
});

function VendorRegister() {
  const [submitted, setSubmitted] = useState(false);

  return (
    <AuthCard
      title="Vendor Registration"
      subtitle="Register → Submit details → Admin review → Approval → Dashboard"
      footer={
        <>
          Already a vendor?{" "}
          <Link to="/vendor/login" className="font-semibold text-gold hover:underline">
            Vendor login
          </Link>
        </>
      }
    >
      {submitted ? (
        <div className="rounded-lg border border-gold/40 bg-ivory p-6">
          <p className="font-bold text-navy">Application submitted</p>
          <p className="mt-2 text-sm text-slate">
            Our compliance team reviews GST, FSSAI and bank details within 2 business days. You will receive an
            email once your vendor account is approved.
          </p>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(true);
            toast.success("Vendor application submitted for admin review");
          }}
          className="space-y-4"
        >
          {["Business name", "Owner name", "Business email", "Phone", "GSTIN", "City & State"].map((l) => (
            <label key={l} className="block">
              <span className="mb-1.5 block text-xs font-semibold text-charcoal">{l}</span>
              <Input required maxLength={120} />
            </label>
          ))}
          <button className="w-full rounded-md bg-gold py-3 text-sm font-bold text-midnight hover:bg-gold-light">
            Submit for Approval
          </button>
        </form>
      )}
    </AuthCard>
  );
}