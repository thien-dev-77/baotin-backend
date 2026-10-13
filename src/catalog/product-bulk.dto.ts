import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Length, Max, Min, ValidateNested } from "class-validator";
import { MAX_PRODUCT_DISCOUNT } from "./product-pricing";
import { AdminBrowseDto } from "../admin/admin-browse.dto";

export const MAX_BULK_PRODUCTS = 500;
export class ProductSelectionDto extends AdminBrowseDto { resource: AdminBrowseDto["resource"] = "products"; }
class BulkProductSelectionDto {
  @IsString() @Length(1, 100) id!: string;
  @IsInt() @Min(1) revision!: number;
}

export class ProductBulkDto {
  @IsIn(["publish", "private", "discounts"]) action!: "publish" | "private" | "discounts";
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_BULK_PRODUCTS) @ArrayUnique((item: BulkProductSelectionDto) => item.id)
  @ValidateNested({ each: true }) @Type(() => BulkProductSelectionDto) products!: BulkProductSelectionDto[];
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MAX_PRODUCT_DISCOUNT) b2cDiscount?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MAX_PRODUCT_DISCOUNT) b2bDiscount?: number;
}
