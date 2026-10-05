import { BadRequestException, Body, Controller, ForbiddenException, Get, Post, Req } from "@nestjs/common";
import { IsEmail, IsString, Length, Matches, MaxLength } from "class-validator";
import { Throttle } from "@nestjs/throttler";
import { DatabaseService } from "../database/database.service";
import { AuthService, type AuthRequest } from "../auth/auth.service";
import { LeadEntity, NewsletterEntity } from "../database/entities";

class ConsultationDto {
  @IsString() @Length(2, 100) name!: string;
  @IsString() @Matches(/^\+?[\d ()-]{9,20}$/) phone!: string;
  @IsString() @MaxLength(160) email!: string;
  @IsString() @Length(5, 2000) message!: string;
}
class NewsletterDto { @IsEmail() @MaxLength(160) email!: string; }

@Controller("contact")
export class ContactController {
  constructor(private readonly db: DatabaseService, private readonly auth: AuthService) {}
  @Post("consultations") @Throttle({ default: { limit: 5, ttl: 60000 } })
  async consultation(@Body() input: ConsultationDto) {
    if (!input.name.trim() || input.message.trim().length < 5 || (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email))) throw new BadRequestException("Thông tin liên hệ không hợp lệ.");
    const result = await this.db.source.getRepository(LeadEntity).save({ data: { name: input.name.trim(), phone: input.phone.trim(), email: input.email.trim(), message: input.message.trim() } });
    return { id: result.id };
  }
  @Post("newsletter") @Throttle({ default: { limit: 5, ttl: 60000 } })
  async newsletter(@Body() input: NewsletterDto) {
    await this.db.source.createQueryBuilder().insert().into(NewsletterEntity).values({ email: input.email.trim().toLowerCase() }).orIgnore().execute();
    return { subscribed: true };
  }
  @Get("consultations") async list(@Req() request: AuthRequest) {
    const user = (await this.auth.authenticate(request))!;
    if (!["admin", "boss", "sales"].includes(user.role) || !user.branches.includes("Quy Nhơn")) throw new ForbiddenException("Không có quyền xem yêu cầu tư vấn tại Quy Nhơn.");
    return this.db.source.getRepository(LeadEntity).find({ order: { createdAt: "DESC" }, take: 100 });
  }
}
