import { priceFor } from "./pricing";
import type { Product, AdminCustomer, AdminOrder, Branch } from "./types";

export const salesSources = ["Zalo", "Điện thoại", "Tại cửa hàng", "Inside Sales"] as const;
export const salesDeliveries = ["Giao nội thành", "Nhận tại cửa hàng", "Sale giao", "Chành xe"] as const;
export const salesPayments = ["Chuyển khoản", "Tiền mặt", "Công nợ B2B"] as const;
export type SalesDetails = { recipient: string; phone: string; address: string; delivery: typeof salesDeliveries[number]; payment: typeof salesPayments[number]; note: string };
export type SalesDraft = { customerId: string; source: string; items: { productId: string; quantity: number }[]; details: SalesDetails };
export type SalesOrderData = Pick<AdminOrder, "items" | "total" | "credit"> & { details: SalesDetails };

export function salesUnitPrice(product: Product, customer?: AdminCustomer) {
  return priceFor(product, customer ? { id: customer.id, name: customer.contact, company: customer.name, phone: customer.phone, email: "", role: "b2b" } : null);
}

export function blankSalesDraft(order?: AdminOrder): SalesDraft {
  return {
    customerId: order?.customerId || "", source: order?.source || "Zalo",
    items: order?.items.map(({ productId, quantity }) => ({ productId, quantity })) || [],
    details: order?.details ? { ...order.details } : { recipient: order?.customerId ? "" : order?.customerName || "", phone: "", address: "", delivery: "Nhận tại cửa hàng", payment: order?.credit ? "Công nợ B2B" : "Chuyển khoản", note: "" }
  };
}

function readDetails(value: unknown): SalesDetails | null {
  if (!value || typeof value !== "object") return null;
  const data = value as SalesDetails;
  if (![data.recipient, data.phone, data.address, data.note].every((item) => typeof item === "string") || !salesDeliveries.includes(data.delivery) || !salesPayments.includes(data.payment)) return null;
  const details = { recipient: data.recipient.trim(), phone: data.phone.trim(), address: data.address.trim(), delivery: data.delivery, payment: data.payment, note: data.note.trim() };
  if (!details.recipient || details.recipient.length > 100 || !/^\+?\d{9,12}$/.test(details.phone.replace(/[\s()-]/g, "")) || details.address.length > 300 || details.note.length > 500 || (details.delivery !== "Nhận tại cửa hàng" && !details.address)) return null;
  return details;
}

export function draftItems(draft: SalesDraft, customer: AdminCustomer | undefined, products: Product[], previous?: AdminOrder) {
  return draft.items.map((line) => ({ ...line, unitPrice: previous?.items.find((item) => item.productId === line.productId)?.unitPrice ?? salesUnitPrice(products.find((product) => product.id === line.productId)!, customer) }));
}

export function validateSalesDraft(draft: SalesDraft, branch: Branch, customers: AdminCustomer[], products: Product[], previous?: AdminOrder): { error?: string; data?: SalesOrderData } {
  const customer = customers.find((item) => item.id === draft.customerId);
  if (draft.customerId && (!customer || customer.branch !== branch || customer.status !== "Đang hoạt động")) return { error: "Chọn khách B2B đang hoạt động tại chi nhánh này." };
  if (!previous && !salesSources.some((source) => source === draft.source)) return { error: "Chọn nguồn đơn hợp lệ." };
  const details = readDetails(draft.details);
  if (!details) return { error: "Kiểm tra người nhận, số điện thoại và địa chỉ giao hàng." };
  if (!customer && !["Giao nội thành", "Nhận tại cửa hàng"].includes(details.delivery)) return { error: "Khách B2C nhận tại cửa hàng hoặc giao nội thành." };
  if (details.payment === "Công nợ B2B" && (!customer || customer.limit <= 0)) return { error: "Khách chưa có hạn mức công nợ. Chọn tiền mặt hoặc chuyển khoản." };
  if (!draft.items.length || draft.items.length > products.length || new Set(draft.items.map((item) => item.productId)).size !== draft.items.length || draft.items.some((line) => !products.some((product) => product.id === line.productId) || !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 999)) return { error: "Thêm ít nhất một SKU với số lượng từ 1 đến 999." };
  const items = draftItems(draft, customer, products, previous);
  return { data: { details, items, total: items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0), credit: details.payment === "Công nợ B2B" } };
}

// Rehydrate only known SKU and price snapshots; browser totals and extra fields are ignored.
export function readSalesData(value: unknown, customer: AdminCustomer | undefined, products: Product[], previous?: AdminOrder): SalesOrderData | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as SalesOrderData;
  const details = readDetails(raw.details);
  if (!details || (!customer && (details.payment === "Công nợ B2B" || !["Giao nội thành", "Nhận tại cửa hàng"].includes(details.delivery))) || !Array.isArray(raw.items) || !raw.items.length || raw.items.length > products.length) return null;
  const items: AdminOrder["items"] = [];
  for (const line of raw.items) {
    const product = products.find((item) => item.id === line?.productId);
    if (!product || !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 999 || items.some((item) => item.productId === line.productId)) return null;
    const unitPrice = previous?.items.find((item) => item.productId === line.productId)?.unitPrice ?? salesUnitPrice(product, customer);
    if (line.unitPrice !== unitPrice) return null;
    items.push({ productId: product.id, quantity: line.quantity, unitPrice });
  }
  return { items, details, credit: details.payment === "Công nợ B2B", total: items.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0) };
}

export function readSalesOrder(value: unknown, customers: AdminCustomer[], products: Product[], branches: readonly Branch[], date: string): AdminOrder | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as AdminOrder;
  if (typeof raw.id !== "string" || !/^BTM2610\d{4,}$/.test(raw.id) || !branches.includes(raw.branch) || raw.date !== date || !salesSources.some((source) => source === raw.source)) return null;
  const customer = customers.find((item) => item.id === raw.customerId);
  if (raw.customerId !== null && (!customer || customer.branch !== raw.branch)) return null;
  const data = readSalesData(raw, customer, products);
  if (!data) return null;
  return { id: raw.id, branch: raw.branch, date, customerId: customer?.id || null, customerName: customer?.name || data.details.recipient, channel: customer ? "B2B" : "B2C", source: raw.source, status: "Chờ xác nhận", ...data };
}
