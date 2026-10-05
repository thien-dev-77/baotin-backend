import type { AdminOrder, Branch } from "./types";

export const receiptMethods = ["Chuyển khoản", "Tiền mặt"] as const;
export type ReceiptMethod = typeof receiptMethods[number];
export type ReceiptDraft = { orderId: string; amount: number; method: ReceiptMethod; date: string; reference: string; note: string };
export type Receipt = ReceiptDraft & {
  id: string; branch: Branch; status: "Chờ đối chiếu" | "Đã đối chiếu" | "Đã hủy"; createdAt: string;
  reconciliation?: { amount: number; reference: string; note: string; at: string };
  cancellation?: { reason: string; at: string };
};
export function validAccountingDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function collectible(order: AdminOrder) { return !["Chờ xác nhận", "Đã hủy"].includes(order.status); }
export function paymentSummary(order: AdminOrder, receipts: Receipt[]) {
  const active = receipts.filter((item) => item.orderId === order.id && item.status !== "Đã hủy");
  const paid = active.filter((item) => item.status === "Đã đối chiếu").reduce((sum, item) => sum + item.amount, 0);
  const pending = active.filter((item) => item.status === "Chờ đối chiếu").reduce((sum, item) => sum + item.amount, 0);
  return { paid, pending, remaining: Math.max(0, order.total - paid), available: Math.max(0, order.total - paid - pending) };
}
export function validateReceipt(draft: ReceiptDraft, order: AdminOrder | undefined, receipts: Receipt[], today: string) {
  if (!order || !collectible(order)) return "Chọn đơn đã xác nhận, chưa hủy.";
  if (!Number.isSafeInteger(draft.amount) || draft.amount <= 0 || draft.amount > paymentSummary(order, receipts).available) return "Số tiền phải là số nguyên dương, không vượt khoản còn có thể lập phiếu.";
  if (!receiptMethods.includes(draft.method)) return "Chọn hình thức thu tiền.";
  if (!validAccountingDate(draft.date) || draft.date < order.date || draft.date > today) return "Ngày thu phải từ ngày tạo đơn đến ngày dữ liệu mẫu.";
  if (!draft.reference.trim() || draft.reference.trim().length > 100) return "Nhập mã giao dịch hoặc chứng từ thu, tối đa 100 ký tự.";
  if (draft.note.trim().length > 500) return "Ghi chú tối đa 500 ký tự.";
  if (receipts.some((item) => item.branch === order.branch && item.method === draft.method && item.status !== "Đã hủy" && item.reference.toLowerCase() === draft.reference.trim().toLowerCase())) return "Mã giao dịch hoặc chứng từ đã có phiếu thu tại chi nhánh.";
  return "";
}
export function reconciliationBlocker(receipt: Receipt, amount: number, reference: string, note: string, receipts: Receipt[]) {
  if (receipt.status !== "Chờ đối chiếu") return "Phiếu không còn chờ đối chiếu.";
  if (!Number.isSafeInteger(amount) || amount !== receipt.amount) return "Số tiền thực nhận không khớp phiếu thu. Kiểm tra chứng từ trước khi xác nhận.";
  if (!reference.trim() || reference.trim().length > 100 || !note.trim() || note.trim().length > 500) return "Nhập mã đối chiếu và kết quả kiểm tra hợp lệ.";
  if (receipts.some((item) => item.id !== receipt.id && item.branch === receipt.branch && item.method === receipt.method && item.status !== "Đã hủy" && item.reconciliation?.reference.toLowerCase() === reference.trim().toLowerCase())) return "Mã đối chiếu đã được sử dụng tại chi nhánh.";
  return "";
}

// Rehydrate a bounded ledger against trusted order projections, not stored totals.
export function readReceipts(raw: unknown, orders: AdminOrder[], today: string): Receipt[] {
  if (!Array.isArray(raw)) return [];
  const result: Receipt[] = [];
  for (const value of raw.slice(0, 500)) {
    if (!value || typeof value !== "object" || !/^PTM\d{4}$/.test(value.id) || result.some((item) => item.id === value.id)) continue;
    const order = orders.find((item) => item.id === value.orderId && item.branch === value.branch);
    if (!order || typeof value.reference !== "string" || typeof value.note !== "string" || typeof value.date !== "string" || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) continue;
    if (!["Chờ đối chiếu", "Đã đối chiếu", "Đã hủy"].includes(value.status)) continue;
    const draft: ReceiptDraft = { orderId: order.id, amount: value.amount, method: value.method, date: value.date, reference: value.reference.trim(), note: value.note.trim() };
    if (validateReceipt(draft, value.status === "Đã hủy" ? { ...order, status: "Chờ soạn hàng" } : order, value.status === "Đã hủy" ? [] : result, today)) continue;
    const receipt: Receipt = { ...draft, id: value.id, branch: order.branch, status: value.status, createdAt: value.createdAt };
    if (value.reconciliation !== undefined) {
      const check = value.reconciliation;
      if (!check || typeof check.reference !== "string" || typeof check.note !== "string" || typeof check.at !== "string" || !Number.isFinite(Date.parse(check.at)) || reconciliationBlocker({ ...receipt, status: "Chờ đối chiếu" }, check.amount, check.reference, check.note, value.status === "Đã hủy" ? [] : result)) continue;
      receipt.reconciliation = { amount: check.amount, reference: check.reference.trim(), note: check.note.trim(), at: check.at };
    }
    if (receipt.status === "Đã đối chiếu" && !receipt.reconciliation) continue;
    if (receipt.status === "Chờ đối chiếu" && receipt.reconciliation) continue;
    if (receipt.status === "Đã hủy") {
      const cancellation = value.cancellation;
      if (!cancellation || typeof cancellation.reason !== "string" || !cancellation.reason.trim() || cancellation.reason.trim().length > 500 || typeof cancellation.at !== "string" || !Number.isFinite(Date.parse(cancellation.at))) continue;
      receipt.cancellation = { reason: cancellation.reason.trim(), at: cancellation.at };
    }
    result.push(receipt);
  }
  return result;
}
