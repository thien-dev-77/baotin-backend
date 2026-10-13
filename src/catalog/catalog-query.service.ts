import { BadRequestException, Injectable } from "@nestjs/common";
import { In } from "typeorm";
import { DatabaseService } from "../database/database.service";
import { CategoryEntity, CustomerEntity, ProductEntity, type UserEntity } from "../database/entities";
import { LedgerService } from "../ledger/ledger.service";
import type { Product } from "../types/domain.types";
import { effectivePolicyPrice, PricePolicyService, selectPricePolicy, today } from "./price-policy.service";
import { orderedCategories } from "./category.rules";
import type { CatalogQueryDto, CatalogSelectionDto } from "./catalog-query.dto";
import { publicProduct, retailPrice, retailProjection, type PricingProduct } from "./product-pricing";
import { groupRepresentatives } from "./product-variants";
import { ReviewEntity } from "../database/experience.entities";

const facetFields = ["brand", "material", "color", "size", "origin"] as const;
const HOME_CATEGORY_SECTIONS = 5;
const HOME_CATEGORY_PRODUCTS = 5;
const HOME_SHOWCASE_PRODUCTS = 10;
const accents = "àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ";
const plain = Array.from(accents, char => char === "đ" ? "d" : char.normalize("NFD").replace(/[\u0300-\u036f]/g, "")).join("");
export const normalizeSearch = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
const sqlSearch = `lower(translate(normalize(concat_ws(' ', p.data->>'name', p.data->>'code', p.data->>'alternateCode', p.data->>'brand', p.data->>'specification'), NFC), '${accents}${accents.toUpperCase()}', '${plain}${plain.toUpperCase()}'))`;
const escapeLike = (value: string) => value.replace(/[\\%_]/g, "\\$&");
type Candidate = PricingProduct & { id: string; variantGroupId?: string; stock: number; featured: boolean; createdAt: Date };

@Injectable()
export class CatalogQueryService {
  constructor(private readonly db: DatabaseService, private readonly pricing: PricePolicyService, private readonly ledger: LedgerService) {}

  async metadata() {
    const [categories, values] = await Promise.all([
      this.db.source.getRepository(CategoryEntity).find(),
      this.db.source.getRepository(ProductEntity).createQueryBuilder("p")
        .select(facetFields.map(field => `p.data->>'${field}' AS "${field}"`))
        .where("p.published = true").distinct(true).getRawMany<Record<typeof facetFields[number], string>>(),
    ]);
    const facets = Object.fromEntries(facetFields.map(field => [field, Array.from(new Set(values.map(value => value[field]).filter(Boolean))).sort((a, b) => a.localeCompare(b, "vi"))])) as Record<typeof facetFields[number], string[]>;
    return { categories: orderedCategories(categories, true), brands: facets.brand, facets };
  }

  private async context(user?: UserEntity) {
    const row = user?.customerId ? await this.db.source.getRepository(CustomerEntity).findOneBy({ id: user.customerId }) : null;
    return { customer: row?.data, branch: row?.branch || "Quy Nhơn" };
  }

  private async withReviewSummaries(products: Product[]): Promise<Product[]> {
    if (!products.length) return products;
    const rows = await this.db.source.getRepository(ReviewEntity).createQueryBuilder("r")
      .select("r.productId", "productId").addSelect("AVG(r.stars)", "rating").addSelect("COUNT(*)", "count")
      .where("r.status = :status AND r.productId IN (:...ids)", { status: "published", ids: products.map(product => product.id) })
      .groupBy("r.productId").getRawMany<{ productId: string; rating: string; count: string }>();
    const summaries = new Map(rows.map(row => [row.productId, { rating: Number(row.rating), count: Number(row.count) }]));
    return products.map(product => ({ ...product, reviewSummary: summaries.get(product.id) || { rating: 0, count: 0 } }));
  }

  private async homeCategoryIds(categories: { slug: string }[]): Promise<string[]> {
    if (!categories.length) return [];
    // Select one published SKU per variant group, then five IDs per category in
    // one bounded query. Galleries and descriptions are hydrated only afterward.
    const representatives = this.db.source.getRepository(ProductEntity).createQueryBuilder("p")
      .select("p.id", "id").addSelect("p.data->>'category'", "category")
      .addSelect("COALESCE((p.data->>'featured')::boolean, false)", "featured")
      .addSelect("ROW_NUMBER() OVER (PARTITION BY p.data->>'category', COALESCE(NULLIF(p.data->>'variantGroupId', ''), p.id) ORDER BY CASE WHEN p.id = p.data->>'variantGroupId' THEN 0 ELSE 1 END, p.id)", "variantRank")
      .where("p.published = true AND p.data->>'category' IN (:...categories)", { categories: categories.map(category => category.slug) });
    const ranked = this.db.source.createQueryBuilder()
      .select('r.id', "id").addSelect('r.category', "category")
      .addSelect("ROW_NUMBER() OVER (PARTITION BY r.category ORDER BY r.featured DESC, r.id)", "categoryRank")
      .from(`(${representatives.getQuery()})`, "r").where('r."variantRank" = 1').setParameters(representatives.getParameters());
    const rows = await this.db.source.createQueryBuilder().select("h.id", "id").addSelect("h.category", "category")
      .from(`(${ranked.getQuery()})`, "h").where('h."categoryRank" <= :count', { count: HOME_CATEGORY_PRODUCTS })
      .orderBy('h."categoryRank"', "ASC").setParameters(ranked.getParameters()).getRawMany<{ id: string; category: string }>();
    const populated = categories.filter(category => rows.some(row => row.category === category.slug)).slice(0, HOME_CATEGORY_SECTIONS);
    return populated.flatMap(category => rows.filter(row => row.category === category.slug).map(row => row.id));
  }

  async selection(input: CatalogSelectionDto, user?: UserEntity) {
    if (!input.ids?.length && !input.code) return { products: [] as Product[] };
    const query = this.db.source.getRepository(ProductEntity).createQueryBuilder("p").where("p.published = true");
    if (input.ids?.length) query.andWhere("p.id IN (:...ids)", { ids: input.ids });
    if (input.code) query.andWhere("(LOWER(TRIM(p.data->>'code')) = LOWER(:code) OR LOWER(TRIM(p.data->>'alternateCode')) = LOWER(:code))", { code: input.code.trim() });
    const [rows, context] = await Promise.all([query.getMany(), this.context(user)]);
    const products = await this.pricing.personalize(await this.ledger.stock(rows.map(row => row.data), context.branch), context.customer);
    return { products: await this.withReviewSummaries(products) };
  }

  async bootstrap(user?: UserEntity) {
    const metadata = await this.metadata();
    const base = () => this.db.source.getRepository(ProductEntity).createQueryBuilder("p").where("p.published = true").orderBy("p.id", "ASC");
    const [batches, categoryIds] = await Promise.all([
      Promise.all([
        base().limit(HOME_SHOWCASE_PRODUCTS).getMany(),
        base().andWhere("(p.data->>'featured')::boolean = true").limit(HOME_SHOWCASE_PRODUCTS).getMany(),
        base().andWhere("(p.data->>'oldPrice')::numeric > (p.data->>'price')::numeric").limit(HOME_SHOWCASE_PRODUCTS).getMany(),
      ]),
      this.homeCategoryIds(metadata.categories),
    ]);
    const ids = Array.from(new Set([...categoryIds, ...batches.flat().map(row => row.id)]));
    const { products } = await this.selection({ ids }, user);
    const order = new Map(ids.map((id, index) => [id, index]));
    const ordered = products.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    return { products: groupRepresentatives(ordered), ...metadata };
  }

  async search(input: CatalogQueryDto, user?: UserEntity) {
    if (input.min !== undefined && input.max !== undefined && input.min > input.max) throw new BadRequestException("Giá từ không được lớn hơn giá đến.");
    const query = this.db.source.getRepository(ProductEntity).createQueryBuilder("p").where("p.published = true");
    for (const field of ["category", ...facetFields] as const) {
      if (input[field]?.length) query.andWhere(`p.data->>'${field}' IN (:...${field})`, { [field]: input[field] });
    }
    if (input.subcategory) query.andWhere("p.data->>'subcategory' = :subcategory", { subcategory: input.subcategory });
    if (input.promotion) query.andWhere("(p.data->>'oldPrice')::numeric > (p.data->>'price')::numeric");
    if (input.featured !== undefined) query.andWhere("(p.data->>'featured')::boolean = :featured", { featured: input.featured });
    normalizeSearch(input.q || "").trim().split(/\s+/).filter(Boolean).forEach((term, index) => {
      query.andWhere(`${sqlSearch} LIKE :term${index}`, { [`term${index}`]: `%${escapeLike(term)}%` });
    });
    // Rank lightweight rows, not full galleries/descriptions. Derived price and
    // available stock reuse the same policies/reservations as checkout.
    query.select("p.id", "id").addSelect("(p.data->>'price')::numeric", "price")
      .addSelect("p.data->>'variantGroupId'", "variantGroupId")
      .addSelect("(p.data->>'listPrice')::numeric", "listPrice").addSelect("(p.data->>'b2cDiscount')::numeric", "b2cDiscount").addSelect("(p.data->>'b2bDiscount')::numeric", "b2bDiscount")
      .addSelect("(p.data->>'stock')::integer", "stock").addSelect("(p.data->>'featured')::boolean", "featured").addSelect("p.createdAt", "createdAt");
    const [raw, metadata, context] = await Promise.all([query.getRawMany<Candidate>(), this.metadata(), this.context(user)]);
    const policy = selectPricePolicy(context.customer, context.customer ? await this.pricing.list(context.branch) : [], today());
    const candidates = await this.ledger.stock(raw.map(row => ({ ...row, price: Number(row.price), stock: Number(row.stock), listPrice: row.listPrice == null ? undefined : Number(row.listPrice), b2cDiscount: row.b2cDiscount == null ? undefined : Number(row.b2cDiscount), b2bDiscount: row.b2bDiscount == null ? undefined : Number(row.b2bDiscount) })), context.branch);
    const activeB2b = context.customer?.status === "Đang hoạt động";
    const price = (row: Candidate) => activeB2b ? effectivePolicyPrice(row, policy) : retailPrice(row);
    const sorted = candidates.filter(row =>
      (input.min === undefined || price(row) >= input.min) && (input.max === undefined || price(row) <= input.max) &&
      (!input.stock?.length || input.stock.includes(row.stock > 0 ? "in" : "out")),
    ).sort((a, b) => {
      const difference = input.sort === "low" ? price(a) - price(b) : input.sort === "high" ? price(b) - price(a) :
        input.sort === "new" ? new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() : Number(b.featured) - Number(a.featured);
      const rootPriority = input.sort === "low" || input.sort === "high" || input.sort === "new" ? 0 :
        Number(Boolean(a.variantGroupId && a.id !== a.variantGroupId)) - Number(Boolean(b.variantGroupId && b.id !== b.variantGroupId));
      return difference || rootPriority || a.id.localeCompare(b.id);
    });
    const seen = new Set<string>();
    const filtered = sorted.filter(row => {
      const key = row.variantGroupId || row.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / input.pageSize));
    const page = Math.min(input.page, totalPages);
    const selected = filtered.slice((page - 1) * input.pageSize, page * input.pageSize);
    const rows = selected.length ? await this.db.source.getRepository(ProductEntity).find({ where: { id: In(selected.map(row => row.id)), published: true } }) : [];
    const byId = new Map(rows.map(row => [row.id, row.data]));
    const products = selected.flatMap(row => {
      const product = byId.get(row.id);
      if (!product) return [];
      const retail = activeB2b ? retailProjection(product) : publicProduct(product);
      return [{ ...retail, stock: row.stock, ...(activeB2b ? { customerPrice: price(row) } : {}) }];
    });
    return { products: await this.withReviewSummaries(products), total, page, pageSize: input.pageSize, totalPages, ...metadata };
  }
}
