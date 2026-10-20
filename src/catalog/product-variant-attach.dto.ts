import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsInt, IsString, Length, Min, ValidateNested } from "class-validator";
import { MAX_BULK_PRODUCTS } from "./product-bulk.dto";
import { VariantAttributeDto } from "./product.dto";

class VariantAttachMemberDto {
  @IsString() @Length(1, 100) id!: string;
  @IsInt() @Min(1) revision!: number;
}

export class ProductVariantAttachDto {
  @IsString() @Length(1, 100) groupId!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_BULK_PRODUCTS)
  @ArrayUnique((item: VariantAttachMemberDto) => item.id)
  @ValidateNested({ each: true }) @Type(() => VariantAttachMemberDto) products!: VariantAttachMemberDto[];
  @IsString() @Length(1, 100) targetId!: string;
  @IsInt() @Min(1) targetRevision!: number;
  @IsArray() @ArrayMaxSize(6)
  @ValidateNested({ each: true }) @Type(() => VariantAttributeDto) attributes!: VariantAttributeDto[];
}
