import sugarImg from "@/assets/p-sugar.jpg";
import riceImg from "@/assets/p-rice.jpg";
import oilImg from "@/assets/p-oil.jpg";
import dalImg from "@/assets/p-dal.jpg";
import premiumRiceCategoryImg from "@/assets/category-rice-premium.jpg";
import premiumSugarCategoryImg from "@/assets/category-sugar-premium.jpg";
import premiumOilCategoryImg from "@/assets/category-oil-premium.jpg";

export const inr = (n: number) =>
  "₹" + Math.round(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });

/* ---------- deterministic pseudo random ---------- */
let seed = 20260818;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const pick = <T,>(arr: T[], i: number): T => arr[i % arr.length]!;
const rint = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));

/* ---------- types ---------- */
export type Product = {
  id: string;
  name: string;
  sku: string;
  brand: string;
  vendor: string;
  vendorId: string;
  category: string;
  subcategory: string;
  image: string;
  mrp: number;
  price: number;
  gst: number;
  rating: number;
  reviews: number;
  stock: number;
  minimumStock?: number;
  warehouseStock?: number;
  requiredStock?: number;
  reserved: number;
  sold: number;
  weight: string;
  status: "approved" | "pending" | "rejected";
  active: boolean;
  tags: ("featured" | "bestseller" | "new" | "offer" | "recommended")[];
  description: string;
  specs: { label: string; value: string }[];
  created: string;
  updated: string;
  purchasePrice?: number;
};

export type PurchaseBatch = {
  id: string;
  batchCode: string;
  productId: string;
  productName: string;
  vendor: string;
  vendorId: string;
  purchaseDate: string; // ISO date format YYYY-MM-DD
  quantity: number;     // initial batch quantity
  remainingQty: number; // remaining available units
  unitCost: number;     // purchase cost per unit
  warehouse: string;
  status: "Active" | "Depleted";
};

export const categories = [
  { name: "Sugar", icon: "Candy", subs: ["S1 Sugar", "S2 Sugar", "M30 Sugar"], count: 42 },
  { name: "Rice", icon: "Wheat", subs: ["Grade A", "Grade B", "Premium Rice"], count: 38 },
  { name: "Oil", icon: "Droplets", subs: ["Sunflower Oil", "Groundnut Oil", "Palm Oil"], count: 26 },
  { name: "Pulses", icon: "Bean", subs: ["Toor Dal", "Urad Dal", "Chana Dal", "Moong Dal"], count: 34 },
  { name: "Flours", icon: "Wheat", subs: ["Chakki Atta", "Maida", "Besan"], count: 22 },
  { name: "Spices", icon: "Flame", subs: ["Turmeric", "Chilli Powder", "Coriander"], count: 30 },
  { name: "Dry Fruits", icon: "Nut", subs: ["Cashew", "Almond", "Raisins"], count: 18 },
  { name: "Tea & Coffee", icon: "Coffee", subs: ["CTC Tea", "Filter Coffee"], count: 14 },
  { name: "Jaggery", icon: "Candy", subs: ["Organic Jaggery", "Jaggery Powder"], count: 12 },
  { name: "Salt & Sweeteners", icon: "Sparkles", subs: ["Iodised Salt", "Rock Salt"], count: 11 },
];

/* ---------- admin-managed storefront categories ---------- */
export type StoreCategory = {
  id: string;
  name: string;
  tagline: string;
  image: string;
  grades: string[];
  enabled: boolean;
  order: number;
};

export const storeCategorySeed: StoreCategory[] = [
  { id: "C1", name: "Rice", tagline: "Raw, steam & premium grades", image: premiumRiceCategoryImg, grades: ["Raw Rice", "Steam Rice", "Premium Rice"], enabled: true, order: 1 },
  { id: "C2", name: "Sugar", tagline: "Mill-fresh refined sugar", image: premiumSugarCategoryImg, grades: ["Grade S1"], enabled: true, order: 2 },
  { id: "C3", name: "Oil", tagline: "Edible oils in every pack size", image: premiumOilCategoryImg, grades: ["Sunflower Oil", "Groundnut Oil", "Palm Oil"], enabled: true, order: 3 },
  { id: "C4", name: "Pulses", tagline: "Everyday dals and pulses", image: dalImg, grades: ["Toor Dal", "Urad Dal", "Chana Dal", "Moong Dal"], enabled: false, order: 4 },
  { id: "C5", name: "Flours", tagline: "Fresh staples for every kitchen", image: riceImg, grades: ["Chakki Atta", "Maida", "Besan"], enabled: false, order: 5 },
  { id: "C6", name: "Spices", tagline: "Quality spices and seasonings", image: dalImg, grades: ["Turmeric", "Chilli Powder", "Coriander"], enabled: false, order: 6 },
  { id: "C7", name: "Dry Fruits", tagline: "Carefully sourced dry fruits", image: dalImg, grades: ["Cashew", "Almond", "Raisins"], enabled: false, order: 7 },
  { id: "C8", name: "Tea & Coffee", tagline: "Tea and coffee for every day", image: dalImg, grades: ["CTC Tea", "Filter Coffee"], enabled: false, order: 8 },
  { id: "C9", name: "Jaggery", tagline: "Traditional jaggery products", image: sugarImg, grades: ["Organic Jaggery", "Jaggery Powder"], enabled: false, order: 9 },
  { id: "C10", name: "Salt & Sweeteners", tagline: "Salt and natural sweeteners", image: sugarImg, grades: ["Iodised Salt", "Rock Salt"], enabled: false, order: 10 },
];

/* Storefront visibility: Rice, Sugar (S1 only) and Oil. */
export const STOREFRONT_CATEGORIES = ["Rice", "Sugar", "Oil"];
export const STOREFRONT_SUBCATEGORIES = ["S1 Sugar"];
export const storefrontCategories = categories
  .filter((c) => STOREFRONT_CATEGORIES.includes(c.name))
  .map((c) => ({ ...c, subs: c.name === "Sugar" ? ["S1 Sugar"] : c.subs }));
export const isStorefrontCategory = (name: string) =>
  storefrontCategories.some((c) => c.name === name || c.subs.includes(name));
export const isStorefrontProduct = (p: Product) =>
  p.status === "approved" && p.active !== false;


const catImage: Record<string, string> = {
  Sugar: sugarImg, Rice: riceImg, Oil: oilImg, Pulses: dalImg,
  Flours: riceImg, Spices: dalImg, "Dry Fruits": dalImg,
  "Tea & Coffee": dalImg, Jaggery: sugarImg, "Salt & Sweeteners": sugarImg,
};


/* ---------- vendors ---------- */
const vendorSeed: Array<[string, string, string, string, string, string, "approved" | "pending" | "suspended", number]> = [
  ["V01", "Shami Sugar Mills", "Imran Shami", "imran@shamisugar.in", "+91 98450 11223", "Belagavi, KA", "approved", 10],
  ["V02", "Kaveri Agro Traders", "Suresh Rao", "sales@kaveriagro.in", "+91 98860 44551", "Mysuru, KA", "approved", 12],
  ["V03", "Deccan Oil Company", "Farida Sheikh", "info@deccanoil.com", "+91 99001 77882", "Hyderabad, TS", "approved", 11],
  ["V04", "Annapurna Pulses", "Vikram Patil", "vikram@annapurnapulses.in", "+91 90080 33445", "Solapur, MH", "pending", 10],
  ["V05", "Bharat Grains LLP", "Nikhil Jain", "hello@bharatgrains.in", "+91 97400 66778", "Pune, MH", "suspended", 10],
  ["V06", "Konkan Spice House", "Meera Naik", "orders@konkanspice.in", "+91 98220 55117", "Ratnagiri, MH", "approved", 13],
  ["V07", "Ganga Flour Mills", "Rajeev Mishra", "rajeev@gangaflour.in", "+91 93110 88220", "Kanpur, UP", "approved", 9],
  ["V08", "Nilgiri Tea Estates", "Anitha Menon", "anitha@nilgiritea.in", "+91 94470 33119", "Coonoor, TN", "approved", 14],
  ["V09", "Rajasthan Dry Fruits Co", "Mahendra Singh", "sales@rajdryfruits.in", "+91 99280 44662", "Jaipur, RJ", "approved", 15],
  ["V10", "Sagar Jaggery Works", "Prakash Shetty", "prakash@sagarjaggery.in", "+91 98860 99001", "Mandya, KA", "pending", 10],
];

export const vendors = vendorSeed.map(([id, business, owner, email, phone, city, status, commission], i) => ({
  id, business, owner, email, phone, city, commission,
  status: status as string,
  gst: `${27 + (i % 8)}ABCDE${1000 + i * 137}F1Z${i % 9}`,
  rating: Math.round((3.8 + (i % 6) * 0.2) * 10) / 10,
  joined: `${String(3 + (i % 24)).padStart(2, "0")} ${pick(["Jan", "Feb", "Mar", "Apr", "May", "Jun"], i)} 202${i % 3 === 0 ? 5 : 6}`,
  bank: `HDFC Bank ••••${4200 + i * 17}`,
  products: 0,
  orders: 0,
  sales: 0,
}));

/* ---------- products (52) ---------- */
const productSeed: Array<[string, string, string, string, number, number]> = [
  ["S1 Refined Sugar 50kg Bag", "Sugar", "S1 Sugar", "50 kg", 2650, 2399],
  ["S2 Refined Sugar 50kg Bag", "Sugar", "S2 Sugar", "50 kg", 2550, 2299],
  ["M30 Premium Sugar 50kg", "Sugar", "M30 Sugar", "50 kg", 2750, 2549],
  ["S1 Sugar Retail Pack 1kg", "Sugar", "S1 Sugar", "1 kg", 62, 54],
  ["M30 Sugar Retail Pack 5kg", "Sugar", "M30 Sugar", "5 kg", 310, 279],
  ["S2 Sugar Retail Pack 2kg", "Sugar", "S2 Sugar", "2 kg", 128, 109],
  ["Brown Sugar Natural 1kg", "Sugar", "M30 Sugar", "1 kg", 145, 119],
  ["Sugar Cubes Box 500g", "Sugar", "S1 Sugar", "500 g", 98, 84],
  ["Grade A Raw Rice 25kg", "Rice", "Grade A", "25 kg", 1650, 1499],
  ["Grade A Steam Rice Sona Masoori 25kg", "Rice", "Grade A", "25 kg", 1750, 1585],
  ["Grade B Steam Rice Retail 5kg", "Rice", "Grade B", "5 kg", 420, 379],
  ["Grade B Raw Rice Retail 10kg", "Rice", "Grade B", "10 kg", 780, 699],
  ["Premium Rice Basmati Classic 5kg", "Rice", "Premium Rice", "5 kg", 690, 615],
  ["Premium Rice Basmati 25kg", "Rice", "Premium Rice", "25 kg", 3250, 2949],
  ["Grade A Idli Rice 25kg", "Rice", "Grade A", "25 kg", 1520, 1385],
  ["Sunflower Oil 1 Litre", "Oil", "Sunflower Oil", "1 L", 165, 142],
  ["Sunflower Oil 500ml", "Oil", "Sunflower Oil", "500 ml", 92, 79],
  ["Sunflower Oil 15L Tin", "Oil", "Sunflower Oil", "15 L", 2250, 2049],
  ["Groundnut Oil 1 Litre", "Oil", "Groundnut Oil", "1 L", 218, 189],
  ["Groundnut Oil 5L Can", "Oil", "Groundnut Oil", "5 L", 1050, 949],
  ["Refined Sunflower Oil 5L Can", "Oil", "Sunflower Oil", "5 L", 820, 739],
  ["Palm Oil 1 Litre Pouch", "Oil", "Palm Oil", "1 L", 138, 119],
  ["Palm Oil 15L Tin", "Oil", "Palm Oil", "15 L", 1980, 1799],

  ["Toor Dal Premium 1kg", "Pulses", "Toor Dal", "1 kg", 185, 159],
  ["Urad Dal Gota 1kg", "Pulses", "Urad Dal", "1 kg", 172, 148],
  ["Chana Dal Select 1kg", "Pulses", "Chana Dal", "1 kg", 132, 112],
  ["Toor Dal Bulk 30kg", "Pulses", "Toor Dal", "30 kg", 4650, 4299],
  ["Chana Dal Bulk 30kg", "Pulses", "Chana Dal", "30 kg", 3600, 3299],
  ["Moong Dal Yellow 1kg", "Pulses", "Moong Dal", "1 kg", 158, 136],
  ["Moong Dal Bulk 30kg", "Pulses", "Moong Dal", "30 kg", 4200, 3849],
  ["Urad Dal Bulk 30kg", "Pulses", "Urad Dal", "30 kg", 4980, 4599],
  ["Chakki Fresh Atta 10kg", "Flours", "Chakki Atta", "10 kg", 520, 459],
  ["Chakki Fresh Atta 5kg", "Flours", "Chakki Atta", "5 kg", 275, 242],
  ["Maida Refined Flour 25kg", "Flours", "Maida", "25 kg", 1180, 1049],
  ["Besan Gram Flour 1kg", "Flours", "Besan", "1 kg", 148, 126],
  ["Besan Gram Flour 25kg", "Flours", "Besan", "25 kg", 3450, 3149],
  ["Turmeric Powder 1kg", "Spices", "Turmeric", "1 kg", 320, 279],
  ["Turmeric Powder 500g", "Spices", "Turmeric", "500 g", 175, 149],
  ["Red Chilli Powder 1kg", "Spices", "Chilli Powder", "1 kg", 385, 339],
  ["Coriander Powder 1kg", "Spices", "Coriander", "1 kg", 290, 249],
  ["Coriander Seeds 5kg", "Spices", "Coriander", "5 kg", 1250, 1129],
  ["Chilli Powder Bulk 10kg", "Spices", "Chilli Powder", "10 kg", 3600, 3299],
  ["Cashew W240 Whole 1kg", "Dry Fruits", "Cashew", "1 kg", 980, 869],
  ["Cashew W320 Whole 5kg", "Dry Fruits", "Cashew", "5 kg", 4450, 4099],
  ["Almond California 1kg", "Dry Fruits", "Almond", "1 kg", 890, 799],
  ["Raisins Long Green 1kg", "Dry Fruits", "Raisins", "1 kg", 340, 289],
  ["Almond Premium 5kg", "Dry Fruits", "Almond", "5 kg", 4250, 3899],
  ["CTC Tea Dust 1kg", "Tea & Coffee", "CTC Tea", "1 kg", 420, 369],
  ["CTC Tea Leaf 5kg", "Tea & Coffee", "CTC Tea", "5 kg", 1980, 1799],
  ["Filter Coffee Powder 1kg", "Tea & Coffee", "Filter Coffee", "1 kg", 640, 579],
  ["Organic Jaggery Blocks 5kg", "Jaggery", "Organic Jaggery", "5 kg", 480, 419],
  ["Jaggery Powder 1kg", "Jaggery", "Jaggery Powder", "1 kg", 128, 109],
  ["Iodised Salt 1kg", "Salt & Sweeteners", "Iodised Salt", "1 kg", 28, 22],
  ["Himalayan Rock Salt 1kg", "Salt & Sweeteners", "Rock Salt", "1 kg", 96, 79],

  /* rice varieties */
  ["R-111 Raw Rice 25kg", "Rice", "Grade A", "25 kg", 1680, 1519],
  ["R-222 Raw Rice 25kg", "Rice", "Grade A", "25 kg", 1620, 1465],
  ["R-333 Raw Rice 25kg", "Rice", "Grade B", "25 kg", 1560, 1409],
  ["R-444 Raw Rice 25kg", "Rice", "Grade B", "25 kg", 1495, 1349],
  ["S-111 Steam Rice 25kg", "Rice", "Grade A", "25 kg", 1740, 1579],
  ["S-222 Steam Rice 25kg", "Rice", "Grade A", "25 kg", 1690, 1529],
  ["S-333 Steam Rice 25kg", "Rice", "Grade B", "25 kg", 1610, 1455],
  ["S-444 Steam Rice 25kg", "Rice", "Premium Rice", "25 kg", 1880, 1699],

  /* cooking oil brands */
  ["Sunpure Sunflower Oil 1 Litre", "Oil", "Sunflower Oil", "1 L", 172, 148],
  ["Sunpure Sunflower Oil 15L Tin", "Oil", "Sunflower Oil", "15 L", 2295, 2085],
  ["GoldWinner Sunflower Oil 1 Litre", "Oil", "Sunflower Oil", "1 L", 168, 145],
  ["GoldWinner Sunflower Oil 5L Can", "Oil", "Sunflower Oil", "5 L", 845, 759],
  ["Palm Shakthi Palm Oil 1 Litre", "Oil", "Palm Oil", "1 L", 132, 115],
  ["Palm Shakthi Palm Oil 15L Tin", "Oil", "Palm Oil", "15 L", 1950, 1775],
  ["Shakthi Gold Palm Oil 1 Litre", "Oil", "Palm Oil", "1 L", 136, 118],
  ["Shakthi Gold Palm Oil 15L Tin", "Oil", "Palm Oil", "15 L", 1990, 1805],
  ["Raaga Palm Oil 1 Litre", "Oil", "Palm Oil", "1 L", 129, 112],
  ["Raaga Palm Oil 15L Tin", "Oil", "Palm Oil", "15 L", 1930, 1749],
  ["SVT Gold Palm Oil 1 Litre", "Oil", "Palm Oil", "1 L", 134, 117],
  ["SVT Gold Palm Oil 15L Tin", "Oil", "Palm Oil", "15 L", 1975, 1789],
];

const dt = (i: number, base = 1) =>
  `${String(1 + ((i * 7 + base) % 27)).padStart(2, "0")} ${pick(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug"], i + base)} 2026`;

export const products: Product[] = productSeed.map(([name, category, subcategory, weight, mrp, price], i) => {
  const vendor = vendors[i % vendors.length]!;
  const tags: Product["tags"] = [];
  if (i % 4 === 0) tags.push("featured");
  if (i % 3 === 0) tags.push("bestseller");
  if (i % 7 === 0) tags.push("new");
  if (mrp - price > 100) tags.push("offer");
  if (i % 2 === 0) tags.push("recommended");
  return {
    id: `P${String(i + 1).padStart(3, "0")}`,
    name,
    sku: `SBV-${category.slice(0, 2).toUpperCase()}-${1000 + i}`,
    brand: "Shami Select",
    vendor: vendor.business,
    vendorId: vendor.id,
    category,
    subcategory,
    image: catImage[category] ?? sugarImg,
    mrp,
    price,
    gst: category === "Oil" || category === "Sugar" ? 5 : 12,
    rating: Math.round((3.8 + (i % 7) * 0.17) * 10) / 10,
    reviews: 18 + i * 7,
    stock: i % 9 === 3 ? 0 : i % 6 === 1 ? rint(4, 18) : rint(40, 460),
    reserved: i % 5,
    sold: 40 + i * 13,
    weight,
    status:
      i >= productSeed.length - 20
        ? "approved"
        : i % 13 === 4
          ? "pending"
          : i % 17 === 7
            ? "rejected"
            : "approved",
    active: i % 19 !== 5,
    tags,
    description:
      "Sourced directly from certified mills and packed under strict quality control. FSSAI compliant, moisture-controlled packaging with batch-level traceability for institutional and retail buyers.",
    specs: [
      { label: "Pack Size", value: weight },
      { label: "Brand", value: "Shami Select" },
      { label: "Shelf Life", value: "12 months from packing" },
      { label: "FSSAI Licence", value: "10019011002345" },
      { label: "Storage", value: "Cool, dry place away from sunlight" },
      { label: "Country of Origin", value: "India" },
    ],
    created: dt(i, 1),
    updated: dt(i, 5),
  };
});

export const byTag = (tag: Product["tags"][number]) =>
  products.filter((p) => p.tags.includes(tag) && isStorefrontProduct(p)).slice(0, 8);

/* ---------- customers (32) ---------- */
const firstNames = ["Rahul", "Sneha", "Mohammed", "Priya", "Anand", "Kavya", "Vishal", "Deepa", "Arjun", "Nisha", "Rohit", "Meena", "Sanjay", "Pooja", "Karthik", "Divya", "Imtiaz", "Lakshmi", "Naveen", "Shalini", "Ganesh", "Ritu", "Manoj", "Anjali", "Sameer", "Harini", "Tarun", "Bhavna", "Yusuf", "Ashwini", "Nitin", "Swati"];
const lastNames = ["Deshpande", "Kulkarni", "Arif", "Nair", "Reddy", "Iyer", "Sharma", "Patel", "Menon", "Joshi", "Verma", "Rao", "Gupta", "Shetty", "Pillai", "Bhat", "Khan", "Naidu", "Kumar", "Mishra", "Hegde", "Chauhan", "Yadav", "Desai", "Sheikh", "Krishnan", "Malhotra", "Saxena", "Ansari", "Kamath", "Bansal", "Jain"];
const cityState: Array<[string, string, string]> = [
  ["Belagavi", "Karnataka", "590010"], ["Mysuru", "Karnataka", "570001"], ["Bengaluru", "Karnataka", "560034"],
  ["Hyderabad", "Telangana", "500081"], ["Pune", "Maharashtra", "411014"], ["Mumbai", "Maharashtra", "400070"],
  ["Chennai", "Tamil Nadu", "600042"], ["Kochi", "Kerala", "682024"], ["Jaipur", "Rajasthan", "302017"],
  ["Kanpur", "Uttar Pradesh", "208012"], ["Nagpur", "Maharashtra", "440015"], ["Coimbatore", "Tamil Nadu", "641012"],
];
const streets = ["Plot 14, Industrial Estate", "Shop 6, Market Road", "42 MG Road", "Flat 302, Sai Residency", "18 Gandhi Nagar", "Unit 9, APMC Yard", "77 Station Road", "Door 5-2-19, Bazaar Street"];

export const customers = Array.from({ length: 32 }, (_, i) => {
  const name = `${pick(firstNames, i)} ${pick(lastNames, i * 3 + 1)}`;
  const [city, state, pin] = cityState[i % cityState.length]!;
  const ord = rint(1, 52);
  return {
    id: `C${1001 + i}`,
    name,
    email: `${name.split(" ")[0]!.toLowerCase()}.${name.split(" ")[1]!.slice(0, 3).toLowerCase()}${i}@${pick(["gmail.com", "outlook.com", "yahoo.in", "rediffmail.com"], i)}`,
    phone: `+91 9${rint(1000, 9999)} ${rint(10000, 99999)}`,
    city,
    state,
    pin,
    gst: `${29 + (i % 6)}AAACB${2000 + i * 111}D1Z${i % 9}`,
    address: `${pick(streets, i)}, ${city}, ${state} ${pin}`,
    joined: dt(i, 2),
    orders: ord,
    spend: ord * rint(1800, 9800),
    lastOrder: dt(i, 6),
    status: (i % 11 === 4 ? "blocked" : "active") as string,
    avatar: name.split(" ").map((w) => w[0]).join(""),
  };
});

/* ---------- FIFO purchase batches ---------- */
export const batches: PurchaseBatch[] = products.flatMap((p) => {
  const baseCost = Math.round(p.price * 0.78);
  const b1Cost = Math.round(baseCost * 0.94);
  const b2Cost = baseCost;
  const b3Cost = Math.round(baseCost * 1.05);

  const stock = p.stock;
  if (stock === 0) {
    return [
      {
        id: `BATCH-${p.id}-01`,
        batchCode: `LOT-${p.sku.replace("SBV-", "")}-01`,
        productId: p.id,
        productName: p.name,
        vendor: p.vendor,
        vendorId: p.vendorId,
        purchaseDate: "2026-06-05",
        quantity: 50,
        remainingQty: 0,
        unitCost: b1Cost,
        warehouse: "Warehouse 1 - Belagavi APMC",
        status: "Depleted" as const,
      },
    ];
  }

  const b1Rem = Math.min(stock, Math.floor(stock * 0.35));
  const b2Rem = Math.min(stock - b1Rem, Math.floor(stock * 0.40));
  const b3Rem = stock - b1Rem - b2Rem;

  const result: PurchaseBatch[] = [];

  result.push({
    id: `BATCH-${p.id}-01`,
    batchCode: `LOT-${p.sku.replace("SBV-", "")}-01`,
    productId: p.id,
    productName: p.name,
    vendor: p.vendor,
    vendorId: p.vendorId,
    purchaseDate: "2026-06-10",
    quantity: b1Rem + 40,
    remainingQty: b1Rem,
    unitCost: b1Cost,
    warehouse: "Warehouse 1 - Belagavi APMC",
    status: b1Rem > 0 ? "Active" : "Depleted",
  });

  if (b2Rem > 0 || stock > 30) {
    result.push({
      id: `BATCH-${p.id}-02`,
      batchCode: `LOT-${p.sku.replace("SBV-", "")}-02`,
      productId: p.id,
      productName: p.name,
      vendor: p.vendor,
      vendorId: p.vendorId,
      purchaseDate: "2026-07-04",
      quantity: b2Rem + 30,
      remainingQty: b2Rem,
      unitCost: b2Cost,
      warehouse: "Warehouse 1 - Belagavi APMC",
      status: b2Rem > 0 ? "Active" : "Depleted",
    });
  }

  if (b3Rem > 0) {
    result.push({
      id: `BATCH-${p.id}-03`,
      batchCode: `LOT-${p.sku.replace("SBV-", "")}-03`,
      productId: p.id,
      productName: p.name,
      vendor: p.vendor,
      vendorId: p.vendorId,
      purchaseDate: "2026-08-12",
      quantity: b3Rem + 20,
      remainingQty: b3Rem,
      unitCost: b3Cost,
      warehouse: "Warehouse 2 - Hubballi Central",
      status: "Active" as const,
    });
  }

  return result;
});

/**
 * Calculates FIFO Cost for a quantity sold from purchase batches.
 * Consumes strictly from the oldest available purchase batch layer first.
 */
export function calculateFIFOCost(
  productId: string,
  qtyToCost: number,
  batchList: PurchaseBatch[]
): {
  totalCost: number;
  unitCost: number;
  layersConsumed: { batchCode: string; qty: number; unitCost: number }[];
} {
  const productBatches = batchList
    .filter((b) => b.productId === productId && b.remainingQty > 0)
    .sort((a, b) => new Date(a.purchaseDate).getTime() - new Date(b.purchaseDate).getTime());

  let needed = qtyToCost;
  let totalCost = 0;
  const layersConsumed: { batchCode: string; qty: number; unitCost: number }[] = [];

  for (const b of productBatches) {
    if (needed <= 0) break;
    const take = Math.min(needed, b.remainingQty);
    totalCost += take * b.unitCost;
    layersConsumed.push({ batchCode: b.batchCode, qty: take, unitCost: b.unitCost });
    needed -= take;
  }

  if (needed > 0) {
    const fallbackCost = productBatches.length > 0 ? productBatches[productBatches.length - 1]!.unitCost : 0;
    totalCost += needed * fallbackCost;
    if (fallbackCost > 0) {
      layersConsumed.push({ batchCode: "BACKORDER-LOT", qty: needed, unitCost: fallbackCost });
    }
  }

  const unitCost = qtyToCost > 0 ? Math.round((totalCost / qtyToCost) * 100) / 100 : 0;
  return { totalCost, unitCost, layersConsumed };
}

/**
 * Gets the current FIFO unit cost for the next item sold (oldest active batch).
 */
export function getCurrentFIFOCost(productId: string, batchList: PurchaseBatch[], fallbackPrice = 0): number {
  const activeBatches = batchList
    .filter((b) => b.productId === productId && b.remainingQty > 0)
    .sort((a, b) => new Date(a.purchaseDate).getTime() - new Date(b.purchaseDate).getTime());

  if (activeBatches.length > 0) {
    return activeBatches[0]!.unitCost;
  }
  const allBatches = batchList
    .filter((b) => b.productId === productId)
    .sort((a, b) => new Date(b.purchaseDate).getTime() - new Date(a.purchaseDate).getTime());

  if (allBatches.length > 0) {
    return allBatches[0]!.unitCost;
  }
  return Math.round(fallbackPrice * 0.78);
}

/**
 * Calculates total inventory valuation under FIFO.
 */
export function calculateInventoryValuation(
  productId: string,
  batchList: PurchaseBatch[]
): {
  totalValue: number;
  totalUnits: number;
  fifoUnitCost: number;
  avgCost: number;
} {
  const productBatches = batchList.filter((b) => b.productId === productId && b.remainingQty > 0);
  const totalUnits = productBatches.reduce((s, b) => s + b.remainingQty, 0);
  const totalValue = productBatches.reduce((s, b) => s + b.remainingQty * b.unitCost, 0);
  const avgCost = totalUnits > 0 ? Math.round((totalValue / totalUnits) * 100) / 100 : 0;
  const fifoUnitCost = getCurrentFIFOCost(productId, batchList);

  return { totalValue, totalUnits, fifoUnitCost, avgCost };
}

/**
 * Calculates the average selling price for an item based on actual order history.
 */
export function getProductAverageSellingPrice(
  product: Product,
  ordersList: Order[]
): number {
  let totalRevenue = 0;
  let totalQty = 0;

  for (const ord of ordersList) {
    for (const it of ord.items) {
      if (it.product.id === product.id) {
        totalRevenue += it.product.price * it.qty;
        totalQty += it.qty;
      }
    }
  }

  if (totalQty > 0) {
    return Math.round((totalRevenue / totalQty) * 100) / 100;
  }
  return product.price;
}

export type OrderStatus =
  | "Placed" | "Payment Confirmed" | "Accepted" | "Packed"
  | "Dispatched" | "Out for Delivery" | "Delivered" | "Cancelled";

export const orderStages: OrderStatus[] = [
  "Placed", "Payment Confirmed", "Accepted", "Packed", "Dispatched", "Out for Delivery", "Delivered",
];

export type OrderItem = { product: Product; qty: number; vendor: string; vendorId: string; capacity?: string; unitPrice?: number; dbItemId?: string };
export type Order = {
  id: string;
  date: string;
  customer: string;
  customerId: string;
  email: string;
  phone: string;
  gstin?: string;
  items: OrderItem[];
  subtotal: number;
  discount: number;
  tax: number;
  shipping: number;
  amount: number;
  payment: "Paid" | "Pending" | "Partially Paid" | "Failed" | "Refunded" | "COD";
  advancePercent?: number;
  paidAmount?: number;
  paymentDueDate?: string;
  utr?: string;
  source?: string;
  method: string;
  txn: string;
  status: OrderStatus;
  address: string;
  city: string;
  state: string;
  pin: string;
  delivery: string;
  coupon?: string;
};

const methods = ["UPI", "Credit Card", "Debit Card", "Net Banking"];
const statusCycle: OrderStatus[] = ["Delivered", "Out for Delivery", "Dispatched", "Packed", "Accepted", "Placed", "Delivered", "Payment Confirmed", "Cancelled", "Delivered"];

export const buildOrder = (
  id: string,
  date: string,
  customerIndex: number,
  items: OrderItem[],
  payment: Order["payment"],
  method: string,
  status: OrderStatus,
  coupon?: string,
): Order => {
  const c = customers[customerIndex % customers.length]!;
  const subtotal = items.reduce((s, it) => s + (it.unitPrice ?? it.product.price) * it.qty, 0);
  const discount = coupon ? Math.round(subtotal * 0.05) : 0;
  const tax = Math.round((subtotal - discount) * 0.05);
  const shipping = subtotal > 5000 ? 0 : 149;
  return {
    id, date,
    customer: c.name, customerId: c.id, email: c.email, phone: c.phone, gstin: c.gst,
    items, subtotal, discount, tax, shipping,
    amount: subtotal - discount + tax + shipping,
    payment, method,
    txn: `TXN-9${id.replace(/\D/g, "").slice(-5)}`,
    status,
    address: c.address, city: c.city, state: c.state, pin: c.pin,
    delivery: "Standard Freight — 2 to 4 days",
    ...(coupon ? { coupon } : {}),
  };
};

export const orders: Order[] = Array.from({ length: 54 }, (_, i) => {
  const n = 1 + (i % 3);
  const items: OrderItem[] = Array.from({ length: n }, (_, k) => {
    const p = products[(i * 5 + k * 11) % products.length]!;
    return { product: p, qty: 1 + ((i + k) % 6), vendor: p.vendor, vendorId: p.vendorId };
  });
  const method = pick(methods, i);
  const payment: Order["payment"] =
    i % 13 === 5 ? "Pending" : i % 17 === 9 ? "Refunded" : i % 19 === 11 ? "Failed" : "Paid";
  const dateStr =
    i === 0 || i === 1
      ? "29 Sep 2026"
      : i < 6
        ? `${String(28 - (i - 2)).padStart(2, "0")} Sep 2026`
        : i < 18
          ? `${String(22 - (i - 6)).padStart(2, "0")} Sep 2026`
          : dt(i, 3);
  return buildOrder(
    `ORD-1${String(10001 + i).slice(-4)}${i}`.slice(0, 12),
    dateStr,
    i,
    items,
    payment,
    method,
    pick(statusCycle, i),
    i % 6 === 0 ? "SHAMI10" : undefined,
  );
}).map((o, i) => ({ ...o, id: `ORD-${10001 + i}` }));

export const vendorSubOrders = orders.flatMap((o) =>
  Array.from(new Set(o.items.map((i) => i.vendorId))).map((vid, idx) => ({
    id: `${o.id}-V${String(idx + 1).padStart(2, "0")}`,
    master: o.id,
    vendorId: vid,
    vendor: o.items.find((i) => i.vendorId === vid)!.vendor,
    customer: o.customer,
    amount: o.items.filter((i) => i.vendorId === vid).reduce((s, i) => s + i.product.price * i.qty, 0),
    status: o.status,
    payment: o.payment,
    date: o.date,
  })),
);

export const payments = orders.map((o) => ({
  txn: o.txn,
  order: o.id,
  customer: o.customer,
  vendor: o.items[0]!.vendor,
  amount: o.amount,
  method: o.method,
  date: o.date,
  status:
    o.payment === "Paid" ? "Successful"
      : o.payment === "Pending" || o.payment === "COD" ? "Pending"
        : o.payment === "Refunded" ? "Refunded" : "Failed",
  refund: o.payment === "Refunded" ? "Refunded to source" : "—",
}));

export const payouts = vendors.map((v, i) => ({
  id: `PO-2026${String(i + 1).padStart(3, "0")}`,
  vendor: v.business,
  vendorId: v.id,
  date: i === 0 ? "29 Sep 2026" : i < 4 ? `${22 + i} Sep 2026` : dt(i, 4),
  amount: rint(28000, 240000),
  method: "NEFT",
  status: pick(["Paid", "Paid", "Processing", "Pending"], i),
}));

export const coupons = [
  { code: "SHAMI10", type: "Percentage", value: "10%", min: 2000, max: 500, start: "01 Aug 2026", end: "30 Sep 2026", limit: 500, used: 231, status: "Active" },
  { code: "SUGARBULK", type: "Fixed", value: "₹750", min: 25000, max: 750, start: "05 Aug 2026", end: "05 Oct 2026", limit: 200, used: 48, status: "Active" },
  { code: "FIRSTORDER", type: "Percentage", value: "15%", min: 999, max: 300, start: "01 Jul 2026", end: "31 Aug 2026", limit: 1000, used: 764, status: "Active" },
  { code: "MONSOON5", type: "Percentage", value: "5%", min: 500, max: 150, start: "01 Jun 2026", end: "31 Jul 2026", limit: 400, used: 400, status: "Expired" },
  { code: "RICE200", type: "Fixed", value: "₹200", min: 3000, max: 200, start: "10 Aug 2026", end: "10 Oct 2026", limit: 300, used: 87, status: "Active" },
  { code: "OILFEST", type: "Percentage", value: "8%", min: 1500, max: 400, start: "01 Aug 2026", end: "31 Aug 2026", limit: 250, used: 122, status: "Active" },
  { code: "GSTSAVER", type: "Fixed", value: "₹1000", min: 50000, max: 1000, start: "01 Jul 2026", end: "31 Dec 2026", limit: 100, used: 19, status: "Active" },
  { code: "WELCOME50", type: "Fixed", value: "₹50", min: 499, max: 50, start: "01 Jan 2026", end: "31 Dec 2026", limit: 5000, used: 2841, status: "Active" },
  { code: "DIWALI20", type: "Percentage", value: "20%", min: 5000, max: 1500, start: "15 Oct 2026", end: "05 Nov 2026", limit: 800, used: 0, status: "Scheduled" },
  { code: "PULSEPACK", type: "Fixed", value: "₹350", min: 8000, max: 350, start: "01 Aug 2026", end: "15 Sep 2026", limit: 200, used: 64, status: "Active" },
  { code: "SUMMER7", type: "Percentage", value: "7%", min: 1200, max: 250, start: "01 Apr 2026", end: "30 Jun 2026", limit: 500, used: 431, status: "Expired" },
];

const reviewTitles = ["Consistent mill quality", "Good packaging", "Great value", "Reliable for canteen use", "Prompt delivery", "Quality as described", "Repeat purchase", "Fair pricing", "Slight delay but good", "Excellent bulk rate"];
const reviewBodies = [
  "Grain size and moisture are consistent every time. Invoicing is clean for GST input.",
  "Sealed packing with no leakage or damage in transit. Will order again.",
  "Quality is premium and the price beats our local wholesale market.",
  "Bought for our staff canteen, vendor coordination was smooth throughout.",
  "Delivered a day ahead of schedule, driver helped with unloading.",
  "Exactly matched the sample we received earlier from the vendor.",
  "Fourth order this quarter, service standard has stayed the same.",
  "Bulk pricing is competitive compared to other B2B platforms.",
  "Delivery came a day late but the product quality made up for it.",
  "Great rate for a 30kg bag, packaging was sturdy and clean.",
];

export const reviews = Array.from({ length: 54 }, (_, i) => {
  const p = products[(i * 3) % products.length]!;
  const c = customers[(i * 5) % customers.length]!;
  return {
    id: `R${100 + i}`,
    product: p.name,
    productId: p.id,
    customer: c.name,
    customerId: c.id,
    avatar: c.avatar,
    vendor: p.vendor,
    vendorId: p.vendorId,
    rating: 3 + (i % 3 === 0 ? 2 : i % 2 === 0 ? 1 : 2),
    title: pick(reviewTitles, i),
    body: pick(reviewBodies, i + 2),
    date: dt(i, 7),
    status: i % 7 === 3 ? "Pending" : i % 11 === 5 ? "Rejected" : "Published",
  };
});

export type ReturnRequest = {
  id: string; order: string; customer: string; product: string; vendor: string;
  reason: string; amount: number; date: string; status: string; refund: string;
};
const reasons = ["Damaged packaging", "Wrong item delivered", "Quality not as expected", "Short quantity received", "Delivery delayed beyond SLA", "Duplicate order placed"];
export const returns: ReturnRequest[] = Array.from({ length: 22 }, (_, i) => {
  const o = orders[(i * 2) % orders.length]!;
  return {
    id: `RET-${5001 + i}`,
    order: o.id,
    customer: o.customer,
    product: o.items[0]!.product.name,
    vendor: o.items[0]!.vendor,
    reason: pick(reasons, i),
    amount: Math.round(o.amount * 0.6),
    date: dt(i, 8),
    status: pick(["Requested", "Approved", "Rejected", "Picked Up", "Completed"], i),
    refund: pick(["Pending", "Processing", "Refunded", "Not Applicable"], i + 1),
  };
});

const notifTemplates: Array<[string, string, string]> = [
  ["New order received", "info", "%ORDER% was placed for %AMOUNT%."],
  ["Payment received", "success", "%AMOUNT% received via UPI for %ORDER%."],
  ["Low stock alert", "warning", "%PRODUCT% has dropped below the reorder level."],
  ["New review submitted", "info", "A 5-star review was posted on %PRODUCT%."],
  ["Refund requested", "warning", "A refund of %AMOUNT% was requested for %ORDER%."],
  ["Order delivered", "success", "%ORDER% was delivered successfully."],
  ["Vendor approval pending", "warning", "A vendor submitted KYC documents for review."],
  ["New customer registered", "info", "A new buyer completed registration."],
];

export const notifications = Array.from({ length: 34 }, (_, i) => {
  const [title, type, body] = notifTemplates[i % notifTemplates.length]!;
  const o = orders[i % orders.length]!;
  const p = products[(i * 7) % products.length]!;
  return {
    id: i + 1,
    role: (["admin", "vendor", "customer"] as const)[i % 3]!,
    title,
    type,
    body: body.replace("%ORDER%", o.id).replace("%AMOUNT%", inr(o.amount)).replace("%PRODUCT%", p.name),
    time: i < 3 ? `${10 + i * 9} min ago` : i < 9 ? `${i} hrs ago` : `${Math.ceil(i / 3)} days ago`,
    read: i % 4 === 0,
  };
});

export const salesSeries = [
  { month: "Jan", revenue: 1120000, orders: 286, customers: 152 },
  { month: "Feb", revenue: 1240000, orders: 320, customers: 180 },
  { month: "Mar", revenue: 1480000, orders: 386, customers: 224 },
  { month: "Apr", revenue: 1320000, orders: 351, customers: 198 },
  { month: "May", revenue: 1760000, orders: 442, customers: 268 },
  { month: "Jun", revenue: 1920000, orders: 489, customers: 305 },
  { month: "Jul", revenue: 2260000, orders: 551, customers: 342 },
  { month: "Aug", revenue: 2480000, orders: 604, customers: 388 },
];

export const categorySales = categories.map((c, i) => ({
  name: c.name,
  value: [22, 16, 13, 12, 9, 8, 7, 5, 4, 4][i] ?? 4,
}));

export const addresses = [
  { id: "A1", label: "Warehouse", name: "Rahul Deshpande", phone: "+91 98765 43210", line: "Plot 14, Industrial Estate", city: "Belagavi", state: "Karnataka", pin: "590010", landmark: "Near APMC Yard", default: true },
  { id: "A2", label: "Retail Store", name: "Rahul Deshpande", phone: "+91 98765 43210", line: "Shop 6, Market Road", city: "Hubballi", state: "Karnataka", pin: "580020", landmark: "Opp. Bus Stand", default: false },
];

/* vendor rollups */
for (const v of vendors) {
  v.products = products.filter((p) => p.vendorId === v.id).length;
  const subs = vendorSubOrders.filter((s) => s.vendorId === v.id);
  v.orders = subs.length;
  v.sales = subs.reduce((s, x) => s + x.amount, 0);
}

export const activity = orders.slice(0, 12).map((o, i) => ({
  id: i,
  text: `${o.customer} placed ${o.id} worth ${inr(o.amount)}`,
  time: `${i + 1} hrs ago`,
}));
