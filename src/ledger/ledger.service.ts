import { ConflictException, Injectable } from "@nestjs/common";
import { In, Raw, type EntityManager } from "typeorm";
import { DatabaseService } from "../database/database.service";
import {
  CustomerEntity,
  OrderEntity,
  ProductEntity,
  ReceiptEntity,
} from "../database/entities";
import {
  CreditEntity,
  InventoryEntity,
  LedgerEntity,
} from "../database/operations.entities";
import type { AdminCustomer, AdminOrder, Product } from "../types/domain.types";
import { today } from "../catalog/price-policy.service";

const reservedStages = ["Chờ soạn hàng", "Đang soạn", "Sẵn sàng giao"];
export const reservesStock = (order: AdminOrder) =>
  reservedStages.includes(order.status);
export function reservedQuantity(
  orders: AdminOrder[],
  productId: string,
  except?: string,
) {
  return reservedQuantities(orders, except).get(productId) || 0;
}

export function reservedQuantities(orders: AdminOrder[], except?: string) {
  const quantities = new Map<string, number>();
  for (const order of orders) {
    if (order.id === except || !reservesStock(order)) continue;
    const seen = new Set<string>();
    for (const line of order.items) {
      if (seen.has(line.productId)) continue;
      seen.add(line.productId);
      quantities.set(line.productId, (quantities.get(line.productId) || 0) + line.quantity);
    }
  }
  return quantities;
}

@Injectable()
export class LedgerService {
  constructor(private readonly db: DatabaseService) {}
  async stock<T extends Pick<Product, "id" | "stock">>(
    products: T[],
    branch: string,
    manager = this.db.source.manager,
    except?: string,
  ) {
    if (!products.length) return [];
    const [balances, orders] = await Promise.all([
      manager.getRepository(InventoryEntity).find({
        select: { productId: true, onHand: true },
        where: { branch, productId: In(products.map(product => product.id)) },
      }),
      manager.getRepository(OrderEntity).find({
        select: { data: true },
        where: { branch, data: Raw(alias => `${alias} ->> 'status' IN (:...reservedStages)`, { reservedStages }) },
      }),
    ]);
    const onHandByProduct = new Map(balances.map(row => [row.productId, row.onHand]));
    const reservedByProduct = reservedQuantities(orders.map(row => row.data), except);
    return products.map((product) => {
      const onHand =
        onHandByProduct.get(product.id) ??
        (branch === "Quy Nhơn" ? product.stock : 0);
      const reserved = reservedByProduct.get(product.id) || 0;
      return {
        ...product,
        onHand,
        reserved,
        stock: Math.max(0, onHand - reserved),
      };
    });
  }
  async customers(
    customers: AdminCustomer[],
    manager = this.db.source.manager,
    except?: string,
  ) {
    if (!customers.length) return [];
    const customerIds = customers.map(customer => customer.id);
    const [balances, orders, entries] = await Promise.all([
      manager.getRepository(CreditEntity).find({ where: { customerId: In(customerIds) } }),
      manager.getRepository(OrderEntity).find({ select: { id: true, customerId: true, data: true, dueDate: true }, where: { customerId: In(customerIds) } }),
      manager.getRepository(LedgerEntity).find({ select: { reference: true }, where: { kind: "credit", resourceId: In(customerIds) } }),
    ]);
    const receipts = orders.length ? await manager.getRepository(ReceiptEntity).find({
      select: { data: true },
      where: { data: Raw(alias => `${alias} ->> 'status' = :posted AND ${alias} ->> 'orderId' IN (:...orderIds)`, { posted: "Đã đối chiếu", orderIds: orders.map(order => order.id) }) },
    }) : [];
    const balanceByCustomer = new Map(balances.map(row => [row.customerId, row]));
    const postedReferences = new Set(entries.map(row => row.reference));
    const paidByOrder = new Map<string, number>();
    for (const receipt of receipts) paidByOrder.set(receipt.data.orderId, (paidByOrder.get(receipt.data.orderId) || 0) + receipt.data.amount);
    const reservedByCustomer = new Map<string, number>();
    const overdueByCustomer = new Map<string, number>();
    const date = today();
    for (const row of orders) {
      if (!row.customerId) continue;
      const unpaid = Math.max(0, row.data.total - (paidByOrder.get(row.id) || 0));
      if (row.id !== except && row.data.credit && reservesStock(row.data)) reservedByCustomer.set(row.customerId, (reservedByCustomer.get(row.customerId) || 0) + unpaid);
      if (row.dueDate && row.dueDate < date && postedReferences.has(`order:${row.id}:credit`)) overdueByCustomer.set(row.customerId, (overdueByCustomer.get(row.customerId) || 0) + unpaid);
    }
    return customers.map((customer) => {
      const balance = balanceByCustomer.get(customer.id);
      const creditReserved = reservedByCustomer.get(customer.id) || 0;
      const debt = balance?.debt ?? customer.debt;
      const overdue = Math.min(
        Math.max(0, debt),
        (balance?.openingOverdue ?? customer.overdue) +
          (overdueByCustomer.get(customer.id) || 0),
      );
      return { ...customer, debt, overdue, creditReserved };
    });
  }
  async credit(
    manager: EntityManager,
    customerId: string,
    delta: number,
    reference: string,
    actorId: string,
    reason: string,
    overdueRestore = 0,
  ) {
    if (await manager.getRepository(LedgerEntity).findOneBy({ reference }))
      return;
    const customer = await manager
      .getRepository(CustomerEntity)
      .findOneByOrFail({ id: customerId });
    const repository = manager.getRepository(CreditEntity);
    const row =
      (await repository.findOneBy({ customerId })) ||
      repository.create({
        customerId,
        branch: customer.branch,
        openingDebt: customer.data.debt,
        debt: customer.data.debt,
        openingOverdue: customer.data.overdue,
      });
    if (!Number.isSafeInteger(row.debt + delta))
      throw new ConflictException("Số dư vượt giới hạn cho phép.");
    row.debt += delta;
    const overdueBefore = row.openingOverdue;
    row.openingOverdue = Math.min(
      Math.max(0, row.debt),
      row.openingOverdue + overdueRestore,
    );
    await repository.save(row);
    await manager
      .getRepository(LedgerEntity)
      .save({
        branch: row.branch,
        kind: "credit",
        resourceId: customerId,
        delta,
        openingOverdueDelta: row.openingOverdue - overdueBefore,
        reference,
        actorId,
        reason,
      });
  }
  async inventory(
    manager: EntityManager,
    branch: string,
    productId: string,
    delta: number,
    reference: string,
    actorId: string,
    reason: string,
  ) {
    if (await manager.getRepository(LedgerEntity).findOneBy({ reference }))
      return;
    const product = await manager
      .getRepository(ProductEntity)
      .findOneByOrFail({ id: productId });
    const repository = manager.getRepository(InventoryEntity);
    const id = `${branch}:${productId}`;
    const row =
      (await repository.findOneBy({ id })) ||
      repository.create({
        id,
        branch,
        productId,
        onHand: branch === "Quy Nhơn" ? product.data.stock : 0,
      });
    if (
      !Number.isSafeInteger(row.onHand + delta) ||
      row.onHand + delta < 0 ||
      row.onHand + delta > 1_000_000_000
    )
      throw new ConflictException(
        "Không thể xuất vượt tồn hoặc ghi số dư không hợp lệ.",
      );
    row.onHand += delta;
    await repository.save(row);
    await manager
      .getRepository(LedgerEntity)
      .save({
        branch,
        kind: "stock",
        resourceId: productId,
        delta,
        reference,
        actorId,
        reason,
      });
  }
  async handoff(manager: EntityManager, order: AdminOrder, actorId: string) {
    for (const item of order.items)
      await this.inventory(
        manager,
        order.branch,
        item.productId,
        -item.quantity,
        `order:${order.id}:stock:${item.productId}`,
        actorId,
        `Xuất hàng ${order.id}`,
      );
    if (order.credit && order.customerId)
      await this.credit(
        manager,
        order.customerId,
        order.total,
        `order:${order.id}:credit`,
        actorId,
        `Ghi nợ ${order.id}`,
      );
  }
  async receipt(
    manager: EntityManager,
    order: AdminOrder,
    id: string,
    amount: number,
    actorId: string,
    reverse = false,
  ) {
    if (!order.credit || !order.customerId) return;
    const original = reverse
      ? await manager
          .getRepository(LedgerEntity)
          .findOneBy({ reference: `receipt:${id}:credit` })
      : null;
    if (reverse && !original) return;
    await this.credit(
      manager,
      order.customerId,
      reverse ? amount : -amount,
      `receipt:${id}:${reverse ? "reverse" : "credit"}`,
      actorId,
      `${reverse ? "Hủy" : "Đối chiếu"} phiếu thu ${id}`,
      original ? -original.openingOverdueDelta : 0,
    );
  }
}
