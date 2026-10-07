import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { IsEmail, IsIn, IsInt, IsString, Length, Matches, MaxLength, Min } from "class-validator";
import { Throttle } from "@nestjs/throttler";
import { DatabaseService } from "../database/database.service";
import { AuthService, type AuthRequest } from "../auth/auth.service";
import { AuditEntity, LeadEntity, NewsletterEntity, UserEntity } from "../database/entities";
import { NotificationsService } from "../notifications/notifications.service";

class ConsultationDto {
  @IsString() @Length(2, 100) name!: string;
  @IsString() @Matches(/^\+?[\d ()-]{9,20}$/) phone!: string;
  @IsString() @MaxLength(160) email!: string;
  @IsString() @Length(5, 2000) message!: string;
}
class NewsletterDto { @IsEmail() @MaxLength(160) email!: string; }
class LeadUpdateDto {
  @IsInt() @Min(1) revision!: number;
  @IsIn(["new", "contacted", "qualified", "closed"]) status!: LeadEntity["status"];
  @IsString() @MaxLength(100) assignedTo!: string;
  @IsString() @MaxLength(2000) note!: string;
}

@Controller("contact")
export class ContactController {
  constructor(private readonly db: DatabaseService, private readonly auth: AuthService, private readonly notifications: NotificationsService) {}
  @Post("consultations") @Throttle({ default: { limit: 5, ttl: 60000 } })
  async consultation(@Body() input: ConsultationDto) {
    if (!input.name.trim() || input.message.trim().length < 5 || (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email))) throw new BadRequestException("Thông tin liên hệ không hợp lệ.");
    return this.db.transaction(async manager => {
      const result = await manager.getRepository(LeadEntity).save({ branch: "Quy Nhơn", data: { name: input.name.trim(), phone: input.phone.trim(), email: input.email.trim(), message: input.message.trim() } });
      await this.notifications.emit(manager, { key: `lead:${result.id}`, type: "consultation", branch: result.branch, title: "Yêu cầu tư vấn mới", message: result.data.name, href: "/admin/consultations" });
      return { id: result.id };
    });
  }
  @Post("newsletter") @Throttle({ default: { limit: 5, ttl: 60000 } })
  async newsletter(@Body() input: NewsletterDto) {
    await this.db.source.createQueryBuilder().insert().into(NewsletterEntity).values({ email: input.email.trim().toLowerCase() }).orIgnore().execute();
    return { subscribed: true };
  }
  @Get("consultations") async list(@Req() request: AuthRequest, @Query("branch") branch = "Quy Nhơn") {
    const user = (await this.auth.authenticate(request))!;
    if (!["admin", "boss", "sales"].includes(user.role) || !user.branches.includes(branch as never)) throw new ForbiddenException();
    return { items: await this.db.source.getRepository(LeadEntity).find({ where: { branch }, order: { createdAt: "DESC" }, take: 200 }), assignees: (await this.db.source.getRepository(UserEntity).find({ where: { disabled: false } })).filter(user => ["admin", "boss", "sales"].includes(user.role) && user.branches.includes(branch as never)).map(user => ({ id: user.id, name: user.name })) };
  }
  @Patch("consultations/:id") async update(@Param("id") id: string, @Req() request: AuthRequest, @Body() input: LeadUpdateDto) {
    const user = (await this.auth.authenticate(request))!;
    return this.db.transaction(async manager => {
      const row = await manager.getRepository(LeadEntity).findOneByOrFail({ id });
      if (!["admin", "boss", "sales"].includes(user.role) || !user.branches.includes(row.branch as never)) throw new ForbiddenException();
      if (row.revision !== input.revision) throw new ConflictException("Yêu cầu đã thay đổi. Làm mới trước khi lưu.");
      if (input.assignedTo) {
        const owner = await manager.getRepository(UserEntity).findOneBy({ id: input.assignedTo, disabled: false });
        if (!owner || !["admin", "boss", "sales"].includes(owner.role) || !owner.branches.includes(row.branch as never)) throw new BadRequestException("Nhân viên không thuộc chi nhánh.");
      }
      row.status = input.status; row.assignedTo = input.assignedTo || null; row.note = input.note.trim();
      const result = await manager.getRepository(LeadEntity).save(row);
      await manager.getRepository(AuditEntity).save({ actorId: user.id, action: "lead-update", resourceId: id, detail: { status: row.status, assignedTo: row.assignedTo } });
      return result;
    });
  }
}
