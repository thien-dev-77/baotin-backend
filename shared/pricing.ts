import type { Customer, Product } from "./types";

// Seed pricing only. Live policies must replace this on the server.
export function priceFor(product: Product, customer: Customer | null) {
  if (customer && product.customerPrice !== undefined) return product.customerPrice;
  return customer ? Math.max(1000, Math.round(product.price * 0.9 / 500) * 500) : product.price;
}
