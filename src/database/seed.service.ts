import { Injectable, OnApplicationBootstrap } from "@nestjs/common";
import { readFile } from "node:fs/promises";
import { DatabaseService } from "./database.service";
import { ApprovalEntity, CategoryEntity, CustomerEntity, OrderEntity, ProductEntity, UserEntity } from "./entities";
import type { AdminApproval, AdminCustomer, AdminOrder, Category, Product, StaffRole } from "../types/domain.types";
import { branches } from "../types/domain.types";
import { hashPassword } from "../auth/password";
import { phoneKey } from "../auth/auth.service";
import { runtimeAssetPath } from "../runtime-assets";
import { PricePolicyEntity } from "./operations.entities";

@Injectable()
export class SeedService implements OnApplicationBootstrap {
  constructor(private readonly db: DatabaseService) {}
  async onApplicationBootstrap() {
    if (process.env.SEED_MOCK_DATA !== "true") return;
    if (process.env.NODE_ENV === "production") throw new Error("Mock seed is disabled in production.");
    if (!process.env.SEED_PASSWORD || process.env.SEED_PASSWORD.length < 12 || process.env.SEED_PASSWORD.startsWith("replace-")) throw new Error("SEED_PASSWORD requires at least 12 non-placeholder characters.");
    const fixture = JSON.parse(await readFile(runtimeAssetPath("seed/mock.json"), "utf8")) as { products: Product[]; categories: Category[]; customers: AdminCustomer[]; orders: AdminOrder[]; approvals: AdminApproval[] };
    const passwordHash = await hashPassword(process.env.SEED_PASSWORD);
    await this.db.transaction(async (manager) => {
      for (const data of fixture.products) await manager.createQueryBuilder().insert().into(ProductEntity).values({ id: data.id, slug: data.slug, data, published: true }).orIgnore().execute();
      for (const data of fixture.categories) await manager.createQueryBuilder().insert().into(CategoryEntity).values({ slug: data.slug, data }).orIgnore().execute();
      for (const data of fixture.customers) await manager.createQueryBuilder().insert().into(CustomerEntity).values({ id: data.id, branch: data.branch, data }).orIgnore().execute();
      for (const [index, branch] of branches.entries()) await manager.createQueryBuilder().insert().into(PricePolicyEntity).values({ id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, branch, data: { name: "Bảng giá B2B mẫu", branch, scope: "default", target: "", discount: 10, prices: {}, startsOn: "1970-01-01", endsOn: null, active: true } }).orIgnore().execute();
      for (const original of fixture.orders) {
        const customer = fixture.customers.find((item) => item.id === original.customerId);
        const data = { ...original, details: { recipient: customer?.contact || original.customerName, phone: customer ? phoneKey(customer.phone) : "0901000000", address: "", delivery: "Nhận tại cửa hàng" as const, payment: original.credit ? "Công nợ B2B" as const : "Chuyển khoản" as const, note: "Đơn seed minh họa; chưa có dữ liệu giao hàng KiotViet." } };
        await manager.createQueryBuilder().insert().into(OrderEntity).values({ id: data.id, branch: data.branch, customerId: data.customerId, data, checkout: null, warehouse: { checks: {}, history: [] }, guestId: null, idempotencyKey: null, dueDate: null }).orIgnore().execute();
      }
      for (const data of fixture.approvals) await manager.createQueryBuilder().insert().into(ApprovalEntity).values({ id: data.id, branch: data.branch, data }).orIgnore().execute();
      const staff: [string, StaffRole][] = [["admin", "admin"], ["boss", "boss"], ["sales", "sales"], ["warehouse", "warehouse"], ["accountant", "accountant"]];
      for (const [name, role] of staff) await manager.createQueryBuilder().insert().into(UserEntity).values({ email: `${name}@baotin.local`, name, passwordHash, role, branches: role === "admin" || role === "boss" ? [...branches] : ["Quy Nhơn"], phone: null, customerId: null, profile: {} }).orIgnore().execute();
      for (const customer of fixture.customers) await manager.createQueryBuilder().insert().into(UserEntity).values({ email: `${customer.id.toLowerCase()}@baotin.local`, name: customer.contact, phone: phoneKey(customer.phone), passwordHash, role: "b2b", branches: [customer.branch], customerId: customer.id, profile: { company: customer.name } }).orIgnore().execute();
    });
    console.log("Mock fixtures seeded idempotently; existing data was not overwritten.");
  }
}
