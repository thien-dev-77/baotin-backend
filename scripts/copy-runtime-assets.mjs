import { access, cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, "dist");

for (const asset of ["certs/prod-ca-2021.crt", "seed/mock.json", "media/images", "assets/fonts"]) {
  const destination = resolve(output, asset);
  await mkdir(dirname(destination), { recursive: true });
  await cp(resolve(root, asset), destination, { recursive: true });
}

const imported = resolve(root, "media/imported/fulco");
if (await access(imported).then(() => true).catch(() => false)) {
  await mkdir(resolve(output, "media/imported"), { recursive: true });
  await cp(imported, resolve(output, "media/imported/fulco"), { recursive: true });
}

console.log("Runtime assets copied to dist: public CA, mock fixtures, sample images and PDF fonts.");
