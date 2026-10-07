import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { randomUUID } from "node:crypto";
import type { EntityManager } from "typeorm";
import type { ApiAdminState } from "../types/api.types";
import type { AdminOrder, StaffRole } from "../types/domain.types";
import { orderStages } from "../types/domain.types";
import { applyApprovedPrice, approvalDecisionBlocker, approvalRejectionBlocker, buildApprovalRequest, latestOrderApprovals } from "./rules/approval.rules";
import { validateSalesDraft } from "./rules/sales.rules";
import { appendWarehouseEvent, hasShortage, isPicked, isWarehouseOrder, warehouseBlocker } from "./rules/warehouse.rules";
import { collectible, reconciliationBlocker, validAccountingDate, validateReceipt } from "./rules/accounting.rules";
import { orderBlocker } from "./rules/order.rules";
import { DatabaseService } from "../database/database.service";
import { assertPublishable } from "../catalog/product.rules";
import { ApprovalEntity, AuditEntity, CategoryEntity, CustomerEntity, OrderEntity, ProductEntity, ReceiptEntity, UserEntity } from "../database/entities";
import { businessDate, shippingCost } from "../orders/orders.service";
import { AdminCommandDto, ApprovalDto, DecisionDto, DueDto, NoteDto, PickDto, PublishDto, ReasonDto, ReceiptDto, ReconcileDto, SalesDto, SalesQuoteDto, ShortageDto, StatusDto } from "./admin.dto";
import { PricePolicyService } from "../catalog/price-policy.service";
import { LedgerService } from "../ledger/ledger.service";
import { NotificationsService } from "../notifications/notifications.service";

const permission: Record<AdminCommandDto["action"], StaffRole[]> = {
  "save-order": ["sales"], "advance-order": ["sales", "warehouse"], "cancel-order": ["sales"],
  "create-approval": ["sales"], "decide-approval": ["boss"], "customer-status": ["sales", "boss"],
  "publish-product": ["sales", "boss"], "pick-item": ["warehouse", "sales"], "report-shortage": ["warehouse", "sales"],
  "resolve-shortage": ["warehouse", "sales"], "create-receipt": ["accountant"], "reconcile-receipt": ["accountant"],
  "void-receipt": ["accountant"], "due-date": ["accountant"]
};
function input<T extends object>(type: new () => T, value: Record<string, unknown>): T {
  const object = plainToInstance(type, value);
  if (validateSync(object, { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true }).length) throw new BadRequestException("Dữ liệu thao tác không hợp lệ.");
  return object;
}
function fail(message: string) { if (message) throw new ConflictException(message); }
export function effectiveOrder(row: OrderEntity, approvals: ApiAdminState["approvals"]): AdminOrder {
  const order = applyApprovedPrice(row.data, approvals);
  const subtotal = order.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const total = row.checkout ? subtotal + row.checkout.shipping - (row.checkout.coupon === "BAOTIN10" || row.checkout.discount ? Math.min(100000, Math.round(subtotal * 0.1)) : 0) : order.total;
  const linked = latestOrderApprovals(order, approvals);
  return { ...order, total, website: !!row.checkout, shipping: row.checkout?.shipping || 0, discount: row.checkout ? subtotal + row.checkout.shipping - total : 0, revision: row.revision, approvalId: linked.find((item) => item.status !== "Đã duyệt")?.id || linked[0]?.id || order.approvalId };
}

@Injectable()
export class AdminService {
  constructor(private readonly db: DatabaseService, private readonly pricing: PricePolicyService, private readonly ledger: LedgerService, private readonly notifications: NotificationsService) {}
  assertStaff(user: UserEntity) { if (user.role === "b2b") throw new ForbiddenException("Chỉ dành cho nhân viên."); }
  async state(user: UserEntity, manager = this.db.source.manager, redact = true): Promise<ApiAdminState> {
    this.assertStaff(user);
    const approvals = (await manager.getRepository(ApprovalEntity).find()).filter((row) => user.branches.includes(row.branch as never)).map((row) => row.data);
    const rows = (await manager.getRepository(OrderEntity).find({ order: { createdAt: "ASC" } })).filter((row) => user.branches.includes(row.branch as never));
    const orders = rows.map((row) => effectiveOrder(row, approvals));
    const stockByBranch: Record<string, Record<string, number>> = {};
    const products = (await manager.getRepository(ProductEntity).find()).map(row => ({ ...row.data, published: row.published, revision: row.revision }));
    for (const branch of user.branches) stockByBranch[branch] = Object.fromEntries((await this.ledger.stock(products, branch, manager)).map(product => [product.id, product.stock]));
    const result: ApiAdminState = {
      products, stockByBranch, categories: (await manager.getRepository(CategoryEntity).find()).map(row => row.data),
      customers: await this.ledger.customers((await manager.getRepository(CustomerEntity).find()).filter(row => user.branches.includes(row.branch as never)).map(row => ({ ...row.data, revision: row.revision })), manager),
      orders, approvals, warehouse: Object.fromEntries(rows.map((row) => [row.id, row.warehouse])),
      receipts: (await manager.getRepository(ReceiptEntity).find()).filter((row) => user.branches.includes(row.branch as never)).map((row) => row.data),
      paymentDueDates: Object.fromEntries(rows.filter((row) => row.dueDate).map((row) => [row.id, row.dueDate!])), today: businessDate()
    };
    if (redact && user.role === "warehouse") {
      result.orders = result.orders.filter(isWarehouseOrder).map((order) => ({ ...order, total: 0, items: order.items.map((item) => ({ ...item, unitPrice: 0 })) }));
      result.products = result.products.map((product) => ({ ...product, price: 0, oldPrice: undefined, customerPrice: undefined }));
      result.customers = result.customers.map((customer) => ({ id: customer.id, name: customer.name, contact: customer.contact, phone: customer.phone, group: customer.group, branch: customer.branch, status: customer.status, limit: 0, debt: 0, overdue: 0, creditReserved: 0 }));
      result.approvals = []; result.receipts = []; result.paymentDueDates = {};
      result.warehouse = Object.fromEntries(Object.entries(result.warehouse).filter(([id]) => result.orders.some((order) => order.id === id)));
    }
    return result;
  }
  async salesQuote(user: UserEntity, input: SalesQuoteDto, manager = this.db.source.manager) {
    if (!["admin", "boss", "sales"].includes(user.role) || !user.branches.includes(input.branch)) throw new ForbiddenException();
    const previous = input.id ? await manager.getRepository(OrderEntity).findOneBy({ id: input.id, branch: input.branch }) : null;
    if (input.id && (!previous || previous.data.status !== "Chờ xác nhận")) throw new ConflictException("Đơn không còn chờ xác nhận.");
    if (previous && (previous.customerId !== (input.customerId || null) || previous.data.source !== input.source)) throw new BadRequestException("Không được đổi khách hoặc nguồn đơn.");
    const customers = (await manager.getRepository(CustomerEntity).find({ where: { branch: input.branch } })).map(row => row.data);
    const customer = customers.find(row => row.id === input.customerId);
    const products = await this.pricing.personalize(await this.ledger.stock((await manager.getRepository(ProductEntity).find({ where: { published: true } })).map(row => row.data), input.branch, manager), customer, manager);
    // Website edits requote every line; Sales-only edits preserve their original price snapshots.
    const base = previous?.checkout ? { ...previous.data, items: [] } : previous?.data;
    const result = validateSalesDraft(input, input.branch, customers, products, base);
    if (!result.data) throw new BadRequestException(result.error);
    const shipping = previous?.checkout ? shippingCost(result.data.details.delivery) : 0;
    const discount = previous?.checkout?.coupon === "BAOTIN10" || previous?.checkout?.discount ? Math.min(100000, Math.round(result.data.total * 0.1)) : 0;
    if (!Number.isSafeInteger(result.data.total + shipping - discount) || result.data.total < 1) throw new BadRequestException("Giá trị đơn vượt giới hạn. Giảm số lượng hoặc liên hệ Sales.");
    return { ...result.data, subtotal: result.data.total, shipping, discount, total: result.data.total + shipping - discount };
  }
  async command(user: UserEntity, command: AdminCommandDto) {
    this.assertStaff(user);
    if (!user.branches.includes(command.branch) || (user.role !== "admin" && !permission[command.action].includes(user.role as StaffRole))) throw new ForbiddenException("Không có quyền thao tác tại chi nhánh này.");
    return this.db.transaction(async (manager) => {
      const state = await this.state(user, manager, false);
      state.products = state.products.map(product => ({ ...product, stock: state.stockByBranch?.[command.branch]?.[product.id] ?? 0 }));
      const orders = manager.getRepository(OrderEntity);
      let resourceId = command.id || "";
      const orderFor = async (id: string) => {
        const row = await orders.findOneBy({ id, branch: command.branch });
        if (!row) throw new NotFoundException("Không tìm thấy đơn tại chi nhánh.");
        if (user.role === "warehouse" && !isWarehouseOrder(row.data)) throw new ForbiddenException("Kho chỉ thao tác đơn đã xác nhận, chưa bàn giao.");
        if (command.expectedRevision !== row.revision) throw new ConflictException("Đơn đã thay đổi. Làm mới dữ liệu và thử lại.");
        return { row, order: effectiveOrder(row, state.approvals) };
      };
      const history = (row: OrderEntity, label: string, note?: string) => { row.warehouse = appendWarehouseEvent(row.warehouse, label, `${user.name}${note ? ` · ${note}` : ""}`); };
      switch (command.action) {
        case "save-order": {
          const draft = input(SalesDto, command.payload);
          const previous = command.id ? await orderFor(command.id) : undefined;
          if (previous && (previous.order.status !== "Chờ xác nhận" || previous.order.approvalId || previous.order.customerId !== (draft.customerId || null) || previous.order.source !== draft.source || !draft.reason?.trim())) throw new ConflictException("Chỉ sửa đơn pending chưa có yêu cầu duyệt, cần giữ nguồn/khách và nhập lý do.");
          const data = await this.salesQuote(user, { ...draft, branch: command.branch, id: command.id }, manager);
          if ((previous?.row.checkout || draft.expectedTotal !== undefined) && draft.expectedTotal !== data.total) throw new ConflictException("Giá đã thay đổi. Cập nhật báo giá trước khi lưu.");
          const customer = state.customers.find((item) => item.id === draft.customerId);
          resourceId = previous?.row.id || `BT-${randomUUID().slice(0, 8).toUpperCase()}`;
          const row = previous?.row || orders.create({ id: resourceId, branch: command.branch, customerId: customer?.id || null, guestId: null, idempotencyKey: null, checkout: null, dueDate: null, warehouse: { checks: {}, history: [] } });
          row.data = { ...(previous?.order || { id: resourceId, branch: command.branch, customerId: customer?.id || null, customerName: customer?.name || data.details.recipient, date: businessDate(), channel: customer ? "B2B" : "B2C", source: draft.source, status: "Chờ xác nhận" }), items: data.items, details: data.details, credit: data.credit, total: data.total };
          if (row.checkout) row.checkout = { ...row.checkout, items: data.items, subtotal: data.subtotal, shipping: data.shipping, discount: data.discount, total: data.total, customer: { ...row.checkout.customer, name: data.details.recipient, phone: data.details.phone, address: data.details.address, city: "", district: "", ward: "" }, delivery: data.details.delivery, payment: data.details.payment, note: data.details.note };
          history(row, previous ? "Đã sửa đơn" : "Inside Sales tạo đơn", draft.reason || draft.source);
          await orders.save(row);
          break;
        }
        case "advance-order": {
          if (Object.keys(command.payload).length) throw new BadRequestException("Không nhận status từ client.");
          const { row, order } = await orderFor(resourceId);
          if (["Hoàn tất", "Đã hủy"].includes(order.status)) throw new ConflictException("Đơn đã kết thúc.");
          if (user.role === "warehouse" && !isWarehouseOrder(order)) throw new ForbiddenException("Kho chỉ thao tác đơn đã xác nhận, chưa bàn giao.");
          if (order.status === "Chờ xác nhận") {
            if (!order.details) throw new ConflictException("Bổ sung thông tin giao hàng/thanh toán trước khi xác nhận.");
            fail(orderBlocker(order, state.customers, state.approvals, state.products));
            if (order.items.some((item) => !state.products.some((product) => product.id === item.productId && product.published))) throw new ConflictException("Đơn có sản phẩm đang ẩn.");
          } else fail(warehouseBlocker(order, row.warehouse));
          const status = orderStages[orderStages.indexOf(order.status) + 1];
          if (status === "Đang giao") {
            if (order.credit && order.customerId) {
              const customer = state.customers.find(customer => customer.id === order.customerId)!;
              if (customer.status !== "Đang hoạt động") throw new ConflictException("Tài khoản B2B đã tạm ngưng; cần Sales kiểm tra trước khi bàn giao.");
              if (!row.dueDate) { const due = new Date(`${businessDate()}T00:00:00Z`); due.setUTCDate(due.getUTCDate() + (customer.termsDays ?? 30)); row.dueDate = due.toISOString().slice(0, 10); }
            }
            await this.ledger.handoff(manager, order, user.id);
          }
          row.data = { ...order, status };
          if (order.status === "Chờ soạn hàng") row.warehouse.checks = {};
          history(row, status);
          await orders.save(row);
          break;
        }
        case "cancel-order": {
          const { reason } = input(ReasonDto, command.payload);
          const { row, order } = await orderFor(resourceId);
          if (!reason.trim() || !["Chờ xác nhận", "Chờ soạn hàng", "Đang soạn", "Sẵn sàng giao"].includes(order.status) || state.receipts.some((item) => item.orderId === resourceId && item.status !== "Đã hủy")) throw new ConflictException("Đơn không thể hủy ở trạng thái này hoặc còn phiếu thu hiệu lực.");
          row.data = { ...order, status: "Đã hủy", cancelReason: reason.trim() }; history(row, "Đã hủy", reason.trim()); await orders.save(row); break;
        }
        case "create-approval": {
          const draft = input(ApprovalDto, command.payload);
          const { row, order } = await orderFor(resourceId);
          const customer = state.customers.find((item) => item.id === order.customerId);
          if (!customer) throw new BadRequestException("Chọn đơn B2B.");
          const result = buildApprovalRequest(order, customer, draft, state.approvals);
          if (!result.snapshot) throw new BadRequestException(result.error);
          if (row.checkout && result.snapshot.kind === "price") {
            const subtotal = result.snapshot.lines.reduce((sum, item) => sum + item.quantity * item.requestedPrice, 0);
            result.snapshot.requestedTotal = subtotal + row.checkout.shipping - (row.checkout.coupon === "BAOTIN10" || row.checkout.discount ? Math.min(100000, Math.round(subtotal * 0.1)) : 0);
          }
          resourceId = `YC-${randomUUID().slice(0, 8).toUpperCase()}`;
          await manager.getRepository(ApprovalEntity).save({ id: resourceId, branch: command.branch, data: { id: resourceId, orderId: order.id, customerId: customer.id, branch: command.branch, type: draft.type, reason: draft.reason.trim(), requestedBy: user.name, createdAt: new Date().toISOString(), status: "Chờ duyệt", snapshot: result.snapshot } });
          history(row, "Gửi yêu cầu duyệt", resourceId); await orders.save(row); break;
        }
        case "decide-approval": {
          const decision = input(DecisionDto, command.payload);
          const approval = await manager.getRepository(ApprovalEntity).findOneBy({ id: resourceId, branch: command.branch });
          if (!approval || approval.data.status !== "Chờ duyệt" || !decision.reason.trim()) throw new ConflictException("Yêu cầu không còn chờ duyệt hoặc thiếu ý kiến.");
          const { row, order } = await orderFor(approval.data.orderId);
          const customer = state.customers.find((item) => item.id === order.customerId);
          fail(decision.approved ? approvalDecisionBlocker(approval.data, order, customer, state.approvals) : approvalRejectionBlocker(approval.data, order, state.approvals));
          approval.data = { ...approval.data, status: decision.approved ? "Đã duyệt" : "Từ chối", decisionReason: decision.reason.trim() };
          await manager.getRepository(ApprovalEntity).save(approval); history(row, approval.data.status, `${resourceId}: ${decision.reason.trim()}`); await orders.save(row); break;
        }
        case "customer-status": {
          const { status, revision } = input(StatusDto, command.payload);
          const row = await manager.getRepository(CustomerEntity).findOneBy({ id: resourceId, branch: command.branch });
          if (!row) throw new NotFoundException();
          if (revision !== undefined && row.revision !== revision) throw new ConflictException("Hồ sơ khách đã thay đổi. Làm mới và thử lại.");
          row.data.status = status; await manager.getRepository(CustomerEntity).save(row); break;
        }
        case "publish-product": {
          const { published } = input(PublishDto, command.payload);
          const row = await manager.getRepository(ProductEntity).findOneBy({ id: resourceId });
          if (!row) throw new NotFoundException();
          if (published) assertPublishable(row.data);
          row.published = published; await manager.getRepository(ProductEntity).save(row); break;
        }
        case "pick-item": case "report-shortage": case "resolve-shortage": {
          const { row, order } = await orderFor(resourceId);
          if (!isWarehouseOrder(order)) throw new ConflictException("Đơn không ở hàng đợi kho.");
          if (command.action === "pick-item") {
            const picked = input(PickDto, command.payload);
            if ((order.status !== "Đang soạn" && !hasShortage(row.warehouse)) || !order.items.some((item) => item.productId === picked.productId)) throw new ConflictException("Không thể kiểm mã hàng này.");
            row.warehouse.checks[picked.productId] = picked.picked; history(row, picked.picked ? "Đã kiểm đủ hàng" : "Bỏ xác nhận đủ hàng", picked.productId);
          } else if (command.action === "report-shortage") {
            const issue = input(ShortageDto, command.payload); const line = order.items.find((item) => item.productId === issue.productId);
            if (!line || issue.quantity > line.quantity || !issue.note.trim() || hasShortage(row.warehouse)) throw new ConflictException("Báo thiếu không hợp lệ hoặc đã có báo thiếu đang mở.");
            row.warehouse.issue = { ...issue, note: issue.note.trim(), reportedAt: new Date().toISOString() }; row.warehouse.checks[issue.productId] = false; history(row, "Báo thiếu hàng", issue.note);
          } else {
            const { note } = input(NoteDto, command.payload); const issue = row.warehouse.issue;
            if (!issue || issue.resolvedAt || !note.trim() || !isPicked(order, row.warehouse, issue.productId)) throw new ConflictException("Kiểm đủ mã thiếu trước khi xử lý.");
            row.warehouse.issue = { ...issue, resolvedAt: new Date().toISOString(), resolution: note.trim() }; history(row, "Đã xử lý thiếu hàng", note);
          }
          await orders.save(row); break;
        }
        case "create-receipt": {
          const draft = input(ReceiptDto, command.payload);
          const order = state.orders.find((item) => item.id === draft.orderId && item.branch === command.branch);
          fail(validateReceipt(draft, order, state.receipts, businessDate()));
          resourceId = `PT-${randomUUID().slice(0, 8).toUpperCase()}`;
          await manager.getRepository(ReceiptEntity).save({ id: resourceId, branch: command.branch, data: { ...draft, reference: draft.reference.trim(), note: draft.note.trim(), id: resourceId, branch: command.branch, status: "Chờ đối chiếu", createdAt: new Date().toISOString() } }); break;
        }
        case "reconcile-receipt": case "void-receipt": {
          const row = await manager.getRepository(ReceiptEntity).findOneBy({ id: resourceId, branch: command.branch });
          if (!row) throw new NotFoundException();
          if (command.action === "reconcile-receipt") {
            const check = input(ReconcileDto, command.payload);
            const order = state.orders.find((item) => item.id === row.data.orderId);
            if (!order || !collectible(order)) throw new ConflictException("Đơn không hợp lệ để thu tiền.");
            fail(reconciliationBlocker(row.data, check.amount, check.reference, check.note, state.receipts));
            await this.ledger.receipt(manager, order, row.id, row.data.amount, user.id);
            row.data = { ...row.data, status: "Đã đối chiếu", reconciliation: { ...check, reference: check.reference.trim(), note: check.note.trim(), at: new Date().toISOString() } };
          } else {
            const { reason } = input(ReasonDto, command.payload);
            if (row.data.status === "Đã hủy" || !reason.trim()) throw new ConflictException("Phiếu đã hủy hoặc thiếu lý do.");
            const order = state.orders.find(item => item.id === row.data.orderId);
            if (order && row.data.status === "Đã đối chiếu") await this.ledger.receipt(manager, order, row.id, row.data.amount, user.id, true);
            row.data = { ...row.data, status: "Đã hủy", cancellation: { reason: reason.trim(), at: new Date().toISOString() } };
          }
          await manager.getRepository(ReceiptEntity).save(row); break;
        }
        case "due-date": {
          const { date } = input(DueDto, command.payload); const { row, order } = await orderFor(resourceId);
          if (!order.credit || !collectible(order) || !validAccountingDate(date) || date < order.date) throw new BadRequestException("Hạn thanh toán không hợp lệ.");
          row.dueDate = date; history(row, "Cập nhật hạn thanh toán", date); await orders.save(row); break;
        }
      }
      await manager.getRepository(AuditEntity).save({ actorId: user.id, action: command.action, resourceId, detail: { branch: command.branch, ...command.payload } });
      if (["save-order", "advance-order", "cancel-order", "report-shortage", "due-date"].includes(command.action)) {
        const row = await orders.findOneByOrFail({ id: resourceId });
        await this.notifications.order(manager, row.branch, row.id, row.customerId, command.action === "report-shortage" ? "Kho báo thiếu hàng" : command.action === "due-date" ? `Hạn thanh toán: ${row.dueDate}` : row.data.status, row.revision, command.action === "due-date" ? 1 : 0);
      }
      if (["create-approval", "decide-approval"].includes(command.action)) {
        const row = await manager.getRepository(ApprovalEntity).findOneByOrFail({ id: resourceId });
        const event = { key: `approval:${row.id}:${row.data.status}`, type: "approval", branch: row.branch, title: `${row.data.type} · ${row.data.orderId}`, message: `${row.data.status}${row.data.decisionReason ? `: ${row.data.decisionReason}` : ""}` };
        await this.notifications.emit(manager, { ...event, href: "/admin/approvals", roles: ["admin", "boss", "sales"] });
        await this.notifications.emit(manager, { ...event, customerId: row.data.customerId, href: `/account/orders/${row.data.orderId}` });
      }
      if (command.action === "customer-status") {
        const row = await manager.getRepository(CustomerEntity).findOneByOrFail({ id: resourceId });
        await this.notifications.emit(manager, { key: `customer:${row.id}:${randomUUID()}`, type: "account", branch: row.branch, customerId: row.id, title: "Tài khoản B2B", message: row.data.status, href: "/account" });
      }
      if (["reconcile-receipt", "void-receipt"].includes(command.action)) {
        const receipt = await manager.getRepository(ReceiptEntity).findOneByOrFail({ id: resourceId });
        const row = await orders.findOneByOrFail({ id: receipt.data.orderId });
        if (row.customerId) await this.notifications.emit(manager, { key: `receipt:${resourceId}:${receipt.data.status}`, type: "payment", branch: row.branch, customerId: row.customerId, preference: 1, title: `Thanh toán đơn ${row.id}`, message: `${receipt.data.status} · ${receipt.data.amount.toLocaleString("vi-VN")} đ`, href: "/account/credit" });
      }
      return { id: resourceId, state: await this.state(user, manager) };
    });
  }
}
