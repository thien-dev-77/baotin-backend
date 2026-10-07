import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from "@nestjs/common";
import { IsIn, IsInt, IsString, Length, Max, Min } from "class-validator";
import { Throttle } from "@nestjs/throttler";
import { AuthService, type AuthRequest } from "../auth/auth.service";
import { DatabaseService } from "../database/database.service";
import { AuditEntity, OrderEntity, ProductEntity } from "../database/entities";
import { ReviewEntity } from "../database/experience.entities";
import { NotificationsService } from "../notifications/notifications.service";

class ReviewDto {
  @IsInt() @Min(1) @Max(5) stars!: number;
  @IsString() @Length(5, 2000) text!: string;
}
class ModerateDto {
  @IsInt() @Min(1) revision!: number;
  @IsIn(["published", "rejected"]) status!: ReviewEntity["status"];
}
@Controller("reviews")
export class ReviewsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly auth: AuthService,
    private readonly notifications: NotificationsService,
  ) {}
  @Get(":productId") async list(@Param("productId") productId: string) {
    if (
      !(await this.db.source
        .getRepository(ProductEntity)
        .existsBy({ id: productId, published: true }))
    )
      throw new BadRequestException("Sản phẩm không còn công khai.");
    const items = await this.db.source
      .getRepository(ReviewEntity)
      .find({
        where: { productId, status: "published" },
        order: { createdAt: "DESC" },
        take: 100,
      });
    return {
      items: items.map(({ id, name, stars, text, createdAt }) => ({
        id,
        name,
        stars,
        text,
        createdAt,
      })),
    };
  }
  @Post(":productId")
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async create(
    @Param("productId") productId: string,
    @Req() request: AuthRequest,
    @Body() input: ReviewDto,
  ) {
    const user = (await this.auth.authenticate(request))!;
    if (input.text.trim().length < 5)
      throw new BadRequestException("Nhận xét cần ít nhất 5 ký tự.");
    if (!user.customerId || user.role !== "b2b")
      throw new ForbiddenException(
        "Đăng nhập tài khoản đã mua sản phẩm để đánh giá.",
      );
    return this.db.transaction(async (manager) => {
      if (
        !(await manager
          .getRepository(ProductEntity)
          .existsBy({ id: productId, published: true }))
      )
        throw new BadRequestException("Sản phẩm không còn công khai.");
      const orders = await manager
        .getRepository(OrderEntity)
        .find({ where: { customerId: user.customerId! } });
      if (
        !orders.some(
          (order) =>
            ["Đang giao", "Hoàn tất"].includes(order.data.status) &&
            order.data.items.some((line) => line.productId === productId),
        )
      )
        throw new ForbiddenException(
          "Bạn chỉ có thể đánh giá sản phẩm đã mua.",
        );
      if (
        await manager
          .getRepository(ReviewEntity)
          .existsBy({ userId: user.id, productId })
      )
        throw new ConflictException("Bạn đã gửi đánh giá cho sản phẩm này.");
      const row = await manager
        .getRepository(ReviewEntity)
        .save({
          userId: user.id,
          productId,
          name: user.name,
          stars: input.stars,
          text: input.text.trim(),
          status: "pending",
        });
      await this.notifications.emit(manager, {
        key: `review:${row.id}`,
        type: "review",
        branch: orders.find(
          (order) =>
            ["Đang giao", "Hoàn tất"].includes(order.data.status) &&
            order.data.items.some((line) => line.productId === productId),
        )!.branch,
        title: "Đánh giá chờ kiểm duyệt",
        message: `${user.name} đã gửi đánh giá sản phẩm`,
        href: "/admin/reviews",
        roles: ["admin", "boss"],
      });
      return { id: row.id, status: row.status };
    });
  }
}
@Controller("admin/reviews")
export class AdminReviewsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly auth: AuthService,
  ) {}
  private async staff(request: AuthRequest) {
    const user = (await this.auth.authenticate(request))!;
    if (!["admin", "boss"].includes(user.role)) throw new ForbiddenException();
    return user;
  }
  @Get() async list(@Req() request: AuthRequest) {
    await this.staff(request);
    const products = await this.db.source.getRepository(ProductEntity).find();
    return {
      items: (
        await this.db.source
          .getRepository(ReviewEntity)
          .find({ order: { createdAt: "DESC" }, take: 200 })
      ).map(({ userId: _userId, ...row }) => ({
        ...row,
        productName:
          products.find((product) => product.id === row.productId)?.data.name ||
          row.productId,
      })),
    };
  }
  @Patch(":id") async moderate(
    @Param("id") id: string,
    @Req() request: AuthRequest,
    @Body() input: ModerateDto,
  ) {
    const user = await this.staff(request);
    return this.db.transaction(async (manager) => {
      const row = await manager
        .getRepository(ReviewEntity)
        .findOneByOrFail({ id });
      if (row.revision !== input.revision)
        throw new ConflictException(
          "Đánh giá đã được xử lý. Làm mới và thử lại.",
        );
      row.status = input.status;
      await manager.getRepository(ReviewEntity).save(row);
      await manager
        .getRepository(AuditEntity)
        .save({
          actorId: user.id,
          action: "review-moderate",
          resourceId: id,
          detail: { status: input.status },
        });
      return { saved: true };
    });
  }
}
