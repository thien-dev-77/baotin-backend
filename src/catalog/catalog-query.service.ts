import { BadRequestException, Injectable } from "@nestjs/common";
import { In } from "typeorm";
import { DatabaseService } from "../database/database.service";
import { CategoryEntity, CustomerEntity, ProductEntity, type UserEntity } from "../database/entities";
import { LedgerService } from "../ledger/ledger.service";
import type { Product } from "../types/domain.types";
import { effectivePolicyPrice, PricePolicyService, selectPricePolicy, today } from "./price-policy.service";
import { orderedCategories } from "./category.rules";
import type { CatalogQueryDto, CatalogSelectionDto } from "./catalog-query.dto";

const facetFields = ["brand", "material", "color", "size", "origin"] as const;
const accents = "àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ";
const plain = Array.from(accents, char => char === "đ" ? "d" : char.normalize("NFD").replace(/[\u0300-\u036f]/g, "")).join("");
export const normalizeSearch = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
const sqlSearch = `lower(translate(normalize(concat_ws(' ', p.data->>'name', p.data->>'code', p.data->>'brand', p.data->>'specification'), NFC), '${accents}${accents.toUpperCase()}', '${plain}${plain.toUpperCase()}'))`;
const escapeLike = (value: string) => value.replace(/[\\%_]/g, "\\$&");
type Candidate = { id: string; price: number; stock: number; featured: boolean; createdAt: Date };

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

  async selection(input: CatalogSelectionDto, user?: UserEntity) {
    if (!input.ids?.length && !input.code) return { products: [] as Product[] };
    const query = this.db.source.getRepository(ProductEntity).createQueryBuilder("p").where("p.published = true");
    if (input.ids?.length) query.andWhere("p.id IN (:...ids)", { ids: input.ids });
    if (input.code) query.andWhere("LOWER(TRIM(p.data->>'code')) = LOWER(:code)", { code: input.code.trim() });
    const [rows, context] = await Promise.all([query.getMany(), this.context(user)]);
    const products = await this.pricing.personalize(await this.ledger.stock(rows.map(row => row.data), context.branch), context.customer);
    return { products };
  }

  async bootstrap(user?: UserEntity) {
    const metadata = await this.metadata();
    const groups = metadata.categories.find(category => category.slug === "khoa")?.subcategories.slice(0, 5) || [];
    const base = () => this.db.source.getRepository(ProductEntity).createQueryBuilder("p").where("p.published = true").orderBy("p.id", "ASC");
    const groupsPromise = groups.map(subcategory => base().andWhere("p.data->>'category' = :category AND p.data->>'subcategory' = :subcategory", { category: "khoa", subcategory }).limit(5).getMany());
    const batches = await Promise.all([
      base().limit(10).getMany(),
      base().andWhere("(p.data->>'featured')::boolean = true").limit(10).getMany(),
      base().andWhere("(p.data->>'oldPrice')::numeric > (p.data->>'price')::numeric").limit(10).getMany(),
      ...groupsPromise,
    ]);
    const ids = Array.from(new Set(batches.flat().map(row => row.id)));
    const { products } = await this.selection({ ids }, user);
    return { products, ...metadata };
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
      .addSelect("(p.data->>'stock')::integer", "stock").addSelect("(p.data->>'featured')::boolean", "featured").addSelect("p.createdAt", "createdAt");
    const [raw, metadata, context] = await Promise.all([query.getRawMany<Candidate>(), this.metadata(), this.context(user)]);
    const policy = selectPricePolicy(context.customer, context.customer ? await this.pricing.list(context.branch) : [], today());
    const candidates = await this.ledger.stock(raw.map(row => ({ ...row, price: Number(row.price), stock: Number(row.stock) })), context.branch);
    const price = (row: Candidate) => effectivePolicyPrice(row, policy);
    const filtered = candidates.filter(row =>
      (input.min === undefined || price(row) >= input.min) && (input.max === undefined || price(row) <= input.max) &&
      (!input.stock?.length || input.stock.includes(row.stock > 0 ? "in" : "out")),
    ).sort((a, b) => {
      const difference = input.sort === "low" ? price(a) - price(b) : input.sort === "high" ? price(b) - price(a) :
        input.sort === "new" ? new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() : Number(b.featured) - Number(a.featured);
      return difference || a.id.localeCompare(b.id);
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
      const { customerPrice: _price, ...retail } = product;
      return [{ ...retail, stock: row.stock, ...(context.customer?.status === "Đang hoạt động" ? { customerPrice: price(row) } : {}) }];
    });
    return { products, total, page, pageSize: input.pageSize, totalPages, ...metadata };
  }
}
