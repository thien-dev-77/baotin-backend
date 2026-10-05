import type { AdminApproval, AdminCustomer, AdminOrder, Category, Order, Product, SessionUser } from "./domain.types";
import type { WarehouseRecord } from "../admin/rules/warehouse.rules";
import type { Receipt } from "../admin/rules/accounting.rules";

export type ApiAdminState = {
  products: (Product & { published: boolean })[]; customers: AdminCustomer[];
  orders: AdminOrder[]; approvals: AdminApproval[]; warehouse: Record<string, WarehouseRecord>;
  receipts: Receipt[]; paymentDueDates: Record<string, string>; today: string;
  stockByBranch?: Record<string, Record<string, number>>;
};
export type ApiSession = { user: SessionUser | null };
export type CatalogResponse = { products: Product[]; categories: Category[] };
export type CheckoutDraft = {
  items: { productId: string; quantity: number }[];
  customer: Order["customer"]; delivery: string; payment: string; note: string; coupon: string; expectedTotal?: number;
};
export type Quote = { items: Order["items"]; subtotal: number; shipping: number; discount: number; total: number };
