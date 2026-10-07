import { Injectable } from "@nestjs/common";
import type { EntityManager } from "typeorm";
import { CustomerEntity, UserEntity } from "../database/entities";
import { NotificationEntity } from "../database/experience.entities";
import { DatabaseService } from "../database/database.service";

type Event = {
  key: string;
  type: string;
  title: string;
  message: string;
  href: string;
  roleHrefs?: Record<string, string>;
  branch: string;
  customerId?: string | null;
  roles?: string[];
  preference?: number;
};
@Injectable()
export class NotificationsService {
  constructor(private readonly db: DatabaseService) {}
  async emit(manager: EntityManager, event: Event) {
    const users = await manager
      .getRepository(UserEntity)
      .find({ where: { disabled: false } });
    const recipients = users.filter((user) =>
      event.customerId
        ? user.role === "b2b" &&
          user.customerId === event.customerId &&
          user.profile.settings?.[event.preference ?? 0] !== false
        : user.role !== "b2b" &&
          (event.roles || ["admin", "boss", "sales"]).includes(user.role) &&
          user.branches.includes(event.branch as never),
    );
    for (const user of recipients)
      await manager
        .createQueryBuilder()
        .insert()
        .into(NotificationEntity)
        .values({
          userId: user.id,
          audienceRole: user.role,
          branch: event.branch,
          eventKey: event.key,
          type: event.type,
          title: event.title,
          message: event.message.slice(0, 500),
          href: event.roleHrefs?.[user.role] || event.href,
        })
        .orIgnore()
        .execute();
  }
  scope(user: UserEntity) {
    return this.db.source
      .getRepository(NotificationEntity)
      .createQueryBuilder("n")
      .where('"userId" = :id AND "audienceRole" = :role', {
        id: user.id,
        role: user.role,
      })
      .andWhere("(branch IS NULL OR branch IN (:...branches))", {
        branches: user.branches.length ? user.branches : [""],
      });
  }
  async order(
    manager: EntityManager,
    branch: string,
    id: string,
    customerId: string | null,
    status: string,
    revision: number,
    preference = 0,
  ) {
    const base = {
      key: `order:${id}:${revision}`,
      type: preference === 1 ? "credit" : "order",
      branch,
      title: `Đơn ${id}`,
      message: status,
    };
    await this.emit(manager, {
      ...base,
      href: `/admin/orders?order=${encodeURIComponent(id)}`,
      roleHrefs: {
        warehouse: `/admin/warehouse?order=${encodeURIComponent(id)}`,
      },
      roles:
        status === "Chờ soạn hàng"
          ? ["admin", "boss", "sales", "warehouse"]
          : preference === 1
            ? ["admin", "boss", "sales", "accountant"]
            : undefined,
    });
    if (customerId)
      await this.emit(manager, {
        ...base,
        customerId,
        preference,
        href: `/account/orders/${encodeURIComponent(id)}`,
      });
  }
  async remindOverdue(
    manager: EntityManager,
    branch: string,
    customerId: string,
    date: string,
    amount: number,
  ) {
    const customer = await manager
      .getRepository(CustomerEntity)
      .findOneByOrFail({ id: customerId, branch });
    const event = {
      key: `overdue:${customerId}:${date}`,
      type: "credit",
      branch,
      title: "Nhắc công nợ quá hạn",
      message: `${customer.data.name}: ${amount.toLocaleString("vi-VN")} đ quá hạn`,
      preference: 1,
    };
    await this.emit(manager, {
      ...event,
      href: "/admin/credit",
      roles: ["admin", "boss", "accountant", "sales"],
    });
    await this.emit(manager, { ...event, customerId, href: "/account/credit" });
  }
}
