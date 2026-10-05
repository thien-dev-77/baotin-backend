import EmbeddedPostgres from "embedded-postgres";
import { config } from "dotenv";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

async function main() {
  config({ path: ".env.local", quiet: true });
  if (!process.env.LOCAL_DB_PASSWORD) throw new Error("LOCAL_DB_PASSWORD is required in .env.local.");
  const databaseDir = resolve(".localdb");
  const postgres = new EmbeddedPostgres({ databaseDir, user: "baotin", password: process.env.LOCAL_DB_PASSWORD, port: 5441, persistent: true, authMethod: "scram-sha-256", initdbFlags: ["--locale=C", "--encoding=UTF8"], postgresFlags: ["-h", "127.0.0.1"], onLog: () => {}, onError: () => {} });
  try { await access(resolve(databaseDir, "PG_VERSION")); } catch { await postgres.initialise(); }
  await postgres.start();
  const client = postgres.getPgClient("postgres", "127.0.0.1"); await client.connect();
  const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", ["baotin_dev"]);
  if (!exists.rowCount) await client.query("CREATE DATABASE baotin_dev");
  await client.end();
  console.log("Local PostgreSQL test database listening on 127.0.0.1:5441. This is not Supabase.");
  const stop = async () => { await postgres.stop(); process.exit(0); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  await new Promise(() => {});
}
void main().catch((error) => { console.error(error.message); process.exit(1); });
