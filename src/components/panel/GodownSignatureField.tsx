import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { PenLine, Trash2, Upload } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { GODOWN_SIGNATURE_BUCKET, SIGNATURE_TYPES, signatureFileProblem, signatureToPng } from "@/lib/godown-signature";
import type { Branch } from "@/lib/branches";
import { Button } from "@/components/ui/button";

/** Admin > Branches: the godown's signature (the channel partner's), printed on its invoices. */
export function GodownSignatureField({ branch }: { branch: Branch }) {
  const [path, setPath] = useState(branch.signaturePath ?? null);
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement | null>(null);
  useEffect(() => { setPath(branch.signaturePath ?? null); }, [branch.signaturePath]);
  useEffect(() => {
    let live = true;
    setPreview("");
    if (!path || STATIC_DATA_MODE) return;
    void supabase.storage.from(GODOWN_SIGNATURE_BUCKET).createSignedUrl(path, 600).then(({ data }) => { if (live) setPreview(data?.signedUrl ?? ""); });
    return () => { live = false; };
  }, [path]);

  const save = async (next: string | null) => {
    const { error } = await supabase.from("branches").update({ signature_path: next }).eq("id", branch.id);
    if (error) throw new Error(error.message);
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
      const target = `${branch.id}/${crypto.randomUUID()}.png`;
      const { error } = await supabase.storage.from(GODOWN_SIGNATURE_BUCKET).upload(target, png, { contentType: "image/png", upsert: false });
      if (error) throw new Error(error.message);
      try {
        await save(target);
      } catch (cause) {
        await supabase.storage.from(GODOWN_SIGNATURE_BUCKET).remove([target]);
        throw cause;
      }
      toast.success("Signature saved", { description: "It prints on this godown's invoices from now on." });
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
      await save(null);
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
      <p className="mb-1 flex items-center gap-1.5 font-semibold text-navy"><PenLine className="h-3.5 w-3.5" />Signature on invoices</p>
      <div className="flex flex-wrap items-center gap-2">
        {preview ? <img src={preview} alt="Godown signature" className="h-10 max-w-[150px] rounded border border-border bg-white object-contain p-0.5" />
          : <span className="text-slate">{path ? "Loading…" : "None yet: the blank signature line is printed."}</span>}
        <input ref={picker} type="file" accept={SIGNATURE_TYPES.join(",")} className="hidden" aria-label="Choose signature picture" onChange={(event) => void choose(event.target.files?.[0])} />
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => picker.current?.click()}><Upload className="mr-1.5 h-3.5 w-3.5" />{busy ? "Saving…" : has ? "Replace" : "Upload"}</Button>
        {has && <Button type="button" size="sm" variant="outline" className="text-danger hover:border-danger" disabled={busy} onClick={() => void remove()}><Trash2 className="mr-1.5 h-3.5 w-3.5" />Remove</Button>}
      </div>
      <p className="mt-1 text-slate">PNG, JPG or WebP, under 2 MB. Best on a white or clear background.</p>
    </div>
  );
}
