import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from "class-validator";
import { AuthService, type AuthRequest } from "../auth/auth.service";
import { branches } from "../types/domain.types";
import { PricePolicyService } from "./price-policy.service";

class PolicyDto {
  @IsOptional() @IsUUID() id?: string;
  @IsOptional() @IsInt() @Min(1) revision?: number;
  @IsString() @Length(2, 120) name!: string;
  @IsIn(branches) branch!: (typeof branches)[number];
  @IsIn(["default", "group", "customer"]) scope!:
    "default" | "group" | "customer";
  @IsString() @Length(0, 120) target!: string;
  @IsInt() @Min(0) @Max(99) discount!: number;
  @IsObject() prices!: Record<string, number>;
  @IsString() @Length(10, 10) startsOn!: string;
  @IsOptional() @IsString() @Length(10, 10) endsOn!: string | null;
  @IsBoolean() active!: boolean;
}
@Controller("admin/pricing")
export class PricePolicyController {
  constructor(
    private readonly auth: AuthService,
    private readonly pricing: PricePolicyService,
  ) {}
  @Get() async list(
    @Query("branch") branch: string,
    @Req() request: AuthRequest,
  ) {
    const user = (await this.auth.authenticate(request))!;
    if (
      !["admin", "boss", "sales"].includes(user.role) ||
      !user.branches.includes(branch as never)
    )
      throw new ForbiddenException();
    return { policies: await this.pricing.list(branch) };
  }
  @Post() async save(@Body() input: PolicyDto, @Req() request: AuthRequest) {
    const user = (await this.auth.authenticate(request))!;
    if (
      !["admin", "boss"].includes(user.role) ||
      !user.branches.includes(input.branch)
    )
      throw new ForbiddenException();
    return this.pricing.save(user, { ...input, endsOn: input.endsOn ?? null });
  }
}
