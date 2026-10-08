import { createFileRoute, Link } from "@tanstack/react-router";
import { AuthCard } from "@/components/site/AuthCard";

export const Route = createFileRoute("/vendor/register")({
  head: () => ({
    meta: [
      { title: "Vendor Access | Grain Bazar" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: VendorRegistrationNotice,
});

function VendorRegistrationNotice() {
  return (
    <AuthCard
      title="Vendor access is provisioned by Shami"
      subtitle="Public vendor registration is disabled. Once your vendor account has been created and approved, use the registered business email to sign in with an OTP."
      footer={
        <Link to="/vendor/login" className="font-semibold text-gold hover:underline">
          Go to vendor sign in
        </Link>
      }
    >
      <p className="text-sm leading-6 text-slate">
        Contact the Shami administrator to request vendor access. Vendor access is enabled only
        after an administrator provisions the account and assigns the vendor role.
      </p>
    </AuthCard>
  );
}
