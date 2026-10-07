import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { EntityManager } from "typeorm";
import { AuthService, phoneKey, type AuthRequest } from "../auth/auth.service";
import { hashPassword } from "../auth/password";
import { DatabaseService } from "../database/database.service";
import {
  AuditEntity,
  CustomerEntity,
  SessionEntity,
  UserEntity,
} from "../database/entities";
import { PasswordResetEntity } from "../database/operations.entities";
import { NotificationsService } from "../notifications/notifications.service";
import {
  branches,
  type AdminCustomer,
  type Branch,
} from "../types/domain.types";
import {
  CreateCustomerDto,
  CustomerAccountDto,
  CustomerProfileDto,
  UpdateCustomerDto,
} from "./customer.dto";

@Controller("admin/customers")
export class CustomersController {
  constructor(
    private readonly auth: AuthService,
    private readonly db: DatabaseService,
    private readonly notifications: NotificationsService,
  ) {}

  private async staff(request: AuthRequest, branch: string, write = false) {
    const user = (await this.auth.authenticate(request))!;
    if (!branches.includes(branch as Branch))
      throw new BadRequestException("Chi nhánh không hợp lệ.");
    if (
      !(
        write
          ? ["admin", "boss", "sales"]
          : ["admin", "boss", "sales", "accountant"]
      ).includes(user.role) ||
      !user.branches.includes(branch as Branch)
    )
      throw new ForbiddenException();
    return user;
  }

  private async profile(
    manager: EntityManager,
    input: CustomerProfileDto,
    previous?: CustomerEntity,
  ) {
    const phone = phoneKey(input.phone);
    const name = input.name.trim(),
      contact = input.contact.trim(),
      group = input.group.trim();
    if (
      !/^\+?\d{9,12}$/.test(phone) ||
      name.length < 2 ||
      contact.length < 2 ||
      !group
    )
      throw new BadRequestException(
        "Tên khách, người liên hệ, số điện thoại hoặc nhóm khách không hợp lệ.",
      );
    const assignedSalesId = input.assignedSalesId || null;
    if (assignedSalesId) {
      const sales = await manager
        .getRepository(UserEntity)
        .findOneBy({ id: assignedSalesId, role: "sales", disabled: false });
      if (!sales?.branches.includes(input.branch))
        throw new BadRequestException(
          "Chọn Inside Sales đang hoạt động tại chi nhánh của khách.",
        );
    }
    if (input.pilot && !assignedSalesId)
      throw new BadRequestException("Khách thử nghiệm cần có Sales phụ trách.");
    const email = input.email.trim().toLowerCase();
    const customers = await manager.getRepository(CustomerEntity).find();
    if (
      customers.some(
        (row) => row.id !== previous?.id && phoneKey(row.data.phone) === phone,
      )
    )
      throw new ConflictException("Số điện thoại đã có hồ sơ khách hàng.");
    const accounts = await manager
      .getRepository(UserEntity)
      .find({ where: [{ phone }, ...(email ? [{ email }] : [])] });
    if (accounts.some((user) => !previous || user.customerId !== previous.id))
      throw new ConflictException(
        "Email hoặc số điện thoại đã được sử dụng bởi tài khoản khác.",
      );
    return {
      name,
      contact,
      phone,
      email,
      group,
      tax: input.tax.trim(),
      address: input.address.trim(),
      assignedSalesId,
      pilot: input.pilot,
      notes: input.notes.trim(),
    };
  }

  private async account(
    manager: EntityManager,
    customer: CustomerEntity,
    passwordHash: string,
  ) {
    if (
      await manager
        .getRepository(UserEntity)
        .findOneBy({ customerId: customer.id })
    )
      throw new ConflictException(
        "Khách đã có tài khoản. Không thể tạo thêm hoặc ghi đè mật khẩu.",
      );
    const duplicate = await manager
      .getRepository(UserEntity)
      .findOne({
        where: [
          { phone: customer.data.phone },
          ...(customer.data.email ? [{ email: customer.data.email }] : []),
        ],
      });
    if (duplicate)
      throw new ConflictException("Email hoặc số điện thoại đã được sử dụng.");
    const data = customer.data;
    const user = await manager.getRepository(UserEntity).save(
      manager.getRepository(UserEntity).create({
        name: data.contact,
        phone: phoneKey(data.phone),
        email: data.email || null,
        role: "b2b",
        customerId: customer.id,
        branches: [customer.branch as Branch],
        disabled: false,
        passwordHash,
        profile: { company: data.name, tax: data.tax, address: data.address },
      }),
    );
    return user.id;
  }

  @Get() async list(
    @Query("branch") branch: string,
    @Req() request: AuthRequest,
  ) {
    await this.staff(request, branch);
    const rows = await this.db.source
      .getRepository(CustomerEntity)
      .find({ where: { branch }, order: { id: "ASC" } });
    const users = await this.db.source.getRepository(UserEntity).find();
    const assignees = users
      .filter(
        (user) =>
          user.role === "sales" && user.branches.includes(branch as Branch),
      )
      .map((user) => ({
        id: user.id,
        name: user.name,
        disabled: user.disabled,
      }));
    return {
      items: rows.map((row) => {
        const account = users.find(
          (user) => user.role === "b2b" && user.customerId === row.id,
        );
        return {
          ...row.data,
          revision: row.revision,
          email: account ? account.email || "" : row.data.email || "",
          tax: account?.profile.tax ?? row.data.tax ?? "",
          address: account?.profile.address ?? row.data.address ?? "",
          account: account
            ? { id: account.id, disabled: account.disabled }
            : null,
        };
      }),
      assignees,
      groups: [
        ...new Set([
          "Chờ phân nhóm",
          "Xưởng nội thất",
          "Thiết kế - thi công",
          "Thợ - đội thi công",
          ...rows.map((row) => row.data.group),
        ]),
      ].sort(),
    };
  }

  @Post() async create(
    @Body() input: CreateCustomerDto,
    @Req() request: AuthRequest,
  ) {
    const actor = await this.staff(request, input.branch, true);
    const passwordHash = input.password
      ? await hashPassword(input.password)
      : null;
    return this.db.transaction(async (manager) => {
      const fields = await this.profile(manager, input);
      const id = `KH-${randomUUID()}`;
      const data: AdminCustomer = {
        id,
        branch: input.branch,
        ...fields,
        status: "Chờ duyệt",
        limit: 0,
        debt: 0,
        overdue: 0,
        termsDays: 30,
      };
      const row = await manager
        .getRepository(CustomerEntity)
        .save(
          manager
            .getRepository(CustomerEntity)
            .create({ id, branch: input.branch, data }),
        );
      const accountId = passwordHash
        ? await this.account(manager, row, passwordHash)
        : null;
      await manager
        .getRepository(AuditEntity)
        .save({
          actorId: actor.id,
          action: "customer-create",
          resourceId: id,
          detail: {
            profile: fields,
            branch: input.branch,
            accountCreated: !!accountId,
          },
        });
      await this.notifications.emit(manager, {
        key: `customer-created:${id}`,
        type: "account",
        branch: input.branch,
        roles: ["admin", "boss", "sales"],
        title: "Hồ sơ khách B2B mới",
        message: data.name,
        href: "/admin/customers?status=Chờ%20duyệt",
      });
      return { id, revision: row.revision, accountCreated: !!accountId };
    });
  }

  @Patch(":id") async update(
    @Param("id") id: string,
    @Body() input: UpdateCustomerDto,
    @Req() request: AuthRequest,
  ) {
    const actor = await this.staff(request, input.branch, true);
    return this.db.transaction(async (manager) => {
      const row = await manager
        .getRepository(CustomerEntity)
        .findOneBy({ id, branch: input.branch });
      if (!row)
        throw new NotFoundException("Không tìm thấy khách trong chi nhánh.");
      if (row.revision !== input.revision)
        throw new ConflictException(
          "Hồ sơ đã thay đổi. Làm mới dữ liệu trước khi lưu lại.",
        );
      const fields = await this.profile(manager, input, row);
      const users = await manager
        .getRepository(UserEntity)
        .find({ where: { customerId: id } });
      if (
        users.length > 1 ||
        users.some(
          (user) => user.role !== "b2b" || user.branches.join() !== row.branch,
        )
      )
        throw new ConflictException(
          "Liên kết tài khoản khách không hợp lệ. Cần quản trị viên kiểm tra.",
        );
      const account = users[0];
      if (account && fields.email !== (account.email || ""))
        throw new BadRequestException(
          "Không đổi email đăng nhập trong hồ sơ khách. Thay đổi qua quản trị tài khoản.",
        );
      const before = row.data;
      row.data = { ...before, ...fields };
      await manager.getRepository(CustomerEntity).save(row);
      if (account) {
        const phoneChanged = account.phone !== fields.phone;
        account.name = fields.contact;
        account.phone = fields.phone;
        account.profile = {
          ...account.profile,
          company: fields.name,
          tax: fields.tax,
          address: fields.address,
        };
        await manager.getRepository(UserEntity).save(account);
        if (phoneChanged) {
          await manager
            .getRepository(SessionEntity)
            .delete({ userId: account.id });
          await manager
            .getRepository(PasswordResetEntity)
            .delete({ userId: account.id });
        }
      }
      await manager
        .getRepository(AuditEntity)
        .save({
          actorId: actor.id,
          action: "customer-update",
          resourceId: id,
          detail: { before, after: fields, revision: row.revision },
        });
      return { id, revision: row.revision };
    });
  }

  @Post(":id/account") async createAccount(
    @Param("id") id: string,
    @Body() input: CustomerAccountDto,
    @Req() request: AuthRequest,
  ) {
    const actor = await this.staff(request, input.branch, true);
    const passwordHash = await hashPassword(input.password);
    return this.db.transaction(async (manager) => {
      const row = await manager
        .getRepository(CustomerEntity)
        .findOneBy({ id, branch: input.branch });
      if (!row)
        throw new NotFoundException("Không tìm thấy khách trong chi nhánh.");
      if (row.revision !== input.revision)
        throw new ConflictException(
          "Hồ sơ đã thay đổi. Làm mới dữ liệu trước khi tạo tài khoản.",
        );
      const accountId = await this.account(manager, row, passwordHash);
      await manager
        .getRepository(CustomerEntity)
        .increment({ id }, "revision", 1);
      await manager
        .getRepository(AuditEntity)
        .save({
          actorId: actor.id,
          action: "customer-account-create",
          resourceId: id,
          detail: { accountId },
        });
      return { id, revision: row.revision + 1, accountCreated: true };
    });
  }
}
