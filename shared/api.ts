import type { AdminApproval, AdminCustomer, AdminOrder, Category, Order, Product, SessionUser } from "./types";
import type { WarehouseRecord } from "./admin-warehouse";
import type { Receipt } from "./admin-accounting";

export type ApiAdminState = {
  products: (Product & { published: boolean })[]; customers: AdminCustomer[];
  orders: AdminOrder[]; approvals: AdminApproval[]; warehouse: Record<string, WarehouseRecord>;
  receipts: Receipt[]; paymentDueDates: Record<string, string>; today: string;
};
export type ApiSession = { user: SessionUser | null };
export type CatalogResponse = { products: Product[]; categories: Category[] };
export type CheckoutDraft = {
  items: { productId: string; quantity: number }[];
  customer: Order["customer"]; delivery: string; payment: string; note: string; coupon: string; expectedTotal?: number;
};
export type Quote = { items: Order["items"]; subtotal: number; shipping: number; discount: number; total: number };
