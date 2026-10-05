import { BadRequestException, Body, Controller, Get, Headers, Post, Req, Res } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { AuthService, cookieOptions, guestCookie, type AuthRequest } from "../auth/auth.service";
import { DatabaseService } from "../database/database.service";
import { ApprovalEntity, OrderEntity } from "../database/entities";
import { applyApprovedPrice } from "../../shared/admin-approval";
import { CheckoutDto, QuoteDto } from "./orders.dto";
import { customerOrder, OrdersService } from "./orders.service";

const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

@Controller("orders")
export class OrdersController {
  constructor(private readonly service: OrdersService, private readonly auth: AuthService, private readonly db: DatabaseService) {}
  private guest(request: AuthRequest, response: Response) {
    let id = request.cookies?.[guestCookie];
    if (typeof id !== "string" || !uuidPattern.test(id)) { id = randomUUID(); response.cookie(guestCookie, id, { ...cookieOptions(), maxAge: 30 * 24 * 60 * 60 * 1000 }); }
    return id as string;
  }
  @Post("quote") async quote(@Body() input: QuoteDto, @Req() request: AuthRequest) { return this.service.quote(input, await this.auth.authenticate(request, false)); }
  @Post() async checkout(@Body() input: CheckoutDto, @Headers("idempotency-key") key: string, @Req() request: AuthRequest, @Res({ passthrough: true }) response: Response) {
    if (!key || !uuidPattern.test(key)) throw new BadRequestException("Idempotency-Key UUID is required.");
    return this.service.checkout(input, await this.auth.authenticate(request, false), this.guest(request, response), key);
  }
  @Get() async list(@Req() request: AuthRequest, @Res({ passthrough: true }) response: Response) {
    const user = await this.auth.authenticate(request, false);
    const repository = this.db.source.getRepository(OrderEntity);
    const rows = user?.customerId ? await repository.find({ where: { customerId: user.customerId }, order: { createdAt: "DESC" } }) : await repository.find({ where: { guestId: this.guest(request, response) }, order: { createdAt: "DESC" } });
    const approvals = (await this.db.source.getRepository(ApprovalEntity).find()).map((row) => row.data);
    return rows.map((row) => customerOrder({ ...row, data: applyApprovedPrice(row.data, approvals) }));
  }
}
