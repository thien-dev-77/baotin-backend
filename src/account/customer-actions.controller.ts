import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Req,
} from "@nestjs/common";
import { IsInt, IsObject, IsString, Length, Min } from "class-validator";
import { randomUUID } from "node:crypto";
import { AuthService, type AuthRequest } from "../auth/auth.service";
import { DatabaseService } from "../database/database.service";
import {
  ApprovalEntity,
  AuditEntity,
  CustomerEntity,
  OrderEntity,
  ProductEntity,
} from "../database/entities";
import { PricePolicyService } from "../catalog/price-policy.service";
import { LedgerService } from "../ledger/ledger.service";
import { buildApprovalRequest } from "../admin/rules/approval.rules";
import { NotificationsService } from "../notifications/notifications.service";
import { frequentProductIds } from "./customer-actions.rules";

class PriceRequestDto {
  @IsString() @Length(1, 100) orderId!: string;
  @IsInt() @Min(1) revision!: number;
  @IsString() @Length(5, 500) reason!: string;
  @IsObject() prices!: Record<string, number>;
}
@Controller("account")
export class CustomerActionsController {
  constructor(
    private readonly auth: AuthService,
    private readonly db: DatabaseService,
    private readonly pricing: PricePolicyService,
    private readonly ledger: LedgerService,
    private readonly notifications: NotificationsService,
  ) {}
  private async customer(request: AuthRequest) {
    const user = (await this.auth.authenticate(request))!;
    if (user.role !== "b2b" || !user.customerId) throw new ForbiddenException();
    const row = await this.db.source
      .getRepository(CustomerEntity)
      .findOneByOrFail({ id: user.customerId });
    if (row.data.status !== "Đang hoạt động")
      throw new ForbiddenException("Tài khoản B2B chưa được kích hoạt.");
    return { user, row };
  }
  @Get("frequently-bought") async frequent(@Req() request: AuthRequest) {
    const { row } = await this.customer(request);
    const orders = (
      await this.db.source
        .getRepository(OrderEntity)
        .find({ where: { customerId: row.id } })
    ).filter((order) => ["Đang giao", "Hoàn tất"].includes(order.data.status));
    const ids = frequentProductIds(orders.map((order) => order.data));
    const products = await this.pricing.personalize(
      await this.ledger.stock(
        (
          await this.db.source
            .getRepository(ProductEntity)
            .find({ where: { published: true } })
        ).map((product) => product.data),
        row.branch,
      ),
      row.data,
    );
    return {
      products: ids
        .map((id) => products.find((product) => product.id === id))
        .filter(Boolean)
        .slice(0, 50),
    };
  }
  @Get("price-requests") async requests(@Req() request: AuthRequest) {
    const { row } = await this.customer(request);
    const items = (
      await this.db.source
        .getRepository(ApprovalEntity)
        .find({ where: { branch: row.branch } })
    )
      .filter((item) => item.data.customerId === row.id)
      .map((item) => item.data)
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    const orders = await this.db.source
      .getRepository(OrderEntity)
      .find({ where: { customerId: row.id, branch: row.branch } });
    return {
      items,
      orders: orders
        .filter((item) => item.data.status === "Chờ xác nhận")
        .map((item) => ({ ...item.data, revision: item.revision })),
    };
  }
  @Post("price-requests") async create(
    @Req() request: AuthRequest,
    @Body() input: PriceRequestDto,
  ) {
    if (input.reason.trim().length < 5) throw new BadRequestException("Lý do cần ít nhất 5 ký tự.");
    const { user, row: customerRow } = await this.customer(request);
    return this.db.transaction(async (manager) => {
      const customer = await manager
        .getRepository(CustomerEntity)
        .findOneByOrFail({ id: customerRow.id });
      if (customer.data.status !== "Đang hoạt động")
        throw new ForbiddenException();
      const order = await manager
        .getRepository(OrderEntity)
        .findOneBy({
          id: input.orderId,
          customerId: customer.id,
          branch: customer.branch,
        });
      if (!order)
        throw new ForbiddenException("Không có quyền với đơn hàng này.");
      if (order.revision !== input.revision)
        throw new ConflictException("Đơn đã thay đổi. Làm mới trước khi gửi.");
      if (
        Object.keys(input.prices).some(
          (id) => !order.data.items.some((line) => line.productId === id),
        )
      )
        throw new BadRequestException(
          "Giá đề nghị chỉ dành cho SKU trong đơn.",
        );
      const approvals = (
        await manager
          .getRepository(ApprovalEntity)
          .find({ where: { branch: customer.branch } })
      ).map((item) => item.data);
      const result = buildApprovalRequest(
        order.data,
        customer.data,
        { type: "Giá đặc biệt", reason: input.reason, prices: input.prices },
        approvals,
      );
      if (!result.snapshot) throw new BadRequestException(result.error);
      if (result.snapshot.kind === "price" && order.checkout) {
        const subtotal = result.snapshot.lines.reduce(
          (sum, line) => sum + line.quantity * line.requestedPrice,
          0,
        );
        result.snapshot.requestedTotal =
          subtotal +
          order.checkout.shipping -
          (order.checkout.coupon === "BAOTIN10" || order.checkout.discount
            ? Math.min(100000, Math.round(subtotal * 0.1))
            : 0);
      }
      const id = `YC-${randomUUID().slice(0, 8).toUpperCase()}`;
      await manager
        .getRepository(ApprovalEntity)
        .save({
          id,
          branch: customer.branch,
          data: {
            id,
            orderId: order.id,
            customerId: customer.id,
            branch: customer.branch as never,
            type: "Giá đặc biệt",
            requestedBy: `B2B · ${user.name}`,
            reason: input.reason.trim(),
            status: "Chờ duyệt",
            createdAt: new Date().toISOString(),
            snapshot: result.snapshot,
          },
        });
      order.warehouse.history.push({
        at: new Date().toISOString(),
        label: "Khách B2B gửi yêu cầu giá",
        note: id,
      });
      await manager.getRepository(OrderEntity).save(order);
      await manager
        .getRepository(AuditEntity)
        .save({
          actorId: user.id,
          action: "b2b-price-request",
          resourceId: id,
          detail: { orderId: order.id },
        });
      await this.notifications.emit(manager, {
        key: `approval:${id}:Chờ duyệt`,
        type: "approval",
        branch: customer.branch,
        title: "B2B đề nghị giá đặc biệt",
        message: `${customer.data.name} · ${order.id}`,
        href: "/admin/approvals",
        roles: ["admin", "boss", "sales"],
      });
      return { id };
    });
  }
}
