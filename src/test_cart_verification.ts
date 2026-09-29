import { products, type Product } from "./lib/data";

// Automated Cart State and Logic Verification
interface CartLine {
  id: string;
  qty: number;
}

let cart: CartLine[] = [];

function getCartItems() {
  return cart
    .map((l) => ({ product: products.find((p: Product) => p.id === l.id)!, qty: l.qty }))
    .filter((l) => l.product);
}

export function getCartCount() {
  return cart.reduce((s, l) => s + l.qty, 0);
}

export function getSubtotal() {
  const items = getCartItems();
  return items.reduce((s, l) => s + l.product.price * l.qty, 0);
}

export function addToCart(id: string, qty = 1) {
  const prod = products.find((p: Product) => p.id === id);
  const addAmount = Math.max(1, Math.floor(Number(qty) || 1));
  const existing = cart.find((l) => l.id === id);
  if (existing) {
    const nextQty = existing.qty + addAmount;
    const safeQty = prod && prod.stock > 0 ? Math.min(nextQty, prod.stock) : nextQty;
    existing.qty = safeQty;
  } else {
    const initialQty = prod && prod.stock > 0 ? Math.min(addAmount, prod.stock) : addAmount;
    cart.push({ id, qty: initialQty });
  }
}

export function setQty(id: string, qty: number | string) {
  const prod = products.find((p: Product) => p.id === id);
  const parsed = Math.max(1, Math.floor(Number(qty) || 1));
  const safeQty = prod && prod.stock > 0 ? Math.min(parsed, prod.stock) : parsed;
  const item = cart.find((l) => l.id === id);
  if (item) {
    item.qty = safeQty;
  }
}

export function removeFromCart(id: string) {
  cart = cart.filter((l) => l.id !== id);
}

export function clearCart() {
  cart = [];
}
