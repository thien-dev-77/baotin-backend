import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDefined, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, MaxLength, Min, ValidateNested } from "class-validator";

export class ItemDto {
  @IsString() @Length(1, 100) productId!: string;
  @IsInt() @Min(1) @Max(999) quantity!: number;
}
export class RecipientDto {
  @IsString() @Length(2, 100) name!: string;
  @IsString() @Matches(/^\+?[\d ()-]{9,20}$/) phone!: string;
  @IsString() @MaxLength(160) email!: string;
  @IsString() @MaxLength(300) address!: string;
  @IsString() @MaxLength(100) city!: string;
  @IsString() @MaxLength(100) district!: string;
  @IsString() @MaxLength(100) ward!: string;
}
export class QuoteDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => ItemDto) items!: ItemDto[];
  @IsIn(["Giao hàng nội thành", "Giao nội thành", "Nhận tại cửa hàng", "Sale giao", "Chành xe"]) delivery!: string;
  @IsString() @MaxLength(30) coupon!: string;
}
export class CheckoutDto extends QuoteDto {
  @IsDefined() @ValidateNested() @Type(() => RecipientDto) customer!: RecipientDto;
  @IsOptional() @IsInt() @Min(0) expectedTotal?: number;
  @IsIn(["Thanh toán khi nhận hàng (COD)", "Chuyển khoản ngân hàng", "Thanh toán công nợ B2B"]) payment!: string;
  @IsString() @MaxLength(500) note!: string;
}
