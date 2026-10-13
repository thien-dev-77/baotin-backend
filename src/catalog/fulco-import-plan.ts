import { randomUUID, createHash } from "node:crypto";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import type { Category, Product } from "../types/domain.types";
import { ProductDto } from "./product.dto";
import { CategoryDto } from "./category.dto";
import { assertPublishable } from "./product.rules";
import { resolveProductPricing } from "./product-pricing";
import { validateVariantGroup } from "./product-variants";
import { fulcoVariantGroups, importSlug, type FulcoWorkbook } from "./fulco-import";
import { sentenceCaseProductName } from "./product-name";

export type FulcoImportOptions = { discountTarget: "b2b" | "both"; b2cDiscount: number; publish: boolean };
export const DEFAULT_FULCO_IMPORT_OPTIONS: Readonly<FulcoImportOptions> = { discountTarget: "b2b", b2cDiscount: 0, publish: false };
export type FulcoImportPlan = { categories: Category[]; products: { data: Product; published: boolean }[]; warnings: { row: number; code: string; messages: string[] }[]; variantGroups: number };

function categorySlug(name: string) {
  const slug = importSlug(name);
  return slug.length <= 80 ? slug : `${slug.slice(0, 71).replace(/-$/, "")}-${createHash("sha256").update(name).digest("hex").slice(0, 8)}`;
}

export function buildFulcoImport(workbook: FulcoWorkbook, imageURLs: Map<string, string>, options: FulcoImportOptions): FulcoImportPlan {
  const categories = [...new Set(workbook.rows.map(row => row.group))].map((name, index): Category => ({ slug: categorySlug(name), name, image: "", description: "", subcategories: [], visible: false, sortOrder: index * 10 }));
  if (new Set(categories.map(item => item.slug)).size !== categories.length) throw new Error("Category slugs collide.");
  const categoryByName = new Map(categories.map(item => [item.name, item]));
  const ids = new Map(workbook.rows.map(row => [row.code, randomUUID()]));
  const groups = fulcoVariantGroups(workbook.rows);
  const groupByCode = new Map(groups.flatMap(group => group.members.map(row => [row.code, group] as const)));
  const warnings = workbook.warnings.map(item => ({ ...item, messages: [...item.messages] }));
  const products = workbook.rows.map(row => {
    const gallery = [...new Set(row.sourceImages.map(url => imageURLs.get(url)).filter((url): url is string => Boolean(url)))];
    const failed = row.sourceImages.filter(url => !imageURLs.has(url)).length;
    if (failed) {
      const warning = warnings.find(item => item.code === row.code);
      const message = `${failed} source image(s) could not be stored; review gallery.`;
      if (warning) warning.messages.push(message); else warnings.push({ row: row.row, code: row.code, messages: [message] });
    }
    const group = groupByCode.get(row.code)!;
    const root = group.members.find(member => member.sourceImages.some(url => imageURLs.has(url))) || group.members[0];
    const category = categoryByName.get(row.group)!;
    const pricing = resolveProductPricing({ listPrice: row.listPrice, b2cDiscount: options.discountTarget === "both" ? row.discount : options.b2cDiscount, b2bDiscount: row.discount });
    const suffix = importSlug(row.code);
    const slug = `${importSlug(row.name).slice(0, 198 - suffix.length).replace(/-$/, "")}-${suffix}`;
    const published = options.publish && !row.missingName && Boolean(gallery.length && row.specification);
    const payload = {
      name: sentenceCaseProductName({ name: row.name, code: row.code, alternateCode: row.alternateCode, brand: "Fulco" }), code: row.code, slug, category: category.slug, subcategory: "", brand: "Fulco", unit: row.unit,
      ...pricing, specification: row.specification, material: row.material, color: row.color, size: row.size, origin: "",
      description: row.description, alternateCode: row.alternateCode, sourceUrl: row.sourceUrl,
      shortDescription: row.shortDescription, technicalDetails: row.technicalDetails, usageGuide: row.usageGuide, warranty: row.warranty,
      gallery, featured: false, published,
      ...(group.members.length > 1 ? { variantGroupId: ids.get(root.code), variantAttributes: group.attributes.get(row.code) } : {}),
    };
    const errors = validateSync(plainToInstance(ProductDto, payload), { whitelist: true, forbidNonWhitelisted: true });
    if (errors.length) throw new Error(`Invalid product at row ${row.row}: ${errors.map(error => error.property).join(", ")}.`);
    const { published: _published, ...fields } = payload;
    const data: Product = { ...fields, id: ids.get(row.code)!, image: gallery[0] || "", stock: 0 };
    if (published) assertPublishable(data);
    if (!category.image && gallery.length) category.image = gallery[0];
    if (published) category.visible = true;
    return { data, published };
  });
  if (new Set(products.map(item => item.data.slug)).size !== products.length) throw new Error("Product slugs collide.");
  for (const category of categories) {
    const errors = validateSync(plainToInstance(CategoryDto, category), { whitelist: true, forbidNonWhitelisted: true });
    if (errors.length) throw new Error(`Invalid category: ${category.name}.`);
  }
  for (const group of groups.filter(item => item.members.length > 1)) {
    const siblings = products.filter(item => group.attributes.has(item.data.code)).map(item => item.data);
    const root = siblings.find(item => item.id === item.variantGroupId)!;
    for (const item of siblings) validateVariantGroup(item.variantAttributes!, root, siblings, item.id);
  }
  return { products, categories, warnings, variantGroups: groups.filter(group => group.members.length > 1).length };
}
