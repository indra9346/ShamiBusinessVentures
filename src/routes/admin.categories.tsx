import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Layers, Package, Percent, Plus, Tags, Trash2, Pencil } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel, StatCard, StatusBadge } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { categories as seedCategories, categorySales } from "@/lib/data";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

export const Route = createFileRoute("/admin/categories")({
  head: () => ({
    meta: [
      { title: "Categories | Shami Business Ventures Admin" },
      { name: "description", content: "Manage marketplace categories, subcategories and revenue share." },
      { property: "og:title", content: "Categories | Shami Admin" },
      { property: "og:description", content: "Manage product categories and subcategories." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminCategories,
});

type Cat = { name: string; icon: string; subs: string[]; count: number; status: string };

function AdminCategories() {
  const { products } = useApp();
  const [cats, setCats] = useState<Cat[]>(() => seedCategories.map((c) => ({ ...c, status: "Active" })));
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Cat | null>(null);
  const [form, setForm] = useState({ name: "", subs: "", status: "Active" });

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of products) m[p.category] = (m[p.category] ?? 0) + 1;
    return m;
  }, [products]);

  const shareMap = useMemo(() => {
    const m: Record<string, number> = {};
    for (const c of categorySales) m[c.name] = c.value;
    return m;
  }, []);

  const startAdd = () => {
    setEditing(null);
    setForm({ name: "", subs: "", status: "Active" });
    setOpen(true);
  };
  const startEdit = (c: Cat) => {
    setEditing(c);
    setForm({ name: c.name, subs: c.subs.join(", "), status: c.status });
    setOpen(true);
  };

  const save = () => {
    if (!form.name.trim()) {
      toast.error("Category name is required");
      return;
    }
    const subs = form.subs.split(",").map((s) => s.trim()).filter(Boolean);
    if (editing) {
      setCats((l) => l.map((c) => (c.name === editing.name ? { ...c, name: form.name, subs, status: form.status } : c)));
      toast.success(`Category "${form.name}" updated`);
    } else {
      setCats((l) => [{ name: form.name, icon: "Tags", subs, count: 0, status: form.status }, ...l]);
      toast.success(`Category "${form.name}" created`);
    }
    setOpen(false);
  };

  const remove = (name: string) => {
    setCats((l) => l.filter((c) => c.name !== name));
    toast.success(`Category "${name}" deleted`);
  };

  return (
    <PanelLayout items={adminNav} tone="admin" title="Categories" subtitle="Organise the product catalogue">
      <div className="mb-6 flex items-center justify-between gap-3">
        <div className="grid flex-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Total Categories" value={String(cats.length)} icon={Tags} />
          <StatCard label="Total Subcategories" value={String(cats.reduce((s, c) => s + c.subs.length, 0))} icon={Layers} />
          <StatCard label="Total Products" value={String(products.length)} icon={Package} />
          <StatCard label="Top Category Share" value={`${categorySales[0]?.value ?? 0}%`} icon={Percent} highlight />
        </div>
      </div>

      <div className="mb-6 flex justify-end">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="bg-navy text-white hover:bg-navy/90" onClick={startAdd}>
              <Plus className="mr-1 h-4 w-4" /> Add Category
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editing ? "Edit Category" : "Add Category"}</DialogTitle>
            </DialogHeader>
            <div className="grid gap-4 py-2">
              <div className="grid gap-1.5">
                <Label>Category Name</Label>
                <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
              </div>
              <div className="grid gap-1.5">
                <Label>Subcategories (comma separated)</Label>
                <Textarea value={form.subs} onChange={(e) => setForm((f) => ({ ...f, subs: e.target.value }))} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button className="bg-navy text-white hover:bg-navy/90" onClick={save}>Save</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cats.map((c) => (
          <div key={c.name} className="rounded-lg border border-border bg-card p-5 shadow-card">
            <div className="flex items-start justify-between">
              <div>
                <p className="font-bold text-navy">{c.name}</p>
                <p className="text-xs text-slate">{c.subs.length} subcategories</p>
              </div>
              <StatusBadge status={c.status} />
            </div>
            <p className="mt-3 text-2xl font-bold text-navy">{counts[c.name] ?? c.count}</p>
            <p className="text-xs text-slate">products · {shareMap[c.name] ?? 0}% revenue share</p>
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="outline" onClick={() => startEdit(c)}>
                <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button size="sm" variant="outline" className="text-danger hover:text-danger">
                    <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete "{c.name}"?</AlertDialogTitle>
                    <AlertDialogDescription>This will remove the category. This action cannot be undone.</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => remove(c.name)}>Delete</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        ))}
      </div>

      <Panel title="All Categories">
        <DataTable
          columns={["Category", "Subcategories", "Products", "Revenue Share", "Status"]}
          rows={cats.map((c) => [
            <span className="font-semibold text-navy">{c.name}</span>,
            <span className="text-xs text-slate">{c.subs.join(", ")}</span>,
            counts[c.name] ?? c.count,
            `${shareMap[c.name] ?? 0}%`,
            <StatusBadge status={c.status} />,
          ])}
        />
      </Panel>
    </PanelLayout>
  );
}
