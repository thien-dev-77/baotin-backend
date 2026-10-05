import type { ApprovalSnapshot, ApprovalType } from "./admin-approval";
import type { SalesDetails } from "./admin-sales";

export type Category = { slug: string; name: string; image: string; description: string; subcategories: string[] };
export type Product = {
  id: string; slug: string; name: string; code: string; category: string; subcategory: string;
  image: string; gallery: string[]; brand: string; specification: string; material: string;
  color: string; size: string; origin: string; price: number; oldPrice?: number;
  unit: string; stock: number; featured: boolean; customerPrice?: number;
};
export type Customer = { id: string; name: string; email: string; phone: string; company: string; tax?: string; address?: string; status?: "pending" | "active"; creditLimit?: number; debt?: number; role: "b2b" };
export type CartLine = { productId: string; quantity: number };
export type OrderStatus = "Chờ xác nhận" | "Đang xử lý" | "Đang giao" | "Đã giao" | "Đã hủy";
export type Order = {
  id: string; customerId: string | null; date: string; status: OrderStatus; b2b: boolean;
  items: { productId: string; quantity: number; unitPrice: number }[];
  subtotal: number; shipping: number; discount: number; total: number;
  customer: { name: string; phone: string; email: string; address: string; city: string; district: string; ward: string };
  delivery: string; payment: string; note: string;
};
export const branches = ["Quy Nhơn", "Tuy Hòa", "Nha Trang"] as const;
export type Branch = typeof branches[number];
export const orderStages = ["Chờ xác nhận", "Chờ soạn hàng", "Đang soạn", "Sẵn sàng giao", "Đang giao", "Hoàn tất", "Đã hủy"] as const;
export type AdminOrderStatus = typeof orderStages[number];
export type CustomerStatus = "Chờ duyệt" | "Đang hoạt động" | "Tạm ngưng";
export type ApprovalStatus = "Chờ duyệt" | "Đã duyệt" | "Từ chối";
export type AdminCustomer = { id: string; name: string; contact: string; phone: string; group: string; branch: Branch; status: CustomerStatus; limit: number; debt: number; overdue: number };
export type AdminOrder = { id: string; customerId: string | null; customerName: string; branch: Branch; date: string; channel: "B2B" | "B2C"; source: string; status: AdminOrderStatus; items: { productId: string; quantity: number; unitPrice: number }[]; total: number; credit: boolean; approvalId?: string; cancelReason?: string; details?: SalesDetails; revision?: number };
export type AdminApproval = { id: string; orderId: string; customerId: string; branch: Branch; type: ApprovalType; requestedBy: string; reason: string; status: ApprovalStatus; decisionReason?: string; createdAt?: string; snapshot?: ApprovalSnapshot };
export type StaffRole = "admin" | "boss" | "sales" | "warehouse" | "accountant";
export type SessionUser = { id: string; email: string; name: string; role: StaffRole | "b2b"; branches: Branch[]; customer: Customer | null };
