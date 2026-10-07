import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  Min,
  ValidateIf,
} from "class-validator";
import { branches, type Branch } from "../types/domain.types";

export class CustomerProfileDto {
  @IsIn(branches) branch!: Branch;
  @IsString() @Length(2, 150) name!: string;
  @IsString() @Length(2, 100) contact!: string;
  @IsString() @Length(9, 20) phone!: string;
  @ValidateIf((value) => value.email !== "")
  @IsEmail()
  @MaxLength(160)
  email!: string;
  @IsString() @MaxLength(30) tax!: string;
  @IsString() @MaxLength(300) address!: string;
  @IsString() @Length(1, 100) group!: string;
  @IsOptional() @IsUUID() assignedSalesId?: string | null;
  @IsBoolean() pilot!: boolean;
  @IsString() @MaxLength(2000) notes!: string;
}
export class CreateCustomerDto extends CustomerProfileDto {
  @IsOptional() @IsString() @Length(12, 128) password?: string;
}
export class UpdateCustomerDto extends CustomerProfileDto {
  @IsInt() @Min(1) revision!: number;
}
export class CustomerAccountDto {
  @IsIn(branches) branch!: Branch;
  @IsInt() @Min(1) revision!: number;
  @IsString() @Length(12, 128) password!: string;
}
