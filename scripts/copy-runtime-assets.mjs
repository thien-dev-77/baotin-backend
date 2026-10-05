import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, "dist");

for (const asset of ["certs/prod-ca-2021.crt", "seed/mock.json", "media/images"]) {
  const destination = resolve(output, asset);
  await mkdir(dirname(destination), { recursive: true });
  await cp(resolve(root, asset), destination, { recursive: true });
}

console.log("Runtime assets copied to dist: public CA, mock fixtures and sample images.");
