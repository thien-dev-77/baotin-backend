import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsInt, IsString, Length, Min, ValidateNested } from "class-validator";
import { MAX_BULK_PRODUCTS } from "./product-bulk.dto";

class VariantDetachMemberDto {
  @IsString() @Length(1, 100) id!: string;
  @IsInt() @Min(1) revision!: number;
}

export class ProductVariantDetachDto {
  @IsString() @Length(1, 100) groupId!: string;
  @IsArray() @ArrayMinSize(2) @ArrayMaxSize(MAX_BULK_PRODUCTS)
  @ArrayUnique((item: VariantDetachMemberDto) => item.id)
  @ValidateNested({ each: true }) @Type(() => VariantDetachMemberDto) products!: VariantDetachMemberDto[];
}
