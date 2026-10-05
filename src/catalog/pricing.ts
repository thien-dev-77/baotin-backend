import type { Customer, Product } from "../types/domain.types";

export function priceFor(product: Product, customer: Customer | null) {
  if (customer && product.customerPrice !== undefined) return product.customerPrice;
  return product.price;
}
