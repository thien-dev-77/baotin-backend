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

function isAttributeProjection(attributes: VariantAttribute[], previous: VariantAttribute[]) {
  return attributes.length < previous.length && attributes.every(attribute => previous.some(item =>
    attributeKey(item.name) === attributeKey(attribute.name) && attributeKey(item.value) === attributeKey(attribute.value)));
}

export function validateVariantGroup(attributes: VariantAttribute[], root: Product | undefined, siblings: Product[], id: string, previous: Product[] = []) {
  const original = previous.find(product => product.id === id);
  const emptyGroup = root?.variantAttributes?.length === 0;
  if ((!attributes.length && !original && !emptyGroup) || attributes.length > 6 || attributes.some(attribute => !attribute.name.trim() || !attribute.value.trim())) {
    throw new BadRequestException("Loại biến thể cần có tên và giá trị, tối đa 6 loại.");
  }
  const names = attributes.map(attribute => attributeKey(attribute.name));
  if (new Set(names).size !== names.length) throw new BadRequestException("Tên thuộc tính biến thể không được trùng nhau.");
  if (root && (root.variantAttributes?.length !== attributes.length || root.variantAttributes.some((item, index) => attributeKey(item.name) !== names[index]))) {
    throw new BadRequestException("Thuộc tính phải có cùng tên và thứ tự với sản phẩm gốc.");
  }
  if (siblings.some(product => {
    if (product.id === id || !product.variantAttributes || variantSignature(product.variantAttributes) !== variantSignature(attributes)) return false;
    if (!attributes.length && emptyGroup) return false;
    const otherOriginal = previous.find(item => item.id === product.id);
    if (!original?.variantAttributes || !otherOriginal?.variantAttributes) return true;
    // Removing a dimension may make distinct SKUs share the remaining values.
    // Existing overlaps remain valid when saving content or renaming a type.
    if (variantSignature(original.variantAttributes) === variantSignature(otherOriginal.variantAttributes)) return false;
    return !isAttributeProjection(attributes, original.variantAttributes)
      || !isAttributeProjection(product.variantAttributes, otherOriginal.variantAttributes);
  })) {
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
