import { BadRequestException, ConflictException, ForbiddenException, Injectable } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import type { EntityManager } from "typeorm";
import { DatabaseService } from "../database/database.service";
import { CustomerEntity, OrderEntity, ProductEntity, UserEntity } from "../database/entities";
import type { CheckoutDto, QuoteDto } from "./orders.dto";
import type { AdminOrder, Order } from "../types/domain.types";
import type { Quote } from "../types/api.types";
import { priceFor } from "../catalog/pricing";
import { PricePolicyService } from "../catalog/price-policy.service";
import { LedgerService } from "../ledger/ledger.service";
import { NotificationsService } from "../notifications/notifications.service";

export const shippingCost = (delivery: string) => delivery === "Nhận tại cửa hàng" ? 0 : delivery === "Chành xe" ? 50000 : 30000;

export function businessDate() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
export function customerOrder(row: OrderEntity): Order {
  const status: Order["status"] = row.data.status === "Hoàn tất" ? "Đã giao" : row.data.status === "Đang giao" ? "Đang giao" : row.data.status === "Đã hủy" ? "Đã hủy" : row.data.status === "Chờ xác nhận" ? "Chờ xác nhận" : "Đang xử lý";
  if (row.checkout) {
    const subtotal = row.data.items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
    const discount = row.checkout.discount ? Math.min(100000, Math.round(subtotal * 0.1)) : 0;
    return { ...row.checkout, items: row.data.items, subtotal, discount, total: subtotal + row.checkout.shipping - discount, status };
  }
  const details = row.data.details;
  return { id: row.id, customerId: row.customerId, date: `${row.data.date}T05:00:00Z`, status, b2b: !!row.customerId, items: row.data.items, subtotal: row.data.total, shipping: 0, discount: 0, total: row.data.total, customer: { name: details?.recipient || row.data.customerName, phone: details?.phone || "", email: "", address: details?.address || "", city: "", district: "", ward: "" }, delivery: details?.delivery || "Nhận tại cửa hàng", payment: details?.payment || "Chuyển khoản", note: details?.note || "" };
}

@Injectable()
export class OrdersService {
  constructor(private readonly db: DatabaseService, private readonly pricing: PricePolicyService, private readonly ledger: LedgerService, private readonly notifications: NotificationsService) {}
  async quote(input: QuoteDto, user?: UserEntity, manager = this.db.source.manager): Promise<Quote> {
    if (new Set(input.items.map((item) => item.productId)).size !== input.items.length) throw new BadRequestException("Mỗi SKU chỉ có một dòng.");
    const customer = user?.customerId ? await manager.getRepository(CustomerEntity).findOneBy({ id: user.customerId }) : null;
    if (user?.role === "b2b" && (!customer || customer.data.status !== "Đang hoạt động")) throw new ForbiddenException("Tài khoản B2B chưa được kích hoạt.");
    if (!customer && ["Sale giao", "Chành xe"].includes(input.delivery)) throw new BadRequestException("Khách lẻ chọn giao nội thành hoặc nhận tại cửa hàng.");
    const rows = await manager.getRepository(ProductEntity).find({ where: { published: true } });
    const products = await this.pricing.personalize(await this.ledger.stock(rows.map(row => row.data), customer?.branch || "Quy Nhơn", manager), customer?.data, manager);
    const items = input.items.map((item) => {
      const product = products.find(row => row.id === item.productId);
      if (!product || item.quantity > product.stock) throw new ConflictException("Sản phẩm không còn bán hoặc tồn kho không đủ.");
      return { productId: product.id, quantity: item.quantity, unitPrice: priceFor(product, customer ? { id: customer.id, name: customer.data.contact, email: user!.email || "", phone: user!.phone || "", company: customer.data.name, role: "b2b" } : null) };
    });
    if (input.coupon && input.coupon !== "BAOTIN10") throw new BadRequestException("Mã khuyến mãi không hợp lệ.");
    const subtotal = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
    if (!Number.isSafeInteger(subtotal) || subtotal < 1) throw new BadRequestException("Giá trị đơn vượt giới hạn. Giảm số lượng hoặc liên hệ Sales.");
    const shipping = shippingCost(input.delivery);
    const discount = input.coupon === "BAOTIN10" ? Math.min(100000, Math.round(subtotal * 0.1)) : 0;
    if (!Number.isSafeInteger(subtotal + shipping - discount)) throw new BadRequestException("Giá trị đơn vượt giới hạn.");
    return { items, subtotal, shipping, discount, total: subtotal + shipping - discount };
  }
  async checkout(input: CheckoutDto, user: UserEntity | undefined, guestId: string, key: string) {
    return this.db.transaction(async (manager) => {
      const repository = manager.getRepository(OrderEntity);
      const customerFields = input.customer;
      const requestHash = createHash("sha256").update(JSON.stringify({ items: input.items.map(({ productId, quantity }) => ({ productId, quantity })).sort((a, b) => a.productId.localeCompare(b.productId)), customer: { name: customerFields.name, phone: customerFields.phone, email: customerFields.email, address: customerFields.address, city: customerFields.city, district: customerFields.district, ward: customerFields.ward }, delivery: input.delivery, payment: input.payment, note: input.note, coupon: input.coupon })).digest("hex");
      const previous = await repository.findOneBy({ idempotencyKey: key });
      if (previous) {
        if (user?.customerId ? previous.customerId !== user.customerId : previous.customerId !== null || previous.guestId !== guestId) throw new ConflictException("Gửi lại đơn cần giữ nguyên phiên khách và mã gửi đơn.");
        if (previous.requestHash !== requestHash) throw new ConflictException("Mã gửi đơn đã dùng với nội dung khác. Kiểm tra lịch sử đơn trước khi gửi lại.");
        return customerOrder(previous);
      }
      const quote = await this.quote(input, user, manager);
      if (input.expectedTotal !== undefined && quote.total !== input.expectedTotal) throw new ConflictException("Giá đã thay đổi. Làm mới báo giá trước khi đặt hàng.");
      const customer = user?.customerId ? await manager.getRepository(CustomerEntity).findOneBy({ id: user.customerId }) : null;
      if (input.payment === "Thanh toán công nợ B2B" && (!customer || customer.data.limit <= 0)) throw new BadRequestException("Khách chưa có hạn mức công nợ.");
      if (input.delivery !== "Nhận tại cửa hàng" && (!input.customer.address.trim() || !input.customer.city.trim() || !input.customer.district.trim())) throw new BadRequestException("Bổ sung địa chỉ nhận hàng.");
      if (input.customer.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.customer.email)) throw new BadRequestException("Email người nhận không hợp lệ.");
      const id = `BT-${randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase()}`;
      const branch = customer?.data.branch || "Quy Nhơn";
      const checkout: Order = { ...quote, id, customerId: customer?.id || null, date: new Date().toISOString(), status: "Chờ xác nhận", b2b: !!customer, customer: input.customer, delivery: input.delivery, payment: input.payment, note: input.note, coupon: input.coupon };
      const data: AdminOrder = { id, customerId: checkout.customerId, customerName: customer?.data.name || input.customer.name, branch, date: businessDate(), channel: customer ? "B2B" : "B2C", source: customer ? "Website B2B" : "Website B2C", status: "Chờ xác nhận", items: quote.items, total: quote.total, credit: input.payment === "Thanh toán công nợ B2B", details: { recipient: input.customer.name, phone: input.customer.phone, address: [input.customer.address, input.customer.ward, input.customer.district, input.customer.city].filter(Boolean).join(", "), delivery: input.delivery === "Giao hàng nội thành" ? "Giao nội thành" : input.delivery as "Giao nội thành", payment: input.payment === "Thanh toán công nợ B2B" ? "Công nợ B2B" : input.payment === "Chuyển khoản ngân hàng" ? "Chuyển khoản" : "Tiền mặt", note: input.note } };
      const row = await repository.save(repository.create({ id, branch, customerId: checkout.customerId, guestId: customer ? null : guestId, idempotencyKey: key, requestHash, data, checkout, warehouse: { checks: {}, history: [{ at: new Date().toISOString(), label: "Website tạo đơn" }] }, dueDate: null }));
      await this.notifications.order(manager, branch, id, row.customerId, data.status, row.revision);
      return customerOrder(row);
    });
  }
}
