import type { AdminOrder } from "./types";

export const warehouseStages = ["Chờ soạn hàng", "Đang soạn", "Sẵn sàng giao"] as const;
export type WarehouseEvent = { at: string; label: string; note?: string };
export type WarehouseIssue = { productId: string; quantity: number; note: string; reportedAt: string; resolvedAt?: string; resolution?: string };
export type WarehouseRecord = { checks: Record<string, boolean>; history: WarehouseEvent[]; issue?: WarehouseIssue };

export function isWarehouseOrder(order: AdminOrder) {
  return warehouseStages.some((status) => status === order.status);
}
export function isPicked(order: AdminOrder, record: WarehouseRecord | undefined, productId: string) {
  return record?.checks[productId] ?? ["Sẵn sàng giao", "Đang giao", "Hoàn tất"].includes(order.status);
}
export function hasShortage(record: WarehouseRecord | undefined) {
  return !!record?.issue && !record.issue.resolvedAt;
}
export function warehouseBlocker(order: AdminOrder, record: WarehouseRecord | undefined) {
  if (!isWarehouseOrder(order)) return "";
  if (hasShortage(record)) return "Đơn đang có báo thiếu hàng chưa được xử lý.";
  if (["Đang soạn", "Sẵn sàng giao"].includes(order.status) && !order.items.every((item) => isPicked(order, record, item.productId))) return "Cần kiểm tra đủ tất cả mã hàng trước khi hoàn tất soạn hoặc bàn giao.";
  return "";
}
export function appendWarehouseEvent(record: WarehouseRecord | undefined, label: string, note?: string): WarehouseRecord {
  return { checks: {}, ...record, history: [...(record?.history || []), { at: new Date().toISOString(), label, ...(note ? { note } : {}) }].slice(-50) };
}
function validTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
export function readWarehouseRecord(value: unknown, order: AdminOrder): WarehouseRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const checks: Record<string, boolean> = {};
  if (input.checks && typeof input.checks === "object") {
    const values = input.checks as Record<string, unknown>;
    for (const item of order.items) if (typeof values[item.productId] === "boolean") checks[item.productId] = values[item.productId] as boolean;
  }
  const history: WarehouseEvent[] = Array.isArray(input.history) ? input.history.filter((event) => event && validTime(event.at) && typeof event.label === "string" && (event.note === undefined || typeof event.note === "string")).slice(-50).map((event) => ({ at: event.at, label: event.label.slice(0, 150), ...(event.note ? { note: event.note.slice(0, 500) } : {}) })) : [];
  const result: WarehouseRecord = { checks, history };
  if (input.issue && typeof input.issue === "object") {
    const issue = input.issue as Record<string, unknown>;
    const line = order.items.find((item) => item.productId === issue.productId);
    if (line && Number.isInteger(issue.quantity) && Number(issue.quantity) > 0 && Number(issue.quantity) <= line.quantity && typeof issue.note === "string" && issue.note.trim() && validTime(issue.reportedAt)) {
      result.issue = { productId: line.productId, quantity: Number(issue.quantity), note: issue.note.slice(0, 500), reportedAt: issue.reportedAt };
      if (validTime(issue.resolvedAt) && typeof issue.resolution === "string" && issue.resolution.trim()) {
        result.issue.resolvedAt = issue.resolvedAt;
        result.issue.resolution = issue.resolution.slice(0, 500);
      }
    }
  }
  return result;
}
export function warehouseTime(value: string) {
  return new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}
