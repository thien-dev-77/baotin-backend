import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import {
  ApprovalEntity,
  AuditEntity,
  CustomerEntity,
  OrderEntity,
  ProductEntity,
  UserEntity,
} from "../database/entities";
import {
  IntegrationLinkEntity,
  IntegrationOutboxEntity,
  IntegrationRunEntity,
} from "../database/operations.entities";
import { effectiveOrder } from "../admin/admin.service";
import {
  branchMap,
  KiotClient,
  KiotHttpError,
  type RemoteRow,
} from "./kiot-client";
import { branches } from "../types/domain.types";

export const orderMarker = (id: string) => `[BAOTIN:${id}]`;
export const uncertainStatus = (error: unknown) =>
  error instanceof KiotHttpError &&
  [400, 401, 403, 404, 422, 429].includes(error.status)
    ? "failed"
    : "uncertain";
const productSnapshot = (row: RemoteRow) => ({
  id: row.id,
  code: String(row.code || ""),
  name: String(row.fullName || row.name || ""),
  unit: String(row.unit || ""),
  basePrice: Number(row.basePrice),
  isActive: row.isActive !== false,
  allowsSale: row.allowsSale !== false,
});
@Injectable()
export class KiotService {
  constructor(
    private readonly db: DatabaseService,
    private readonly client: KiotClient,
  ) {}
  assert(user: UserEntity, branch: string) {
    if (
      !["admin", "boss"].includes(user.role) ||
      !user.branches.includes(branch as never)
    )
      throw new ForbiddenException();
  }
  async status(user: UserEntity, branch: string) {
    this.assert(user, branch);
    const runs = await this.db.source
      .getRepository(IntegrationRunEntity)
      .createQueryBuilder("run")
      .where("run.detail ->> 'branch' = :branch", { branch })
      .orderBy("run.at", "DESC")
      .take(20)
      .getMany();
    const outbox = await this.db.source
      .getRepository(IntegrationOutboxEntity)
      .find({ where: { branch }, order: { at: "DESC" }, take: 50 });
    return {
      ...this.client.configuration(),
      runs: runs.map(({ id, at, status, detail }) => ({
        id,
        at,
        status,
        counts: detail.counts,
      })),
      links: await this.db.source
        .getRepository(IntegrationLinkEntity)
        .find({ where: [{ kind: "product" }, { kind: "customer" }] })
        .then((rows) =>
          rows.filter(
            (row) => row.kind === "product" || row.snapshot.branch === branch,
          ),
        ),
      outbox: outbox.map(({ payload: _payload, ...row }) => row),
    };
  }
  async preview(user: UserEntity, branch: string) {
    this.assert(user, branch);
    if (!branches.every((branch) => user.branches.includes(branch)))
      throw new ForbiddenException(
        "Danh mục KiotViet dùng chung cần quyền trên tất cả chi nhánh.",
      );
    const run = await this.db.source
      .getRepository(IntegrationRunEntity)
      .save(
        this.db.source
          .getRepository(IntegrationRunEntity)
          .create({ actorId: user.id, status: "running", detail: { branch } }),
      );
    try {
      const products = (await this.client.list("products")).map(
        productSnapshot,
      );
      const customers = (await this.client.list("customers")).map((row) => ({
        id: row.id,
        code: String(row.code || ""),
        name: String(row.name || ""),
      }));
      const remoteBranches = (await this.client.list("branches")).map(
        (row) => ({
          id: row.id,
          name: String(row.branchName || row.name || ""),
        }),
      );
      const counts = {
        products: products.length,
        customers: customers.length,
        branches: remoteBranches.length,
      };
      run.status = "completed";
      run.detail = {
        branch,
        products,
        customers,
        branches: remoteBranches,
        counts,
      };
      await this.db.source.getRepository(IntegrationRunEntity).save(run);
      return {
        id: run.id,
        products,
        customers,
        branches: remoteBranches,
        counts,
      };
    } catch {
      run.status = "failed";
      run.detail = { branch };
      await this.db.source.getRepository(IntegrationRunEntity).save(run);
      throw new ServiceUnavailableException(
        "Không tải được dữ liệu KiotViet. Kiểm tra cấu hình và thử lại; chưa thay đổi dữ liệu website.",
      );
    }
  }
  async link(
    user: UserEntity,
    input: {
      branch: string;
      kind: "product" | "customer";
      localId: string;
      externalId: number;
      runId: string;
    },
  ) {
    this.assert(user, input.branch);
    if (!branches.every((branch) => user.branches.includes(branch)))
      throw new ForbiddenException(
        "Ghép mã từ danh mục KiotViet dùng chung cần quyền tất cả chi nhánh.",
      );
    return this.db.transaction(async (manager) => {
      const run = await manager
        .getRepository(IntegrationRunEntity)
        .findOneBy({ id: input.runId, status: "completed" });
      if (
        !run ||
        run.detail.branch !== input.branch ||
        Date.now() - run.at.getTime() > 30 * 60000
      )
        throw new ConflictException("Lấy bản xem trước mới trước khi ghép mã.");
      const remote = (
        run.detail[
          input.kind === "product" ? "products" : "customers"
        ] as Record<string, unknown>[]
      ).find((row) => row.id === input.externalId);
      if (!remote)
        throw new BadRequestException(
          "Không tìm thấy mã KiotViet trong bản xem trước.",
        );
      if (input.kind === "product") {
        const local = await manager
          .getRepository(ProductEntity)
          .findOneByOrFail({ id: input.localId });
        if (local.data.code !== remote.code || local.data.unit !== remote.unit)
          throw new ConflictException(
            "Mã hàng và đơn vị tính phải trùng khớp tuyệt đối trước khi ghép.",
          );
      } else
        await manager
          .getRepository(CustomerEntity)
          .findOneByOrFail({ id: input.localId, branch: input.branch });
      const repository = manager.getRepository(IntegrationLinkEntity);
      const duplicate = await repository.findOneBy({
        kind: input.kind,
        externalId: String(input.externalId),
      });
      if (duplicate && duplicate.localId !== input.localId)
        throw new ConflictException(
          "Mã KiotViet đã được ghép với đối tượng khác.",
        );
      const id = `${input.kind}:${input.localId}`;
      const previous = await repository.findOneBy({ id });
      if (previous && previous.externalId !== String(input.externalId))
        throw new ConflictException(
          "Mã này đã được ghép; không tự đổi liên kết đã dùng.",
        );
      await repository.save({
        id,
        kind: input.kind,
        localId: input.localId,
        externalId: String(input.externalId),
        snapshot: { ...remote, branch: input.branch },
      });
      await manager.getRepository(AuditEntity).save({
        actorId: user.id,
        action: "kiot-link",
        resourceId: id,
        detail: { externalId: input.externalId },
      });
      return { saved: true };
    });
  }
  async applyPrices(user: UserEntity, branch: string, runId: string) {
    this.assert(user, branch);
    if (
      user.role !== "admin" ||
      !branches.every((branch) => user.branches.includes(branch))
    )
      throw new ForbiddenException(
        "Cần quản trị viên có quyền tất cả chi nhánh để đồng bộ giá bán lẻ dùng chung.",
      );
    return this.db.transaction(async (manager) => {
      const run = await manager
        .getRepository(IntegrationRunEntity)
        .findOneBy({ id: runId, status: "completed" });
      if (
        !run ||
        run.detail.branch !== branch ||
        Date.now() - run.at.getTime() > 30 * 60000
      )
        throw new ConflictException("Bản xem trước hết hạn.");
      const links = await manager
        .getRepository(IntegrationLinkEntity)
        .find({ where: { kind: "product" } });
      let count = 0;
      for (const link of links) {
        const remote = (
          run.detail.products as ReturnType<typeof productSnapshot>[]
        ).find((row) => String(row.id) === link.externalId);
        const product = await manager
          .getRepository(ProductEntity)
          .findOneByOrFail({ id: link.localId });
        if (
          !remote ||
          remote.code !== product.data.code ||
          remote.unit !== product.data.unit ||
          !Number.isSafeInteger(remote.basePrice) ||
          remote.basePrice < 1 ||
          remote.basePrice > 1e12
        )
          throw new ConflictException(
            "Mã/đơn vị/giá thay đổi. Chưa áp dụng bản xem trước.",
          );
        const before = {
          price: product.data.price,
          published: product.published,
        };
        product.data = { ...product.data, price: remote.basePrice };
        if (!remote.isActive || !remote.allowsSale) product.published = false;
        await manager.getRepository(ProductEntity).save(product);
        await manager.getRepository(AuditEntity).save({
          actorId: user.id,
          action: "kiot-price-sync",
          resourceId: product.id,
          detail: {
            before,
            after: { price: remote.basePrice, published: product.published },
            runId,
          },
        });
        count++;
      }
      return { updated: count };
    });
  }
  async exportOrder(
    user: UserEntity,
    branch: string,
    id: string,
    revision: number,
  ) {
    this.assert(user, branch);
    const config = this.client.configuration();
    if (
      !config.enabled ||
      !config.configured ||
      !config.branches[branch as keyof typeof config.branches]
    )
      throw new ServiceUnavailableException(
        "KiotViet chưa được cấu hình cho chi nhánh này.",
      );
    const prepared = await this.db.transaction(async (manager) => {
      const repository = manager.getRepository(IntegrationOutboxEntity);
      const previous = await repository.findOneBy({ orderId: id, branch });
      if (previous?.status === "sent") return previous;
      if (previous)
        throw new ConflictException(
          "Đơn đã có lần gửi. Đối chiếu KiotViet trước; không tự gửi lại.",
        );
      const row = await manager
        .getRepository(OrderEntity)
        .findOneByOrFail({ id, branch });
      if (
        row.revision !== revision ||
        !["Chờ soạn hàng", "Đang soạn", "Sẵn sàng giao"].includes(
          row.data.status,
        )
      )
        throw new ConflictException(
          "Chỉ gửi đơn đã xác nhận, chưa bàn giao, đúng phiên bản.",
        );
      const approvals = (
        await manager.getRepository(ApprovalEntity).find({ where: { branch } })
      ).map((row) => row.data);
      const order = effectiveOrder(row, approvals);
      if (
        order.approvalId &&
        !approvals.some(
          (a) => a.id === order.approvalId && a.status === "Đã duyệt",
        )
      )
        throw new ConflictException("Đơn còn yêu cầu duyệt chưa hoàn tất.");
      const details = [];
      for (const item of order.items) {
        const link = await manager
          .getRepository(IntegrationLinkEntity)
          .findOneBy({ id: `product:${item.productId}` });
        const product = await manager
          .getRepository(ProductEntity)
          .findOneByOrFail({ id: item.productId });
        if (
          !link ||
          link.snapshot.code !== product.data.code ||
          link.snapshot.unit !== product.data.unit
        )
          throw new ConflictException(
            "Ghép tất cả mã hàng và đơn vị KiotViet trước khi gửi.",
          );
        details.push({
          productId: Number(link.externalId),
          productCode: product.data.code,
          productName: product.data.name,
          quantity: item.quantity,
          price: item.unitPrice,
        });
      }
      const customer = row.customerId
        ? await manager
            .getRepository(IntegrationLinkEntity)
            .findOneBy({ id: `customer:${row.customerId}` })
        : null;
      if (row.customerId && !customer)
        throw new ConflictException("Khách B2B chưa ghép mã KiotViet.");
      const payload = {
        purchaseDate: new Date().toISOString(),
        branchId: config.branches[branch as keyof typeof config.branches],
        description: orderMarker(id),
        discount: order.discount || 0,
        method: order.details?.payment === "Chuyển khoản" ? "TRANSFER" : "CASH",
        totalPayment: 0,
        makeInvoice: false,
        orderDetails: details,
        ...(customer ? { customer: { id: Number(customer.externalId) } } : {}),
        ...(order.details?.delivery !== "Nhận tại cửa hàng"
          ? {
              orderDelivery: {
                receiver: order.details?.recipient || order.customerName,
                contactNumber: order.details?.phone || "",
                address: order.details?.address || "",
                price: order.shipping || 0,
              },
            }
          : {}),
      };
      return repository.save({
        orderId: id,
        branch,
        revision,
        status: "sending",
        payload,
        externalId: "",
      });
    });
    if (prepared.status === "sent")
      return { status: "sent", externalId: prepared.externalId };
    try {
      const result = await this.client.request("/orders", {
        method: "POST",
        body: JSON.stringify(prepared.payload),
      });
      if (!Number.isSafeInteger(result.id) || Number(result.id) <= 0)
        throw new Error("Missing external order ID");
      await this.markSent(user, prepared, String(result.id));
      return { status: "sent", externalId: String(result.id) };
    } catch (error) {
      await this.db.source
        .getRepository(IntegrationOutboxEntity)
        .update({ orderId: id }, { status: uncertainStatus(error) });
      throw new ServiceUnavailableException(
        "Chưa xác định kết quả gửi. Đối chiếu KiotViet trước khi xử lý lại; hệ thống không tự gửi trùng.",
      );
    }
  }
  private async markSent(
    user: UserEntity,
    outbox: IntegrationOutboxEntity,
    externalId: string,
  ) {
    await this.db.transaction(async (manager) => {
      await manager
        .getRepository(IntegrationOutboxEntity)
        .update({ orderId: outbox.orderId }, { status: "sent", externalId });
      await manager.getRepository(IntegrationLinkEntity).save({
        id: `order:${outbox.orderId}`,
        kind: "order",
        localId: outbox.orderId,
        externalId,
        snapshot: { branch: outbox.branch },
      });
      await manager.getRepository(AuditEntity).save({
        actorId: user.id,
        action: "kiot-order-sent",
        resourceId: outbox.orderId,
        detail: { externalId },
      });
    });
  }
  async reconcile(user: UserEntity, branch: string, id: string) {
    this.assert(user, branch);
    const outbox = await this.db.source
      .getRepository(IntegrationOutboxEntity)
      .findOneByOrFail({ orderId: id, branch });
    if (outbox.status === "sent")
      return { status: "sent", externalId: outbox.externalId };
    const map = branchMap();
    if (!map[branch as keyof typeof map])
      throw new ServiceUnavailableException(
        "Chi nhánh chưa được ghép KiotViet.",
      );
    const rows = await this.client.list("orders", {
      branchIds: String(map[branch as keyof typeof map]),
      lastModifiedFrom: outbox.at.toISOString(),
    });
    const matches = rows.filter((row) => row.description === orderMarker(id));
    if (matches.length !== 1)
      throw new ConflictException(
        matches.length
          ? "Có nhiều đơn cùng mã tham chiếu. Cần đối chiếu thủ công."
          : "Chưa tìm thấy đơn. Kiểm tra tại KiotViet; không tự gửi lại khi kết quả chưa rõ.",
      );
    await this.markSent(user, outbox, String(matches[0].id));
    return { status: "sent", externalId: String(matches[0].id) };
  }
}
