import { Transform } from "class-transformer";
import { ArrayMaxSize, ArrayUnique, IsArray, IsBoolean, IsInt, IsNumber, IsOptional, IsString, Length, Matches, Max, MaxLength, Min, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { MAX_PRODUCT_PRICE, MAX_PRODUCT_DISCOUNT } from "./product-pricing";
import { MAX_PRODUCT_GALLERY, MAX_VARIANT_LABEL_LENGTH } from "./product.constants";

const trim = Transform(({ value }) => typeof value === "string" ? value.trim() : value);
export const productImagePattern = /^\/(?:images|media\/(?:images|uploads))\/[a-zA-Z0-9/_-]+\.(?:jpe?g|png|webp)$/;

export class VariantAttributeDto {
  @trim @IsString() @Length(1, 50) name!: string;
  @trim @IsString() @Length(1, 100) value!: string;
}

export class ProductDto {
  @IsOptional() @IsInt() @Min(1) revision?: number;
  @trim @IsString() @Length(2, 200) name!: string;
  @trim @IsString() @Length(1, 80) code!: string;
  @trim @IsString() @Length(1, 200) @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) slug!: string;
  @trim @IsString() @Length(1, 80) category!: string;
  @trim @IsString() @MaxLength(100) subcategory!: string;
  @trim @IsString() @Length(1, 80) brand!: string;
  @trim @IsString() @Length(1, 30) unit!: string;
  @IsOptional() @IsInt() @Min(0) @Max(MAX_PRODUCT_PRICE) price?: number;
  @IsOptional() @IsInt() @Min(0) @Max(MAX_PRODUCT_PRICE) listPrice?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MAX_PRODUCT_DISCOUNT) b2cDiscount?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MAX_PRODUCT_DISCOUNT) b2bDiscount?: number;
  @IsOptional() @IsInt() @Min(0) @Max(999999999999) oldPrice?: number;
  @trim @IsString() @MaxLength(500) specification!: string;
  @trim @IsString() @MaxLength(100) material!: string;
  @trim @IsString() @MaxLength(100) color!: string;
  @trim @IsString() @MaxLength(100) size!: string;
  @trim @IsString() @MaxLength(100) origin!: string;
  @trim @IsString() @MaxLength(10000) description!: string;
  @IsOptional() @trim @IsString() @MaxLength(80) alternateCode?: string;
  @IsOptional() @trim @IsString() @MaxLength(300) @Matches(/^(?:|https:\/\/[^\s]+)$/) sourceUrl?: string;
  @IsOptional() @trim @IsString() @MaxLength(2000) shortDescription?: string;
  @IsOptional() @trim @IsString() @MaxLength(10000) technicalDetails?: string;
  @IsOptional() @trim @IsString() @MaxLength(20000) usageGuide?: string;
  @IsOptional() @trim @IsString() @MaxLength(500) warranty?: string;
  @IsArray() @ArrayMaxSize(MAX_PRODUCT_GALLERY) @ArrayUnique() @IsString({ each: true }) @Matches(productImagePattern, { each: true }) gallery!: string[];
  @IsBoolean() featured!: boolean;
  @IsOptional() @IsBoolean() showAuthenticityLabel?: boolean;
  @IsBoolean() published!: boolean;
  @IsOptional() @trim @IsString() @Length(1, 100) variantGroupId?: string;
  @IsOptional() @trim @IsString() @MaxLength(MAX_VARIANT_LABEL_LENGTH) variantLabel?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(6) @ValidateNested({ each: true }) @Type(() => VariantAttributeDto) variantAttributes?: VariantAttributeDto[];
}
