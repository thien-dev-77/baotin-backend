import { ConflictException, Injectable } from "@nestjs/common";
import type { EntityManager } from "typeorm";
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
  return orders
    .filter((order) => order.id !== except && reservesStock(order))
    .reduce(
      (sum, order) =>
        sum +
        (order.items.find((item) => item.productId === productId)?.quantity ||
          0),
      0,
    );
}

@Injectable()
export class LedgerService {
  constructor(private readonly db: DatabaseService) {}
  async stock(
    products: Product[],
    branch: string,
    manager = this.db.source.manager,
    except?: string,
  ) {
    const balances = await manager
      .getRepository(InventoryEntity)
      .find({ where: { branch } });
    const orders = (
      await manager.getRepository(OrderEntity).find({ where: { branch } })
    ).map((row) => row.data);
    return products.map((product) => {
      const onHand =
        balances.find((row) => row.productId === product.id)?.onHand ??
        (branch === "Quy Nhơn" ? product.stock : 0);
      const reserved = reservedQuantity(orders, product.id, except);
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
    const balances = await manager.getRepository(CreditEntity).find();
    const orders = await manager.getRepository(OrderEntity).find();
    const receipts = (await manager.getRepository(ReceiptEntity).find()).filter(
      (row) => row.data.status === "Đã đối chiếu",
    );
    const entries = await manager
      .getRepository(LedgerEntity)
      .find({ where: { kind: "credit" } });
    return customers.map((customer) => {
      const balance = balances.find((row) => row.customerId === customer.id);
      const rows = orders.filter((row) => row.customerId === customer.id);
      const unpaid = (row: OrderEntity) =>
        Math.max(
          0,
          row.data.total -
            receipts
              .filter((receipt) => receipt.data.orderId === row.id)
              .reduce((sum, receipt) => sum + receipt.data.amount, 0),
        );
      const creditReserved = rows
        .filter(
          (row) =>
            row.id !== except && row.data.credit && reservesStock(row.data),
        )
        .reduce((sum, row) => sum + unpaid(row), 0);
      const debt = balance?.debt ?? customer.debt;
      const overdue = Math.min(
        Math.max(0, debt),
        (balance?.openingOverdue ?? customer.overdue) +
          rows
            .filter(
              (row) =>
                row.dueDate &&
                row.dueDate < today() &&
                entries.some(
                  (entry) => entry.reference === `order:${row.id}:credit`,
                ),
            )
            .reduce((sum, row) => sum + unpaid(row), 0),
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
