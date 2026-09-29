import riceImg from "@/assets/p-rice.jpg";
import oilImg from "@/assets/p-oil.jpg";
import sugarImg from "@/assets/p-sugar.jpg";

export type Tile = {
  /** Card label */
  label: string;
  caption?: string;
  image: string;
  /** Drill-down slug (child level) or undefined when the tile opens the shop listing */
  slug?: string;
  /** Shop filter value used when the tile is a leaf */
  filter?: string;
};

export type CategoryNode = {
  slug: string;
  name: string;
  tagline: string;
  image: string;
  tiles: Tile[];
  children?: Record<string, { name: string; tagline: string; tiles: Tile[] }>;
};

export const categorySlug = (name: string) =>
  name.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const riceVariety = (code: string, kind: string): Tile => ({
  label: code,
  caption: `${kind} rice · 25 kg bag`,
  image: riceImg,
  filter: code,
});

const brand = (label: string, caption: string): Tile => ({ label, caption, image: oilImg, filter: label });

export const categoryTree: Record<string, CategoryNode> = {
  rice: {
    slug: "rice",
    name: "Rice",
    tagline: "Raw and steam varieties in 25 kg bags",
    image: riceImg,
    tiles: [
      riceVariety("R-111", "Raw"),
      riceVariety("R-222", "Raw"),
      riceVariety("R-333", "Raw"),
      riceVariety("R-444", "Raw"),
      riceVariety("S-111", "Steam"),
      riceVariety("S-222", "Steam"),
      riceVariety("S-333", "Steam"),
      riceVariety("S-444", "Steam"),
    ],
  },
  sugar: {
    slug: "sugar",
    name: "Sugar",
    tagline: "Mill-fresh refined sugar",
    image: sugarImg,
    tiles: [{ label: "Grade S1", caption: "Refined S1 sugar bags & packs", image: sugarImg, filter: "S1 Sugar" }],
  },
  oil: {
    slug: "oil",
    name: "Cooking Oil",
    tagline: "Sunflower and palm oil in every pack size",
    image: oilImg,
    tiles: [
      { label: "Sunflower Oil", caption: "2 brands", image: oilImg, slug: "sunflower-oil" },
      { label: "Palm Oil", caption: "4 brands", image: oilImg, slug: "palm-oil" },
    ],
    children: {
      "sunflower-oil": {
        name: "Sunflower Oil",
        tagline: "Choose a brand",
        tiles: [brand("Sunpure", "Refined sunflower oil"), brand("GoldWinner", "Refined sunflower oil")],
      },
      "palm-oil": {
        name: "Palm Oil",
        tagline: "Choose a brand",
        tiles: [
          brand("Palm Shakthi", "Palm oil pouches & tins"),
          brand("Shakthi Gold", "Palm oil pouches & tins"),
          brand("Raaga Palm Oil", "Palm oil pouches & tins"),
          brand("SVT Gold", "Palm oil pouches & tins"),
        ],
      },
    },
  },
};

export const getCategoryNode = (slug: string) => categoryTree[slug];
