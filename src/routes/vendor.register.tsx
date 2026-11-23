import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { AuthCard } from "@/components/site/AuthCard";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "@/components/panel/widgets";
import { supabase } from "@/integrations/supabase/client";
import { useBranches } from "@/lib/branches";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { useApp } from "@/lib/store";

export const Route = createFileRoute("/vendor/register")({
  head: () => ({ meta: [{ title: "Vendor Application | Grain Bazar" }, { name: "robots", content: "noindex" }] }),
  component: VendorRegistration,
});

type Application = { id: string; status: string; admin_notes: string | null; vendor_id: string | null; created_at: string };

function VendorRegistration() {
  const { user, logout } = useApp();
  // The database accepts applications only from logins that hold the customer role and are not
  // already a vendor or admin. Channel-partner and godown-staff logins have no customer role, but
  // the site shows them as customers, so read the live roles instead of trusting user.role.
  const [roles, setRoles] = useState<string[] | null>(null);
  const branchState = useBranches();
  const [application, setApplication] = useState<Application | null>(null);
  const [business, setBusiness] = useState("");
  const [owner, setOwner] = useState(user?.name ?? "");
  const [phone, setPhone] = useState(user?.phone ?? "");
  const [gstin, setGstin] = useState("");
  const [city, setCity] = useState("");
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user?.id) { setRoles(null); return; }
    let active = true;
    setRoles(null);
    void supabase.from("user_roles").select("role").eq("user_id", user.id).then(({ data, error }) => {
      if (!active) return;
      setRoles(error ? [] : (data ?? []).map((row) => String(row.role)));
    });
    return () => { active = false; };
  }, [user?.id]);

  const canApply = Boolean(roles?.includes("customer") && !roles.includes("vendor") && !roles.includes("admin"));

  useEffect(() => {
    if (!user?.id || !canApply) return;
    const userId = user.id;
    let active = true;
    let loadRevision = 0;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let hasConnectedOnce = false;
    const load = async () => {
      const revision = ++loadRevision;
      const { data, error } = await supabase.from("vendor_applications").select("id,status,admin_notes,vendor_id,created_at,business_name,owner_name,phone,gstin,city,address").eq("applicant_id", userId).maybeSingle();
      if (!active || revision !== loadRevision) return;
      if (error) { setLoading(false); toast.error("Could not load your vendor application", { description: error.message }); return; }
      if (data) {
        setApplication({ id: data.id, status: data.status, admin_notes: data.admin_notes, vendor_id: data.vendor_id, created_at: data.created_at });
        setBusiness(data.business_name); setOwner(data.owner_name); setPhone(data.phone); setGstin(data.gstin); setCity(data.city); setAddress(data.address);
      } else {
        setApplication(null);
      }
      setLoading(false);
    };
    const scheduleLoad = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void load(), 100);
    };
    setLoading(true);
    void load();
    const channel = supabase.channel(`vendor-application-${userId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "vendor_applications", filter: `applicant_id=eq.${userId}` }, scheduleLoad)
      .subscribe((status) => {
        if (status !== "SUBSCRIBED") return;
        if (hasConnectedOnce) scheduleLoad();
        hasConnectedOnce = true;
      });
    return () => {
      active = false;
      loadRevision += 1;
      if (refreshTimer) clearTimeout(refreshTimer);
      void supabase.removeChannel(channel);
    };
  }, [user?.id, canApply]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!user?.id || !canApply) { toast.error("Sign in with the applicant's own customer account to apply"); return; }
    if (!user.email.includes("@")) { toast.error("A verified email account is required for vendor sign-in"); return; }
    if (gstin.trim() && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin.trim().toUpperCase())) {
      toast.error("Enter a valid 15-character GSTIN (for example 29ABCDE1234F1Z5), or leave it blank");
      return;
    }
    setSaving(true);
    const { data, error } = await supabase.rpc("customer_submit_vendor_application", {
      _business_name: business.trim(), _owner_name: owner.trim(), _phone: phone.trim(), _gstin: gstin.trim(), _city: city.trim(), _address: address.trim(),
    });
    setSaving(false);
    if (error || !data) {
      const message = error?.message ?? "Please try again.";
      const description = /customer account to request vendor access/i.test(message)
        ? "This login is not a customer account (channel partner, staff or admin logins can't apply). Sign out, then sign in or register with the applicant's own customer account."
        : message;
      toast.error("Could not submit vendor application", { description });
      return;
    }
    const { data: row } = await supabase.from("vendor_applications").select("id,status,admin_notes,vendor_id,created_at").eq("id", data).single();
    if (row) setApplication(row);
    toast.success("Vendor application submitted for review");
  };

  if (!STATIC_DATA_MODE && branchState.ready && !branchState.features.marketplaceVendors) {
    return <AuthCard title="Vendor applications are not open yet" subtitle="Grain Bazar is currently selling its own products only."><p className="text-sm text-slate">Please check back later. You can still shop as a customer.</p><Link to="/" className="mt-3 inline-block font-semibold text-gold hover:underline">Go to the store</Link></AuthCard>;
  }
  if (!user) return <AuthCard title="Apply to become a vendor" subtitle="Create or sign in to your customer account first. Vendor access is granted after an administrator reviews your business details." footer={<><Link to="/register" className="font-semibold text-gold hover:underline">Create customer account</Link><span className="mx-2">·</span><Link to="/login" className="font-semibold text-gold hover:underline">Sign in</Link></>}><p className="text-sm text-slate">Applications are linked to your signed-in account. Public forms cannot create vendor roles or accounts directly.</p></AuthCard>;
  if (roles === null) return <AuthCard title="Vendor application" subtitle="Checking your account…"><p className="text-sm text-slate">One moment.</p></AuthCard>;
  if (roles.includes("vendor")) return <AuthCard title="You already have vendor access" subtitle="This account is already an approved vendor, so it does not need a new application."><Link to="/vendor/login" className="font-semibold text-gold hover:underline">Go to vendor sign in</Link></AuthCard>;
  if (!canApply) {
    const kind = roles.includes("admin") ? "an administrator" : "a channel partner or staff";
    return <AuthCard title="Use the applicant's own customer account" subtitle={`You are signed in with ${kind} login. Vendor applications must come from the business owner's own customer account.`} footer={<><Link to="/register" className="font-semibold text-gold hover:underline">Create customer account</Link><span className="mx-2">·</span><Link to="/login" className="font-semibold text-gold hover:underline">Customer sign in</Link></>}>
      <p className="text-sm text-slate">Sign out, then the person who wants to sell signs in (or registers) with their own email. After an administrator approves the application in Admin › Vendors, that same account gets vendor access.</p>
      <Button type="button" variant="outline" className="mt-3 w-full" onClick={() => logout()}>Sign out</Button>
    </AuthCard>;
  }

  return <AuthCard title="Vendor application" subtitle="Submit your business details for administrator review. Approval enables vendor access on this same account." footer={<Link to="/vendor/login" className="font-semibold text-gold hover:underline">Already approved? Vendor sign in</Link>}>
    {loading ? <p className="text-sm text-slate">Loading application…</p> : application && <div className="mb-5 rounded-md border border-border p-4">
      <div className="flex items-center justify-between"><span className="font-semibold text-navy">Application status</span><StatusBadge status={application.status} /></div>
      <p className="mt-2 text-xs text-slate">Submitted {new Date(application.created_at).toLocaleDateString("en-IN")}{application.vendor_id ? ` · Vendor ID ${application.vendor_id}` : ""}</p>
      {application.admin_notes && <p className="mt-2 text-sm text-charcoal">Administrator note: {application.admin_notes}</p>}
      {application.status === "Approved" && <p className="mt-3 text-sm text-slate">Your vendor role is enabled. If you created your account with an email code, set a password in <Link to="/account/settings" className="font-semibold text-gold underline">Account Settings</Link>, then use vendor sign in.</p>}
      {application.status === "Pending" && <p className="mt-3 text-sm text-slate">Your application is awaiting review. You can submit changes again if it is returned as rejected.</p>}
    </div>}
    {application?.status === "Approved" || application?.status === "Pending" ? null : <form className="space-y-3" onSubmit={(event) => void submit(event)}>
      <div className="grid gap-1.5"><Label htmlFor="vendor-business">Business name</Label><Input id="vendor-business" required minLength={2} value={business} onChange={(event) => setBusiness(event.target.value)} /></div>
      <div className="grid gap-1.5"><Label htmlFor="vendor-owner">Owner name</Label><Input id="vendor-owner" required minLength={2} value={owner} onChange={(event) => setOwner(event.target.value)} /></div>
      <div className="grid gap-1.5"><Label htmlFor="vendor-phone">Business phone</Label><Input id="vendor-phone" required type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} /></div>
      <div className="grid gap-1.5"><Label htmlFor="vendor-gstin">GSTIN (if registered)</Label><Input id="vendor-gstin" value={gstin} onChange={(event) => setGstin(event.target.value.toUpperCase())} maxLength={15} /></div>
      <div className="grid gap-1.5"><Label htmlFor="vendor-city">City</Label><Input id="vendor-city" required minLength={2} value={city} onChange={(event) => setCity(event.target.value)} /></div>
      <div className="grid gap-1.5"><Label htmlFor="vendor-address">Business address</Label><Textarea id="vendor-address" required minLength={8} rows={3} value={address} onChange={(event) => setAddress(event.target.value)} /></div>
      <Button type="submit" className="w-full bg-navy text-white" disabled={saving || loading}>{saving ? "Submitting…" : application ? "Resubmit application" : "Submit vendor application"}</Button>
    </form>}
  </AuthCard>;
}
