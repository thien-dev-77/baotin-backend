import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsString, Length, Min, ValidateNested } from "class-validator";
import { MAX_BULK_PRODUCTS } from "./product-bulk.dto";

export const PRODUCT_VARIANT_COPY_FIELDS = ["name", "shortDescription", "description", "technicalDetails", "usageGuide", "warranty", "gallery", "material", "origin"] as const;
export type ProductVariantCopyField = typeof PRODUCT_VARIANT_COPY_FIELDS[number];

class VariantCopyTargetDto {
  @IsString() @Length(1, 100) id!: string;
  @IsInt() @Min(1) revision!: number;
}

export class ProductVariantCopyDto {
  @IsInt() @Min(1) revision!: number;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(PRODUCT_VARIANT_COPY_FIELDS.length) @ArrayUnique()
  @IsIn(PRODUCT_VARIANT_COPY_FIELDS, { each: true }) fields!: ProductVariantCopyField[];
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_BULK_PRODUCTS) @ArrayUnique((item: VariantCopyTargetDto) => item.id)
  @ValidateNested({ each: true }) @Type(() => VariantCopyTargetDto) products!: VariantCopyTargetDto[];
}
