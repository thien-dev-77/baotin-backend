import { BadRequestException } from "@nestjs/common";
import type { Product } from "../types/domain.types";

export const MAX_PRODUCT_PRICE = 999_999_999_999;
export const MAX_PRODUCT_DISCOUNT = 99.99;
const BASIS_POINTS = 10_000;
export type PricingProduct = Pick<Product, "price" | "listPrice" | "b2cDiscount" | "b2bDiscount">;
type PricingInput = Partial<PricingProduct> & Pick<Product, "oldPrice">;

export function hasRetailPricing(product: Partial<PricingProduct>): product is PricingProduct & { listPrice: number; b2cDiscount: number } {
  return Number.isSafeInteger(product.listPrice) && Number(product.listPrice) >= 0 && typeof product.b2cDiscount === "number" && Number.isFinite(product.b2cDiscount) && product.b2cDiscount >= 0 && product.b2cDiscount <= MAX_PRODUCT_DISCOUNT;
}

export function discountedPrice(listPrice: number, discount: number) {
  // Integer basis points avoid floating-point half-VND rounding differences.
  const numerator = BigInt(listPrice) * BigInt(BASIS_POINTS - Math.round(discount * 100));
  const amount = Number((numerator + BigInt(BASIS_POINTS / 2)) / BigInt(BASIS_POINTS));
  return listPrice > 0 ? Math.max(1, amount) : 0;
}
export const retailPrice = (product: PricingProduct) => hasRetailPricing(product) ? discountedPrice(product.listPrice, product.b2cDiscount) : product.price;
export const pricingBase = (product: PricingProduct) => hasRetailPricing(product) ? product.listPrice : product.price;
export const defaultB2bPrice = (product: PricingProduct) => hasRetailPricing(product) && product.b2bDiscount !== undefined ? discountedPrice(product.listPrice, product.b2bDiscount) : product.price;

export function retailProjection<T extends Product>(product: T) {
  return hasRetailPricing(product) ? { ...product, price: retailPrice(product), oldPrice: product.b2cDiscount > 0 ? product.listPrice : undefined } : product;
}
export function publicProduct<T extends Product>(product: T) {
  const { customerPrice: _customerPrice, b2bDiscount: _b2bDiscount, ...retail } = retailProjection(product);
  return retail;
}
export function redactProductPricing<T extends Product>(product: T) {
  const { listPrice: _list, b2cDiscount: _b2c, b2bDiscount: _b2b, customerPrice: _customer, oldPrice: _old, ...data } = product;
  return { ...data, price: 0 };
}

export function resolveProductPricing(input: PricingInput, previous?: Product): Pick<Product, "price" | "oldPrice" | "listPrice" | "b2cDiscount" | "b2bDiscount"> {
  const fields = [input.listPrice, input.b2cDiscount, input.b2bDiscount];
  if (fields.some(value => value !== undefined)) {
    if (fields.some(value => value === undefined)) throw new BadRequestException("Nhập đủ giá niêm yết, CK B2C và CK B2B.");
    const listPrice = input.listPrice!, b2cDiscount = input.b2cDiscount!, b2bDiscount = input.b2bDiscount!;
    if (!Number.isSafeInteger(listPrice) || listPrice < 0 || listPrice > MAX_PRODUCT_PRICE || [b2cDiscount, b2bDiscount].some(discount => !Number.isFinite(discount) || discount < 0 || discount > MAX_PRODUCT_DISCOUNT || Math.abs(discount * 100 - Math.round(discount * 100)) > 0.000001)) throw new BadRequestException("Giá niêm yết hoặc chiết khấu không hợp lệ.");
    return { listPrice, b2cDiscount, b2bDiscount, price: discountedPrice(listPrice, b2cDiscount), oldPrice: b2cDiscount > 0 ? listPrice : undefined };
  }
  if (previous && hasRetailPricing(previous)) {
    if (input.price !== undefined && input.price !== retailPrice(previous)) throw new BadRequestException("Cập nhật giá niêm yết và chiết khấu để thay đổi giá bán.");
    if (input.oldPrice !== undefined && input.oldPrice !== retailProjection(previous).oldPrice) throw new BadRequestException("Giá trước giảm được xác định từ giá niêm yết.");
    return { listPrice: previous.listPrice, b2cDiscount: previous.b2cDiscount, b2bDiscount: previous.b2bDiscount, price: retailPrice(previous), oldPrice: retailProjection(previous).oldPrice };
  }
  if (!Number.isSafeInteger(input.price) || Number(input.price) < 0 || Number(input.price) > MAX_PRODUCT_PRICE) throw new BadRequestException("Nhập giá bán hoặc cấu hình giá niêm yết và chiết khấu.");
  if (input.oldPrice != null && input.oldPrice < input.price!) throw new BadRequestException("Giá trước giảm không được thấp hơn giá bán lẻ.");
  return { price: input.price!, oldPrice: input.oldPrice ?? undefined };
}
