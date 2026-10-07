import { Body, Controller, Get, Patch, Query, Req } from "@nestjs/common";
import { IsOptional, IsUUID } from "class-validator";
import { AuthService, type AuthRequest } from "../auth/auth.service";
import { NotificationsService } from "./notifications.service";

class ReadDto {
  @IsOptional() @IsUUID() id?: string;
}
@Controller("notifications")
export class NotificationsController {
  constructor(
    private readonly auth: AuthService,
    private readonly service: NotificationsService,
  ) {}
  @Get() async list(
    @Req() request: AuthRequest,
    @Query("page") page = "1",
    @Query("unread") unread = "false",
    @Query("type") type = "",
  ) {
    const user = (await this.auth.authenticate(request))!;
    const current = Math.min(
      10000,
      Math.max(1, Number.parseInt(page, 10) || 1),
    );
    const query = this.service.scope(user);
    const unreadCount = await query
      .clone()
      .andWhere('"readAt" IS NULL')
      .getCount();
    if (unread === "true") query.andWhere('"readAt" IS NULL');
    if (type) query.andWhere("type = :type", { type: type.slice(0, 30) });
    const [items, total] = await query
      .orderBy('n."createdAt"', "DESC")
      .addOrderBy("n.id", "DESC")
      .skip((current - 1) * 20)
      .take(20)
      .getManyAndCount();
    return {
      items: items.map(
        ({ id, type, title, message, href, readAt, createdAt }) => ({
          id,
          type,
          title,
          message,
          href,
          readAt,
          createdAt,
        }),
      ),
      total,
      page: current,
      pageSize: 20,
      unreadCount,
    };
  }
  @Patch("read") async read(
    @Req() request: AuthRequest,
    @Body() input: ReadDto,
  ) {
    const query = this.service
      .scope((await this.auth.authenticate(request))!)
      .andWhere('"readAt" IS NULL');
    if (input.id)
      query.andWhere("id = :notification", { notification: input.id });
    const result = await query.update().set({ readAt: new Date() }).execute();
    return { updated: result.affected || 0 };
  }
}
