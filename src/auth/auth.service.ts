import { ConflictException, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { DatabaseService } from "../database/database.service";
import { CustomerEntity, SessionEntity, UserEntity } from "../database/entities";
import { hashPassword, verifyPassword } from "./password";
import type { LoginDto, RegisterDto } from "./auth.dto";
import type { SessionUser } from "../types/domain.types";
import { LedgerService } from "../ledger/ledger.service";

export type AuthRequest = Request & { user?: UserEntity; sessionId?: string; guestId?: string };
export const authCookie = "baotin_session";
export const guestCookie = "baotin_guest";
export function cookieOptions() { return { httpOnly: true, secure: process.env.NODE_ENV === "production" || process.env.COOKIE_SECURE === "true", sameSite: "lax" as const, path: "/" }; }
export const phoneKey = (value: string) => value.replace(/[\s()-]/g, "");

@Injectable()
export class AuthService {
  constructor(private readonly db: DatabaseService, private readonly jwt: JwtService, private readonly ledger: LedgerService) {}
  async userView(user: UserEntity): Promise<SessionUser> {
    const customer = user.customerId ? await this.db.source.getRepository(CustomerEntity).findOneBy({ id: user.customerId }) : null;
    const balance = customer ? (await this.ledger.customers([customer.data]))[0] : null;
    return { id: user.id, name: user.name, email: user.email, role: user.role, branches: user.branches, customer: customer && balance ? { id: customer.id, name: user.name, email: user.email, phone: user.phone || "", company: user.profile.company || customer.data.name, tax: user.profile.tax, address: user.profile.address, role: "b2b", status: customer.data.status === "Đang hoạt động" ? "active" : "pending", creditLimit: customer.data.limit, debt: balance.debt, creditReserved: balance.creditReserved } : null };
  }
  async authenticate(request: AuthRequest, required = true): Promise<UserEntity | undefined> {
    const token = request.cookies?.[authCookie];
    if (!token) { if (required) throw new UnauthorizedException("Vui lòng đăng nhập."); return; }
    try {
      const claims = await this.jwt.verifyAsync<{ sub: string; sid: string }>(token, { algorithms: ["HS256"], issuer: "baotin-api", audience: "baotin-web" });
      const session = await this.db.source.getRepository(SessionEntity).findOneBy({ id: claims.sid, userId: claims.sub });
      const user = session && session.expiresAt > new Date() ? await this.db.source.getRepository(UserEntity).findOneBy({ id: claims.sub }) : null;
      if (!user || user.disabled) throw new Error("Invalid session");
      if (user.customerId) {
        const customer = await this.db.source.getRepository(CustomerEntity).findOneBy({ id: user.customerId });
        if (!customer || customer.data.status === "Tạm ngưng") throw new ForbiddenException("Tài khoản đang tạm ngưng.");
      }
      request.user = user; request.sessionId = claims.sid;
      return user;
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      throw new UnauthorizedException("Phiên đăng nhập hết hạn hoặc không hợp lệ.");
    }
  }
  async establish(user: UserEntity, response: Response, remember = false) {
    const sid = randomUUID();
    await this.db.source.getRepository(SessionEntity).save({ id: sid, userId: user.id, expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000) });
    const token = await this.jwt.signAsync({ sub: user.id, sid }, { expiresIn: "2h", issuer: "baotin-api", audience: "baotin-web", algorithm: "HS256" });
    response.cookie(authCookie, token, { ...cookieOptions(), ...(remember ? { maxAge: 2 * 60 * 60 * 1000 } : {}) });
    return { user: await this.userView(user) };
  }
  async login(input: LoginDto, response: Response) {
    const users = this.db.source.getRepository(UserEntity);
    const identity = input.identity.trim().toLowerCase();
    const user = await users.createQueryBuilder("u").addSelect("u.passwordHash").where("u.email = :email OR u.phone = :phone", { email: identity, phone: phoneKey(identity) }).getOne();
    if (!user || user.disabled || !await verifyPassword(input.password, user.passwordHash)) throw new UnauthorizedException("Thông tin đăng nhập không đúng.");
    if (user.customerId) {
      const customer = await this.db.source.getRepository(CustomerEntity).findOneBy({ id: user.customerId });
      if (!customer || customer.data.status === "Tạm ngưng") throw new ForbiddenException("Tài khoản đang tạm ngưng.");
    }
    return this.establish(user, response, input.remember);
  }
  async register(input: RegisterDto, response: Response) {
    const email = input.email.trim().toLowerCase();
    const phone = phoneKey(input.phone);
    if (!/^\+?\d{9,12}$/.test(phone)) throw new ConflictException("Số điện thoại không hợp lệ.");
    const passwordHash = await hashPassword(input.password);
    const user = await this.db.transaction(async (manager) => {
      if (await manager.getRepository(UserEntity).findOne({ where: [{ email }, { phone }] })) throw new ConflictException("Email hoặc số điện thoại đã đăng ký.");
      const id = `KH-${randomUUID()}`;
      await manager.getRepository(CustomerEntity).save({ id, branch: "Quy Nhơn", data: { id, name: input.company.trim(), contact: input.name.trim(), phone, group: "Chờ phân nhóm", branch: "Quy Nhơn", status: "Chờ duyệt", limit: 0, debt: 0, overdue: 0 } });
      return manager.getRepository(UserEntity).save(manager.getRepository(UserEntity).create({ email, phone, name: input.name.trim(), passwordHash, role: "b2b", customerId: id, branches: ["Quy Nhơn"], profile: { company: input.company.trim() } }));
    });
    return this.establish(user, response);
  }
  async logout(request: AuthRequest, response: Response) {
    try { await this.authenticate(request, false); } catch { /* Invalid cookies can still be cleared. */ }
    if (request.sessionId) await this.db.source.getRepository(SessionEntity).delete({ id: request.sessionId });
    response.clearCookie(authCookie, cookieOptions());
    return { user: null };
  }
}
