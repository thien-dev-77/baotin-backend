import { BadRequestException, ConflictException } from "@nestjs/common";
import type { Product } from "../types/domain.types";

export type VariantAttribute = NonNullable<Product["variantAttributes"]>[number];

export function attributeKey(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("vi");
}

export function variantSignature(attributes: VariantAttribute[]) {
  return JSON.stringify(attributes.map(attribute => [attributeKey(attribute.name), attributeKey(attribute.value)]));
}

export function variantDimension(attributes: VariantAttribute[], kind: "size" | "color") {
  return attributes.find(attribute => {
    const name = attributeKey(attribute.name).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d");
    return (kind === "size" ? /^(kich thuoc|kich co|size)(\b|$)/ : /^(mau sac|mau|color)(\b|$)/).test(name);
  })?.value.trim();
}

export function validateVariantGroup(attributes: VariantAttribute[], root: Product | undefined, siblings: Product[], id: string) {
  if (!attributes.length || attributes.length > 6 || attributes.some(attribute => !attribute.name.trim() || !attribute.value.trim())) {
    throw new BadRequestException("Mỗi biến thể cần từ 1 đến 6 thuộc tính có tên và giá trị.");
  }
  const names = attributes.map(attribute => attributeKey(attribute.name));
  if (new Set(names).size !== names.length) throw new BadRequestException("Tên thuộc tính biến thể không được trùng nhau.");
  if (root && (root.variantAttributes?.length !== attributes.length || root.variantAttributes.some((item, index) => attributeKey(item.name) !== names[index]))) {
    throw new BadRequestException("Thuộc tính phải có cùng tên và thứ tự với sản phẩm gốc.");
  }
  if (siblings.some(product => product.id !== id && product.variantAttributes && variantSignature(product.variantAttributes) === variantSignature(attributes))) {
    throw new ConflictException("Tổ hợp thuộc tính này đã có trong nhóm sản phẩm.");
  }
}

export function groupRepresentatives(products: Product[]) {
  const groups = new Map<string, Product>();
  for (const product of products) {
    const key = product.variantGroupId || product.id;
    if (!groups.has(key) || product.id === key) groups.set(key, product);
  }
  return Array.from(groups.values());
}
