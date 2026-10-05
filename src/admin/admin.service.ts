import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { randomUUID } from "node:crypto";
import type { EntityManager } from "typeorm";
import type { ApiAdminState } from "../../shared/api";
import type { AdminOrder, StaffRole } from "../../shared/types";
import { orderStages } from "../../shared/types";
import { applyApprovedPrice, approvalDecisionBlocker, approvalRejectionBlocker, buildApprovalRequest, latestOrderApprovals } from "../../shared/admin-approval";
import { validateSalesDraft } from "../../shared/admin-sales";
import { appendWarehouseEvent, hasShortage, isPicked, isWarehouseOrder, warehouseBlocker } from "../../shared/admin-warehouse";
import { collectible, reconciliationBlocker, validAccountingDate, validateReceipt } from "../../shared/admin-accounting";
import { orderBlocker } from "../../shared/order-rules";
import { DatabaseService } from "../database/database.service";
import { ApprovalEntity, AuditEntity, CustomerEntity, OrderEntity, ProductEntity, ReceiptEntity, UserEntity } from "../database/entities";
import { businessDate } from "../orders/orders.service";
import { AdminCommandDto, ApprovalDto, DecisionDto, DueDto, NoteDto, PickDto, PublishDto, ReasonDto, ReceiptDto, ReconcileDto, SalesDto, ShortageDto, StatusDto } from "./admin.dto";

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
function effectiveOrder(row: OrderEntity, approvals: ApiAdminState["approvals"]): AdminOrder {
  const order = applyApprovedPrice(row.data, approvals);
  const subtotal = order.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const total = row.checkout ? subtotal + row.checkout.shipping - (row.checkout.discount ? Math.min(100000, Math.round(subtotal * 0.1)) : 0) : order.total;
  const linked = latestOrderApprovals(order, approvals);
  return { ...order, total, revision: row.revision, approvalId: linked.find((item) => item.status !== "Đã duyệt")?.id || linked[0]?.id || order.approvalId };
}

@Injectable()
export class AdminService {
  constructor(private readonly db: DatabaseService) {}
  assertStaff(user: UserEntity) { if (user.role === "b2b") throw new ForbiddenException("Chỉ dành cho nhân viên."); }
  async state(user: UserEntity, manager = this.db.source.manager, redact = true): Promise<ApiAdminState> {
    this.assertStaff(user);
    const approvals = (await manager.getRepository(ApprovalEntity).find()).filter((row) => user.branches.includes(row.branch as never)).map((row) => row.data);
    const rows = (await manager.getRepository(OrderEntity).find({ order: { createdAt: "ASC" } })).filter((row) => user.branches.includes(row.branch as never));
    const orders = rows.map((row) => effectiveOrder(row, approvals));
    const result: ApiAdminState = {
      products: (await manager.getRepository(ProductEntity).find()).map((row) => ({ ...row.data, published: row.published })),
      customers: (await manager.getRepository(CustomerEntity).find()).filter((row) => user.branches.includes(row.branch as never)).map((row) => row.data),
      orders, approvals, warehouse: Object.fromEntries(rows.map((row) => [row.id, row.warehouse])),
      receipts: (await manager.getRepository(ReceiptEntity).find()).filter((row) => user.branches.includes(row.branch as never)).map((row) => row.data),
      paymentDueDates: Object.fromEntries(rows.filter((row) => row.dueDate).map((row) => [row.id, row.dueDate!])), today: businessDate()
    };
    if (redact && user.role === "warehouse") {
      result.orders = result.orders.filter(isWarehouseOrder).map((order) => ({ ...order, total: 0, items: order.items.map((item) => ({ ...item, unitPrice: 0 })) }));
      result.products = result.products.map((product) => ({ ...product, price: 0, oldPrice: undefined, customerPrice: undefined }));
      result.customers = result.customers.map((customer) => ({ ...customer, limit: 0, debt: 0, overdue: 0 }));
      result.approvals = []; result.receipts = []; result.paymentDueDates = {};
      result.warehouse = Object.fromEntries(Object.entries(result.warehouse).filter(([id]) => result.orders.some((order) => order.id === id)));
    }
    return result;
  }
  async command(user: UserEntity, command: AdminCommandDto) {
    this.assertStaff(user);
    if (!user.branches.includes(command.branch) || (user.role !== "admin" && !permission[command.action].includes(user.role as StaffRole))) throw new ForbiddenException("Không có quyền thao tác tại chi nhánh này.");
    return this.db.transaction(async (manager) => {
      const state = await this.state(user, manager, false);
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
          if (previous?.row.checkout) throw new ConflictException("Đơn website cần quy trình báo giá lại khi sửa; chưa hỗ trợ sửa tại màn hình này.");
          const result = validateSalesDraft(draft, command.branch, state.customers, state.products.filter((product) => product.published), previous?.order);
          if (!result.data) throw new BadRequestException(result.error);
          const customer = state.customers.find((item) => item.id === draft.customerId);
          resourceId = previous?.row.id || `BT-${randomUUID().slice(0, 8).toUpperCase()}`;
          const row = previous?.row || orders.create({ id: resourceId, branch: command.branch, customerId: customer?.id || null, guestId: null, idempotencyKey: null, checkout: null, dueDate: null, warehouse: { checks: {}, history: [] } });
          row.data = { ...(previous?.order || { id: resourceId, branch: command.branch, customerId: customer?.id || null, customerName: customer?.name || result.data.details.recipient, date: businessDate(), channel: customer ? "B2B" : "B2C", source: draft.source, status: "Chờ xác nhận" }), ...result.data };
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
            const reserved = state.orders.filter((item) => item.id !== order.id && !["Chờ xác nhận", "Đã hủy", "Hoàn tất"].includes(item.status));
            const stock = state.products.map((product) => ({ ...product, stock: Math.max(0, product.stock - reserved.reduce((sum, item) => sum + (item.items.find((line) => line.productId === product.id)?.quantity || 0), 0)) }));
            fail(orderBlocker(order, state.customers, state.approvals, stock));
            if (order.items.some((item) => !state.products.some((product) => product.id === item.productId && product.published))) throw new ConflictException("Đơn có sản phẩm đang ẩn.");
          } else fail(warehouseBlocker(order, row.warehouse));
          const status = orderStages[orderStages.indexOf(order.status) + 1];
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
            result.snapshot.requestedTotal = subtotal + row.checkout.shipping - (row.checkout.discount ? Math.min(100000, Math.round(subtotal * 0.1)) : 0);
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
          const { status } = input(StatusDto, command.payload);
          const row = await manager.getRepository(CustomerEntity).findOneBy({ id: resourceId, branch: command.branch });
          if (!row) throw new NotFoundException(); row.data.status = status; await manager.getRepository(CustomerEntity).save(row); break;
        }
        case "publish-product": {
          const { published } = input(PublishDto, command.payload);
          const row = await manager.getRepository(ProductEntity).findOneBy({ id: resourceId });
          if (!row) throw new NotFoundException(); row.published = published; await manager.getRepository(ProductEntity).save(row); break;
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
            row.data = { ...row.data, status: "Đã đối chiếu", reconciliation: { ...check, reference: check.reference.trim(), note: check.note.trim(), at: new Date().toISOString() } };
          } else {
            const { reason } = input(ReasonDto, command.payload);
            if (row.data.status === "Đã hủy" || !reason.trim()) throw new ConflictException("Phiếu đã hủy hoặc thiếu lý do.");
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
      return { id: resourceId, state: await this.state(user, manager) };
    });
  }
}
