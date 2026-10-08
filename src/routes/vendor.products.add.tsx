import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, type ChangeEvent } from "react";
import { toast } from "sonner";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel } from "@/components/panel/widgets";
import { vendorNav } from "@/lib/panel-nav";
import { products as seedProducts, type Product } from "@/lib/data";
import { useApp } from "@/lib/store";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { uploadCatalogImage } from "@/lib/catalog-images";
import { defaultGstForCategory, loadTaxSettings } from "@/lib/business-rules";

export const Route = createFileRoute("/vendor/products/add")({
  head: () => ({
    meta: [
      { title: "Add Product | Shami Vendor Panel" },
      { name: "description", content: "List a new product on the Shami marketplace." },
      { property: "og:title", content: "Add Product | Shami Vendor" },
      { property: "og:description", content: "Create a new catalogue entry as a Shami vendor." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: VendorAddProduct,
});

function VendorAddProduct() {
  const { addProduct, categories } = useApp();
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [subcategory, setSubcategory] = useState("");
  const [weight, setWeight] = useState("");
  const [mrp, setMrp] = useState("");
  const [price, setPrice] = useState("");
  const [gst, setGst] = useState("5");
  const [stock, setStock] = useState("");
  const [description, setDescription] = useState("");
  const [specLabel, setSpecLabel] = useState("");
  const [specValue, setSpecValue] = useState("");
  const [status, setStatus] = useState<Product["status"]>("pending");
  const [image, setImage] = useState("");
  const [imageUploading, setImageUploading] = useState(false);

  const chooseImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setImageUploading(true);
    try {
      setImage(await uploadCatalogImage(file, "products"));
      toast.success("Product image uploaded");
    } catch (error) {
      toast.error("Could not upload the product image", { description: error instanceof Error ? error.message : "Try again." });
    } finally {
      setImageUploading(false);
      event.target.value = "";
    }
  };

  const cat = categories.find((c) => c.name === category);
  const sku = category ? `SBV-${category.slice(0, 2).toUpperCase()}-${1000 + Math.floor(Math.random() * 8999)}` : "";

  const handleSubmit = (): void => {
    if (!name.trim()) { toast.error("Product name is required"); return; }
    if (!category) { toast.error("Please select a category"); return; }
    if (!subcategory) { toast.error("Please select a subcategory"); return; }
    if (!weight.trim()) { toast.error("Weight / pack size is required"); return; }
    const mrpNum = Number(mrp);
    const priceNum = Number(price);
    const stockNum = Number(stock);
    if (!mrpNum || mrpNum <= 0) { toast.error("Enter a valid MRP"); return; }
    if (!priceNum || priceNum <= 0) { toast.error("Enter a valid selling price"); return; }
    if (priceNum > mrpNum) { toast.error("Selling price cannot exceed MRP"); return; }
    if (!stock || stockNum < 0) { toast.error("Enter a valid stock quantity"); return; }
    if (!description.trim()) { toast.error("Description is required"); return; }

    const sampleImage = image || (seedProducts.find((p) => p.category === category)?.image ?? "");
    const id = `P${Date.now().toString().slice(-6)}`;
    const today = new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

    const product: Product = {
      id,
      name: name.trim(),
      sku,
      brand: "Shami Select",
      vendor: "",
      vendorId: "",
      category,
      subcategory,
      image: sampleImage,
      mrp: mrpNum,
      price: priceNum,
      gst: Number(gst),
      rating: 0,
      reviews: 0,
      stock: stockNum,
      reserved: 0,
      sold: 0,
      weight,
      status,
      active: true,
      tags: [],
      description: description.trim(),
      specs: specLabel && specValue ? [{ label: specLabel, value: specValue }] : [],
      created: today,
      updated: today,
    };

    void addProduct(product).then((saved) => {
      if (!saved) return;
      toast.success(`${product.name} submitted for approval`);
      navigate({ to: "/vendor/products" });
    });
  };

  return (
    <PanelLayout items={vendorNav} tone="vendor" title="Add Product" subtitle="List a new product for Shami Sugar Mills">
      <Panel title="Product Details">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="grid gap-1.5">
            <Label>Product Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. S1 Refined Sugar 50kg Bag" />
          </div>
          <div className="grid gap-1.5">
            <Label>SKU (auto-generated)</Label>
            <Input value={sku} disabled placeholder="Select a category to generate SKU" />
          </div>
          <div className="grid gap-1.5">
            <Label>Category</Label>
            <Select value={category} onValueChange={(v) => {
              setCategory(v);
              setSubcategory("");
              void loadTaxSettings().then((settings) => setGst(String(defaultGstForCategory(settings, v))))
                .catch((error: unknown) => toast.error("Could not load GST defaults", { description: error instanceof Error ? error.message : "Using the current product rate." }));
            }}>
              <SelectTrigger><SelectValue placeholder="Select category" /></SelectTrigger>
              <SelectContent>
                {categories.filter((c) => c.enabled).map((c) => (
                  <SelectItem key={c.name} value={c.name}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>Subcategory</Label>
            <Select value={subcategory} onValueChange={setSubcategory} disabled={!cat}>
              <SelectTrigger><SelectValue placeholder="Select subcategory" /></SelectTrigger>
              <SelectContent>
                {cat?.grades.map((s) => (
                  <SelectItem key={s} value={s}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>Weight / Pack Size</Label>
            <Input value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="e.g. 50 kg" />
          </div>
          <div className="grid gap-1.5">
            <Label>GST %</Label>
            <Select value={gst} onValueChange={setGst}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="0">0%</SelectItem>
                <SelectItem value="5">5%</SelectItem>
                <SelectItem value="12">12%</SelectItem>
                <SelectItem value="18">18%</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>MRP (₹)</Label>
            <Input type="number" value={mrp} onChange={(e) => setMrp(e.target.value)} placeholder="e.g. 2650" />
          </div>
          <div className="grid gap-1.5">
            <Label>Selling Price (₹)</Label>
            <Input type="number" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="e.g. 2399" />
          </div>
          <div className="grid gap-1.5">
            <Label>Opening Stock</Label>
            <Input type="number" value={stock} onChange={(e) => setStock(e.target.value)} placeholder="e.g. 120" />
          </div>
          <div className="grid gap-1.5">
            <Label>Product Image</Label>
            <label className="inline-flex cursor-pointer items-center justify-center rounded-md border border-dashed p-3 text-sm font-medium text-navy hover:bg-ivory">
              {imageUploading ? "Uploading…" : image ? "Choose a different image" : "Browse local files"}
              <input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" disabled={imageUploading} onChange={(event) => void chooseImage(event)} />
            </label>
            {image && <img src={image} alt="Product preview" className="h-28 w-28 rounded-md border object-cover" />}
          </div>
          <div className="grid gap-1.5">
            <Label>Listing Status</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as Product["status"])}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="pending">Submit for Approval</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5 lg:col-span-2">
            <Label>Description</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} placeholder="Describe quality, packaging, certifications..." />
          </div>
          <div className="grid gap-1.5">
            <Label>Spec Label (optional)</Label>
            <Input value={specLabel} onChange={(e) => setSpecLabel(e.target.value)} placeholder="e.g. Shelf Life" />
          </div>
          <div className="grid gap-1.5">
            <Label>Spec Value (optional)</Label>
            <Input value={specValue} onChange={(e) => setSpecValue(e.target.value)} placeholder="e.g. 12 months" />
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={() => navigate({ to: "/vendor/products" })}>Cancel</Button>
          <Button className="bg-navy text-white hover:bg-navy/90" onClick={handleSubmit}>Add Product</Button>
        </div>
      </Panel>
    </PanelLayout>
  );
}
