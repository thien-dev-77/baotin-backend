import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsInt, IsString, Length, Min, ValidateNested } from "class-validator";
import { VariantAttributeDto } from "./product.dto";
import { MAX_BULK_PRODUCTS } from "./product-bulk.dto";

class VariantGroupProductDto {
  @IsString() @Length(1, 100) id!: string;
  @IsInt() @Min(1) revision!: number;
  @IsArray() @ArrayMaxSize(6)
  @ValidateNested({ each: true }) @Type(() => VariantAttributeDto) attributes!: VariantAttributeDto[];
}

export class ProductVariantGroupDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_BULK_PRODUCTS)
  @ArrayUnique((item: VariantGroupProductDto) => item.id)
  @ValidateNested({ each: true }) @Type(() => VariantGroupProductDto) products!: VariantGroupProductDto[];
}
