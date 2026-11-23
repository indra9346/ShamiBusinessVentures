import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { PenLine, Trash2, Upload } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import {
  GODOWN_SIGNATURE_BUCKET, SIGNATURE_TYPES, godownSignatureObject, partnerSignatureObject, signatureFileProblem, signatureToPng,
} from "@/lib/godown-signature";
import type { Branch } from "@/lib/branches";
import { Button } from "@/components/ui/button";

/** A stored signature, shown from the private bucket through a short-lived link. */
export function useSignaturePreview(path: string | null) {
  const [preview, setPreview] = useState("");
  useEffect(() => {
    let live = true;
    setPreview("");
    if (!path || STATIC_DATA_MODE) return;
    void supabase.storage.from(GODOWN_SIGNATURE_BUCKET).createSignedUrl(path, 600).then(({ data }) => { if (live) setPreview(data?.signedUrl ?? ""); });
    return () => { live = false; };
  }, [path]);
  return [preview, setPreview] as const;
}

/**
 * Upload, replace or remove a signature picture (admins only: the bucket's write policies and the tables' admin
 * policies refuse anyone else). `save` stores the new path on the row; the old file is removed after it.
 */
function SignatureUploadField({ title, initialPath, newObjectPath, save, empty, savedDescription, note }: {
  title: string;
  initialPath: string | null;
  newObjectPath: () => string;
  save: (path: string | null) => Promise<void>;
  empty: string;
  savedDescription: string;
  note?: ReactNode;
}) {
  const [path, setPath] = useState(initialPath);
  const [preview, setPreview] = useSignaturePreview(path);
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement | null>(null);
  useEffect(() => { setPath(initialPath); }, [initialPath]);

  const store = async (next: string | null) => {
    await save(next);
    const old = path;
    setPath(next);
    if (old && old !== next) await supabase.storage.from(GODOWN_SIGNATURE_BUCKET).remove([old]);
  };
  const choose = async (file: File | undefined) => {
    if (!file) return;
    const problem = signatureFileProblem(file);
    if (problem) { toast.error(problem); return; }
    setBusy(true);
    try {
      const png = await signatureToPng(file);
      if (STATIC_DATA_MODE) { setPreview(URL.createObjectURL(png)); toast.success("Signature saved"); return; }
      const target = newObjectPath();
      const { error } = await supabase.storage.from(GODOWN_SIGNATURE_BUCKET).upload(target, png, { contentType: "image/png", upsert: false });
      if (error) throw new Error(error.message);
      try {
        await store(target);
      } catch (cause) {
        await supabase.storage.from(GODOWN_SIGNATURE_BUCKET).remove([target]);
        throw cause;
      }
      toast.success("Signature saved", { description: savedDescription });
    } catch (cause) {
      toast.error("Could not save the signature", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy(false);
      if (picker.current) picker.current.value = "";
    }
  };
  const remove = async () => {
    if (!window.confirm("Remove this signature? Invoices go back to a blank signature line.")) return;
    setBusy(true);
    try {
      await store(null);
      setPreview("");
      toast.success("Signature removed");
    } catch (cause) {
      toast.error("Could not remove the signature", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy(false);
    }
  };
  const has = Boolean(path || preview);
  return (
    <div className="rounded-md border border-border p-2 text-xs">
      <p className="mb-1 flex items-center gap-1.5 font-semibold text-navy"><PenLine className="h-3.5 w-3.5" />{title}</p>
      <div className="flex flex-wrap items-center gap-2">
        {preview ? <img src={preview} alt={title} className="h-10 max-w-[150px] rounded border border-border bg-white object-contain p-0.5" />
          : <span className="text-slate">{path ? "Loading…" : empty}</span>}
        <input ref={picker} type="file" accept={SIGNATURE_TYPES.join(",")} className="hidden" aria-label="Choose signature picture" onChange={(event) => void choose(event.target.files?.[0])} />
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => picker.current?.click()}><Upload className="mr-1.5 h-3.5 w-3.5" />{busy ? "Saving…" : has ? "Replace" : "Upload"}</Button>
        {has && <Button type="button" size="sm" variant="outline" className="text-danger hover:border-danger" disabled={busy} onClick={() => void remove()}><Trash2 className="mr-1.5 h-3.5 w-3.5" />Remove</Button>}
      </div>
      <p className="mt-1 text-slate">PNG, JPG or WebP, under 2 MB. Best on a white or clear background.</p>
      {note && <p className="mt-1 text-slate">{note}</p>}
    </div>
  );
}

/** Admin > Branches: the godown's own signature, printed only when the order's channel partner has none. */
export function GodownSignatureField({ branch }: { branch: Branch }) {
  return (
    <SignatureUploadField
      title="Godown signature (spare)"
      initialPath={branch.signaturePath ?? null}
      newObjectPath={() => godownSignatureObject(branch.id)}
      save={async (next) => {
        const { error } = await supabase.from("branches").update({ signature_path: next }).eq("id", branch.id);
        if (error) throw new Error(error.message);
      }}
      empty="None: the blank signature line is printed when the partner has no signature."
      savedDescription="Printed on this godown's invoices whose channel partner has no signature."
      note="Each channel partner's own signature is set in Admin > Channel Partners and comes first."
    />
  );
}

/** Admin > Channel Partners: the partner's signature, printed on the invoices of the orders placed while they ran the godown. */
export function PartnerSignatureField({ partner, onSaved }: { partner: { id: string; name: string; signature_path: string | null }; onSaved?: () => void }) {
  return (
    <SignatureUploadField
      title="Signature on invoices"
      initialPath={partner.signature_path ?? null}
      newObjectPath={() => partnerSignatureObject(partner.id)}
      save={async (next) => {
        const { error } = await supabase.from("channel_partners").update({ signature_path: next }).eq("id", partner.id);
        if (error) throw new Error(error.message);
        onSaved?.();
      }}
      empty="None yet: the godown's spare signature, else a blank signature line, is printed."
      savedDescription={`Printed on the invoices of the orders placed while ${partner.name} runs this godown, and shown in their app.`}
      note="It stays on this partner's invoices after a change of partner. Only admins can change it."
    />
  );
}
