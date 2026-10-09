import type { ApiAdminState } from "../types/api.types";
import type { AdminCommandDto } from "./admin.dto";

export const adminResources = ["products", "categories", "customers", "orders", "approvals", "receipts"] as const;
export type AdminResource = typeof adminResources[number];
export const emptyAdminState = (): ApiAdminState => ({ products: [], categories: [], customers: [], orders: [], approvals: [], warehouse: {}, receipts: [], paymentDueDates: {}, today: "" });

// Command validation is server-controlled, independent of the client's requested view.
export const commandResources: Record<AdminCommandDto["action"], readonly AdminResource[]> = {
  "save-order": ["customers", "approvals"],
  "advance-order": ["products", "customers", "approvals"],
  "cancel-order": ["approvals", "receipts"],
  "create-approval": ["customers", "approvals"],
  "decide-approval": ["customers", "approvals"],
  "customer-status": [], "publish-product": [],
  "pick-item": ["approvals"], "report-shortage": ["approvals"], "resolve-shortage": ["approvals"],
  "create-receipt": ["orders", "receipts"], "reconcile-receipt": ["orders", "receipts"], "void-receipt": ["orders", "receipts"],
  "due-date": ["approvals"],
};
