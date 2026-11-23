import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState, type ChangeEvent, type Dispatch, type SetStateAction } from "react";
import { toast } from "sonner";
import { AlertTriangle, Archive, ArrowUp, Hash, ImagePlus, Lock, PackageCheck, PackageX, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel, scrollToSection, StatCard, StatusBadge } from "@/components/panel/widgets";
import { Pager } from "@/components/panel/pager";
import { adminNav } from "@/lib/panel-nav";
import { isZohoMirrorProduct, type Product } from "@/lib/data";
import { useApp } from "@/lib/store";
import {
  createCodePart,
  createCodeSet,
  createProductCode,
  setCodePartRetired,
  setProductCodeRetired,
  updateCodePart,
  updateCodeSet,
  updateProductCode,
  codeListErrorText,
  uploadCodeImage,
  useCodeMaster,
} from "@/lib/product-codes";
import {
  activePartsOfSet,
  buildCode,
  codeDetailsProblem,
  codePartProblem,
  codeSetProblem,
  codesOfPair,
  codesOfPart,
  isCodeLetter,
  letterLocked,
  newCodePreview,
  partsOfSet,
  productsWithCode,
  productsWithoutCode,
  setForCategory,
  type CodeMaster,
  type CodePart,
  type CodePartKind,
  type CodeSet,
  type CodeSetInput,
  type MasterCode,
} from "@/lib/product-code-rules";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type Search = { category?: string };
const codeListSearch = (search: Record<string, unknown>): Search => {
  const category = search["category"];
  return typeof category === "string" && category.trim() ? { category: category.trim() } : {};
};

export const Route = createFileRoute("/admin/product-codes")({
  validateSearch: codeListSearch,
  head: () => ({
    meta: [
      { title: "Product Codes | Shami Business Ventures Admin" },
      { name: "description", content: "Keep the master list of product names and codes for each category." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminProductCodes,
});

const PAGE_SIZE = 10;
const MAX_IMAGES = 8;
const OWN_SUBCATEGORY = "__own_subcategory__";
const IMAGE_URL = /^(https?:\/\/\S+|data:image\/\S+)$/i;

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const reasonOf = (cause: unknown) => (cause instanceof Error ? cause.message : "Please try again.");
const lettersOnly = (raw: string) => raw.toUpperCase().replace(/[^A-Z]/g, "");
const labelOf = (set: CodeSet, kind: CodePartKind) => (kind === "method" ? set.firstLabel : set.secondLabel);
const stickyActions = "sticky right-0 z-[1] whitespace-nowrap bg-card text-right shadow-[-8px_0_12px_-10px_rgba(60,45,20,0.25)]";
const packOf = (product: Product) => product.weight || "Not set";

/** A set's codes in the workbook's order: by method, then variety, then serial. */
function codesInOrder(master: CodeMaster, setId: string) {
  const place = (parts: CodePart[], id: string) => parts.find((part) => part.id === id)?.sortOrder ?? 0;
  return master.codes
    .filter((code) => code.setId === setId)
    .sort((a, b) => place(master.methods, a.methodId) - place(master.methods, b.methodId)
      || place(master.varieties, a.varietyId) - place(master.varieties, b.varietyId)
      || a.serial - b.serial);
}

function CodeChip({ code, retired }: { code: string; retired?: boolean }) {
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-xs font-bold ${retired ? "border-border bg-panel text-slate line-through" : "border-gold/50 bg-ivory text-navy"}`}>
      {code}
    </span>
  );
}

/** The products a change touches, each opening its own page. */
function ProductList({ products }: { products: Product[] }) {
  return (
    <ul className="max-h-48 space-y-1.5 overflow-y-auto">
      {products.map((product) => (
        <li key={product.id}>
          <Link to="/admin/products/$id" params={{ id: product.id }} className="block rounded-md border border-border px-3 py-2 text-sm hover:border-gold">
            <span className="block font-semibold text-navy">{product.name}</span>
            <span className="block text-xs text-slate">{product.sku} · {packOf(product)}{product.productCode ? ` · ${product.productCode}` : ""}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function AdminProductCodes() {
  const { categories, products } = useApp();
  const { master, error, reload } = useCodeMaster();
  const { category: wanted } = codeListSearch(Route.useSearch());
  const navigate = Route.useNavigate();

  const ordered = useMemo(() => [...categories].sort((a, b) => a.order - b.order), [categories]);
  // A set whose category was renamed stays reachable, so it can be moved.
  const choices = useMemo(() => {
    const names = ordered.map((category) => category.name);
    for (const set of master?.sets ?? []) if (!names.some((name) => sameName(name, set.category))) names.push(set.category);
    return names;
  }, [ordered, master]);
  const selected = (wanted ? choices.find((name) => sameName(name, wanted)) ?? wanted : undefined)
    ?? choices.find((name) => sameName(name, "Rice")) ?? choices[0] ?? "Rice";
  const options = choices.some((name) => sameName(name, selected)) ? choices : [...choices, selected];
  const set = master ? setForCategory(master, selected) : undefined;
  const grades = ordered.find((category) => sameName(category.name, selected))?.grades ?? [];
  const categoryExists = ordered.length === 0 || ordered.some((category) => sameName(category.name, selected));

  const [codeQ, setCodeQ] = useState("");
  const [codeStatus, setCodeStatus] = useState<"active" | "retired" | "all">("active");
  const [codePage, setCodePage] = useState(1);
  const [productQ, setProductQ] = useState("");
  const [productView, setProductView] = useState<"without" | "with">("without");
  const [productPage, setProductPage] = useState(1);

  const [partDialog, setPartDialog] = useState<{ kind: CodePartKind; id?: string } | null>(null);
  const [retiringPart, setRetiringPart] = useState<{ kind: CodePartKind; id: string } | null>(null);
  const [newCode, setNewCode] = useState<{ methodId: string; varietyId: string } | null>(null);
  const [editCodeId, setEditCodeId] = useState<string | null>(null);
  const [retiringCodeId, setRetiringCodeId] = useState<string | null>(null);
  const [productsOfCodeId, setProductsOfCodeId] = useState<string | null>(null);
  const [editingSet, setEditingSet] = useState(false);

  const chooseCategory = (category: string) => {
    void navigate({ search: { category }, replace: true });
    setCodeQ("");
    setCodePage(1);
    setProductQ("");
    setProductPage(1);
  };

  const ownProducts = useMemo(() => products.filter((product) => !isZohoMirrorProduct(product)), [products]);
  const inCategory = useMemo(() => ownProducts.filter((product) => sameName(product.category, selected)), [ownProducts, selected]);
  const withoutCode = useMemo(() => productsWithoutCode(inCategory), [inCategory]);
  const withCode = useMemo(() => inCategory.filter((product) => !!product.productCode), [inCategory]);

  const setCodes = useMemo(() => (master && set ? codesInOrder(master, set.id) : []), [master, set]);
  const activeCount = setCodes.filter((code) => !code.retiredAt).length;
  const retiredCount = setCodes.length - activeCount;

  const filteredCodes = useMemo(() => {
    const q = codeQ.trim().toLowerCase();
    return setCodes.filter((code) =>
      (codeStatus === "all" || (codeStatus === "retired" ? !!code.retiredAt : !code.retiredAt))
      && (!q || `${code.code} ${code.name} ${code.subcategory}`.toLowerCase().includes(q)));
  }, [setCodes, codeQ, codeStatus]);
  const codePages = Math.max(1, Math.ceil(filteredCodes.length / PAGE_SIZE));
  const codePageSafe = Math.min(codePage, codePages);
  const codeRows = filteredCodes.slice((codePageSafe - 1) * PAGE_SIZE, codePageSafe * PAGE_SIZE);

  const filteredProducts = useMemo(() => {
    const q = productQ.trim().toLowerCase();
    return (productView === "with" ? withCode : withoutCode).filter((product) =>
      !q || `${product.name} ${product.sku} ${product.productCode ?? ""}`.toLowerCase().includes(q));
  }, [productView, withCode, withoutCode, productQ]);
  const productPages = Math.max(1, Math.ceil(filteredProducts.length / PAGE_SIZE));
  const productPageSafe = Math.min(productPage, productPages);
  const productRows = filteredProducts.slice((productPageSafe - 1) * PAGE_SIZE, productPageSafe * PAGE_SIZE);

  const openCodes = (status: "active" | "retired") => {
    setCodeQ("");
    setCodeStatus(status);
    setCodePage(1);
    scrollToSection(set ? "code-list" : "start-code-set");
  };
  const openProducts = (view: "without" | "with") => {
    setProductQ("");
    setProductView(view);
    setProductPage(1);
    scrollToSection("category-products");
  };

  /** Runs one change, refreshes the list and says how it went. */
  const act = async (done: string, work: () => Promise<unknown>, description?: string) => {
    try {
      await work();
      await reload();
      toast.success(done, description ? { description } : undefined);
      return true;
    } catch (cause) {
      toast.error("Could not save this", { description: reasonOf(cause) });
      return false;
    }
  };

  const editingCode = master?.codes.find((code) => code.id === editCodeId);
  const retiringCode = master?.codes.find((code) => code.id === retiringCodeId);
  const productsOfCode = master?.codes.find((code) => code.id === productsOfCodeId);

  return (
    <PanelLayout items={adminNav} tone="admin" title="Product Codes" subtitle="Names and codes for your products, kept by category">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="w-full sm:w-72">
          <Label htmlFor="code-category">Category</Label>
          <Select value={options.find((name) => sameName(name, selected)) ?? selected} onValueChange={chooseCategory}>
            <SelectTrigger id="code-category" className="h-10">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <Link to="/admin/products" className="text-sm font-semibold text-navy hover:text-gold">← Back to Products</Link>
      </div>

      {master && (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
          <StatCard compact onClick={() => openCodes("active")} label="Active codes" value={String(activeCount)} icon={Hash} highlight />
          <StatCard compact onClick={() => openCodes("retired")} label="Retired codes" value={String(retiredCount)} icon={Archive} />
          <StatCard compact onClick={() => openProducts("with")} label="Products with a code" value={String(withCode.length)} icon={PackageCheck} />
          <StatCard compact onClick={() => openProducts("without")} label="Products without a code" value={String(withoutCode.length)} icon={PackageX} />
        </div>
      )}

      {error && master && (
        <p role="alert" className="mt-4 flex flex-wrap items-center gap-2 rounded-md border border-gold/40 bg-ivory px-3 py-2 text-sm text-navy">
          <AlertTriangle className="h-4 w-4 shrink-0 text-gold" aria-hidden="true" />
          <span className="min-w-0 flex-1">The list could not be refreshed: {error}</span>
          <Button size="sm" variant="outline" className="h-9" onClick={() => void reload()}>Try again</Button>
        </p>
      )}

      {!master && !error && (
        <Panel className="mt-6">
          <p className="py-10 text-center text-sm text-slate">Loading the product codes…</p>
        </Panel>
      )}

      {!master && error && (
        <Panel className="mt-6" title="The product codes could not load">
          <p className="text-sm text-charcoal">
            {codeListErrorText(error) !== error
              ? "The product code list is not set up on this database yet. The rest of the site keeps working as before. It starts working once the database step in the go-live notes is done."
              : error}
          </p>
          <Button className="mt-3 h-10" variant="outline" onClick={() => void reload()}>Try again</Button>
        </Panel>
      )}

      {master && !set && (categoryExists ? (
        <StartSetPanel key={selected} master={master} category={selected} onStart={(input) => act(`Code set started for ${selected}`, () => createCodeSet(input), "Now add its first letters below.")} />
      ) : (
        <Panel className="mt-6" title="No such category">
          <p className="text-sm text-charcoal">There is no category called {selected}. Choose one above, or add it in Categories first.</p>
        </Panel>
      ))}

      {master && set && (
        <>
          <Panel
            className="mt-6"
            title="How these codes are built"
            action={<Button size="sm" variant="outline" className="h-9" onClick={() => setEditingSet(true)}><Pencil className="mr-1.5 h-3.5 w-3.5" /> Edit set</Button>}
          >
            <p className="text-sm text-charcoal">
              Code = {set.prefix ? <><span className="font-semibold">prefix {set.prefix}</span> + </> : null}
              <span className="font-semibold">{set.firstLabel} letter</span> + <span className="font-semibold">{set.secondLabel} letter</span> + <span className="font-semibold">serial</span>.
              {setCodes[0] && <> For example <CodeChip code={setCodes[0].code} /> is {setCodes[0].name}.</>}
            </p>
            <p className="mt-2 text-xs text-slate">Codes are printed and spoken, so a code never changes once it is made, and a retired code is never used again.</p>
            {ordered.length > 0 && !ordered.some((category) => sameName(category.name, set.category)) && (
              <div role="alert" className="mt-3 rounded-md border border-gold/40 bg-ivory p-3 text-sm text-navy">
                <p className="flex items-start gap-2 font-semibold"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-gold" aria-hidden="true" /> This set is for “{set.category}”, but no category has that name any more.</p>
                <p className="mt-1 text-xs text-charcoal">The Add Product form won't find these codes until the set is moved to the right category.</p>
                <div className="mt-2 w-full sm:w-64">
                  <Label htmlFor="move-code-set" className="text-xs">Move this set to</Label>
                  <Select
                    onValueChange={(category) => {
                      void act(`Code set moved to ${category}`, () => updateCodeSet(set.id, { category, prefix: set.prefix, firstLabel: set.firstLabel, secondLabel: set.secondLabel, brand: set.brand }))
                        .then((ok) => { if (ok) chooseCategory(category); });
                    }}
                  >
                    <SelectTrigger id="move-code-set" className="h-10"><SelectValue placeholder="Choose a category" /></SelectTrigger>
                    <SelectContent>
                      {ordered.filter((category) => !setForCategory(master, category.name)).map((category) => (
                        <SelectItem key={category.id} value={category.name}>{category.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
          </Panel>

          <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
            {(["method", "variety"] as const).map((kind) => (
              <PartsPanel
                key={kind}
                master={master}
                set={set}
                kind={kind}
                onNew={() => setPartDialog({ kind })}
                onEdit={(id) => setPartDialog({ kind, id })}
                onRetire={(id) => setRetiringPart({ kind, id })}
                onRestore={(part) => void act(`${part.name} restored`, () => setCodePartRetired(kind, part.id, false), "Codes retired together with it are back too. Any retired on their own stay retired.")}
              />
            ))}
          </div>

          <CodeMatrix master={master} set={set} onEdit={setEditCodeId} onAdd={(methodId, varietyId) => setNewCode({ methodId, varietyId })} />

          <Panel
            id="code-list"
            title="All codes"
            className="mt-6"
            action={
              <>
                <Input
                  placeholder="Search code or name"
                  aria-label="Search code or name"
                  value={codeQ}
                  onChange={(e) => { setCodeQ(e.target.value); setCodePage(1); }}
                  className="h-10 w-full sm:w-52"
                />
                <Select value={codeStatus} onValueChange={(v) => { setCodeStatus(v as "active" | "retired" | "all"); setCodePage(1); }}>
                  <SelectTrigger className="h-10 w-full sm:w-36" aria-label="Show codes"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="retired">Retired</SelectItem>
                    <SelectItem value="all">All</SelectItem>
                  </SelectContent>
                </Select>
              </>
            }
          >
            <DataTable
              minWidth={760}
              empty={codeStatus === "retired" ? "No retired codes" : "No codes found"}
              columns={["Code", "Name", "Subcategory", "Images", "Products", "Status", "Actions"]}
              columnClassNames={["whitespace-nowrap", "min-w-[200px]", "min-w-[110px]", "whitespace-nowrap", "whitespace-nowrap", "whitespace-nowrap", stickyActions]}
              rows={codeRows.map((code) => {
                const carrying = productsWithCode(ownProducts, code.code).length;
                return [
                  <CodeChip code={code.code} retired={!!code.retiredAt} />,
                  <span className="font-medium text-charcoal">{code.name}</span>,
                  <span className="text-xs text-slate">{code.subcategory}</span>,
                  code.images[0] ? (
                    <span className="inline-flex items-center gap-2 text-xs text-slate">
                      <img src={code.images[0]} alt="" loading="lazy" className="h-10 w-10 rounded-md border border-border object-cover" />
                      {code.images.length}
                    </span>
                  ) : <span className="text-xs text-slate">None</span>,
                  carrying > 0 ? (
                    <Button size="sm" variant="outline" className="h-9" aria-label={`Show ${carrying} products with code ${code.code}`} onClick={() => setProductsOfCodeId(code.id)}>{carrying}</Button>
                  ) : <span className="text-xs text-slate">0</span>,
                  <StatusBadge status={code.retiredAt ? "Retired" : "Active"} />,
                  <div className="inline-flex items-center gap-1">
                    <Button variant="outline" size="icon" className="h-9 w-9" title={code.retiredAt ? "View" : "Edit"} aria-label={`${code.retiredAt ? "View" : "Edit"} ${code.code}`} onClick={() => setEditCodeId(code.id)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    {code.retiredAt ? (
                      <Button variant="outline" size="icon" className="h-9 w-9" title="Restore" aria-label={`Restore ${code.code}`} onClick={() => void act(`${code.code} restored`, () => setProductCodeRetired(code.id, false))}>
                        <RotateCcw className="h-3.5 w-3.5" />
                      </Button>
                    ) : (
                      <Button variant="outline" size="icon" className="h-9 w-9 text-danger hover:text-danger" title="Retire" aria-label={`Retire ${code.code}`} onClick={() => setRetiringCodeId(code.id)}>
                        <Archive className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>,
                ];
              })}
            />
            <Pager page={codePageSafe} pages={codePages} onPage={setCodePage} total={filteredCodes.length} />
          </Panel>
        </>
      )}

      {master && (
        <Panel
          id="category-products"
          title={productView === "with" ? `${selected} products with a code` : `${selected} products without a code`}
          className="mt-6"
          action={
            <>
              <div className="inline-flex rounded-md border border-border p-0.5" role="group" aria-label="Which products to show">
                {(["without", "with"] as const).map((view) => (
                  <button
                    key={view}
                    type="button"
                    aria-pressed={productView === view}
                    onClick={() => { setProductView(view); setProductPage(1); }}
                    className={`h-9 rounded px-3 text-xs font-semibold ${productView === view ? "bg-navy text-white" : "text-navy hover:bg-ivory"}`}
                  >
                    {view === "with" ? `With a code (${withCode.length})` : `Without a code (${withoutCode.length})`}
                  </button>
                ))}
              </div>
              <Input
                placeholder="Search name or SKU"
                aria-label="Search name or SKU"
                value={productQ}
                onChange={(e) => { setProductQ(e.target.value); setProductPage(1); }}
                className="h-10 w-full sm:w-52"
              />
            </>
          }
        >
          <p className="mb-3 text-xs text-slate">Link a code opens the product page. Nothing on the product changes until you save there. Zoho-imported copies are not listed.</p>
          <DataTable
            minWidth={600}
            empty={productView === "with" ? "No products carry a code yet" : "Every product here has a code"}
            columns={["Product", "SKU", "Pack", "Code"]}
            columnClassNames={["min-w-[180px]", "whitespace-nowrap", "whitespace-nowrap", stickyActions]}
            rows={productRows.map((product) => {
              const code = master.codes.find((row) => row.code === product.productCode);
              return [
                <Link to="/admin/products/$id" params={{ id: product.id }} className="font-semibold text-navy hover:text-gold">{product.name}</Link>,
                <span className="font-mono text-xs text-slate">{product.sku}</span>,
                <span className="text-xs text-slate">{packOf(product)}</span>,
                product.productCode ? (
                  <div className="inline-flex items-center gap-2">
                    <CodeChip code={product.productCode} retired={!!code?.retiredAt} />
                    <Button asChild size="sm" variant="outline" className="h-9">
                      <Link to="/admin/products/$id" params={{ id: product.id }} hash="product-code">Change</Link>
                    </Button>
                  </div>
                ) : (
                  <Button asChild size="sm" className="h-9 bg-navy text-white hover:bg-navy/90">
                    <Link to="/admin/products/$id" params={{ id: product.id }} hash="product-code">Link a code</Link>
                  </Button>
                ),
              ];
            })}
          />
          <Pager page={productPageSafe} pages={productPages} onPage={setProductPage} total={filteredProducts.length} />
        </Panel>
      )}

      {master && set && editingSet && (
        <EditSetDialog
          master={master}
          set={set}
          onClose={() => setEditingSet(false)}
          onSave={(input) => act("Code set updated", () => updateCodeSet(set.id, input))}
        />
      )}
      {master && set && partDialog && (
        <PartDialog
          key={`${partDialog.kind}-${partDialog.id ?? "new"}`}
          master={master}
          set={set}
          kind={partDialog.kind}
          {...(partDialog.id ? { partId: partDialog.id } : {})}
          products={ownProducts}
          onClose={() => setPartDialog(null)}
          onSave={(input, part) => act(
            part ? `${input.name} saved` : `${input.name} added`,
            () => (part ? updateCodePart(partDialog.kind, part.id, set.id, input) : createCodePart(partDialog.kind, set.id, input)),
            part ? undefined : "Now make its codes in the matrix with the + buttons.",
          )}
        />
      )}
      {master && set && retiringPart && (
        <RetirePartDialog
          master={master}
          set={set}
          kind={retiringPart.kind}
          partId={retiringPart.id}
          products={ownProducts}
          onClose={() => setRetiringPart(null)}
          onConfirm={(part) => act(`${part.name} retired`, () => setCodePartRetired(retiringPart.kind, part.id, true))}
        />
      )}
      {master && set && newCode && (
        <NewCodeDialog
          key={`${newCode.methodId}-${newCode.varietyId}`}
          master={master}
          set={set}
          methodId={newCode.methodId}
          varietyId={newCode.varietyId}
          grades={grades}
          onClose={() => setNewCode(null)}
          onCreate={async (details) => {
            try {
              const made = await createProductCode(set.id, newCode.methodId, newCode.varietyId, details);
              await reload();
              toast.success(`Code ${made.code} added`, { action: { label: "Add images", onClick: () => setEditCodeId(made.id) } });
              return true;
            } catch (cause) {
              toast.error("Could not add this code", { description: reasonOf(cause) });
              return false;
            }
          }}
        />
      )}
      {master && set && editingCode && (
        <CodeEditDialog
          key={editingCode.id}
          master={master}
          set={set}
          code={editingCode}
          grades={grades}
          carrying={productsWithCode(ownProducts, editingCode.code).length}
          onClose={() => setEditCodeId(null)}
          onSave={(details) => act(`${editingCode.code} saved`, () => updateProductCode(editingCode.id, details))}
          onRetire={() => { setEditCodeId(null); setRetiringCodeId(editingCode.id); }}
          onRestore={() => act(`${editingCode.code} restored`, () => setProductCodeRetired(editingCode.id, false))}
        />
      )}
      {retiringCode && (
        <RetireCodeDialog
          code={retiringCode}
          products={productsWithCode(ownProducts, retiringCode.code)}
          onClose={() => setRetiringCodeId(null)}
          onConfirm={() => act(`${retiringCode.code} retired`, () => setProductCodeRetired(retiringCode.id, true))}
        />
      )}
      <Dialog open={!!productsOfCode} onOpenChange={(open) => { if (!open) setProductsOfCodeId(null); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle className="pr-6">Products with code {productsOfCode?.code}</DialogTitle></DialogHeader>
          {productsOfCode && <ProductList products={productsWithCode(ownProducts, productsOfCode.code)} />}
        </DialogContent>
      </Dialog>
    </PanelLayout>
  );
}

/* ---------- a category's code set ---------- */

type SetInput = CodeSetInput;

function SetFields({ value, onChange, prefixLocked }: { value: SetInput; onChange: (next: SetInput) => void; prefixLocked: boolean }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="set-first-label">First letter is the</Label>
          <Input id="set-first-label" className="h-10" maxLength={40} value={value.firstLabel} onChange={(e) => onChange({ ...value, firstLabel: e.target.value })} />
        </div>
        <div>
          <Label htmlFor="set-second-label">Second letter is the</Label>
          <Input id="set-second-label" className="h-10" maxLength={40} value={value.secondLabel} onChange={(e) => onChange({ ...value, secondLabel: e.target.value })} />
        </div>
      </div>
      <div>
        <Label htmlFor="set-brand">Brand (optional)</Label>
        <Input id="set-brand" className="h-10 sm:w-64" maxLength={60} value={value.brand} onChange={(e) => onChange({ ...value, brand: e.target.value })} />
        <p className="mt-1 text-xs text-slate">Fills in on new products, and starts the name of each new code, such as Grain Bazar RS02. Codes already made keep their names.</p>
      </div>
      <div>
        <Label htmlFor="set-prefix">Code prefix (optional, up to 3 letters)</Label>
        <Input
          id="set-prefix"
          className="h-10 sm:w-40"
          autoCapitalize="characters"
          disabled={prefixLocked}
          value={value.prefix}
          onChange={(e) => onChange({ ...value, prefix: lettersOnly(e.target.value).slice(0, 3) })}
        />
        <p className="mt-1 text-xs text-slate">
          {prefixLocked
            ? "This set already has codes, so its prefix can no longer change."
            : "A prefix keeps these codes apart from other categories. Rice already uses RS01. With prefix U, a Sugar code reads URS01, so the two can never be mixed up. It can't change once the set has codes."}
        </p>
      </div>
    </div>
  );
}

function StartSetPanel({ master, category, onStart }: { master: CodeMaster; category: string; onStart: (input: SetInput) => Promise<boolean> }) {
  const [input, setInput] = useState<SetInput>({ category, prefix: "", firstLabel: "Method", secondLabel: "Variety", brand: "" });
  const [saving, setSaving] = useState(false);
  const problem = codeSetProblem(master, input);
  return (
    <Panel id="start-code-set" className="mt-6" title={`Start a code set for ${category}`}>
      <p className="mb-3 text-sm text-charcoal">
        {category} has no codes yet, and nothing is made for you. Name the two letter positions here, then add the letters and make only the codes you want.
      </p>
      <SetFields value={input} onChange={setInput} prefixLocked={false} />
      {problem && <p role="alert" className="mt-2 text-xs font-medium text-danger">{problem}</p>}
      <Button
        className="mt-3 h-10 bg-navy text-white hover:bg-navy/90"
        disabled={!!problem || saving}
        onClick={() => { setSaving(true); void onStart(input).finally(() => setSaving(false)); }}
      >
        {saving ? "Starting…" : "Start the code set"}
      </Button>
    </Panel>
  );
}

function EditSetDialog({ master, set, onClose, onSave }: { master: CodeMaster; set: CodeSet; onClose: () => void; onSave: (input: SetInput) => Promise<boolean> }) {
  const [input, setInput] = useState<SetInput>({ category: set.category, prefix: set.prefix, firstLabel: set.firstLabel, secondLabel: set.secondLabel, brand: set.brand });
  const [saving, setSaving] = useState(false);
  const problem = codeSetProblem(master, input, set.id);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle className="pr-6">Code set for {set.category}</DialogTitle></DialogHeader>
        <SetFields value={input} onChange={setInput} prefixLocked={master.codes.some((code) => code.setId === set.id)} />
        {problem && <p role="alert" className="text-xs font-medium text-danger">{problem}</p>}
        <DialogFooter>
          <Button variant="outline" className="h-10" onClick={onClose}>Cancel</Button>
          <Button
            className="h-10 bg-navy text-white hover:bg-navy/90"
            disabled={!!problem || saving}
            onClick={() => { setSaving(true); void onSave(input).then((ok) => { setSaving(false); if (ok) onClose(); }); }}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------- methods and varieties ---------- */

function PartsPanel({ master, set, kind, onNew, onEdit, onRetire, onRestore }: {
  master: CodeMaster;
  set: CodeSet;
  kind: CodePartKind;
  onNew: () => void;
  onEdit: (id: string) => void;
  onRetire: (id: string) => void;
  onRestore: (part: CodePart) => void;
}) {
  const label = labelOf(set, kind);
  const parts = partsOfSet(master, kind, set.id);
  return (
    <Panel
      className="min-w-0"
      title={`${label} letters`}
      action={<Button size="sm" className="h-9 bg-navy text-white hover:bg-navy/90" onClick={onNew}><Plus className="mr-1 h-3.5 w-3.5" /> New {label.toLowerCase()}</Button>}
    >
      {parts.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate">No {label.toLowerCase()} yet. Add the first one.</p>
      ) : (
        <ul className="divide-y divide-border">
          {parts.map((part) => {
            const codes = codesOfPart(master, kind, part.id);
            return (
              <li key={part.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
                <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-md border font-mono text-sm font-bold ${part.retiredAt ? "border-border bg-panel text-slate line-through" : "border-gold/50 bg-ivory text-navy"}`}>{part.letter}</span>
                <div className="min-w-0 flex-1 basis-32">
                  <p className={`font-semibold ${part.retiredAt ? "text-slate" : "text-navy"}`}>{part.name}</p>
                  <p className="text-xs text-slate">{codes.length} {codes.length === 1 ? "code" : "codes"}</p>
                </div>
                <StatusBadge status={part.retiredAt ? "Retired" : "Active"} />
                <div className="inline-flex items-center gap-1">
                  <Button variant="outline" size="icon" className="h-9 w-9" title="Edit" aria-label={`Edit ${part.name}`} onClick={() => onEdit(part.id)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  {part.retiredAt ? (
                    <Button variant="outline" size="icon" className="h-9 w-9" title="Restore" aria-label={`Restore ${part.name}`} onClick={() => onRestore(part)}>
                      <RotateCcw className="h-3.5 w-3.5" />
                    </Button>
                  ) : (
                    <Button variant="outline" size="icon" className="h-9 w-9 text-danger hover:text-danger" title="Retire" aria-label={`Retire ${part.name}`} onClick={() => onRetire(part.id)}>
                      <Archive className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function PartDialog({ master, set, kind, partId, products, onClose, onSave }: {
  master: CodeMaster;
  set: CodeSet;
  kind: CodePartKind;
  partId?: string;
  products: Product[];
  onClose: () => void;
  onSave: (input: { letter: string; name: string }, part: CodePart | undefined) => Promise<boolean>;
}) {
  const part = partId ? partsOfSet(master, kind, set.id).find((row) => row.id === partId) : undefined;
  const label = labelOf(set, kind);
  const [letter, setLetter] = useState(part?.letter ?? "");
  const [name, setName] = useState(part?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [sameThing, setSameThing] = useState(false);
  const locked = !!part && letterLocked(master, kind, part.id);
  const codes = part ? codesOfPart(master, kind, part.id) : [];
  const carrying = products.filter((product) => codes.some((code) => code.code === product.productCode));
  const typed = !!(part || letter || name);
  const problem = codePartProblem(master, kind, set.id, { letter, name }, part?.id);
  const unchanged = !!part && part.letter === letter && part.name === name.trim().replace(/\s+/g, " ");
  // A letter stands for this name in every code using it, so a new name must not mean a different thing.
  const renamingInUse = !!part && codes.length > 0 && part.name !== name.trim().replace(/\s+/g, " ");
  const partners = activePartsOfSet(master, kind === "method" ? "variety" : "method", set.id).slice(0, 5);
  const samples = !isCodeLetter(letter) ? [] : partners.length
    ? partners.map((other) => (kind === "method" ? buildCode(set.prefix, letter, other.letter, 1) : buildCode(set.prefix, other.letter, letter, 1)))
    : [kind === "method" ? `${set.prefix}${letter}?01` : `${set.prefix}?${letter}01`];
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle className="pr-6">{part ? `Edit ${part.name}` : `New ${label.toLowerCase()}`}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="part-letter">Letter</Label>
            <div className="flex items-center gap-2">
              <Input
                id="part-letter"
                className="h-10 w-20 text-center font-mono text-base font-bold"
                autoCapitalize="characters"
                autoComplete="off"
                disabled={locked || !!part?.retiredAt}
                value={letter}
                onChange={(e) => setLetter(lettersOnly(e.target.value).slice(-1))}
              />
              {locked && <Lock className="h-4 w-4 text-slate" aria-label="Letter is locked" />}
            </div>
            {locked ? (
              <p className="mt-1.5 rounded-md bg-ivory p-2 text-xs text-navy">
                Letter {part?.letter} is locked. {codes.length === 1 ? "This code uses" : `These ${codes.length} codes use`} it: {codes.map((code) => code.code).join(", ")}. {carrying.length === 1 ? "1 product carries" : `${carrying.length} products carry`} them. Codes are printed and spoken, so they never change. To use a different letter, retire this {label.toLowerCase()} and create a new one, with the same name if you like.
              </p>
            ) : samples.length > 0 && (
              <p className="mt-1.5 text-xs text-slate">New codes will look like {samples.join(", ")}…</p>
            )}
          </div>
          <div>
            <Label htmlFor="part-name">Name</Label>
            <Input id="part-name" className="h-10" maxLength={80} disabled={!!part?.retiredAt} value={name} onChange={(e) => setName(e.target.value)} />
            {part?.retiredAt
              ? <p className="mt-1 text-xs text-slate">Retired, so its letter and name stay as they were. Restore it to change the name.</p>
              : part && <p className="mt-1 text-xs text-slate">A new name shows in the dropdowns. Codes and products already made keep the names they have.</p>}
          </div>
          {renamingInUse && (
            <label className="flex items-start gap-2 rounded-md border border-gold/40 bg-ivory p-2 text-xs text-navy">
              <input type="checkbox" className="mt-0.5" checked={sameThing} onChange={(e) => setSameThing(e.target.checked)} />
              <span>Letter {part?.letter} in {codes.map((code) => code.code).join(", ")} will now stand for {name.trim() || "this name"}. Yes, it is the same {label.toLowerCase()} and only the name changes. For a different {label.toLowerCase()}, retire this one and create a new one instead.</span>
            </label>
          )}
          {typed && problem && <p role="alert" className="text-xs font-medium text-danger">{problem}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" className="h-10" onClick={onClose}>Cancel</Button>
          <Button
            className="h-10 bg-navy text-white hover:bg-navy/90"
            disabled={!!problem || saving || unchanged || (renamingInUse && !sameThing)}
            onClick={() => { setSaving(true); void onSave({ letter, name: name.trim().replace(/\s+/g, " ") }, part).then((ok) => { setSaving(false); if (ok) onClose(); }); }}
          >
            {saving ? "Saving…" : part ? "Save" : `Add ${label.toLowerCase()}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RetirePartDialog({ master, set, kind, partId, products, onClose, onConfirm }: {
  master: CodeMaster;
  set: CodeSet;
  kind: CodePartKind;
  partId: string;
  products: Product[];
  onClose: () => void;
  onConfirm: (part: CodePart) => Promise<boolean>;
}) {
  const part = partsOfSet(master, kind, set.id).find((row) => row.id === partId);
  if (!part) return null;
  const codes = codesOfPart(master, kind, part.id).filter((code) => !code.retiredAt);
  const carrying = products.filter((product) => codes.some((code) => code.code === product.productCode));
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <AlertDialogContent className="max-h-[90vh] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>Retire {part.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            It stops appearing in the dropdowns and can't get new codes. Letter {part.letter} stays reserved and is never given to anything else.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3 text-sm">
          <div>
            <p className="font-semibold text-navy">{codes.length === 0 ? "No active codes retire with it." : `${codes.length} ${codes.length === 1 ? "code retires" : "codes retire"} with it:`}</p>
            {codes.length > 0 && <p className="mt-1.5 flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">{codes.map((code) => <CodeChip key={code.id} code={code.code} />)}</p>}
          </div>
          <div>
            <p className="font-semibold text-navy">{carrying.length === 0 ? "No products carry these codes." : `${carrying.length} ${carrying.length === 1 ? "product carries" : "products carry"} these codes and will keep them:`}</p>
            {carrying.length > 0 && <div className="mt-1.5"><ProductList products={carrying} /></div>}
          </div>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel className="h-10">Cancel</AlertDialogCancel>
          <AlertDialogAction className="h-10" onClick={() => void onConfirm(part)}>Retire {part.name}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/* ---------- the matrix, like the workbook's sheet ---------- */

function CodeMatrix({ master, set, onEdit, onAdd }: { master: CodeMaster; set: CodeSet; onEdit: (id: string) => void; onAdd: (methodId: string, varietyId: string) => void }) {
  const methods = partsOfSet(master, "method", set.id);
  const varieties = partsOfSet(master, "variety", set.id);
  return (
    <Panel id="code-matrix" title={`${set.secondLabel} by ${set.firstLabel}`} className="mt-6">
      {methods.length === 0 || varieties.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate">Add at least one {set.firstLabel.toLowerCase()} and one {set.secondLabel.toLowerCase()}, then codes can be made here.</p>
      ) : (
        <>
          <p className="mb-3 text-xs text-slate">Tap a code to edit it. Tap + to make the next code in that box (02, 03).</p>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm" style={{ minWidth: 150 + methods.length * 110 }}>
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="sticky left-0 z-[1] min-w-[120px] bg-card px-2 py-2 text-[11px] font-bold uppercase tracking-wider text-slate">{set.secondLabel}</th>
                  {methods.map((method) => (
                    <th key={method.id} className={`px-2 py-2 text-[11px] font-bold uppercase tracking-wider ${method.retiredAt ? "text-slate line-through" : "text-navy"}`}>
                      {method.name} <span className="font-mono normal-case">({method.letter})</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {varieties.map((variety) => (
                  <tr key={variety.id} className="border-b border-border last:border-0">
                    <th scope="row" className={`sticky left-0 z-[1] min-w-[120px] bg-card px-2 py-2 text-left text-xs font-semibold ${variety.retiredAt ? "text-slate line-through" : "text-navy"}`}>
                      {variety.name} <span className="font-mono">({variety.letter})</span>
                    </th>
                    {methods.map((method) => {
                      const canAdd = !method.retiredAt && !variety.retiredAt;
                      return (
                        <td key={method.id} className="px-2 py-2 align-top">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {codesOfPair(master, method.id, variety.id).map((code) => (
                              <button
                                key={code.id}
                                type="button"
                                title={code.name}
                                aria-label={`${code.code}, ${code.name}${code.retiredAt ? ", retired" : ""}`}
                                onClick={() => onEdit(code.id)}
                                className={`inline-flex h-9 min-w-[3.25rem] items-center justify-center rounded-md border px-2 font-mono text-xs font-bold ${code.retiredAt ? "border-border bg-panel text-slate line-through" : "border-gold/50 bg-ivory text-navy hover:border-gold"}`}
                              >
                                {code.code}
                              </button>
                            ))}
                            {canAdd && (
                              <button
                                type="button"
                                title={`Next code for ${method.name}, ${variety.name}`}
                                aria-label={`Make the next code for ${method.name}, ${variety.name}`}
                                onClick={() => onAdd(method.id, variety.id)}
                                className="grid h-9 w-9 place-items-center rounded-md border border-dashed border-gold/70 text-navy hover:bg-ivory"
                              >
                                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                              </button>
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Panel>
  );
}

/* ---------- one code ---------- */

function SubcategoryField({ id, value, onChange, grades, category, disabled }: { id: string; value: string; onChange: (next: string) => void; grades: string[]; category: string; disabled?: boolean }) {
  const [typing, setTyping] = useState(false);
  const listed = grades.some((grade) => sameName(grade, value));
  const options = value.trim() && !listed ? [...grades, value] : grades;
  return (
    <div>
      <Label htmlFor={id}>Subcategory</Label>
      <Select
        value={typing ? OWN_SUBCATEGORY : grades.find((grade) => sameName(grade, value)) ?? value}
        disabled={!!disabled}
        onValueChange={(next) => {
          if (next === OWN_SUBCATEGORY) { setTyping(true); onChange(""); return; }
          setTyping(false);
          onChange(next);
        }}
      >
        <SelectTrigger id={id} className="h-10"><SelectValue placeholder="Choose subcategory" /></SelectTrigger>
        <SelectContent>
          {options.map((grade) => <SelectItem key={grade} value={grade}>{grade}</SelectItem>)}
          <SelectItem value={OWN_SUBCATEGORY} className="font-semibold text-navy">+ Type a different one…</SelectItem>
        </SelectContent>
      </Select>
      {typing && (
        <Input className="mt-2 h-10" aria-label="Type the subcategory" maxLength={80} placeholder={`New subcategory in ${category}`} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
      {value.trim() && !listed && !disabled && (
        <p className="mt-1 text-xs text-slate">{value.trim()} is not a subcategory of {category} yet. It is added to {category} when you add a product with this code, or take this subcategory on a product.</p>
      )}
    </div>
  );
}

function NewCodeDialog({ master, set, methodId, varietyId, grades, onClose, onCreate }: {
  master: CodeMaster;
  set: CodeSet;
  methodId: string;
  varietyId: string;
  grades: string[];
  onClose: () => void;
  onCreate: (details: { name: string; subcategory: string }) => Promise<boolean>;
}) {
  const preview = newCodePreview(master, methodId, varietyId);
  const [name, setName] = useState("error" in preview ? "" : preview.name);
  const [subcategory, setSubcategory] = useState("error" in preview ? "" : preview.subcategory);
  const [saving, setSaving] = useState(false);
  const problem = name.trim() ? (subcategory.trim() ? null : "Enter the subcategory for this code") : "Enter the product name for this code";
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle className="pr-6">{"error" in preview ? "This code can't be made" : `Make code ${preview.code}`}</DialogTitle></DialogHeader>
        {"error" in preview ? (
          <p role="alert" className="text-sm font-medium text-danger">{preview.error}</p>
        ) : (
          <div className="space-y-3">
            <p className="rounded-md bg-ivory p-3 text-sm text-navy">
              <CodeChip code={preview.code} /> is serial {String(preview.serial).padStart(2, "0")} of {master.methods.find((part) => part.id === methodId)?.name} and {master.varieties.find((part) => part.id === varietyId)?.name}. Once made it never changes and is never used for anything else.
            </p>
            <div>
              <Label htmlFor="new-code-name">Product name</Label>
              <Input id="new-code-name" className="h-10" maxLength={160} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <SubcategoryField id="new-code-subcategory" value={subcategory} onChange={setSubcategory} grades={grades} category={set.category} />
            {problem && <p role="alert" className="text-xs font-medium text-danger">{problem}</p>}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" className="h-10" onClick={onClose}>{"error" in preview ? "Close" : "Cancel"}</Button>
          {!("error" in preview) && (
            <Button
              className="h-10 bg-navy text-white hover:bg-navy/90"
              disabled={!!problem || saving}
              onClick={() => { setSaving(true); void onCreate({ name: name.trim(), subcategory: subcategory.trim() }).then((ok) => { setSaving(false); if (ok) onClose(); }); }}
            >
              {saving ? "Making…" : `Make ${preview.code}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImagesField({ images, onChange, disabled, onUploading }: { images: string[]; onChange: Dispatch<SetStateAction<string[]>>; disabled: boolean; onUploading: (busy: boolean) => void }) {
  const [url, setUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const full = images.length >= MAX_IMAGES;
  const addUrl = () => {
    const clean = url.trim();
    if (!IMAGE_URL.test(clean)) { toast.error("Paste a full image address starting with https://"); return; }
    if (images.includes(clean)) { toast.info("This image is already on the code"); return; }
    onChange([...images, clean]);
    setUrl("");
  };
  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    onUploading(true);
    try {
      const image = await uploadCodeImage(file);
      // Images may have been removed while this one uploaded, so add it to what is there now.
      onChange((current) => (current.includes(image) ? current : [...current, image].slice(0, MAX_IMAGES)));
      toast.success("Image added. Save the code to keep it.");
    } catch (cause) {
      toast.error("Could not upload this image", { description: reasonOf(cause) });
    } finally {
      setUploading(false);
      onUploading(false);
      event.target.value = "";
    }
  };
  return (
    <div>
      <Label>Images ({images.length} of {MAX_IMAGES})</Label>
      {images.length === 0 && <p className="mt-1 text-xs text-slate">No images yet. The first image fills in when this code is chosen on a product.</p>}
      {images.length > 0 && (
        <ul className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {images.map((image, index) => (
            <li key={image} className="rounded-md border border-border p-1.5">
              <img src={image} alt={`Code image ${index + 1}`} className="h-20 w-full rounded object-contain" />
              <p className="mt-1 text-center text-[11px] font-semibold text-slate">{index === 0 ? "First image" : `Image ${index + 1}`}</p>
              {!disabled && (
                <div className="mt-1 flex justify-center gap-1">
                  {index > 0 && (
                    <Button type="button" variant="outline" size="icon" className="h-9 w-9" title="Make first" aria-label={`Make image ${index + 1} first`} onClick={() => onChange([image, ...images.filter((other) => other !== image)])}>
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  <Button type="button" variant="outline" size="icon" className="h-9 w-9 text-danger hover:text-danger" title="Remove" aria-label={`Remove image ${index + 1}`} onClick={() => onChange(images.filter((other) => other !== image))}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {!disabled && !full && (
        <div className="mt-2 space-y-2">
          <label className={`inline-flex h-10 items-center gap-2 rounded-md border border-dashed border-gold/70 px-3 text-sm font-semibold text-navy ${uploading ? "cursor-wait opacity-60" : "cursor-pointer hover:bg-ivory"}`}>
            <ImagePlus className="h-4 w-4" aria-hidden="true" />
            {uploading ? "Uploading…" : "Browse local files"}
            <input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" disabled={uploading} onChange={(event) => void upload(event)} />
          </label>
          <div className="flex gap-2">
            <Input
              className="h-10 min-w-0 flex-1"
              aria-label="Paste an image address"
              placeholder="Or paste an image address"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addUrl(); } }}
            />
            <Button type="button" variant="outline" className="h-10" disabled={!url.trim()} onClick={addUrl}>Add</Button>
          </div>
          <p className="mt-1 text-xs text-slate">Uploading is safest. A product using an image from another website stops syncing to Zoho until its image is uploaded here.</p>
        </div>
      )}
    </div>
  );
}

function CodeEditDialog({ master, set, code, grades, carrying, onClose, onSave, onRetire, onRestore }: {
  master: CodeMaster;
  set: CodeSet;
  code: MasterCode;
  grades: string[];
  carrying: number;
  onClose: () => void;
  onSave: (details: { name: string; description: string; subcategory: string; images: string[] }) => Promise<boolean>;
  onRetire: () => void;
  onRestore: () => Promise<boolean>;
}) {
  const [name, setName] = useState(code.name);
  const [description, setDescription] = useState(code.description);
  const [subcategory, setSubcategory] = useState(code.subcategory);
  const [images, setImages] = useState(code.images);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const retired = !!code.retiredAt;
  const partRetired = !!(master.methods.find((part) => part.id === code.methodId)?.retiredAt || master.varieties.find((part) => part.id === code.varietyId)?.retiredAt);
  const details = { name: name.trim(), description: description.trim(), subcategory: subcategory.trim(), images };
  const problem = retired ? null : codeDetailsProblem(code, details);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2 pr-6">
            <CodeChip code={code.code} retired={retired} /> {retired ? "Retired code" : "Code details"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {retired && (
            <p className="rounded-md bg-panel p-2 text-xs text-charcoal">
              This code is retired, so its details stay as they were. {partRetired ? "Restore its method and variety first, then the code." : "Restore it to use or change it."}
            </p>
          )}
          <div>
            <Label htmlFor="code-name">Product name</Label>
            <Input id="code-name" className="h-10" maxLength={160} disabled={retired} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="code-description">Description</Label>
            <Textarea id="code-description" rows={3} maxLength={2000} disabled={retired} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Quality, grade, use. Fills in when this code is chosen on a new product." />
          </div>
          <SubcategoryField id="code-subcategory" value={subcategory} onChange={setSubcategory} grades={grades} category={set.category} disabled={retired} />
          <ImagesField images={images} onChange={setImages} disabled={retired} onUploading={setUploading} />
          <p className="text-xs text-slate">
            {carrying === 1 ? "1 product uses this code." : `${carrying} products use this code.`} {carrying > 0 && "They keep their own name and image; change those on the product."}
          </p>
          {problem && <p role="alert" className="text-xs font-medium text-danger">{problem}</p>}
        </div>
        <DialogFooter className="gap-2">
          {!retired && (
            <Button variant="ghost" className="h-10 text-danger hover:text-danger sm:mr-auto" onClick={onRetire}>
              <Archive className="mr-1.5 h-4 w-4" /> Retire this code
            </Button>
          )}
          <Button variant="outline" className="h-10" onClick={onClose}>{retired ? "Close" : "Cancel"}</Button>
          {retired ? (
            <Button
              className="h-10 bg-navy text-white hover:bg-navy/90"
              disabled={saving || partRetired}
              onClick={() => { setSaving(true); void onRestore().finally(() => setSaving(false)); }}
            >
              <RotateCcw className="mr-1.5 h-4 w-4" /> Restore
            </Button>
          ) : (
            <Button
              className="h-10 bg-navy text-white hover:bg-navy/90"
              disabled={!!problem || saving || uploading}
              onClick={() => { setSaving(true); void onSave(details).then((ok) => { setSaving(false); if (ok) onClose(); }); }}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RetireCodeDialog({ code, products, onClose, onConfirm }: { code: MasterCode; products: Product[]; onClose: () => void; onConfirm: () => Promise<boolean> }) {
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <AlertDialogContent className="max-h-[90vh] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>Retire {code.code}?</AlertDialogTitle>
          <AlertDialogDescription>
            {code.name}. New products can no longer choose this code. It stays on record and is never used again for anything else.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="text-sm">
          <p className="font-semibold text-navy">{products.length === 0 ? "No products carry this code." : `${products.length} ${products.length === 1 ? "product carries" : "products carry"} it and will keep it:`}</p>
          {products.length > 0 && <div className="mt-1.5"><ProductList products={products} /></div>}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel className="h-10">Cancel</AlertDialogCancel>
          <AlertDialogAction className="h-10" onClick={() => void onConfirm()}>Retire {code.code}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
