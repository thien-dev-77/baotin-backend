import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { IsIn, IsString, Length } from "class-validator";
import { AuthService, type AuthRequest } from "../auth/auth.service";
import { DatabaseService } from "../database/database.service";
import {
  CustomerEntity,
  OrderEntity,
  ReceiptEntity,
} from "../database/entities";
import { LedgerEntity } from "../database/operations.entities";
import { LedgerService } from "../ledger/ledger.service";
import { NotificationsService } from "../notifications/notifications.service";
import { branches } from "../types/domain.types";
import { businessDate } from "../orders/orders.service";
import { agingBucket } from "./report.rules";
import { customerDebtSql, customerFinanceQuery, customerOverdueSql } from "../admin/customer-finance.query";

class ReminderDto {
  @IsIn(branches) branch!: string;
  @IsString() @Length(1, 100) customerId!: string;
}
@Controller("admin/reports")
export class ReportsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly auth: AuthService,
    private readonly ledger: LedgerService,
    private readonly notifications: NotificationsService,
  ) {}
  private async staff(request: AuthRequest, branch: string) {
    const user = (await this.auth.authenticate(request))!;
    if (
      !["admin", "boss", "sales", "accountant"].includes(user.role) ||
      !user.branches.includes(branch as never)
    )
      throw new ForbiddenException();
    return user;
  }
  @Get() async report(
    @Req() request: AuthRequest,
    @Query("branch") branch: string,
    @Query("days") raw = "30",
  ) {
    await this.staff(request, branch);
    const date = businessDate();
    const days = Math.max(1, Math.min(365, Number.parseInt(raw, 10) || 30));
    const start = new Date(`${date}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - days + 1);
    const paid = this.db.source.getRepository(ReceiptEntity).createQueryBuilder("r")
      .select("r.data->>'orderId'", "orderId").addSelect("SUM((r.data->>'amount')::numeric)", "amount")
      .where("r.branch = :branch AND r.data->>'status' = :posted", { branch, posted: "Đã đối chiếu" }).groupBy("r.data->>'orderId'");
    const [rawCustomers, period, unpaidOrders] = await Promise.all([
      customerFinanceQuery(this.db, branch).select("c.id", "id").addSelect("c.data->>'name'", "name").addSelect("c.data->>'status'", "status")
        .addSelect(customerDebtSql, "debt").addSelect(customerOverdueSql, "overdue")
        .getRawMany<{ id: string; name: string; status: string; debt: string; overdue: string }>(),
      this.db.source.getRepository(OrderEntity).createQueryBuilder("o")
        .select("o.id", "id").addSelect("o.customerId", "customerId").addSelect("o.createdAt", "createdAt")
        .addSelect("o.checkout->>'date'", "checkoutDate").addSelect("o.data->>'source'", "source")
        .addSelect("o.data->>'status'", "status").addSelect("o.data->>'cancelReason'", "cancelReason")
        .addSelect(`(SELECT event->>'at' FROM jsonb_array_elements(o.warehouse->'history') WITH ORDINALITY AS history(event, position)
          WHERE event->>'label' = 'Chờ soạn hàng' ORDER BY position LIMIT 1)`, "confirmedAt")
        .addSelect("jsonb_typeof(o.warehouse->'issue') = 'object' AND COALESCE(o.warehouse->'issue'->>'resolvedAt', '') = ''", "shortage")
        .where("o.branch = :branch AND o.data->>'date' BETWEEN :since AND :date", { branch, since: start.toISOString().slice(0, 10), date })
        .getRawMany<{ id: string; customerId: string | null; createdAt: Date; checkoutDate: string | null; source: string; status: string; cancelReason: string; confirmedAt: string | null; shortage: boolean }>(),
      this.db.source.getRepository(OrderEntity).createQueryBuilder("o")
        .innerJoin(LedgerEntity, "entry", "entry.reference = concat('order:', o.id, ':credit') AND entry.kind = :ledgerKind", { ledgerKind: "credit" })
        .leftJoin(`(${paid.getQuery()})`, "paid", 'paid."orderId" = o.id').setParameters(paid.getParameters())
        .select("o.customerId", "customerId").addSelect("o.dueDate", "dueDate")
        .addSelect("entry.delta", "posted").addSelect("COALESCE(paid.amount, 0)", "paid")
        .where("o.branch = :branch", { branch }).orderBy("o.dueDate", "ASC", "NULLS LAST").addOrderBy("o.id", "ASC")
        .getRawMany<{ customerId: string; dueDate: string | null; posted: string; paid: string }>(),
    ]);
    // The period summary is bounded by dates. Aging deliberately keeps credit
    // from all time, including opening debt and credits outside that period.
    const customers = rawCustomers.map(row => ({ ...row, debt: Number(row.debt), overdue: Number(row.overdue) }));
    const b2b = period.filter(row => row.customerId);
    const selfOrders = b2b.filter(row => /^Website/.test(row.source)).length;
    const confirmed = period.map(row => row.confirmedAt ? (Date.parse(row.confirmedAt) - Date.parse(row.checkoutDate || new Date(row.createdAt).toISOString())) / 60000 : -1)
      .filter(minutes => Number.isFinite(minutes) && minutes >= 0);
    const byCustomer = new Map<string, typeof unpaidOrders>();
    for (const row of unpaidOrders) {
      const rows = byCustomer.get(row.customerId) || [];
      rows.push(row); byCustomer.set(row.customerId, rows);
    }
    const aging = customers.map(customer => {
      const amounts = { current: 0, days30: 0, days60: 0, days90: 0, older: 0, unknown: 0 };
      let remaining = Math.max(0, customer.debt);
      for (const row of byCustomer.get(customer.id) || []) {
        const unpaid = Math.min(remaining, Math.max(0, Number(row.posted) - Number(row.paid)));
        amounts[agingBucket(row.dueDate, date)] += unpaid;
        remaining -= unpaid;
      }
      amounts.unknown += remaining;
      return { id: customer.id, name: customer.name, debt: customer.debt, overdue: customer.overdue, ...amounts };
    });
    return {
      date, days, customers: customers.length, activeCustomers: customers.filter(row => row.status === "Đang hoạt động").length,
      orderingCustomers: new Set(b2b.map(row => row.customerId)).size, orders: period.length, b2bOrders: b2b.length,
      selfOrders, selfOrderRate: b2b.length ? Math.round(100 * selfOrders / b2b.length) : 0,
      confirmationMinutes: confirmed.length ? Math.round(confirmed.reduce((sum, value) => sum + value, 0) / confirmed.length) : null,
      cancelledOrders: period.filter(row => row.status === "Đã hủy").map(row => ({ id: row.id, reason: row.cancelReason || "Chưa ghi lý do" })),
      shortages: period.filter(row => row.shortage).length, aging,
    };
  }

  @Post("remind") async remind(
    @Req() request: AuthRequest,
    @Body() input: ReminderDto,
  ) {
    await this.staff(request, input.branch);
    return this.db.transaction(async (manager) => {
      const row = await manager
        .getRepository(CustomerEntity)
        .findOneByOrFail({ id: input.customerId, branch: input.branch });
      const customer = (await this.ledger.customers([row.data], manager))[0];
      if (customer.overdue > 0)
        await this.notifications.remindOverdue(
          manager,
          input.branch,
          row.id,
          businessDate(),
          customer.overdue,
        );
      return { sent: customer.overdue > 0 };
    });
  }
}
