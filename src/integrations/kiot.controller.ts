import { Body, Controller, Get, Post, Query, Req } from "@nestjs/common";
import { IsIn, IsInt, IsString, IsUUID, Length, Min } from "class-validator";
import { Throttle } from "@nestjs/throttler";
import { AuthService, type AuthRequest } from "../auth/auth.service";
import { branches } from "../types/domain.types";
import { KiotService } from "./kiot.service";
import { KiotReconciliationService } from "./kiot-reconciliation.service";

class BranchDto {
  @IsIn(branches) branch!: (typeof branches)[number];
}
class RunDto extends BranchDto {
  @IsUUID() runId!: string;
}
class LinkDto extends RunDto {
  @IsIn(["product", "customer"]) kind!: "product" | "customer";
  @IsString() @Length(1, 100) localId!: string;
  @IsInt() @Min(1) externalId!: number;
}
class OrderDto extends BranchDto {
  @IsString() @Length(1, 100) id!: string;
}
class ExportDto extends OrderDto {
  @IsInt() @Min(1) revision!: number;
}
@Controller("admin/integrations/kiotviet")
export class KiotController {
  constructor(
    private readonly auth: AuthService,
    private readonly kiot: KiotService,
    private readonly reconciliation: KiotReconciliationService,
  ) {}
  @Get("reconciliation") async snapshot(@Req() request: AuthRequest, @Query("branch") branch: string) { return this.reconciliation.latest((await this.auth.authenticate(request))!, branch); }
  @Post("pull") @Throttle({ default: { limit: 5, ttl: 60000 } })
  async pull(@Body() input: BranchDto, @Req() request: AuthRequest) { return this.reconciliation.pull((await this.auth.authenticate(request))!, input.branch); }
  @Get() async status(
    @Query("branch") branch: string,
    @Req() request: AuthRequest,
  ) {
    return this.kiot.status((await this.auth.authenticate(request))!, branch);
  }
  @Post("preview")
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async preview(@Body() input: BranchDto, @Req() request: AuthRequest) {
    return this.kiot.preview(
      (await this.auth.authenticate(request))!,
      input.branch,
    );
  }
  @Post("link") async link(
    @Body() input: LinkDto,
    @Req() request: AuthRequest,
  ) {
    return this.kiot.link((await this.auth.authenticate(request))!, input);
  }
  @Post("apply-prices") async apply(
    @Body() input: RunDto,
    @Req() request: AuthRequest,
  ) {
    return this.kiot.applyPrices(
      (await this.auth.authenticate(request))!,
      input.branch,
      input.runId,
    );
  }
  @Post("export") async export(
    @Body() input: ExportDto,
    @Req() request: AuthRequest,
  ) {
    return this.kiot.exportOrder(
      (await this.auth.authenticate(request))!,
      input.branch,
      input.id,
      input.revision,
    );
  }
  @Post("reconcile") async reconcile(
    @Body() input: OrderDto,
    @Req() request: AuthRequest,
  ) {
    return this.kiot.reconcile(
      (await this.auth.authenticate(request))!,
      input.branch,
      input.id,
    );
  }
}
