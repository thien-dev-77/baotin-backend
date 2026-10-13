import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { In, type ObjectLiteral, type SelectQueryBuilder } from "typeorm";
import { CategoryEntity, CustomerEntity, OrderEntity, ProductEntity, ApprovalEntity, ReceiptEntity, UserEntity } from "../database/entities";
import { DatabaseService } from "../database/database.service";
import { LedgerService } from "../ledger/ledger.service";
import { businessDate } from "../orders/orders.service";
import { validDate } from "../catalog/price-policy.service";
import { orderedCategories } from "../catalog/category.rules";
import { normalizeSearch } from "../catalog/catalog-query.service";
import { redactProductPricing } from "../catalog/product-pricing";
import { emptyAdminState } from "./admin-resources";
import { effectiveOrder } from "./admin.service";
import { isWarehouseOrder } from "./rules/warehouse.rules";
import { customerDebtSql, customerFinanceQuery, customerOverdueSql } from "./customer-finance.query";
import type { ApiAdminState } from "../types/api.types";
import type { AdminBrowseDto, AdminBranchDto } from "./admin-browse.dto";
import { MAX_BULK_PRODUCTS } from "../catalog/product-bulk.dto";

const accents = "àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ";
const plain = Array.from(accents, char => char === "đ" ? "d" : char.normalize("NFD").replace(/[\u0300-\u036f]/g, "")).join("");
const warehouseStages = ["Chờ soạn hàng", "Đang soạn", "Sẵn sàng giao"];
const customerGroups = ["Chờ phân nhóm", "Xưởng nội thất", "Thiết kế - thi công", "Thợ - đội thi công"];
const RECENT_CUSTOMER_ORDERS = 4;

export function applyAdminSearch<T extends ObjectLiteral>(query: SelectQueryBuilder<T>, text: string | undefined, expressions: readonly string[]) {
  const folded = `lower(translate(normalize(concat_ws(' ', ${expressions.join(", ")}), NFC), '${accents}${accents.toUpperCase()}', '${plain}${plain.toUpperCase()}'))`;
  normalizeSearch(text || "").trim().split(/\s+/).filter(Boolean).forEach((term, index) => {
    query.andWhere(`${folded} LIKE :search${index}`, { [`search${index}`]: `%${term.replace(/[\\%_]/g, "\\$&")}%` });
  });
  return query;
}

@Injectable()
export class AdminBrowseService {
  constructor(private readonly db: DatabaseService, private readonly ledger: LedgerService) {}
  authorize(user: UserEntity, branch: string, financial = false) {
    if (user.role === "b2b" || !user.branches.includes(branch as never) || (financial && user.role === "warehouse")) throw new ForbiddenException("Không có quyền xem dữ liệu này.");
  }
  private async window<T extends ObjectLiteral>(query: SelectQueryBuilder<T>, input: AdminBrowseDto) {
    const total = await query.clone().getCount();
    const totalPages = Math.max(1, Math.ceil(total / input.pageSize));
    const page = Math.min(input.page, totalPages);
    const rows = await query.offset((page - 1) * input.pageSize).limit(input.pageSize).getMany();
    return { rows, pagination: { resource: input.resource, total, page, pageSize: input.pageSize, totalPages, ids: rows.map(row => String(row.id)) } };
  }
  private dates<T extends ObjectLiteral>(query: SelectQueryBuilder<T>, input: AdminBrowseDto, field = "r.data->>'date'") {
    if (input.from) query.andWhere(`LEFT(${field}, 10) >= :from`, { from: input.from });
    if (input.to) query.andWhere(`LEFT(${field}, 10) <= :to`, { to: input.to });
  }
  async orders(rows: OrderEntity[], result: Partial<ApiAdminState>) {
    const approvals = rows.length ? await this.db.source.getRepository(ApprovalEntity).createQueryBuilder("a").where("a.data->>'orderId' IN (:...ids)", { ids: rows.map(row => row.id) }).orderBy("a.data->>'createdAt'", "ASC").addOrderBy("a.id", "ASC").getMany() : [];
    const data = approvals.map(row => row.data);
    result.orders = rows.map(row => effectiveOrder(row, data));
    result.approvals = data;
    result.warehouse = Object.fromEntries(rows.map(row => [row.id, row.warehouse]));
    result.paymentDueDates = Object.fromEntries(rows.filter(row => row.dueDate).map(row => [row.id, row.dueDate!]));
  }
  private redact<T extends Partial<ApiAdminState>>(user: UserEntity, result: T) {
    if (user.role !== "warehouse") return result;
    if (result.orders) result.orders = result.orders.map(order => ({ ...order, total: 0, items: order.items.map(item => ({ ...item, unitPrice: 0 })) }));
    if (result.products) result.products = result.products.map(redactProductPricing);
    result.customers = []; result.approvals = []; result.receipts = []; result.paymentDueDates = {};
    return result;
  }
  private productQuery(input: AdminBrowseDto) {
    const query = this.db.source.getRepository(ProductEntity).createQueryBuilder("r").orderBy("r.data->>'name'", "ASC").addOrderBy("r.id", "ASC");
    applyAdminSearch(query, input.q, ["r.data->>'name'", "r.data->>'code'", "r.data->>'alternateCode'", "r.data->>'brand'"]);
    if (input.category) query.andWhere("r.data->>'category' = :category", { category: input.category });
    if (input.status && input.status !== "all") {
      if (!["published", "hidden"].includes(input.status)) throw new BadRequestException("Trạng thái sản phẩm không hợp lệ.");
      query.andWhere("r.published = :published", { published: input.status === "published" });
    }
    return query;
  }
  async productSelection(user: UserEntity, input: AdminBrowseDto) {
    this.authorize(user, input.branch);
    if (input.resource !== "products") throw new BadRequestException("Chỉ chọn danh sách sản phẩm.");
    const products = await this.productQuery(input).select("r.id", "id").addSelect("r.revision", "revision").addSelect("r.data->>'code'", "code").limit(MAX_BULK_PRODUCTS + 1).getRawMany<{ id: string; revision: number; code: string }>();
    if (products.length > MAX_BULK_PRODUCTS) throw new BadRequestException(`Lọc danh sách còn tối đa ${MAX_BULK_PRODUCTS} sản phẩm để chọn tất cả.`);
    return { products, count: products.length };
  }
  async browse(user: UserEntity, input: AdminBrowseDto) {
    this.authorize(user, input.branch, ["customers", "approvals", "receipts"].includes(input.resource));
    if ((input.from && !validDate(input.from)) || (input.to && !validDate(input.to)) || (input.from && input.to && input.from > input.to)) throw new BadRequestException("Khoảng ngày không hợp lệ.");
    const result: Partial<ApiAdminState> = { today: businessDate() };
    if (input.resource === "products") {
      const query = this.productQuery(input);
      const { rows, pagination } = await this.window(query, input);
      result.products = await this.ledger.stock(rows.map(row => ({ ...row.data, published: row.published, revision: row.revision })), input.branch);
      result.categories = orderedCategories(await this.db.source.getRepository(CategoryEntity).find());
      return this.redact(user, { ...result, pagination });
    }
    if (["orders", "warehouse"].includes(input.resource)) {
      const query = this.db.source.getRepository(OrderEntity).createQueryBuilder("r").where("r.branch = :branch", { branch: input.branch }).orderBy("r.createdAt", "DESC").addOrderBy("r.id", "DESC");
      const searchFields = ["r.id", "r.data->>'customerName'"];
      if (input.resource === "warehouse") {
        const codes = this.db.source.getRepository(ProductEntity).createQueryBuilder("p").select("string_agg(p.data->>'code', ' ')").where("p.id IN (SELECT item->>'productId' FROM jsonb_array_elements(r.data->'items') item)");
        searchFields.push("(r.data->'items')::text", `(${codes.getQuery()})`);
      }
      applyAdminSearch(query, input.q, searchFields);
      this.dates(query, input);
      if (input.resource === "warehouse" || user.role === "warehouse") query.andWhere("r.data->>'status' IN (:...stages)", { stages: warehouseStages });
      if (input.status === "issues") query.andWhere("r.warehouse->'issue' IS NOT NULL AND COALESCE(r.warehouse->'issue'->>'resolvedAt', '') = ''");
      else if (input.status && input.status !== "all") query.andWhere("r.data->>'status' = :status", { status: input.status });
      const { rows, pagination } = await this.window(query, input);
      await this.orders(rows, result);
      if (input.resource !== "warehouse") return this.redact(user, { ...result, pagination });
      const counts = await this.db.source.getRepository(OrderEntity).createQueryBuilder("o")
        .where("o.branch = :branch AND o.data->>'status' IN (:...stages)", { branch: input.branch, stages: warehouseStages })
        .select("COUNT(*)", "total")
        .addSelect("COUNT(*) FILTER (WHERE o.data->>'status' = 'Chờ soạn hàng')", "waiting")
        .addSelect("COUNT(*) FILTER (WHERE o.data->>'status' = 'Đang soạn')", "picking")
        .addSelect("COUNT(*) FILTER (WHERE o.data->>'status' = 'Sẵn sàng giao')", "ready")
        .addSelect("COUNT(*) FILTER (WHERE o.warehouse->'issue' IS NOT NULL AND COALESCE(o.warehouse->'issue'->>'resolvedAt', '') = '')", "issues")
        .getRawOne<Record<string, string>>();
      return this.redact(user, { ...result, pagination, warehouseSummary: { total: Number(counts?.total || 0), waiting: Number(counts?.waiting || 0), picking: Number(counts?.picking || 0), ready: Number(counts?.ready || 0), issues: Number(counts?.issues || 0) } });
    }
    if (input.resource === "customers") return this.customers(input);
    if (input.resource === "approvals") {
      const query = this.db.source.getRepository(ApprovalEntity).createQueryBuilder("r").where("r.branch = :branch", { branch: input.branch }).orderBy("r.data->>'createdAt'", "DESC").addOrderBy("r.id", "DESC");
      applyAdminSearch(query, input.q, ["r.id", "r.data->>'orderId'", "r.data->>'type'"]);
      if (input.status && input.status !== "all") query.andWhere("r.data->>'status' = :status", { status: input.status });
      const { rows, pagination } = await this.window(query, input);
      const orderIds = rows.map(row => row.data.orderId);
      await this.orders(orderIds.length ? await this.db.source.getRepository(OrderEntity).find({ where: { id: In(orderIds), branch: input.branch } }) : [], result);
      result.approvals = [...new Map([...(result.approvals || []), ...rows.map(row => row.data)].map(row => [row.id, row])).values()];
      const customerIds = rows.map(row => row.data.customerId);
      result.customers = customerIds.length ? await this.ledger.customers((await this.db.source.getRepository(CustomerEntity).find({ where: { id: In(customerIds), branch: input.branch } })).map(row => ({ ...row.data, revision: row.revision }))) : [];
      return { ...result, pagination };
    }
    const query = this.db.source.getRepository(ReceiptEntity).createQueryBuilder("r").where("r.branch = :branch", { branch: input.branch }).orderBy("r.data->>'date'", "DESC").addOrderBy("r.id", "DESC");
    applyAdminSearch(query, input.q, ["r.id", "r.data->>'orderId'", "r.data->>'reference'"]);
    this.dates(query, input);
    if (input.status && input.status !== "all") query.andWhere("r.data->>'status' = :status", { status: input.status });
    const { rows, pagination } = await this.window(query, input);
    result.receipts = rows.map(row => row.data);
    const orderIds = rows.map(row => row.data.orderId);
    await this.orders(orderIds.length ? await this.db.source.getRepository(OrderEntity).find({ where: { id: In(orderIds), branch: input.branch } }) : [], result);
    return { ...result, pagination };
  }
  private async customers(input: AdminBrowseDto) {
    const query = customerFinanceQuery(this.db, input.branch).orderBy("c.data->>'name'", "ASC").addOrderBy("c.id", "ASC");
    applyAdminSearch(query, input.q, ["c.id", "c.data->>'name'", "c.data->>'contact'", "c.data->>'phone'", "c.data->>'email'"]);
    if (input.status === "overdue") query.andWhere(`${customerOverdueSql} > 0`);
    else if (input.status === "overlimit") query.andWhere(`${customerDebtSql} > COALESCE((c.data->>'limit')::numeric, 0)`);
    else if (input.status && input.status !== "all") query.andWhere("c.data->>'status' = :status", { status: input.status });
    if (input.group) query.andWhere("c.data->>'group' = :group", { group: input.group });
    if (input.sales === "unassigned") query.andWhere("COALESCE(c.data->>'assignedSalesId', '') = ''");
    else if (input.sales) query.andWhere("c.data->>'assignedSalesId' = :sales", { sales: input.sales });
    if (input.pilot) query.andWhere("COALESCE((c.data->>'pilot')::boolean, false) = :pilot", { pilot: input.pilot === "pilot" });
    const { rows, pagination } = await this.window(query, input);
    const ids = rows.map(row => row.id);
    const [customers, accounts, staff, groups, summary] = await Promise.all([
      this.ledger.customers(rows.map(row => ({ ...row.data, revision: row.revision }))),
      ids.length ? this.db.source.getRepository(UserEntity).find({ where: { customerId: In(ids), role: "b2b" } }) : [],
      this.db.source.getRepository(UserEntity).createQueryBuilder("u").where("u.role = :role", { role: "sales" }).andWhere(":branch = ANY(string_to_array(u.branches, ','))", { branch: input.branch }).getMany(),
      this.db.source.getRepository(CustomerEntity).createQueryBuilder("c").select("c.data->>'group'", "group").where("c.branch = :branch", { branch: input.branch }).distinct(true).getRawMany<{ group: string }>(),
      customerFinanceQuery(this.db, input.branch).select(`COALESCE(SUM(${customerDebtSql}), 0)`, "debt").addSelect(`COALESCE(SUM(${customerOverdueSql}), 0)`, "overdue").addSelect(`COUNT(*) FILTER (WHERE ${customerDebtSql} > COALESCE((c.data->>'limit')::numeric, 0))`, "overLimit").getRawOne<{ debt: string; overdue: string; overLimit: string }>(),
    ]);
    const byCustomer = new Map(accounts.map(account => [account.customerId, account]));
    const items = customers.map(customer => {
      const account = byCustomer.get(customer.id);
      return { ...customer, revision: customer.revision!, email: account?.email || customer.email || "", tax: account?.profile.tax ?? customer.tax ?? "", address: account?.profile.address ?? customer.address ?? "", account: account ? { id: account.id, disabled: account.disabled } : null };
    });
    const result: Partial<ApiAdminState> = { today: businessDate(), customers: items };
    if (ids.length) {
      const recent = this.db.source.getRepository(OrderEntity).createQueryBuilder("o").select("o.id", "id").addSelect('ROW_NUMBER() OVER(PARTITION BY o."customerId" ORDER BY o."createdAt" DESC, o.id DESC)', "position").where("o.branch = :branch AND o.customerId IN (:...ids)", { branch: input.branch, ids });
      const [sql, parameters] = recent.getQueryAndParameters();
      const selected: { id: string }[] = await this.db.source.query(`SELECT id FROM (${sql}) recent WHERE position <= ${RECENT_CUSTOMER_ORDERS}`, parameters);
      await this.orders(selected.length ? await this.db.source.getRepository(OrderEntity).find({ where: { id: In(selected.map(row => row.id)), branch: input.branch }, order: { createdAt: "DESC" } }) : [], result);
    }
    return { ...result, pagination, summary: { debt: Number(summary?.debt || 0), overdue: Number(summary?.overdue || 0), overLimit: Number(summary?.overLimit || 0) }, directory: { items, assignees: staff.map(row => ({ id: row.id, name: row.name, disabled: row.disabled })), groups: [...new Set([...customerGroups, ...groups.map(row => row.group).filter(Boolean)])].sort() } };
  }
  async orderDetail(user: UserEntity, id: string, input: AdminBranchDto) {
    this.authorize(user, input.branch);
    const row = await this.db.source.getRepository(OrderEntity).findOneBy({ id, branch: input.branch });
    if (!row || (user.role === "warehouse" && !isWarehouseOrder(row.data))) throw new NotFoundException("Không tìm thấy đơn tại chi nhánh này.");
    const result: Partial<ApiAdminState> = { today: businessDate() };
    await this.orders([row], result);
    const ids = row.data.items.map(item => item.productId);
    result.products = ids.length ? await this.ledger.stock((await this.db.source.getRepository(ProductEntity).find({ where: { id: In(ids) } })).map(product => ({ ...product.data, published: product.published, revision: product.revision })), input.branch) : [];
    const customer = row.customerId ? await this.db.source.getRepository(CustomerEntity).findOneBy({ id: row.customerId, branch: input.branch }) : null;
    result.customers = customer ? await this.ledger.customers([{ ...customer.data, revision: customer.revision }]) : [];
    result.receipts = user.role !== "warehouse" ? (await this.db.source.getRepository(ReceiptEntity).createQueryBuilder("r").where("r.branch = :branch AND r.data->>'orderId' = :id", { branch: input.branch, id }).getMany()).map(receipt => receipt.data) : [];
    return { ...emptyAdminState(), ...this.redact(user, result) };
  }
}
