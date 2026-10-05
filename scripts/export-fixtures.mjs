import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

async function main() {
  const frontendDir = resolve(process.env.FRONTEND_DIR || "../baotin-frontend");
  const tsconfig = join(frontendDir, "tsconfig.json");
  try { await access(tsconfig); }
  catch { throw new Error("Set FRONTEND_DIR to the separate frontend directory with tsconfig.json and lib/. Build/start use the bundled seed and do not require frontend source."); }
  const require = createRequire(import.meta.url);
  const child = spawn(process.execPath, [require.resolve("tsx/cli"), "--tsconfig", tsconfig, fileURLToPath(new URL("./export-fixtures.ts", import.meta.url))], { stdio: "inherit", env: { ...process.env, FRONTEND_DIR: frontendDir } });
  child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
  child.on("close", (code) => { process.exitCode = code ?? 1; });
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
