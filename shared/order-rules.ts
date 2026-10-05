import { approvalMatchesOrder, latestOrderApprovals } from "./admin-approval";
import type { AdminOrder, AdminCustomer, AdminApproval, Product } from "./types";

export function orderBlocker(order: AdminOrder, customers: AdminCustomer[], approvals: AdminApproval[], products: Product[]) {
  const customer = customers.find((item) => item.id === order.customerId);
  if (customer && customer.status !== "Đang hoạt động") return "Tài khoản B2B chưa được kích hoạt hoặc đang tạm ngưng.";
  if (order.items.some((item) => item.quantity > (products.find((product) => product.id === item.productId)?.stock || 0))) return "Tồn kho không đủ cho số lượng đặt hàng.";
  const linked = latestOrderApprovals(order, approvals);
  if (linked.some((item) => !approvalMatchesOrder(item, order))) return "Nội dung đơn không khớp yêu cầu, cần gửi lại đề nghị.";
  if (linked.some((item) => item.status === "Từ chối")) return "Yêu cầu ngoại lệ đã bị từ chối.";
  if (linked.some((item) => item.status === "Chờ duyệt")) return "Cần duyệt ngoại lệ trước khi xác nhận đơn.";
  const creditApproval = linked.find((item) => item.type === "Công nợ" && item.status === "Đã duyệt");
  const creditAllowed = creditApproval && (creditApproval.snapshot?.kind !== "credit" || order.total <= creditApproval.snapshot.amount);
  if (order.credit && customer && (customer.overdue > 0 || customer.debt + order.total > customer.limit) && !creditAllowed) return "Công nợ vượt hạn mức hoặc quá hạn, cần duyệt ngoại lệ.";
  return "";
}
