import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState, type ChangeEvent } from "react";
import { toast } from "sonner";
import { Layers, Package, Plus, Tags, Trash2, Pencil, ImagePlus } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel, StatCard, StatusBadge } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { storeCategorySeed, type StoreCategory } from "@/lib/data";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { uploadCatalogImage } from "@/lib/catalog-images";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";

export const Route = createFileRoute("/admin/categories")({
  head: () => ({ meta: [{ title: "Categories | Shami Business Ventures Admin" }, { name: "description", content: "Manage marketplace categories, images and subcategories." }, { name: "robots", content: "noindex" }] }),
  component: AdminCategories,
});

function AdminCategories() {
  const { categories, products, addCategory, updateCategory, deleteCategory } = useApp();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<StoreCategory | null>(null);
  const [imageUploading, setImageUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", tagline: "", subs: "", image: "", enabled: true });
  const ordered = useMemo(() => [...categories].sort((a, b) => a.order - b.order), [categories]);
  const counts = useMemo(() => products.reduce<Record<string, number>>((m, p) => ({ ...m, [p.category]: (m[p.category] ?? 0) + 1 }), {}), [products]);

  const startAdd = () => { setEditing(null); setForm({ name: "", tagline: "", subs: "", image: "", enabled: true }); setOpen(true); };
  const startEdit = (category: StoreCategory) => { setEditing(category); setForm({ name: category.name, tagline: category.tagline, subs: category.grades.join(", "), image: category.image, enabled: category.enabled }); setOpen(true); };
  const chooseImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setImageUploading(true);
    try {
      const url = await uploadCatalogImage(file, "categories");
      setForm((current) => ({ ...current, image: url }));
    } catch (error) {
      toast.error("Could not upload this category image", { description: error instanceof Error ? error.message : "Try again." });
    } finally {
      setImageUploading(false);
      event.target.value = "";
    }
  };
  const save = async () => {
    const name = form.name.trim();
    if (!name) { toast.error("Category name is required"); return; }
    const grades = [...new Set(form.subs.split(",").map((s) => s.trim()).filter(Boolean))];
    if (!grades.length) { toast.error("Add at least one subcategory"); return; }
    const image = form.image || (STATIC_DATA_MODE ? storeCategorySeed[0]!.image : "");
    if (!image) { toast.error("Choose an image for this category"); return; }
    setSaving(true);
    try {
      const patch = { name, tagline: form.tagline.trim() || `${name} products`, grades, image, enabled: form.enabled };
      const saved = editing ? await updateCategory(editing.id, patch) : await addCategory(patch);
      if (!saved) return;
      toast.success(`Category “${name}” ${editing ? "updated" : "created"}`);
      setOpen(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <PanelLayout items={adminNav} tone="admin" title="Categories" subtitle="Manage storefront categories, images and subcategories">
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard label="Total Categories" value={String(categories.length)} icon={Tags} />
        <StatCard label="Total Subcategories" value={String(categories.reduce((sum, c) => sum + c.grades.length, 0))} icon={Layers} />
        <StatCard label="Total Products" value={String(products.length)} icon={Package} />
      </div>
      <div className="mb-6 flex justify-end">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button className="bg-navy text-white hover:bg-navy/90" onClick={startAdd}><Plus className="mr-1 h-4 w-4" /> Add Category</Button></DialogTrigger>
          <DialogContent className="max-h-[90vh] overflow-y-auto">
            <DialogHeader><DialogTitle>{editing ? "Edit Category" : "Add Category"}</DialogTitle></DialogHeader>
            <div className="grid gap-4 py-2">
              <div className="grid gap-1.5"><Label>Category Name</Label><Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></div>
              <div className="grid gap-1.5"><Label>Description</Label><Input value={form.tagline} onChange={(e) => setForm((f) => ({ ...f, tagline: e.target.value }))} /></div>
              <div className="grid gap-1.5"><Label>Subcategories (comma separated)</Label><Textarea placeholder="Raw Rice, Steam Rice" value={form.subs} onChange={(e) => setForm((f) => ({ ...f, subs: e.target.value }))} /></div>
              <div className="grid gap-2"><Label>Category image</Label><label className={`flex items-center justify-center gap-2 rounded-md border border-dashed border-gold/70 p-3 text-sm font-semibold text-navy ${imageUploading ? "cursor-wait opacity-60" : "cursor-pointer hover:bg-ivory"}`}><ImagePlus className="h-4 w-4" /> {imageUploading ? "Uploading…" : form.image ? "Change image" : "Browse local files"}<input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" disabled={imageUploading || saving} onChange={(event) => void chooseImage(event)} /></label>{form.image && <img src={form.image} alt="Category preview" className="h-36 w-full rounded-md border object-cover" />}</div>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))} /> Show on storefront</label>
            </div>
            <DialogFooter><Button variant="outline" disabled={saving || imageUploading} onClick={() => setOpen(false)}>Cancel</Button><Button className="bg-navy text-white hover:bg-navy/90" disabled={saving || imageUploading} onClick={() => void save()}>{saving ? "Saving…" : "Save Category"}</Button></DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {ordered.map((c) => <div key={c.id} className="overflow-hidden rounded-lg border border-border bg-card shadow-card"><img src={c.image} alt={c.name} className="h-36 w-full object-cover" /><div className="p-4"><div className="flex items-start justify-between gap-2"><div><p className="font-bold text-navy">{c.name}</p><p className="text-xs text-slate">{c.grades.length} subcategories</p></div><StatusBadge status={c.enabled ? "Active" : "Hidden"} /></div><p className="mt-2 text-2xl font-bold text-navy">{counts[c.name] ?? 0}</p><p className="text-xs text-slate">products</p><p className="mt-2 text-xs text-slate">{c.grades.join(" · ")}</p><div className="mt-3 flex gap-2"><Button size="sm" variant="outline" onClick={() => startEdit(c)}><Pencil className="mr-1 h-3.5 w-3.5" /> Edit</Button><AlertDialog><AlertDialogTrigger asChild><Button size="sm" variant="outline" className="text-danger hover:text-danger"><Trash2 className="mr-1 h-3.5 w-3.5" /> Delete</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Delete “{c.name}”?</AlertDialogTitle><AlertDialogDescription>Products assigned to this category are retained but may no longer appear in storefront category filters.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={async () => { if (await deleteCategory(c.id)) toast.success(`Category “${c.name}” deleted`); }}>Delete</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></div></div></div>)}
      </div>
      <Panel title="All Categories"><DataTable columns={["Category", "Subcategories", "Products", "Visibility"]} rows={ordered.map((c) => [<span className="font-semibold text-navy">{c.name}</span>, <span className="text-xs text-slate">{c.grades.join(", ")}</span>, counts[c.name] ?? 0, <StatusBadge status={c.enabled ? "Active" : "Hidden"} />])} /></Panel>
      <p className="mt-2 text-xs text-slate">Category and product counts reflect the connected Supabase catalog.</p>
    </PanelLayout>
  );
}
