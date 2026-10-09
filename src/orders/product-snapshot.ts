import { In, type EntityManager } from "typeorm";
import { ProductEntity } from "../database/entities";
import type { OrderLine, Product, ProductSnapshot } from "../types/domain.types";

export function productSnapshot(product: Product): ProductSnapshot {
  const { name, code, slug, image, unit } = product;
  return { name, code, slug, image, unit };
}

export async function captureOrderItems(manager: EntityManager, items: OrderLine[], previous: OrderLine[] = []): Promise<OrderLine[]> {
  const existing = new Map(previous.map(line => [line.productId, line]));
  const ids = items.filter(line => !existing.has(line.productId)).map(line => line.productId);
  const products = ids.length ? await manager.getRepository(ProductEntity).find({ where: { id: In(ids) }, select: { id: true, data: true } }) : [];
  const byId = new Map(products.map(row => [row.id, row.data]));
  return items.map(({ productId, quantity, unitPrice }) => {
    const old = existing.get(productId);
    const product = byId.get(productId);
    // Legacy lines stay legacy; today's catalog cannot reconstruct their history.
    const snapshot = old ? old.snapshot : product ? productSnapshot(product) : undefined;
    return { productId, quantity, unitPrice, ...(snapshot ? { snapshot } : {}) };
  });
}
