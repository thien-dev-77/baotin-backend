import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsString, Length, Matches, Min, ValidateNested } from "class-validator";

export const MAX_BULK_CATEGORIES = 500;

class CategorySelectionDto {
  @IsString() @Length(1, 80) @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) slug!: string;
  @IsInt() @Min(1) revision!: number;
}

export class CategoryBulkDto {
  @IsIn(["show", "hide"]) action!: "show" | "hide";
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_BULK_CATEGORIES) @ArrayUnique((item: CategorySelectionDto) => item.slug)
  @ValidateNested({ each: true }) @Type(() => CategorySelectionDto) categories!: CategorySelectionDto[];
}
