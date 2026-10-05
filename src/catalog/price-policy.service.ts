import {
  BadRequestException,
  ConflictException,
  Injectable,
} from "@nestjs/common";
import type { EntityManager } from "typeorm";
import { randomUUID } from "node:crypto";
import { DatabaseService } from "../database/database.service";
import {
  AuditEntity,
  CustomerEntity,
  ProductEntity,
  UserEntity,
} from "../database/entities";
import { PricePolicyEntity } from "../database/operations.entities";
import type { AdminCustomer, Product } from "../types/domain.types";
import type { PricePolicy } from "../types/operations.types";

export function policyPrice(
  product: Product,
  customer: AdminCustomer | undefined,
  policies: PricePolicy[],
  date: string,
) {
  if (!customer || customer.status !== "Đang hoạt động") return product.price;
  const matches = policies.filter(
    (policy) =>
      policy.active &&
      policy.branch === customer.branch &&
      policy.startsOn <= date &&
      (!policy.endsOn || policy.endsOn >= date) &&
      (policy.scope === "default" ||
        (policy.scope === "group" && policy.target === customer.group) ||
        (policy.scope === "customer" && policy.target === customer.id)),
  );
  const rank = { default: 0, group: 1, customer: 2 };
  matches.sort(
    (a, b) =>
      rank[b.scope] - rank[a.scope] ||
      b.startsOn.localeCompare(a.startsOn) ||
      a.id.localeCompare(b.id),
  );
  const policy = matches[0];
  return policy
    ? (policy.prices[product.id] ??
        Math.max(
          1,
          Math.round((product.price * (100 - policy.discount)) / 100),
        ))
    : product.price;
}
export function validDate(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
export function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

@Injectable()
export class PricePolicyService {
  constructor(private readonly db: DatabaseService) {}
  async list(
    branch: string,
    manager = this.db.source.manager,
  ): Promise<PricePolicy[]> {
    return (
      await manager.getRepository(PricePolicyEntity).find({ where: { branch } })
    ).map((row) => ({ ...row.data, id: row.id, revision: row.revision }));
  }
  async personalize(
    products: Product[],
    customer: AdminCustomer | undefined,
    manager = this.db.source.manager,
  ) {
    if (!customer)
      return products.map(({ customerPrice: _price, ...product }) => product);
    const policies = await this.list(customer.branch, manager);
    return products.map((product) => ({
      ...product,
      customerPrice: policyPrice(product, customer, policies, today()),
    }));
  }
  async save(
    user: UserEntity,
    input: Omit<PricePolicy, "id" | "revision"> & {
      id?: string;
      revision?: number;
    },
  ) {
    if (input.name.trim().length < 2)
      throw new BadRequestException("Nhập tên bảng giá.");
    input = { ...input, name: input.name.trim() };
    if (
      !validDate(input.startsOn) ||
      (input.endsOn !== null &&
        (!validDate(input.endsOn) || input.endsOn < input.startsOn))
    )
      throw new BadRequestException("Ngày hiệu lực không hợp lệ.");
    return this.db.transaction(async (manager) => {
      const products = await manager.getRepository(ProductEntity).find();
      if (
        Object.entries(input.prices).some(
          ([id, value]) =>
            !products.some((product) => product.id === id) ||
            !Number.isSafeInteger(value) ||
            value < 1 ||
            value > 1_000_000_000_000,
        )
      )
        throw new BadRequestException("Giá theo mã hàng không hợp lệ.");
      const customers = await manager
        .getRepository(CustomerEntity)
        .find({ where: { branch: input.branch } });
      if (
        input.scope === "default"
          ? input.target !== ""
          : !customers.some((customer) =>
              input.scope === "customer"
                ? customer.id === input.target
                : customer.data.group === input.target,
            )
      )
        throw new BadRequestException(
          "Nhóm hoặc khách hàng không thuộc chi nhánh.",
        );
      const repository = manager.getRepository(PricePolicyEntity);
      const previous = input.id
        ? await repository.findOneBy({ id: input.id, branch: input.branch })
        : null;
      if (input.id && (!previous || previous.revision !== input.revision))
        throw new ConflictException(
          "Bảng giá đã thay đổi. Làm mới và thử lại.",
        );
      const policies = await this.list(input.branch, manager);
      if (
        input.active &&
        policies.some(
          (policy) =>
            policy.id !== input.id &&
            policy.active &&
            policy.scope === input.scope &&
            policy.target === input.target &&
            policy.startsOn <= (input.endsOn || "9999-12-31") &&
            input.startsOn <= (policy.endsOn || "9999-12-31"),
        )
      )
        throw new ConflictException(
          "Đã có bảng giá cùng đối tượng trong thời gian này.",
        );
      const { id: _id, revision: _revision, ...data } = input;
      const row = await repository.save(
        repository.create({
          ...(previous || { id: randomUUID() }),
          branch: input.branch,
          data,
        }),
      );
      await manager
        .getRepository(AuditEntity)
        .save({
          actorId: user.id,
          action: "price-policy",
          resourceId: row.id,
          detail: { previous: previous?.data || null, current: data },
        });
      return { ...row.data, id: row.id, revision: row.revision };
    });
  }
}
