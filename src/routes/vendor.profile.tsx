import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Building2 } from "lucide-react";
import { toast } from "sonner";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel, StatusBadge } from "@/components/panel/widgets";
import { vendorNav } from "@/lib/panel-nav";
import { useApp, useVendorScope } from "@/lib/store";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { uploadCatalogImage } from "@/lib/catalog-images";

export const Route = createFileRoute("/vendor/profile")({
  head: () => ({
    meta: [
      { title: "Store Profile | Shami Vendor Panel" },
      { name: "description", content: "Manage your vendor business profile and KYC documents." },
      { property: "og:title", content: "Vendor Profile | Shami" },
      { property: "og:description", content: "Business profile management for Shami marketplace vendors." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: VendorProfile,
});

function VendorProfile() {
  const { vendors, user } = useApp();
  const { vendorId } = useVendorScope();
  const vendor = vendors.find((v) => v.id === vendorId);
  const vendorBusiness = vendor?.business;
  const vendorOwner = vendor?.owner;
  const vendorEmail = vendor?.email;
  const vendorPhone = vendor?.phone;
  const vendorCity = vendor?.city;
  const vendorAvatar = vendor?.avatar;

  const [business, setBusiness] = useState("");
  const [owner, setOwner] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [city, setCity] = useState("");
  const [saving, setSaving] = useState(false);
  const [logo, setLogo] = useState<string | null>(null);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [kycDocuments, setKycDocuments] = useState<Array<{ id: string; document_type: string; object_path: string; status: string; admin_notes: string | null; created_at: string }>>([]);
  const [documentType, setDocumentType] = useState("gst_certificate");
  const [uploadingDocument, setUploadingDocument] = useState(false);
  useEffect(() => {
    if (!vendorBusiness) return;
    setBusiness(vendorBusiness);
    setOwner(vendorOwner ?? "");
    setEmail(vendorEmail ?? "");
    setPhone(vendorPhone ?? "");
    setCity(vendorCity ?? "");
    setLogo(vendorAvatar ?? null);
  }, [vendorBusiness, vendorOwner, vendorEmail, vendorPhone, vendorCity, vendorAvatar]);
  useEffect(() => {
    if (!user?.id) return;
    const userId = user.id;
    let active = true;
    let revision = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let connectedOnce = false;
    const load = async () => {
      const requestRevision = ++revision;
      const { data, error } = await supabase.from("vendor_kyc_documents").select("id,document_type,object_path,status,admin_notes,created_at").eq("user_id", userId).order("created_at", { ascending: false });
      if (!active || requestRevision !== revision) return;
      if (error) { toast.error("Could not load verification documents", { description: error.message }); return; }
      setKycDocuments(data ?? []);
    };
    const refreshSoon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 100);
    };
    void load();
    const channel = supabase.channel(`vendor-kyc-${userId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "vendor_kyc_documents", filter: `user_id=eq.${userId}` }, refreshSoon)
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          if (connectedOnce) refreshSoon();
          connectedOnce = true;
        }
      });
    return () => {
      active = false;
      ++revision;
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [user?.id]);
  const uploadKycDocument = async (file?: File) => {
    if (!file || !user?.id || !vendorId) return;
    const allowedTypes = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
    if (!allowedTypes.includes(file.type) || file.size > 15 * 1024 * 1024) {
      toast.error("Choose a PDF, JPG, PNG or WebP file under 15 MB");
      return;
    }
    const extensions: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
    const path = `${user.id}/${documentType}/${crypto.randomUUID()}.${extensions[file.type]}`;
    setUploadingDocument(true);
    const { error: uploadError } = await supabase.storage.from("vendor-kyc").upload(path, file, { contentType: file.type, upsert: false });
    if (uploadError) {
      setUploadingDocument(false);
      toast.error("Could not upload verification document", { description: uploadError.message });
      return;
    }
    const { data, error } = await supabase.from("vendor_kyc_documents").insert({ vendor_id: vendorId, user_id: user.id, document_type: documentType, object_path: path }).select("id,document_type,object_path,status,admin_notes,created_at").single();
    if (error) {
      await supabase.storage.from("vendor-kyc").remove([path]);
      setUploadingDocument(false);
      toast.error("Could not submit verification document", { description: error.message });
      return;
    }
    setKycDocuments((items) => [data, ...items]);
    setUploadingDocument(false);
    toast.success("Document submitted for admin review");
  };
  const openKycDocument = async (path: string) => {
    const { data, error } = await supabase.storage.from("vendor-kyc").createSignedUrl(path, 60);
    if (error || !data?.signedUrl) { toast.error("Could not open this document", { description: error?.message }); return; }
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  };
  const saveProfile = async () => {
    if (!vendor) { toast.error("Your vendor profile is still loading"); return; }
    setSaving(true);
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) { setSaving(false); toast.error("Sign in again to update your profile"); return; }
    const { error } = await supabase.from("profiles").update({ company: business.trim(), full_name: owner.trim(), phone: phone.trim() }).eq("id", user.id);
    setSaving(false);
    if (error) { toast.error("Could not update store profile", { description: error.message }); return; }
    if (email.trim() !== user.email) toast.info("Email changes require a separate verified account email update.");
    if (city.trim() !== vendor.city) toast.info("City is shown from the approved vendor registration; edit it through the registration/KYC process.");
    toast.success("Store profile updated");
  };
  const saveLogo = async (file?: File) => {
    if (!file) return;
    setUploadingLogo(true);
    try {
      const url = await uploadCatalogImage(file, "profiles");
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Sign in again to update your logo");
      const { error } = await supabase.from("profiles").update({ avatar_url: url }).eq("id", user.id);
      if (error) throw error;
      setLogo(url);
      toast.success("Store logo updated");
    } catch (error) {
      toast.error("Could not upload store logo", { description: error instanceof Error ? error.message : "Try again." });
    } finally { setUploadingLogo(false); }
  };

  if (!vendor) return <PanelLayout items={vendorNav} tone="vendor" title="Store Profile" subtitle="Loading your vendor profile"><Panel><p className="text-sm text-slate">Loading vendor details…</p></Panel></PanelLayout>;

  return (
    <PanelLayout items={vendorNav} tone="vendor" title="Store Profile" subtitle="Manage your business details">
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Panel title="Business Details">
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Business Name</Label>
              <Input value={business} onChange={(e) => setBusiness(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Owner Name</Label>
              <Input value={owner} onChange={(e) => setOwner(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Email</Label>
              <Input value={email} readOnly aria-describedby="email-profile-note" />
              <p id="email-profile-note" className="text-xs text-slate">Change your sign-in email through account security settings.</p>
            </div>
            <div className="grid gap-1.5">
              <Label>Phone</Label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>City</Label>
              <Input value={city} readOnly aria-describedby="city-profile-note" />
              <p id="city-profile-note" className="text-xs text-slate">City is part of your approved vendor registration. Contact support to request a change.</p>
            </div>
            <div className="grid gap-1.5">
              <Label>GST Number</Label>
              <Input value={vendor.gst} disabled />
            </div>
            <div className="grid gap-1.5">
              <Label>Bank Account</Label>
              <Input value={vendor.bank} disabled />
            </div>
            <div className="grid gap-1.5">
              <Label>Commission Rate</Label>
              <Input value={`${vendor.commission}%`} disabled />
            </div>
            <div className="grid gap-1.5">
              <Label>Rating</Label>
              <Input value={`${vendor.rating} / 5`} disabled />
            </div>
            <div className="grid gap-1.5">
              <Label>Joined</Label>
              <Input value={vendor.joined} disabled />
            </div>
          </div>
          <div className="mt-6 flex justify-end">
            <Button
              className="bg-navy text-white hover:bg-navy/90"
              disabled={saving}
              onClick={() => void saveProfile()}
            >
              Save Changes
            </Button>
          </div>
        </Panel>

        <div className="space-y-6">
          <Panel title="Store Logo">
            <div className="grid place-items-center gap-3 rounded-lg border border-dashed border-border py-8">
              {logo ? <img src={logo} alt="Store logo" className="h-16 w-16 rounded-full object-cover" /> : <span className="grid h-16 w-16 place-items-center rounded-full bg-navy/6 text-navy"><Building2 className="h-8 w-8" /></span>}
              <p className="text-xs text-slate">{business}</p>
              <label className="inline-flex h-9 cursor-pointer items-center rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-accent">{uploadingLogo ? "Uploading…" : "Upload Logo"}<input className="sr-only" type="file" accept="image/png,image/jpeg,image/webp,image/avif" disabled={uploadingLogo} onChange={(e) => { void saveLogo(e.target.files?.[0]); e.currentTarget.value = ""; }} /></label>
            </div>
          </Panel>
          <Panel title="KYC Documents">
            <p className="mb-4 text-sm text-slate">Upload business documents for private review by the marketplace administrator. Only you and authorized administrators can open these files.</p>
            <div className="mb-4 grid gap-2">
              <Label htmlFor="kyc-document-type">Document type</Label>
              <select id="kyc-document-type" className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={documentType} onChange={(event) => setDocumentType(event.target.value)}>
                <option value="gst_certificate">GST certificate</option>
                <option value="pan_card">PAN card</option>
                <option value="bank_proof">Bank account proof</option>
                <option value="business_registration">Business registration</option>
              </select>
              <label className="inline-flex h-10 cursor-pointer items-center justify-center rounded-md bg-navy px-3 text-sm font-semibold text-white hover:bg-navy/90">{uploadingDocument ? "Uploading…" : "Browse and submit document"}<input className="sr-only" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" disabled={uploadingDocument} onChange={(event) => { void uploadKycDocument(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label>
              <p className="text-xs text-slate">PDF, JPG, PNG or WebP; maximum 15 MB.</p>
            </div>
            <div className="space-y-3">
              {kycDocuments.length === 0 && <p className="text-sm text-slate">No documents submitted yet.</p>}
              {kycDocuments.map((document) => <div key={document.id} className="rounded-md border border-border p-3">
                <div className="flex items-center justify-between gap-2"><p className="text-sm font-semibold text-navy">{document.document_type.replaceAll("_", " ")}</p><StatusBadge status={document.status} /></div>
                <p className="mt-1 text-xs text-slate">Submitted {new Date(document.created_at).toLocaleDateString("en-IN")}</p>
                {document.admin_notes && <p className="mt-2 text-xs text-danger">Admin note: {document.admin_notes}</p>}
                <Button variant="outline" size="sm" className="mt-2" onClick={() => void openKycDocument(document.object_path)}>View submitted file</Button>
              </div>)}
            </div>
          </Panel>
        </div>
      </div>
    </PanelLayout>
  );
}
