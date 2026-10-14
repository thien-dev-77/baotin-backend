import { Transform, Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from "class-validator";
import { branches } from "../types/domain.types";

export const browseResources = ["products", "orders", "customers", "approvals", "receipts", "warehouse"] as const;
export const ADMIN_PAGE_SIZES = [10, 25, 50] as const;
export const ADMIN_DEFAULT_PAGE_SIZE = 10;

export class AdminBranchDto {
  @IsIn(branches) branch!: typeof branches[number];
}
export class AdminBrowseDto extends AdminBranchDto {
  @IsIn(browseResources) resource!: typeof browseResources[number];
  @Type(() => Number) @IsInt() @Min(1) @Max(100000) page = 1;
  @Type(() => Number) @IsIn(ADMIN_PAGE_SIZES) pageSize = ADMIN_DEFAULT_PAGE_SIZE;
  @IsOptional() @Transform(({ value }) => typeof value === "string" ? value.trim() : value) @IsString() @MaxLength(200) q?: string;
  @IsOptional() @IsString() @MaxLength(100) status?: string;
  @IsOptional() @IsString() @MaxLength(80) category?: string;
  @IsOptional() @IsString() @MaxLength(100) subcategory?: string;
  @IsOptional() @IsString() @MaxLength(100) group?: string;
  @IsOptional() @IsString() @MaxLength(100) sales?: string;
  @IsOptional() @IsIn(["pilot", "regular"]) pilot?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
}
export class AdminDashboardDto extends AdminBranchDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(365) days = 7;
}
