import { BadRequestException, Body, Controller, Get, Patch, Req } from "@nestjs/common";
import { IsArray, IsBoolean, IsEmail, IsOptional, IsString, Length, MaxLength, ValidateNested, ArrayMaxSize, ArrayMinSize } from "class-validator";
import { Type } from "class-transformer";
import { AuthService, phoneKey, type AuthRequest } from "../auth/auth.service";
import { DatabaseService } from "../database/database.service";
import { CustomerEntity, ProductEntity, UserEntity } from "../database/entities";
import { LedgerEntity } from "../database/operations.entities";

class ProfileDto {
  @IsString() @Length(2, 100) name!: string;
  @IsString() @Length(2, 150) company!: string;
  @IsString() @Length(9, 20) phone!: string;
  @IsEmail() email!: string;
  @IsString() @MaxLength(30) tax!: string;
  @IsString() @MaxLength(300) address!: string;
}
class AddressDto {
  @IsString() @Length(1, 100) id!: string;
  @IsString() @Length(2, 100) name!: string;
  @IsString() @Length(9, 20) phone!: string;
  @IsString() @Length(2, 300) address!: string;
}
class PreferencesDto {
  @IsOptional() @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => AddressDto) addresses?: AddressDto[];
  @IsOptional() @IsArray() @ArrayMinSize(3) @ArrayMaxSize(3) @IsBoolean({ each: true }) settings?: boolean[];
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) favorites?: string[];
}
@Controller("account")
export class AccountController {
  constructor(private readonly auth: AuthService, private readonly db: DatabaseService) {}
  @Get() async account(@Req() request: AuthRequest) {
    const user = (await this.auth.authenticate(request))!;
    const entries = user.customerId ? await this.db.source.getRepository(LedgerEntity).find({ where: { resourceId: user.customerId, kind: "credit" }, order: { at: "DESC" }, take: 100 }) : [];
    return { user: await this.auth.userView(user), addresses: user.profile.addresses || [], settings: user.profile.settings || [true, true, false], favorites: user.profile.favorites || [], payments: entries.map(row => ({ date: row.at.toISOString(), note: row.reason, debit: Math.max(0, row.delta), credit: Math.max(0, -row.delta) })) };
  }
  @Patch("profile") async profile(@Body() input: ProfileDto, @Req() request: AuthRequest) {
    const user = (await this.auth.authenticate(request))!;
    if (!user.customerId) throw new BadRequestException("Tài khoản không phải khách B2B.");
    if (input.email.trim().toLowerCase() !== user.email) throw new BadRequestException("Thay đổi email đăng nhập cần xác minh riêng.");
    const phone = phoneKey(input.phone);
    if (!/^\+?\d{9,12}$/.test(phone)) throw new BadRequestException("Số điện thoại không hợp lệ.");
    await this.db.transaction(async (manager) => {
      const duplicate = await manager.getRepository(UserEntity).findOneBy({ phone });
      if (duplicate && duplicate.id !== user.id) throw new BadRequestException("Số điện thoại đã đăng ký.");
      const current = await manager.getRepository(UserEntity).findOneByOrFail({ id: user.id });
      current.name = input.name.trim(); current.phone = phone; current.profile = { ...current.profile, company: input.company.trim(), tax: input.tax.trim(), address: input.address.trim() };
      await manager.getRepository(UserEntity).save(current);
      const customer = await manager.getRepository(CustomerEntity).findOneByOrFail({ id: user.customerId! });
      customer.data = { ...customer.data, name: current.profile.company!, contact: current.name, phone };
      await manager.getRepository(CustomerEntity).save(customer);
    });
    return { user: await this.auth.userView(await this.db.source.getRepository(UserEntity).findOneByOrFail({ id: user.id })) };
  }
  @Patch("preferences") async preferences(@Body() input: PreferencesDto, @Req() request: AuthRequest) {
    const user = (await this.auth.authenticate(request))!;
    if (input.addresses && (new Set(input.addresses.map((item) => item.id)).size !== input.addresses.length || input.addresses.some((item) => !/^\+?\d{9,12}$/.test(phoneKey(item.phone))))) throw new BadRequestException("Địa chỉ không hợp lệ.");
    if (input.favorites) {
      const products = await this.db.source.getRepository(ProductEntity).find();
      if (new Set(input.favorites).size !== input.favorites.length || input.favorites.some((id) => !products.some((item) => item.id === id))) throw new BadRequestException("Sản phẩm yêu thích không hợp lệ.");
    }
    await this.db.transaction(async (manager) => {
      const current = await manager.getRepository(UserEntity).findOneByOrFail({ id: user.id });
      current.profile = { ...current.profile, ...input };
      await manager.getRepository(UserEntity).save(current);
    });
    return { saved: true };
  }
}
