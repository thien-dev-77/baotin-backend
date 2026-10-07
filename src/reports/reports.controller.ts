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
    const customers = await this.ledger.customers(
      (
        await this.db.source
          .getRepository(CustomerEntity)
          .find({ where: { branch } })
      ).map((row) => row.data),
    );
    const orders = await this.db.source
      .getRepository(OrderEntity)
      .find({ where: { branch } });
    const receipts = (
      await this.db.source
        .getRepository(ReceiptEntity)
        .find({ where: { branch } })
    ).filter((row) => row.data.status === "Đã đối chiếu");
    const entries = await this.db.source
      .getRepository(LedgerEntity)
      .find({ where: { branch, kind: "credit" } });
    const period = orders.filter(
      (row) =>
        row.data.date >= start.toISOString().slice(0, 10) &&
        row.data.date <= date,
    );
    const b2b = period.filter((row) => row.customerId);
    const confirmed = period
      .map((row) => {
        const event = row.warehouse.history.find(
          (event) => event.label === "Chờ soạn hàng",
        );
        const created = row.checkout?.date || row.createdAt.toISOString();
        return event
          ? (Date.parse(event.at) - Date.parse(created)) / 60000
          : -1;
      })
      .filter((minutes) => Number.isFinite(minutes) && minutes >= 0);
    const aging = customers.map((customer) => {
      const amounts = {
        current: 0,
        days30: 0,
        days60: 0,
        days90: 0,
        older: 0,
        unknown: 0,
      };
      let remaining = Math.max(0, customer.debt);
      const unpaidOrders = orders
        .filter(
          (row) =>
            row.customerId === customer.id &&
            entries.some(
              (entry) => entry.reference === `order:${row.id}:credit`,
            ),
        )
        .sort((a, b) =>
          (a.dueDate || "9999").localeCompare(b.dueDate || "9999"),
        );
      for (const row of unpaidOrders) {
        const paid = receipts
          .filter((receipt) => receipt.data.orderId === row.id)
          .reduce((sum, receipt) => sum + receipt.data.amount, 0);
        const posted = entries.find(
          (entry) => entry.reference === `order:${row.id}:credit`,
        )!.delta;
        const unpaid = Math.min(remaining, Math.max(0, posted - paid));
        amounts[agingBucket(row.dueDate, date)] += unpaid;
        remaining -= unpaid;
      }
      amounts.unknown += remaining;
      return {
        id: customer.id,
        name: customer.name,
        debt: customer.debt,
        overdue: customer.overdue,
        ...amounts,
      };
    });
    return {
      date,
      days,
      customers: customers.length,
      activeCustomers: customers.filter(
        (row) => row.status === "Đang hoạt động",
      ).length,
      orderingCustomers: new Set(b2b.map((row) => row.customerId)).size,
      orders: period.length,
      b2bOrders: b2b.length,
      selfOrders: b2b.filter((row) => /^Website/.test(row.data.source)).length,
      selfOrderRate: b2b.length
        ? Math.round(
            (100 *
              b2b.filter((row) => /^Website/.test(row.data.source)).length) /
              b2b.length,
          )
        : 0,
      confirmationMinutes: confirmed.length
        ? Math.round(
            confirmed.reduce((sum, value) => sum + value, 0) / confirmed.length,
          )
        : null,
      cancelledOrders: period
        .filter((row) => row.data.status === "Đã hủy")
        .map((row) => ({
          id: row.id,
          reason: row.data.cancelReason || "Chưa ghi lý do",
        })),
      shortages: period.filter(
        (row) => row.warehouse.issue && !row.warehouse.issue.resolvedAt,
      ).length,
      aging,
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
