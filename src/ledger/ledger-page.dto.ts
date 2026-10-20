import { Transform, Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import { AdminBranchDto, ADMIN_PAGE_SIZES } from "../admin/admin-browse.dto";

export class LedgerPageDto extends AdminBranchDto {
  @IsIn(["stock", "credit", "entries"]) tab: "stock" | "credit" | "entries" = "stock";
  @Type(() => Number) @IsInt() @Min(1) @Max(100000) page = 1;
  @Type(() => Number) @IsIn(ADMIN_PAGE_SIZES) pageSize = 10;
  @IsOptional() @Transform(({ value }) => typeof value === "string" ? value.trim() : value) @IsString() @MaxLength(200) q?: string;
}
