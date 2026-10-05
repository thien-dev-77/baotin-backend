import { IsBoolean, IsEmail, IsOptional, IsString, Length, Matches } from "class-validator";

export class LoginDto {
  @IsString() @Length(3, 160) identity!: string;
  @IsString() @Length(8, 128) password!: string;
  @IsOptional() @IsBoolean() remember?: boolean;
}
export class RegisterDto {
  @IsString() @Length(2, 100) name!: string;
  @IsString() @Length(2, 150) company!: string;
  @IsString() @Matches(/^\+?[\d ()-]{9,20}$/) phone!: string;
  @IsEmail() @Length(3, 160) email!: string;
  @IsString() @Length(8, 128) password!: string;
}
