import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  VersionColumn,
} from "typeorm";
import type { PricePolicy } from "../types/operations.types";

const integer = {
  to: (value: number) => value,
  from: (value: string) => Number(value),
};

@Entity("price_policies")
export class PricePolicyEntity {
  @PrimaryColumn("uuid") id!: string;
  @Column() branch!: string;
  @Column("jsonb") data!: Omit<PricePolicy, "id" | "revision">;
  @VersionColumn() revision!: number;
}
@Entity("inventory_balances")
export class InventoryEntity {
  @PrimaryColumn() id!: string;
  @Column() branch!: string;
  @Column() productId!: string;
  @Column() onHand!: number;
}
@Entity("credit_balances")
export class CreditEntity {
  @PrimaryColumn() customerId!: string;
  @Column() branch!: string;
  @Column("bigint", { transformer: integer }) openingDebt!: number;
  @Column("bigint", { transformer: integer }) debt!: number;
  @Column("bigint", { transformer: integer }) openingOverdue!: number;
}
@Entity("ledger_entries")
export class LedgerEntity {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Column({ unique: true }) reference!: string;
  @Column() branch!: string;
  @Column() kind!: "stock" | "credit";
  @Column() resourceId!: string;
  @Column("bigint", { transformer: integer }) delta!: number;
  @Column("bigint", { default: 0, transformer: integer })
  openingOverdueDelta!: number;
  @Column() actorId!: string;
  @Column() reason!: string;
  @CreateDateColumn() at!: Date;
}
@Entity("password_resets")
export class PasswordResetEntity {
  @PrimaryColumn() tokenHash!: string;
  @Column("uuid") userId!: string;
  @Column("timestamptz") expiresAt!: Date;
}
@Entity("integration_links")
export class IntegrationLinkEntity {
  @PrimaryColumn() id!: string;
  @Column() kind!: "product" | "customer" | "order";
  @Column() localId!: string;
  @Column() externalId!: string;
  @Column("jsonb", { default: {} }) snapshot!: Record<string, unknown>;
}
@Entity("integration_runs")
export class IntegrationRunEntity {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Column() actorId!: string;
  @Column() status!: "running" | "completed" | "failed";
  @Column("jsonb") detail!: Record<string, unknown>;
  @CreateDateColumn() at!: Date;
}
@Entity("integration_outbox")
export class IntegrationOutboxEntity {
  @PrimaryColumn() orderId!: string;
  @Column() branch!: string;
  @Column() revision!: number;
  @Column() status!: "sending" | "sent" | "uncertain" | "failed";
  @Column("jsonb") payload!: Record<string, unknown>;
  @Column({ default: "" }) externalId!: string;
  @CreateDateColumn() at!: Date;
}
