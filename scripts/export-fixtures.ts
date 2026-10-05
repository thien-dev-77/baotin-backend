import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";

async function main() {
  const frontendDir = process.env.FRONTEND_DIR;
  if (!frontendDir) throw new Error("Run npm run fixtures with FRONTEND_DIR configured.");
  const requireFrontend = createRequire(resolve(frontendDir, "package.json"));
  const { catalog, categoryCatalog, guideCatalog } = requireFrontend("./lib/catalog.ts");
  const { adminCustomers, adminOrders, adminApprovals } = requireFrontend("./lib/admin-preview.ts");
  const path = resolve("seed");
  await mkdir(path, { recursive: true });
  await writeFile(resolve(path, "mock.json"), JSON.stringify({ products: catalog, categories: categoryCatalog, guides: guideCatalog, customers: adminCustomers, orders: adminOrders, approvals: adminApprovals }, null, 2) + "\n");
  console.log(`Exported existing mock: ${catalog.length} products, ${adminCustomers.length} customers, ${adminOrders.length} orders.`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
