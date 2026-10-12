import { Controller, Get, Param, Query, Req } from "@nestjs/common";
import { AuthService, type AuthRequest } from "../auth/auth.service";
import { AdminBrowseService } from "./admin-browse.service";
import { AdminBrowseDto, AdminBranchDto, AdminDashboardDto } from "./admin-browse.dto";
import { AdminDashboardService } from "./admin-dashboard.service";

@Controller("admin")
export class AdminBrowseController {
  constructor(private readonly auth: AuthService, private readonly service: AdminBrowseService, private readonly dashboard: AdminDashboardService) {}
  @Get("dashboard") async summary(@Query() input: AdminDashboardDto, @Req() request: AuthRequest) {
    return this.dashboard.summary((await this.auth.authenticate(request))!, input);
  }
  @Get("browse") async browse(@Query() input: AdminBrowseDto, @Req() request: AuthRequest) {
    return this.service.browse((await this.auth.authenticate(request))!, input);
  }
  @Get("orders/:id") async order(@Param("id") id: string, @Query() input: AdminBranchDto, @Req() request: AuthRequest) {
    return this.service.orderDetail((await this.auth.authenticate(request))!, id, input);
  }
}
