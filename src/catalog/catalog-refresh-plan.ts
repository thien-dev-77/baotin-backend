import type { ProductEntity } from "../database/entities";
import type { InventoryEntity } from "../database/operations.entities";
import { branches, type AdminOrder } from "../types/domain.types";
import { reservedQuantities } from "../ledger/ledger.service";
import { sentenceCaseProductName } from "./product-name";

export const CATALOG_REFRESH_VERSION = "catalog-stock-names-v1";
export const CATALOG_INITIAL_STOCK = 100;

export function planCatalogRefresh(products: ProductEntity[], inventory: InventoryEntity[], orders: { branch: string; data: AdminOrder }[]) {
  const names = products.flatMap(row => {
    const name = sentenceCaseProductName(row.data);
    return name === row.data.name ? [] : [{ id: row.id, code: row.data.code, before: row.data.name, name, revision: row.revision }];
  });
  const stock = products.filter(row => row.data.stock !== CATALOG_INITIAL_STOCK).map(row => ({ id: row.id, revision: row.revision }));
  const balances = new Map(inventory.map(row => [`${row.branch}:${row.productId}`, row]));
  if (balances.size !== inventory.length) throw new Error("Duplicate inventory balances. Review before setting stock.");
  const adjustments = branches.flatMap(branch => {
    const reserved = reservedQuantities(orders.filter(row => row.branch === branch).map(row => row.data));
    return products.flatMap(row => {
      if ((reserved.get(row.id) || 0) > CATALOG_INITIAL_STOCK) throw new Error(`Target stock is below reserved quantity for ${row.data.code} at ${branch}.`);
      const current = balances.get(`${branch}:${row.id}`);
      const onHand = current?.onHand ?? (branch === "Quy Nhơn" ? row.data.stock : 0);
      if (!Number.isSafeInteger(onHand) || onHand < 0) throw new Error(`Invalid inventory for ${row.data.code} at ${branch}.`);
      if (current && onHand === CATALOG_INITIAL_STOCK) return [];
      return [{ id: current?.id || `${branch}:${row.id}`, branch, productId: row.id, before: onHand, target: CATALOG_INITIAL_STOCK, delta: CATALOG_INITIAL_STOCK - onHand }];
    });
  });
  return { names, stock, adjustments, summary: { products: products.length, namesUpdated: names.length, baseStocksUpdated: stock.length, inventoryBalancesUpdated: adjustments.length, targetStock: CATALOG_INITIAL_STOCK, branches: Array.from(branches), published: products.filter(row => row.published).length, private: products.filter(row => !row.published).length } };
}
