import { BadRequestException, ConflictException } from "@nestjs/common";
import type { Product } from "../types/domain.types";

export type VariantAttribute = NonNullable<Product["variantAttributes"]>[number];
const skuCollator = new Intl.Collator("vi", { numeric: true, sensitivity: "base" });

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

type VariantCandidate = Pick<Product, "id" | "code" | "variantAttributes">;
type VariantConflict = { attributes: VariantAttribute[]; products: VariantCandidate[] };

function validateVariantAttributes(attributes: VariantAttribute[], root: Product | undefined, hasPrevious: boolean) {
  const emptyGroup = root?.variantAttributes?.length === 0;
  if ((!attributes.length && !hasPrevious && !emptyGroup) || attributes.length > 6 || attributes.some(attribute => !attribute.name.trim() || !attribute.value.trim())) {
    throw new BadRequestException("Loại biến thể cần có tên và giá trị, tối đa 6 loại.");
  }
  const names = attributes.map(attribute => attributeKey(attribute.name));
  if (new Set(names).size !== names.length) throw new BadRequestException("Tên thuộc tính biến thể không được trùng nhau.");
  if (root && (root.variantAttributes?.length !== attributes.length || root.variantAttributes.some((item, index) => attributeKey(item.name) !== names[index]))) {
    throw new BadRequestException("Thuộc tính phải có cùng tên và thứ tự với sản phẩm gốc.");
  }
}

function allowsSharedCombination(attributes: VariantAttribute[], original: Product | undefined, otherOriginal: Product | undefined, emptyGroup: boolean) {
  if (!attributes.length && emptyGroup) return true;
  if (!original?.variantAttributes || !otherOriginal?.variantAttributes) return false;
  // Removing a dimension may make distinct SKUs share the remaining values.
  // Existing overlaps remain valid when saving content or renaming a type.
  if (variantSignature(original.variantAttributes) === variantSignature(otherOriginal.variantAttributes)) return true;
  return isAttributeProjection(attributes, original.variantAttributes)
    && isAttributeProjection(attributes, otherOriginal.variantAttributes);
}

function findVariantConflicts(products: VariantCandidate[], previous: Product[], emptyGroup: boolean) {
  const originals = new Map(previous.map(product => [product.id, product]));
  const combinations = new Map<string, VariantCandidate[]>();
  for (const product of products) {
    if (!product.variantAttributes) continue;
    const signature = variantSignature(product.variantAttributes);
    const members = combinations.get(signature) || [];
    members.push(product); combinations.set(signature, members);
  }
  const conflicts: VariantConflict[] = [];
  for (const members of combinations.values()) {
    const attributes = members[0].variantAttributes!;
    const conflicting = members.some((member, index) => members.slice(index + 1).some(other =>
      !allowsSharedCombination(attributes, originals.get(member.id), originals.get(other.id), emptyGroup)));
    if (conflicting) conflicts.push({ attributes, products: members });
  }
  return conflicts;
}

function assertNoVariantConflicts(conflicts: VariantConflict[]) {
  if (!conflicts.length) return;
  const details = conflicts.map(conflict => {
    const codes = conflict.products.map(product => product.code).sort(skuCollator.compare).join(", ");
    const attributes = conflict.attributes.map(attribute => `${attribute.name.trim()}: ${attribute.value.trim()}`).join(" · ");
    return `• SKU ${codes} cùng có ${attributes}.`;
  });
  throw new ConflictException([
    `Tổ hợp thuộc tính bị trùng ở ${conflicts.length} nhóm SKU:`,
    ...details,
    "Kiểm tra và sửa giá trị của các SKU trên, thêm thuộc tính để phân biệt hoặc tách SKU khỏi nhóm, rồi lưu lại.",
  ].join("\n"));
}

export function validateVariantGroup(attributes: VariantAttribute[], root: Product | undefined, siblings: Product[], id: string, previous: Product[] = []) {
  const original = previous.find(product => product.id === id);
  validateVariantAttributes(attributes, root, Boolean(original));
  const signature = variantSignature(attributes);
  const candidates: VariantCandidate[] = siblings.filter(product => product.id !== id && product.variantAttributes && variantSignature(product.variantAttributes) === signature);
  candidates.push({ id, code: original?.code || "SKU đang lưu", variantAttributes: attributes });
  assertNoVariantConflicts(findVariantConflicts(candidates, previous, root?.variantAttributes?.length === 0));
}

export function validateVariantGroupConfiguration(products: Product[], root: Product, previous: Product[]) {
  const originalIds = new Set(previous.map(product => product.id));
  for (const product of products) validateVariantAttributes(product.variantAttributes!, root, originalIds.has(product.id));
  assertNoVariantConflicts(findVariantConflicts(products, previous, root.variantAttributes?.length === 0));
}

export function groupRepresentatives(products: Product[]) {
  const groups = new Map<string, Product>();
  for (const product of products) {
    const key = product.variantGroupId || product.id;
    if (!groups.has(key) || product.id === key) groups.set(key, product);
  }
  return Array.from(groups.values());
}
