import { Body, Controller, Get, Post, Req } from "@nestjs/common";
import { AuthService, type AuthRequest } from "../auth/auth.service";
import { AdminService } from "./admin.service";
import { AdminCommandDto, SalesQuoteDto } from "./admin.dto";

@Controller("admin")
export class AdminController {
  constructor(private readonly auth: AuthService, private readonly service: AdminService) {}
  @Get("state") async state(@Req() request: AuthRequest) { return this.service.state((await this.auth.authenticate(request))!); }
  @Post("commands") async command(@Body() input: AdminCommandDto, @Req() request: AuthRequest) { return this.service.command((await this.auth.authenticate(request))!, input); }
  @Post("orders/quote") async quote(@Body() input: SalesQuoteDto, @Req() request: AuthRequest) { return this.service.salesQuote((await this.auth.authenticate(request))!, input); }
}
