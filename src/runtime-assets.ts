import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function runtimeAssetPath(path: string): string {
  // Full-repo runs keep source assets/uploads; output-only deploys use bundled assets.
  const source = resolve(__dirname, "..", path);
  return existsSync(source) ? source : resolve(__dirname, path);
}

export function startupErrorDetails(error: unknown) {
  const failure = error instanceof Error ? error as NodeJS.ErrnoException : new Error("Unknown startup error") as NodeJS.ErrnoException;
  return {
    code: failure.code || failure.name,
    ...(failure.code === "ENOENT" && failure.path ? { path: failure.path } : {}),
    hint: failure.code === "ENOENT"
      ? "Missing runtime file. Check DB_SSL_CA_FILE and bundled certs/, seed/ and media/ assets."
      : "Check runtime environment, database connectivity and application port."
  };
}
