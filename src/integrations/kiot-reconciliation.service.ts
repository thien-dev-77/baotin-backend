import {
  ConflictException,
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
  ServiceUnavailableException,
} from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import {
  CustomerEntity,
  OrderEntity,
  ProductEntity,
  UserEntity,
} from "../database/entities";
import {
  IntegrationLinkEntity,
  IntegrationRunEntity,
} from "../database/operations.entities";
import { KiotClient } from "./kiot-client";
import { KiotService } from "./kiot.service";
import { LedgerService } from "../ledger/ledger.service";
import { NotificationsService } from "../notifications/notifications.service";

@Injectable()
export class KiotReconciliationService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private timer?: NodeJS.Timeout;
  private running = new Set<string>();
  constructor(
    private readonly db: DatabaseService,
    private readonly client: KiotClient,
    private readonly kiot: KiotService,
    private readonly ledger: LedgerService,
    private readonly notifications: NotificationsService,
  ) {}
  onApplicationBootstrap() {
    if (process.env.KIOTVIET_POLL_ENABLED !== "true") return;
    const minutes = Math.max(
      5,
      Number(process.env.KIOTVIET_POLL_MINUTES) || 15,
    );
    this.timer = setInterval(() => {
      void this.poll().catch(() =>
        console.warn(
          "Kiot reconciliation poll failed; local balances were not modified.",
        ),
      );
    }, minutes * 60000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  private async poll() {
    const config = this.client.configuration();
    if (!config.enabled || !config.configured) return;
    const users = await this.db.source
      .getRepository(UserEntity)
      .find({ where: { role: "admin", disabled: false } });
    for (const branch of Object.keys(config.branches)) {
      const user = users.find((user) =>
        user.branches.includes(branch as never),
      );
      if (user && !this.running.has(branch))
        await this.pull(user, branch).catch(() => undefined);
    }
  }
  async latest(user: UserEntity, branch: string) {
    this.kiot.assert(user, branch);
    const query = this.db.source
      .getRepository(IntegrationRunEntity)
      .createQueryBuilder("r")
      .where(
        "r.detail->>'branch' = :branch AND r.detail->>'kind' = 'reconciliation'",
        { branch },
      )
      .orderBy("r.at", "DESC")
      .addOrderBy("r.id", "DESC");
    const attempt = await query.clone().getOne();
    const run = await query
      .andWhere("r.status = :status", { status: "completed" })
      .getOne();
    return {
      polling: process.env.KIOTVIET_POLL_ENABLED === "true",
      lastAttempt: attempt
        ? { id: attempt.id, at: attempt.at, status: attempt.status }
        : null,
      run: run
        ? { id: run.id, at: run.at, status: run.status, ...run.detail }
        : null,
    };
  }
  async pull(user: UserEntity, branch: string) {
    this.kiot.assert(user, branch);
    const config = this.client.configuration();
    const branchId = config.branches[branch as keyof typeof config.branches];
    if (!config.enabled || !config.configured || !branchId)
      throw new ServiceUnavailableException(
        "KiotViet chưa được cấu hình đầy đủ cho chi nhánh.",
      );
    if (this.running.has(branch))
      throw new ConflictException("Chi nhánh đang được đối chiếu.");
    this.running.add(branch);
    const repo = this.db.source.getRepository(IntegrationRunEntity);
    let run: IntegrationRunEntity | undefined;
    try {
      run = await repo.save(
        repo.create({
          actorId: user.id,
          status: "running",
          detail: { branch, kind: "reconciliation" },
        }),
      );
      const current = run;
      const remoteProducts = await this.client.list("products", {
        includeInventory: "true",
      });
      const remoteCustomers = await this.client.list("customers", {
        includeTotal: "true",
      });
      const remoteOrders = await this.client.list("orders", {
        branchIds: String(branchId),
      });
      await this.db.transaction(async (manager) => {
        const links = await manager.getRepository(IntegrationLinkEntity).find();
        const products = await this.ledger.stock(
          (await manager.getRepository(ProductEntity).find()).map(
            (row) => row.data,
          ),
          branch,
          manager,
        );
        const customers = await this.ledger.customers(
          (
            await manager
              .getRepository(CustomerEntity)
              .find({ where: { branch } })
          ).map((row) => row.data),
          manager,
        );
        const orders = await manager
          .getRepository(OrderEntity)
          .find({ where: { branch } });
        const stock = links
          .filter((link) => link.kind === "product")
          .map((link) => {
            const local = products.find((row) => row.id === link.localId);
            const remote = remoteProducts.find(
              (row) => String(row.id) === link.externalId,
            );
            const inventory = Array.isArray(remote?.inventories)
              ? remote.inventories.find(
                  (row: Record<string, unknown>) => row.branchId === branchId,
                )
              : null;
            const value = Number(inventory?.onHand);
            const valid =
              !!local &&
              !!remote &&
              typeof inventory?.onHand === "number" &&
              remote.code === local.code &&
              String(remote.unit || "") === local.unit &&
              Number.isSafeInteger(value) &&
              value >= 0 &&
              value <= 1e9;
            return {
              id: link.localId,
              name: local?.name || link.localId,
              local: local?.onHand ?? null,
              remote: valid ? value : null,
              valid,
              difference: valid ? value - local!.onHand : null,
            };
          });
        const debt = links
          .filter(
            (link) =>
              link.kind === "customer" && link.snapshot.branch === branch,
          )
          .map((link) => {
            const local = customers.find((row) => row.id === link.localId);
            const remote = remoteCustomers.find(
              (row) => String(row.id) === link.externalId,
            );
            const value = Number(remote?.debt);
            const valid =
              !!local &&
              !!remote &&
              typeof remote.debt === "number" &&
              Number.isSafeInteger(value) &&
              Math.abs(value) <= 1e12;
            return {
              id: link.localId,
              name: local?.name || link.localId,
              local: local?.debt ?? null,
              remote: valid ? value : null,
              valid,
              difference: valid ? value - local!.debt : null,
            };
          });
        const statuses = links
          .filter(
            (link) => link.kind === "order" && link.snapshot.branch === branch,
          )
          .map((link) => {
            const local = orders.find((row) => row.id === link.localId);
            const remote = remoteOrders.find(
              (row) => String(row.id) === link.externalId,
            );
            return {
              id: link.localId,
              local: local?.data.status || "",
              remote:
                typeof remote?.statusValue === "string"
                  ? remote.statusValue.slice(0, 100)
                  : "Không tìm thấy",
              remoteStatus: remote?.status ?? null,
            };
          });
        const differences = [...stock, ...debt].filter(
          (row) => !row.valid || row.difference !== 0,
        ).length;
        current.status = "completed";
        current.detail = {
          branch,
          kind: "reconciliation",
          stock,
          debt,
          statuses,
          differences,
          debtScope: "retailer",
        };
        await manager.getRepository(IntegrationRunEntity).save(current);
        if (differences)
          await this.notifications.emit(manager, {
            key: `kiot-reconcile:${branch}:${Math.floor(Date.now() / 900000)}`,
            type: "integration",
            branch,
            title: "KiotViet có dữ liệu cần đối chiếu",
            message: `${differences} dòng tồn kho/công nợ khác biệt hoặc thiếu dữ liệu`,
            href: "/admin/integrations",
            roles: ["admin", "boss"],
          });
      });
      return { id: run.id, completed: true };
    } catch {
      if (run)
        await repo.update(
          { id: run.id },
          { status: "failed", detail: { branch, kind: "reconciliation" } },
        );
      throw new ServiceUnavailableException(
        "Không thể lấy bản đối chiếu KiotViet; số dư website chưa bị thay đổi.",
      );
    } finally {
      this.running.delete(branch);
    }
  }
}
