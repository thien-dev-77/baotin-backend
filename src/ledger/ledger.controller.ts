import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { IsIn, IsInt, IsString, Length, Max, Min } from "class-validator";
import { randomUUID } from "node:crypto";
import { AuthService, type AuthRequest } from "../auth/auth.service";
import { DatabaseService } from "../database/database.service";
import {
  AuditEntity,
  CustomerEntity,
  ProductEntity,
} from "../database/entities";
import { LedgerEntity } from "../database/operations.entities";
import { branches } from "../types/domain.types";
import { LedgerService } from "./ledger.service";

class AdjustmentDto {
  @IsIn(branches) branch!: (typeof branches)[number];
  @IsIn(["stock", "credit"]) kind!: "stock" | "credit";
  @IsString() @Length(1, 100) id!: string;
  @IsInt() @Min(-1_000_000_000_000) @Max(1_000_000_000_000) expected!: number;
  @IsInt() @Min(-1_000_000_000_000) @Max(1_000_000_000_000) target!: number;
  @IsString() @Length(3, 500) reason!: string;
}
class TermsDto {
  @IsIn(branches) branch!: (typeof branches)[number];
  @IsString() @Length(1, 100) id!: string;
  @IsInt() @Min(0) @Max(1_000_000_000_000) expected!: number;
  @IsInt() @Min(0) @Max(1_000_000_000_000) limit!: number;
  @IsString() @Length(1, 100) group!: string;
  @IsInt() @Min(0) @Max(365) termsDays!: number;
  @IsString() @Length(1, 100) expectedGroup!: string;
  @IsInt() @Min(0) @Max(365) expectedTermsDays!: number;
  @IsString() @Length(3, 500) reason!: string;
}
@Controller("admin/ledger")
export class LedgerController {
  constructor(
    private readonly auth: AuthService,
    private readonly db: DatabaseService,
    private readonly ledger: LedgerService,
  ) {}
  @Get() async view(
    @Query("branch") branch: string,
    @Req() request: AuthRequest,
  ) {
    const user = (await this.auth.authenticate(request))!;
    if (user.role === "b2b" || !user.branches.includes(branch as never))
      throw new ForbiddenException();
    const inventory = await this.ledger.stock(
      (await this.db.source.getRepository(ProductEntity).find()).map(
        (row) => row.data,
      ),
      branch,
    );
    const customers =
      user.role === "warehouse"
        ? []
        : await this.ledger.customers(
            (
              await this.db.source
                .getRepository(CustomerEntity)
                .find({ where: { branch } })
            ).map((row) => row.data),
          );
    const entries = await this.db.source
      .getRepository(LedgerEntity)
      .find({
        where:
          user.role === "warehouse" ? { branch, kind: "stock" } : { branch },
        order: { at: "DESC" },
        take: 100,
      });
    return {
      inventory: inventory.map(({ customerPrice: _price, ...product }) =>
        user.role === "warehouse"
          ? { ...product, price: 0, oldPrice: undefined }
          : product,
      ),
      customers,
      entries,
    };
  }
  @Post("adjust") async adjust(
    @Body() input: AdjustmentDto,
    @Req() request: AuthRequest,
  ) {
    const user = (await this.auth.authenticate(request))!;
    if (
      !["admin", "boss"].includes(user.role) ||
      !user.branches.includes(input.branch)
    )
      throw new ForbiddenException();
    if (
      !input.reason.trim() ||
      (input.kind === "stock" &&
        (input.target < 0 || input.target > 1_000_000_000))
    )
      throw new BadRequestException();
    await this.db.transaction(async (manager) => {
      if (input.kind === "stock") {
        const product = await manager
          .getRepository(ProductEntity)
          .findOneByOrFail({ id: input.id });
        const [balance] = await this.ledger.stock(
          [product.data],
          input.branch,
          manager,
        );
        if (
          balance.onHand !== input.expected ||
          input.target < balance.reserved
        )
          throw new ConflictException(
            "Số dư đã thay đổi hoặc tồn thấp hơn lượng đang giữ cho đơn.",
          );
        await this.ledger.inventory(
          manager,
          input.branch,
          input.id,
          input.target - balance.onHand,
          `adjust:${randomUUID()}`,
          user.id,
          input.reason.trim(),
        );
      } else {
        const customer = await manager
          .getRepository(CustomerEntity)
          .findOneByOrFail({ id: input.id, branch: input.branch });
        const [balance] = await this.ledger.customers([customer.data], manager);
        if (balance.debt !== input.expected)
          throw new ConflictException(
            "Công nợ đã thay đổi. Làm mới và thử lại.",
          );
        await this.ledger.credit(
          manager,
          input.id,
          input.target - balance.debt,
          `adjust:${randomUUID()}`,
          user.id,
          input.reason.trim(),
        );
      }
      await manager
        .getRepository(AuditEntity)
        .save({
          actorId: user.id,
          action: "ledger-adjust",
          resourceId: input.id,
          detail: { ...input },
        });
    });
    return { saved: true };
  }
  @Post("terms") async terms(
    @Body() input: TermsDto,
    @Req() request: AuthRequest,
  ) {
    const user = (await this.auth.authenticate(request))!;
    if (
      !["admin", "boss"].includes(user.role) ||
      !user.branches.includes(input.branch)
    )
      throw new ForbiddenException();
    if (!input.group.trim() || input.reason.trim().length < 3)
      throw new BadRequestException();
    await this.db.transaction(async (manager) => {
      const repository = manager.getRepository(CustomerEntity);
      const customer = await repository.findOneByOrFail({
        id: input.id,
        branch: input.branch,
      });
      if (
        customer.data.limit !== input.expected ||
        customer.data.group !== input.expectedGroup ||
        (customer.data.termsDays ?? 30) !== input.expectedTermsDays
      )
        throw new ConflictException(
          "Chính sách đã thay đổi. Làm mới và thử lại.",
        );
      const before = {
        limit: customer.data.limit,
        group: customer.data.group,
        termsDays: customer.data.termsDays ?? 30,
      };
      customer.data = {
        ...customer.data,
        limit: input.limit,
        group: input.group.trim(),
        termsDays: input.termsDays,
      };
      await repository.save(customer);
      await manager
        .getRepository(AuditEntity)
        .save({
          actorId: user.id,
          action: "credit-terms",
          resourceId: input.id,
          detail: {
            before,
            after: {
              limit: input.limit,
              group: input.group.trim(),
              termsDays: input.termsDays,
            },
            reason: input.reason.trim(),
          },
        });
    });
    return { saved: true };
  }
}
