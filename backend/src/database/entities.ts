import { Column, CreateDateColumn, Entity, PrimaryColumn, PrimaryGeneratedColumn, UpdateDateColumn, VersionColumn } from "typeorm";
import type { AdminApproval, AdminCustomer, AdminOrder, Branch, Category, Order, Product, StaffRole } from "../../../shared/types";
import type { WarehouseRecord } from "../../../shared/admin-warehouse";
import type { Receipt } from "../../../shared/admin-accounting";

@Entity("products")
export class ProductEntity {
  @PrimaryColumn() id!: string;
  @Column({ unique: true }) slug!: string;
  @Column("jsonb") data!: Product;
  @Column({ default: true }) published!: boolean;
  @VersionColumn() revision!: number;
}
@Entity("categories")
export class CategoryEntity { @PrimaryColumn() slug!: string; @Column("jsonb") data!: Category; }
@Entity("customers")
export class CustomerEntity { @PrimaryColumn() id!: string; @Column() branch!: string; @Column("jsonb") data!: AdminCustomer; }
@Entity("users")
export class UserEntity {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Column({ unique: true }) email!: string;
  @Column({ type: "varchar", unique: true, nullable: true }) phone!: string | null;
  @Column() name!: string;
  @Column({ select: false }) passwordHash!: string;
  @Column() role!: StaffRole | "b2b";
  @Column({ type: "varchar", nullable: true }) customerId!: string | null;
  @Column("simple-array") branches!: Branch[];
  @Column("jsonb", { default: {} }) profile!: { company?: string; tax?: string; address?: string; addresses?: { id: string; name: string; phone: string; address: string }[]; settings?: boolean[]; favorites?: string[] };
}
@Entity("sessions")
export class SessionEntity {
  @PrimaryColumn("uuid") id!: string;
  @Column("uuid") userId!: string;
  @Column("timestamptz") expiresAt!: Date;
}
@Entity("orders")
export class OrderEntity {
  @PrimaryColumn() id!: string;
  @Column() branch!: string;
  @Column({ type: "varchar", nullable: true }) customerId!: string | null;
  @Column({ type: "varchar", nullable: true }) guestId!: string | null;
  @Column({ type: "varchar", unique: true, nullable: true }) idempotencyKey!: string | null;
  @Column({ type: "varchar", nullable: true }) requestHash!: string | null;
  @Column("jsonb") data!: AdminOrder;
  @Column("jsonb", { nullable: true }) checkout!: Order | null;
  @Column("jsonb", { default: { checks: {}, history: [] } }) warehouse!: WarehouseRecord;
  @Column({ type: "varchar", nullable: true }) dueDate!: string | null;
  @VersionColumn() revision!: number;
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}
@Entity("approvals")
export class ApprovalEntity { @PrimaryColumn() id!: string; @Column() branch!: string; @Column("jsonb") data!: AdminApproval; }
@Entity("receipts")
export class ReceiptEntity { @PrimaryColumn() id!: string; @Column() branch!: string; @Column("jsonb") data!: Receipt; }
@Entity("audit_events")
export class AuditEntity {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Column() actorId!: string;
  @Column() action!: string;
  @Column() resourceId!: string;
  @Column("jsonb") detail!: Record<string, unknown>;
  @CreateDateColumn() at!: Date;
}
@Entity("leads")
export class LeadEntity {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Column("jsonb") data!: { name: string; phone: string; email: string; message: string };
  @CreateDateColumn() createdAt!: Date;
}
@Entity("newsletter_subscriptions")
export class NewsletterEntity {
  @PrimaryColumn() email!: string;
  @CreateDateColumn() createdAt!: Date;
}
export const entities = [ProductEntity, CategoryEntity, CustomerEntity, UserEntity, SessionEntity, OrderEntity, ApprovalEntity, ReceiptEntity, AuditEntity, LeadEntity, NewsletterEntity];
