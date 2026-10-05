import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { catalog, categoryCatalog, guideCatalog } from "../../frontend/lib/catalog";
import { adminCustomers, adminOrders, adminApprovals } from "../../frontend/lib/admin-preview";

async function main() {
  const path = resolve("seed");
  await mkdir(path, { recursive: true });
  await writeFile(resolve(path, "mock.json"), JSON.stringify({ products: catalog, categories: categoryCatalog, guides: guideCatalog, customers: adminCustomers, orders: adminOrders, approvals: adminApprovals }, null, 2) + "\n");
  console.log(`Exported existing mock: ${catalog.length} products, ${adminCustomers.length} customers, ${adminOrders.length} orders.`);
}
void main();
