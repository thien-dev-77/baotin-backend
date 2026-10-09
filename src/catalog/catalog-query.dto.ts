import { Transform, Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

const list = Transform(({ value }) => value === undefined ? undefined : Array.isArray(value) ? value : [value]);
const boolean = Transform(({ value }) => value === "true" ? true : value === "false" ? false : value);

export class CatalogQueryDto {
  @IsOptional() @IsString() @MaxLength(200) q?: string;
  @IsOptional() @list @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(100, { each: true }) category?: string[];
  @IsOptional() @list @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(100, { each: true }) brand?: string[];
  @IsOptional() @list @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(100, { each: true }) material?: string[];
  @IsOptional() @list @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(100, { each: true }) color?: string[];
  @IsOptional() @list @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(100, { each: true }) size?: string[];
  @IsOptional() @list @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(100, { each: true }) origin?: string[];
  @IsOptional() @IsString() @MaxLength(100) subcategory?: string;
  @IsOptional() @list @IsArray() @ArrayMaxSize(2) @IsIn(["in", "out"], { each: true }) stock?: string[];
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(999999999999) min?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(999999999999) max?: number;
  @IsOptional() @boolean @IsBoolean() promotion?: boolean;
  @IsOptional() @boolean @IsBoolean() featured?: boolean;
  @IsIn(["popular", "low", "high", "new"]) sort = "popular";
  @Type(() => Number) @IsInt() @Min(1) @Max(1000000) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(60) pageSize = 12;
}

export class CatalogSelectionDto {
  @IsOptional() @list @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) @MaxLength(100, { each: true }) ids?: string[];
  @IsOptional() @IsString() @MaxLength(80) code?: string;
}
