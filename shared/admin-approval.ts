import type { AdminApproval, AdminCustomer, AdminOrder } from "./types";

export const approvalTypes = ["Giá đặc biệt", "Công nợ"] as const;
export type ApprovalType = typeof approvalTypes[number];
export type ApprovalPriceLine = AdminOrder["items"][number] & { requestedPrice: number };
export type ApprovalSnapshot =
  | { kind: "price"; lines: ApprovalPriceLine[]; total: number; requestedTotal: number }
  | { kind: "credit"; items: { productId: string; quantity: number }[]; amount: number; debt: number; limit: number; overdue: number };
export type ApprovalDraft = { type: ApprovalType; reason: string; prices: Record<string, number> };

export function latestOrderApprovals(order: AdminOrder, approvals: AdminApproval[]) {
  const seen = new Set<ApprovalType>();
  return approvals.filter((item) => item.orderId === order.id).reverse().filter((item) => {
    if (seen.has(item.type)) return false;
    seen.add(item.type);
    return true;
  });
}

function sameQuantities(items: { productId: string; quantity: number }[], order: AdminOrder) {
  return items.length === order.items.length && new Set(items.map((item) => item?.productId)).size === items.length && items.every((item) => order.items.some((line) => line.productId === item?.productId && line.quantity === item.quantity));
}

export function approvalMatchesOrder(approval: AdminApproval, order: AdminOrder) {
  if (approval.customerId !== order.customerId || approval.branch !== order.branch) return false;
  const snapshot = approval.snapshot;
  return !snapshot || sameQuantities(snapshot.kind === "price" ? snapshot.lines : snapshot.items, order);
}

export function applyApprovedPrice(order: AdminOrder, approvals: AdminApproval[]): AdminOrder {
  const approval = latestOrderApprovals(order, approvals).find((item) => item.type === "Giá đặc biệt");
  const snapshot = approval?.snapshot;
  if (approval?.status !== "Đã duyệt" || snapshot?.kind !== "price" || !approvalMatchesOrder(approval, order) || snapshot.lines.some((line) => line.unitPrice !== order.items.find((item) => item.productId === line.productId)?.unitPrice)) return order;
  const items = order.items.map((line) => ({ ...line, unitPrice: snapshot.lines.find((item) => item.productId === line.productId)!.requestedPrice }));
  return { ...order, items, total: items.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0) };
}

export function approvalRequestBlocker(order: AdminOrder | undefined, customer: AdminCustomer | undefined, type: ApprovalType, approvals: AdminApproval[]) {
  if (!order || order.status !== "Chờ xác nhận" || !order.customerId) return "Chọn đơn B2B đang chờ xác nhận.";
  if (!customer || customer.status !== "Đang hoạt động") return "Khách B2B chưa được kích hoạt hoặc đang tạm ngưng.";
  const existing = latestOrderApprovals(order, approvals).find((item) => item.type === type);
  if (existing && existing.status !== "Từ chối") return existing.status === "Chờ duyệt" ? "Đã có yêu cầu cùng loại đang chờ duyệt." : "Đơn đã được duyệt ngoại lệ cùng loại.";
  if (type === "Công nợ" && (!order.credit || customer.limit <= 0)) return "Chỉ xin ngoại lệ cho đơn công nợ B2B đã có hạn mức.";
  if (type === "Công nợ" && !customer.overdue && customer.debt + order.total <= customer.limit) return "Đơn đang trong hạn mức, không cần xin ngoại lệ công nợ.";
  return "";
}

function priceSnapshot(order: AdminOrder, prices: Record<string, number>): ApprovalSnapshot | null {
  const lines = order.items.map((item) => ({ ...item, requestedPrice: prices[item.productId] }));
  if (lines.some((item) => !Number.isSafeInteger(item.requestedPrice) || item.requestedPrice < 1 || item.requestedPrice > item.unitPrice) || !lines.some((item) => item.requestedPrice < item.unitPrice)) return null;
  return { kind: "price", lines, total: order.total, requestedTotal: lines.reduce((sum, item) => sum + item.quantity * item.requestedPrice, 0) };
}

export function buildApprovalRequest(order: AdminOrder, customer: AdminCustomer, draft: ApprovalDraft, approvals: AdminApproval[]): { snapshot?: ApprovalSnapshot; error?: string } {
  if (!approvalTypes.includes(draft.type)) return { error: "Chọn loại yêu cầu hợp lệ." };
  const blocker = approvalRequestBlocker(order, customer, draft.type, approvals);
  if (blocker) return { error: blocker };
  if (!draft.reason.trim() || draft.reason.trim().length > 500) return { error: "Nhập lý do đề nghị (tối đa 500 ký tự)." };
  if (draft.type === "Giá đặc biệt") {
    const snapshot = priceSnapshot(order, draft.prices);
    return snapshot ? { snapshot } : { error: "Giá đề nghị phải là số nguyên dương, không vượt giá hiện tại và có ít nhất một SKU giảm giá." };
  }
  return { snapshot: { kind: "credit", items: order.items.map(({ productId, quantity }) => ({ productId, quantity })), amount: order.total, debt: customer.debt, limit: customer.limit, overdue: customer.overdue } };
}

export function approvalDecisionBlocker(approval: AdminApproval, order: AdminOrder | undefined, customer: AdminCustomer | undefined, approvals: AdminApproval[]) {
  if (!order || order.status !== "Chờ xác nhận") return "Đơn không còn chờ xác nhận, không thể duyệt yêu cầu.";
  if (!customer || customer.status !== "Đang hoạt động") return "Khách B2B chưa được kích hoạt hoặc đang tạm ngưng.";
  if (latestOrderApprovals(order, approvals).find((item) => item.type === approval.type)?.id !== approval.id) return "Yêu cầu đã được thay bằng đề nghị mới.";
  if (!approvalMatchesOrder(approval, order)) return "Nội dung đơn không khớp yêu cầu, cần gửi lại đề nghị.";
  if (approval.snapshot?.kind === "credit" && order.total > approval.snapshot.amount) return "Giá trị đơn vượt phạm vi công nợ đề nghị.";
  return "";
}

export function approvalRejectionBlocker(approval: AdminApproval, order: AdminOrder | undefined, approvals: AdminApproval[]) {
  if (!order) return "Không tìm thấy đơn hàng của yêu cầu.";
  if (latestOrderApprovals(order, approvals).find((item) => item.type === approval.type)?.id !== approval.id) return "Yêu cầu đã được thay bằng đề nghị mới.";
  return "";
}

export function readApprovalRequest(value: unknown, orders: AdminOrder[], customers: AdminCustomer[]): AdminApproval | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as AdminApproval;
  const order = orders.find((item) => item.id === raw.orderId);
  const customer = customers.find((item) => item.id === raw.customerId);
  if (typeof raw.id !== "string" || !/^YCM\d{4}$/.test(raw.id) || !order || !customer || raw.customerId !== order.customerId || raw.branch !== order.branch || customer.branch !== order.branch || !approvalTypes.includes(raw.type) || typeof raw.reason !== "string" || !raw.reason.trim() || raw.reason.trim().length > 500 || typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt))) return null;
  const data = raw.snapshot;
  let snapshot: ApprovalSnapshot | null = null;
  if (raw.type === "Giá đặc biệt" && data?.kind === "price" && Array.isArray(data.lines) && sameQuantities(data.lines, order) && data.lines.every((line) => line.unitPrice === order.items.find((item) => item.productId === line.productId)?.unitPrice)) {
    snapshot = priceSnapshot(order, Object.fromEntries(data.lines.map((line) => [line.productId, line.requestedPrice])));
  }
  if (raw.type === "Công nợ" && data?.kind === "credit" && order.credit && customer.limit > 0 && Array.isArray(data.items) && sameQuantities(data.items, order) && Number.isSafeInteger(data.amount) && data.amount > 0 && data.amount <= order.total && data.debt === customer.debt && data.limit === customer.limit && data.overdue === customer.overdue) {
    snapshot = { kind: "credit", items: order.items.map(({ productId, quantity }) => ({ productId, quantity })), amount: data.amount, debt: customer.debt, limit: customer.limit, overdue: customer.overdue };
  }
  if (!snapshot) return null;
  return { id: raw.id, orderId: order.id, customerId: customer.id, branch: order.branch, type: raw.type, requestedBy: `Inside Sales ${order.branch}`, reason: raw.reason.trim(), status: "Chờ duyệt", createdAt: raw.createdAt, snapshot };
}
