import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { entities } from "./entities";
import { readFile } from "node:fs/promises";

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  source!: DataSource;
  async onModuleInit() {
    const schema = process.env.DB_SCHEMA || "baotin_app";
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(schema) || ["public", "auth", "storage"].includes(schema)) throw new Error("DB_SCHEMA must be a dedicated application schema.");
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
    const ssl = process.env.DB_SSL === "true" ? { rejectUnauthorized: true, ...(process.env.DB_SSL_CA_FILE ? { ca: await readFile(process.env.DB_SSL_CA_FILE, "utf8") } : {}) } : false;
    this.source = new DataSource({ type: "postgres", url: process.env.DATABASE_URL, schema, entities, synchronize: false, ssl, logging: false, extra: { max: 5, connectionTimeoutMillis: 7000 } });
    await this.source.initialize();
    await this.source.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    if (process.env.DB_SYNCHRONIZE === "true") await this.source.synchronize();
  }
  async transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.source.transaction(async (manager) => {
      // Serialize pilot commands across API instances until finer-grained locking is introduced.
      await manager.query("SELECT pg_advisory_xact_lock(82610477)");
      return work(manager);
    });
  }
  async onModuleDestroy() { if (this.source?.isInitialized) await this.source.destroy(); }
}
