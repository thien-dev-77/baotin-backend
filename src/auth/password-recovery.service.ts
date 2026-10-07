import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import nodemailer from "nodemailer";
import { DatabaseService } from "../database/database.service";
import { AuditEntity, SessionEntity, UserEntity } from "../database/entities";
import { PasswordResetEntity } from "../database/operations.entities";
import { hashPassword, verifyPassword } from "./password";

export const resetDigest = (token: string) =>
  createHash("sha256").update(token).digest("hex");

@Injectable()
export class PasswordRecoveryService {
  private readonly logger = new Logger(PasswordRecoveryService.name);
  constructor(private readonly db: DatabaseService) {}
  async change(userId: string, currentPassword: string, password: string) {
    if (password === currentPassword)
      throw new BadRequestException("Mật khẩu mới cần khác mật khẩu hiện tại.");
    await this.db.transaction(async (manager) => {
      const user = await manager
        .getRepository(UserEntity)
        .createQueryBuilder("u")
        .addSelect("u.passwordHash")
        .where("u.id = :id", { id: userId })
        .getOneOrFail();
      if (
        user.disabled ||
        !(await verifyPassword(currentPassword, user.passwordHash))
      )
        throw new UnauthorizedException("Mật khẩu hiện tại không đúng.");
      user.passwordHash = await hashPassword(password);
      await manager.getRepository(UserEntity).save(user);
      await manager.getRepository(SessionEntity).delete({ userId });
      await manager.getRepository(PasswordResetEntity).delete({ userId });
      await manager.getRepository(AuditEntity).save({
        actorId: userId,
        action: "password-change",
        resourceId: userId,
        detail: {},
      });
    });
    return { user: null };
  }
  async forgot(email: string) {
    if (
      !process.env.SMTP_URL ||
      !process.env.EMAIL_FROM ||
      !process.env.FRONTEND_URL
    )
      throw new ServiceUnavailableException(
        "Khôi phục qua email chưa được cấu hình. Vui lòng liên hệ quản trị viên.",
      );
    const frontend = new URL(process.env.FRONTEND_URL);
    if (
      frontend.protocol !== "https:" &&
      !(
        process.env.NODE_ENV !== "production" &&
        ["localhost", "127.0.0.1"].includes(frontend.hostname)
      )
    )
      throw new ServiceUnavailableException(
        "Khôi phục qua email chưa được cấu hình.",
      );
    const token = randomBytes(32).toString("hex");
    const tokenHash = resetDigest(token);
    const user = await this.db.source
      .getRepository(UserEntity)
      .findOneBy({ email: email.trim().toLowerCase(), disabled: false });
    if (user?.email) {
      await this.db.transaction(async (manager) => {
        await manager
          .getRepository(PasswordResetEntity)
          .delete({ userId: user.id });
        await manager.getRepository(PasswordResetEntity).save({
          userId: user.id,
          tokenHash,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        });
      });
      const link = new URL("/reset-password", frontend);
      link.hash = `token=${token}`;
      let transport: ReturnType<typeof nodemailer.createTransport> | undefined;
      try {
        transport = nodemailer.createTransport({
          url: process.env.SMTP_URL,
          connectionTimeout: 10000,
          socketTimeout: 15000,
          requireTLS: process.env.NODE_ENV === "production",
          logger: false,
          debug: false,
        });
        await transport.sendMail({
          from: process.env.EMAIL_FROM,
          to: user.email,
          subject: "Bảo Tín - Khôi phục mật khẩu",
          text: `Liên kết có hiệu lực 30 phút và chỉ dùng một lần:\n${link.toString()}\nBỏ qua email nếu bạn không yêu cầu.`,
        });
      } catch {
        await this.db.source
          .getRepository(PasswordResetEntity)
          .delete({ tokenHash });
        // Keep public replies neutral even when a registered recipient cannot receive mail.
        this.logger.warn("Recovery delivery failed. Check SMTP configuration.");
      } finally {
        transport?.close();
      }
    }
    return {
      message:
        "Yêu cầu đã được tiếp nhận. Nếu email đã đăng ký, hãy kiểm tra hộp thư để nhận liên kết khôi phục.",
    };
  }
  async reset(token: string, password: string) {
    return this.db.transaction(async (manager) => {
      const tokenHash = resetDigest(token);
      const reset = await manager
        .getRepository(PasswordResetEntity)
        .findOneBy({ tokenHash });
      if (!reset || reset.expiresAt <= new Date())
        throw new BadRequestException("Liên kết hết hạn hoặc đã được sử dụng.");
      const user = await manager
        .getRepository(UserEntity)
        .findOneBy({ id: reset.userId, disabled: false });
      if (!user)
        throw new BadRequestException("Liên kết hết hạn hoặc đã được sử dụng.");
      user.passwordHash = await hashPassword(password);
      await manager.getRepository(UserEntity).save(user);
      await manager
        .getRepository(PasswordResetEntity)
        .delete({ userId: user.id });
      await manager.getRepository(SessionEntity).delete({ userId: user.id });
      await manager.getRepository(AuditEntity).save({
        actorId: user.id,
        action: "password-reset",
        resourceId: user.id,
        detail: {},
      });
      return { user: null };
    });
  }
}
