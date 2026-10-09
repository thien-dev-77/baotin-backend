import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from "typeorm";

export type ContentKind = "banner" | "guide" | "solution";
export type ContentData = {
  slug: string;
  title: string;
  description: string;
  image: string;
  href: string;
  category: string;
  body: string;
  minutes: number;
  width: number;
  height: number;
  position: number;
};

@Entity("notifications")
@Index(["userId", "createdAt"])
@Index(["userId", "eventKey"], { unique: true })
@Index("notifications_unread_scope_idx", ["userId", "audienceRole", "branch"], {
  where: '"readAt" IS NULL',
})
export class NotificationEntity {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Column("uuid") userId!: string;
  @Column() audienceRole!: string;
  @Column({ type: "varchar", nullable: true }) branch!: string | null;
  @Column() eventKey!: string;
  @Column() type!: string;
  @Column() title!: string;
  @Column() message!: string;
  @Column() href!: string;
  @Column("timestamptz", { nullable: true }) readAt!: Date | null;
  @CreateDateColumn() createdAt!: Date;
}

@Entity("content_entries")
export class ContentEntity {
  @PrimaryColumn() id!: string;
  @Column() kind!: ContentKind;
  @Column("jsonb") data!: ContentData;
  @Column({ default: false }) published!: boolean;
  @VersionColumn() revision!: number;
  @UpdateDateColumn() updatedAt!: Date;
}

@Entity("product_reviews")
@Index(["productId", "userId"], { unique: true })
export class ReviewEntity {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Column() productId!: string;
  @Column("uuid") userId!: string;
  @Column() name!: string;
  @Column() stars!: number;
  @Column() text!: string;
  @Column({ default: "pending" }) status!: "pending" | "published" | "rejected";
  @VersionColumn() revision!: number;
  @CreateDateColumn() createdAt!: Date;
}
