import { Transform } from "class-transformer";
import { ArrayMaxSize, ArrayUnique, IsArray, IsBoolean, IsInt, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from "class-validator";

const trim = Transform(({ value }) => typeof value === "string" ? value.trim() : value);
export const productImagePattern = /^\/(?:images|media\/(?:images|uploads))\/[a-zA-Z0-9/_-]+\.(?:jpe?g|png|webp)$/;

export class ProductDto {
  @IsOptional() @IsInt() @Min(1) revision?: number;
  @trim @IsString() @Length(2, 200) name!: string;
  @trim @IsString() @Length(1, 80) code!: string;
  @trim @IsString() @Length(1, 200) @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) slug!: string;
  @trim @IsString() @Length(1, 80) category!: string;
  @trim @IsString() @MaxLength(100) subcategory!: string;
  @trim @IsString() @Length(1, 80) brand!: string;
  @trim @IsString() @Length(1, 30) unit!: string;
  @IsInt() @Min(0) @Max(999999999999) price!: number;
  @IsOptional() @IsInt() @Min(0) @Max(999999999999) oldPrice?: number;
  @trim @IsString() @MaxLength(500) specification!: string;
  @trim @IsString() @MaxLength(100) material!: string;
  @trim @IsString() @MaxLength(100) color!: string;
  @trim @IsString() @MaxLength(100) size!: string;
  @trim @IsString() @MaxLength(100) origin!: string;
  @trim @IsString() @MaxLength(10000) description!: string;
  @IsArray() @ArrayMaxSize(10) @ArrayUnique() @IsString({ each: true }) @Matches(productImagePattern, { each: true }) gallery!: string[];
  @IsBoolean() featured!: boolean;
  @IsBoolean() published!: boolean;
}
