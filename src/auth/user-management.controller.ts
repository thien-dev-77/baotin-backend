import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
} from "class-validator";
import { randomUUID } from "node:crypto";
import { AuthService, type AuthRequest } from "./auth.service";
import { DatabaseService } from "../database/database.service";
import { AuditEntity, SessionEntity, UserEntity } from "../database/entities";
import { PasswordResetEntity } from "../database/operations.entities";
import { branches, type Branch, type StaffRole } from "../types/domain.types";
import { hashPassword } from "./password";

class UserDto {
  @IsOptional() @IsUUID() id?: string;
  @IsOptional() @IsInt() @Min(1) revision?: number;
  @IsEmail() @Length(3, 160) email!: string;
  @IsString() @Length(2, 100) name!: string;
  @IsIn(["admin", "boss", "sales", "warehouse", "accountant", "b2b"]) role!:
    StaffRole | "b2b";
  @IsArray()
  @ArrayUnique()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @IsIn(branches, { each: true })
  branches!: Branch[];
  @IsBoolean() disabled!: boolean;
  @IsOptional() @IsString() @Length(12, 128) password?: string;
}
class ResetDto {
  @IsString() @Length(12, 128) password!: string;
}
@Controller("admin/users")
export class UserManagementController {
  constructor(
    private readonly auth: AuthService,
    private readonly db: DatabaseService,
  ) {}
  async admin(request: AuthRequest) {
    const user = (await this.auth.authenticate(request))!;
    if (user.role !== "admin") throw new ForbiddenException();
    return user;
  }
  @Get() async list(@Req() request: AuthRequest) {
    const admin = await this.admin(request);
    const users = await this.db.source
      .getRepository(UserEntity)
      .find({ order: { email: "ASC" } });
    return {
      users: users
        .filter((user) =>
          user.branches.every((branch) => admin.branches.includes(branch)),
        )
        .map((user) => ({
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          branches: user.branches,
          disabled: user.disabled,
          customerId: user.customerId,
          revision: user.revision,
        })),
    };
  }
  @Post() async save(@Body() input: UserDto, @Req() request: AuthRequest) {
    const admin = await this.admin(request);
    if (!input.branches.every((branch) => admin.branches.includes(branch)))
      throw new ForbiddenException();
    return this.db.transaction(async (manager) => {
      const repository = manager.getRepository(UserEntity);
      const previous = input.id
        ? await repository.findOneBy({ id: input.id })
        : null;
      if (
        input.id &&
        (!previous ||
          !previous.branches.every((branch) => admin.branches.includes(branch)))
      )
        throw new ForbiddenException();
      if (previous && input.revision !== previous.revision)
        throw new ConflictException(
          "Tài khoản đã thay đổi. Làm mới và thử lại.",
        );
      if (!input.id && (!input.password || input.role === "b2b"))
        throw new BadRequestException(
          "Tạo nhân viên cần mật khẩu; khách B2B đăng ký qua website.",
        );
      if (
        previous &&
        (previous.role === "b2b" || input.role === "b2b") &&
        (input.role !== previous.role ||
          input.branches.join() !== previous.branches.join())
      )
        throw new BadRequestException(
          "Không chuyển đổi tài khoản B2B hoặc chi nhánh khách ở màn hình nhân viên.",
        );
      const email = input.email.trim().toLowerCase();
      const duplicate = await repository.findOneBy({ email });
      if (duplicate && duplicate.id !== input.id)
        throw new ConflictException("Email đã được sử dụng.");
      if (
        previous?.role === "admin" &&
        (input.disabled || input.role !== "admin") &&
        (await repository.countBy({ role: "admin", disabled: false })) <= 1
      )
        throw new ConflictException(
          "Cần giữ ít nhất một quản trị viên đang hoạt động.",
        );
      const row =
        previous ||
        repository.create({
          id: randomUUID(),
          customerId: null,
          phone: null,
          profile: {},
        });
      Object.assign(row, {
        email,
        name: input.name.trim(),
        role: input.role,
        branches: input.branches,
        disabled: input.disabled,
      });
      if (input.password) row.passwordHash = await hashPassword(input.password);
      await repository.save(row);
      if (previous) {
        await manager.getRepository(SessionEntity).delete({ userId: row.id });
        await manager
          .getRepository(PasswordResetEntity)
          .delete({ userId: row.id });
      }
      await manager
        .getRepository(AuditEntity)
        .save({
          actorId: admin.id,
          action: "user-save",
          resourceId: row.id,
          detail: {
            email,
            role: row.role,
            branches: row.branches,
            disabled: row.disabled,
          },
        });
      return { id: row.id };
    });
  }
  @Post(":id/password") async reset(
    @Param("id") id: string,
    @Body() input: ResetDto,
    @Req() request: AuthRequest,
  ) {
    const admin = await this.admin(request);
    await this.db.transaction(async (manager) => {
      const repository = manager.getRepository(UserEntity);
      const user = await repository.findOneBy({ id });
      if (
        !user ||
        !user.branches.every((branch) => admin.branches.includes(branch))
      )
        throw new ForbiddenException();
      user.passwordHash = await hashPassword(input.password);
      await repository.save(user);
      await manager.getRepository(SessionEntity).delete({ userId: id });
      await manager.getRepository(PasswordResetEntity).delete({ userId: id });
      await manager
        .getRepository(AuditEntity)
        .save({
          actorId: admin.id,
          action: "admin-password-reset",
          resourceId: id,
          detail: {},
        });
    });
    return { saved: true };
  }
}
