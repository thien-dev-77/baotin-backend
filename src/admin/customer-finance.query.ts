import { CustomerEntity, OrderEntity, ReceiptEntity } from "../database/entities";
import { CreditEntity, LedgerEntity } from "../database/operations.entities";
import type { DatabaseService } from "../database/database.service";
import { businessDate } from "../orders/orders.service";

export const customerDebtSql = "COALESCE(balance.debt, (c.data->>'debt')::numeric, 0)";
export const customerOverdueSql = `LEAST(GREATEST(0, ${customerDebtSql}), COALESCE(balance."openingOverdue", (c.data->>'overdue')::numeric, 0) + COALESCE(overdue.amount, 0))`;

export function customerFinanceQuery(db: DatabaseService, branch: string) {
  const paid = db.source.createQueryBuilder().select("receipt.data->>'orderId'", "orderId")
    .addSelect("SUM((receipt.data->>'amount')::numeric)", "amount").from(ReceiptEntity, "receipt")
    .where("receipt.branch = :branch AND receipt.data->>'status' = :posted", { branch, posted: "Đã đối chiếu" })
    .groupBy("receipt.data->>'orderId'");
  const overdue = db.source.createQueryBuilder().select('o."customerId"', "customerId")
    .addSelect("SUM(GREATEST(0, (o.data->>'total')::numeric - COALESCE(paid.amount, 0)))", "amount")
    .from(OrderEntity, "o").leftJoin(`(${paid.getQuery()})`, "paid", 'paid."orderId" = o.id')
    .innerJoin(LedgerEntity, "entry", "entry.reference = concat('order:', o.id, ':credit') AND entry.kind = 'credit'")
    .where('o.branch = :branch AND o."dueDate" < :date', { branch, date: businessDate() })
    .groupBy('o."customerId"').setParameters(paid.getParameters());
  return db.source.getRepository(CustomerEntity).createQueryBuilder("c")
    .leftJoin(CreditEntity, "balance", 'balance."customerId" = c.id AND balance.branch = c.branch')
    .leftJoin(`(${overdue.getQuery()})`, "overdue", 'overdue."customerId" = c.id')
    .where("c.branch = :branch", { branch }).setParameters(overdue.getParameters());
}
