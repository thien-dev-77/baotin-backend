import { Injectable } from "@nestjs/common";
import { ApprovalEntity, OrderEntity } from "../database/entities";
import { DatabaseService } from "../database/database.service";
import { businessDate } from "../orders/orders.service";
import { AdminBrowseService } from "./admin-browse.service";
import { customerDebtSql, customerFinanceQuery, customerOverdueSql } from "./customer-finance.query";
import type { AdminDashboardDto } from "./admin-browse.dto";
import type { UserEntity } from "../database/entities";
import type { ApiAdminState } from "../types/api.types";

const RECENT_ORDERS = 5;
const CHART_BINS = 6;
const WAREHOUSE_STAGES = ["Chờ soạn hàng", "Đang soạn", "Sẵn sàng giao"];
const dateAt = (start: string, offset: number) => {
  const date = new Date(`${start}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};

// Match approval snapshot and website-discount rules without returning order
// galleries, recipients or histories just to draw dashboard totals.
const validPrice = `price.data->>'status' = 'Đã duyệt'
  AND price.data->'snapshot'->>'kind' = 'price'
  AND price.data->>'customerId' = o."customerId" AND price.branch = o.branch
  AND jsonb_array_length(price.data->'snapshot'->'lines') = jsonb_array_length(o.data->'items')
  AND (SELECT COUNT(DISTINCT line->>'productId') FROM jsonb_array_elements(price.data->'snapshot'->'lines') line) = jsonb_array_length(o.data->'items')
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(price.data->'snapshot'->'lines') line
    WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(o.data->'items') item
      WHERE item->>'productId' = line->>'productId' AND item->>'quantity' = line->>'quantity' AND item->>'unitPrice' = line->>'unitPrice'))`;
const subtotal = `(SELECT COALESCE(SUM((item->>'quantity')::numeric *
  CASE WHEN ${validPrice} THEN (SELECT (line->>'requestedPrice')::numeric FROM jsonb_array_elements(price.data->'snapshot'->'lines') line WHERE line->>'productId' = item->>'productId' LIMIT 1)
  ELSE (item->>'unitPrice')::numeric END), 0) FROM jsonb_array_elements(o.data->'items') item)`;
const effectiveTotal = `CASE WHEN o.checkout IS NOT NULL THEN ${subtotal} + COALESCE((o.checkout->>'shipping')::numeric, 0)
  - CASE WHEN o.checkout->>'coupon' = 'BAOTIN10' OR COALESCE((o.checkout->>'discount')::numeric, 0) <> 0 THEN LEAST(100000, ROUND(${subtotal} * 0.1)) ELSE 0 END
  WHEN ${validPrice} THEN ${subtotal} ELSE COALESCE((o.data->>'total')::numeric, 0) END`;

@Injectable()
export class AdminDashboardService {
  constructor(private readonly db: DatabaseService, private readonly browse: AdminBrowseService) {}
  async summary(user: UserEntity, input: AdminDashboardDto) {
    this.browse.authorize(user, input.branch, true);
    const today = businessDate();
    const since = dateAt(today, -input.days + 1);
    const latest = this.db.source.getRepository(ApprovalEntity).createQueryBuilder("latest")
      .select("latest.id").where("latest.data->>'orderId' = o.id AND latest.data->>'type' = :priceType", { priceType: "Giá đặc biệt" })
      .orderBy("latest.data->>'createdAt'", "DESC", "NULLS LAST").addOrderBy("latest.id", "DESC").limit(1);
    const dailyQuery = this.db.source.getRepository(OrderEntity).createQueryBuilder("o")
      .leftJoin(ApprovalEntity, "price", `price.id = (${latest.getQuery()})`).setParameters(latest.getParameters())
      .select("LEFT(o.data->>'date', 10)", "date")
      .addSelect(`COALESCE(SUM(${effectiveTotal}), 0)`, "value").addSelect("COUNT(*)", "count")
      .where("o.branch = :branch AND o.data->>'status' <> :cancelled AND LEFT(o.data->>'date', 10) BETWEEN :since AND :today", { branch: input.branch, cancelled: "Đã hủy", since, today })
      .groupBy("LEFT(o.data->>'date', 10)").orderBy("date", "ASC");
    const [daily, queues, customers, approvals, recent] = await Promise.all([
      dailyQuery.getRawMany<{ date: string; value: string; count: string }>(),
      this.db.source.getRepository(OrderEntity).createQueryBuilder("o")
        .select("COUNT(*) FILTER (WHERE o.data->>'status' = :pending)", "pending")
        .addSelect("COUNT(*) FILTER (WHERE o.data->>'status' = :waiting)", "waiting")
        .addSelect("COUNT(*) FILTER (WHERE o.data->>'status' IN (:...stages) AND o.warehouse->'issue' IS NOT NULL AND COALESCE(o.warehouse->'issue'->>'resolvedAt', '') = '')", "shortages")
        .where("o.branch = :branch", { branch: input.branch, pending: "Chờ xác nhận", waiting: "Chờ soạn hàng", stages: WAREHOUSE_STAGES })
        .getRawOne<{ pending: string; waiting: string; shortages: string }>(),
      customerFinanceQuery(this.db, input.branch).select(`COALESCE(SUM(${customerDebtSql}), 0)`, "debt")
        .addSelect(`COUNT(*) FILTER (WHERE ${customerOverdueSql} > 0)`, "overdue")
        .addSelect("COUNT(*) FILTER (WHERE c.data->>'status' = :pendingCustomer)", "pending")
        .setParameter("pendingCustomer", "Chờ duyệt").getRawOne<{ debt: string; overdue: string; pending: string }>(),
      this.db.source.getRepository(ApprovalEntity).createQueryBuilder("a").where("a.branch = :branch AND a.data->>'status' = :pending", { branch: input.branch, pending: "Chờ duyệt" }).getCount(),
      this.db.source.getRepository(OrderEntity).createQueryBuilder("o").where("o.branch = :branch AND LEFT(o.data->>'date', 10) BETWEEN :since AND :today", { branch: input.branch, since, today }).orderBy("o.createdAt", "DESC").addOrderBy("o.id", "DESC").take(RECENT_ORDERS).getMany(),
    ]);
    const recentState: Partial<ApiAdminState> = {};
    await this.browse.orders(recent, recentState);
    const count = input.days === 7 ? 7 : Math.min(CHART_BINS, input.days);
    const step = Math.ceil(input.days / count);
    const periods = Array.from({ length: count }, (_, index) => {
      const start = dateAt(since, index * step);
      const end = dateAt(since, Math.min(input.days - 1, (index + 1) * step - 1));
      return { start, end, value: daily.filter(row => row.date >= start && row.date <= end).reduce((sum, row) => sum + Number(row.value), 0) };
    }).filter(period => period.start <= today);
    return {
      today, since, days: input.days, periods, recentOrders: recentState.orders || [],
      metrics: {
        total: daily.reduce((sum, row) => sum + Number(row.value), 0), validOrders: daily.reduce((sum, row) => sum + Number(row.count), 0),
        pendingOrders: Number(queues?.pending || 0), approvals, debt: Number(customers?.debt || 0), overdueCustomers: Number(customers?.overdue || 0),
        pendingCustomers: Number(customers?.pending || 0), warehouseWaiting: Number(queues?.waiting || 0), shortages: Number(queues?.shortages || 0),
      },
    };
  }
}
