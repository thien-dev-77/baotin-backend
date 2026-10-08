import { Transform } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";

const trim = Transform(({ value }) =>
  typeof value === "string" ? value.normalize("NFC").trim() : value,
);

export class CategoryDto {
  @IsOptional() @IsInt() @Min(1) revision?: number;
  @trim
  @IsString()
  @Length(1, 80)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  slug!: string;
  @trim @IsString() @Length(2, 120) name!: string;
  @trim
  @IsString()
  @Matches(
    /^(?:|\/(?:images|media\/(?:images|uploads))\/[a-zA-Z0-9/_-]+\.(?:jpe?g|png|webp))$/,
  )
  image!: string;
  @trim @IsString() @MaxLength(2000) description!: string;
  @Transform(({ value }) =>
    Array.isArray(value)
      ? value.map((item) =>
          typeof item === "string" ? item.normalize("NFC").trim() : item,
        )
      : value,
  )
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @Length(1, 100, { each: true })
  subcategories!: string[];
  @IsBoolean() visible!: boolean;
  @IsInt() @Min(0) @Max(100000) sortOrder!: number;
}
