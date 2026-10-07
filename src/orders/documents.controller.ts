import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import PDFDocument from "pdfkit";
import {
  AuthService,
  guestCookie,
  type AuthRequest,
} from "../auth/auth.service";
import { DatabaseService } from "../database/database.service";
import {
  ApprovalEntity,
  OrderEntity,
  ProductEntity,
} from "../database/entities";
import { effectiveOrder } from "../admin/admin.service";
import { runtimeAssetPath } from "../runtime-assets";

@Controller()
export class DocumentsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly auth: AuthService,
  ) {}
  @Get("orders/:id/document") customer(
    @Param("id") id: string,
    @Req() request: AuthRequest,
    @Res() response: Response,
    @Query("kind") kind = "order",
  ) {
    return this.document(id, request, response, kind, false);
  }
  @Get("admin/orders/:id/document") staff(
    @Param("id") id: string,
    @Req() request: AuthRequest,
    @Res() response: Response,
    @Query("kind") kind = "order",
  ) {
    return this.document(id, request, response, kind, true);
  }
  private async document(
    id: string,
    request: AuthRequest,
    response: Response,
    kind: string,
    staff: boolean,
  ) {
    if (!["order", "quote"].includes(kind))
      throw new BadRequestException("Loại tài liệu không hợp lệ.");
    const user = await this.auth.authenticate(request, staff);
    const row = await this.db.source
      .getRepository(OrderEntity)
      .findOneBy({ id });
    if (
      !row ||
      (staff
        ? !user ||
          !["admin", "boss", "sales", "accountant"].includes(user.role) ||
          !user.branches.includes(row.branch as never)
        : user?.customerId
          ? row.customerId !== user.customerId
          : !row.guestId || row.guestId !== request.cookies?.[guestCookie])
    )
      throw new ForbiddenException("Không có quyền tải tài liệu đơn này.");
    const approvals = (
      await this.db.source
        .getRepository(ApprovalEntity)
        .find({ where: { branch: row.branch } })
    ).map((item) => item.data);
    const order = effectiveOrder(row, approvals);
    const products = await this.db.source.getRepository(ProductEntity).find();
    const title = kind === "quote" ? "BÁO GIÁ" : "ĐƠN HÀNG";
    const doc = new PDFDocument({
      size: "A4",
      margin: 40,
      info: { Title: `${title} ${id}`, Author: "Bảo Tín" },
    });
    doc.font(runtimeAssetPath("assets/fonts/NotoSans.ttf"));
    const chunks: Buffer[] = [];
    const bytes = new Promise<Buffer>((resolve, reject) => {
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
    });
    doc.fillColor("#123354").fontSize(23).text("BẢO TÍN");
    doc
      .fontSize(10)
      .text("PHỤ KIỆN NỘI THẤT")
      .text(`Chi nhánh: ${row.branch}`)
      .moveDown();
    doc.fontSize(18).text(title, { align: "center" }).moveDown(0.5);
    doc
      .fontSize(10)
      .fillColor("#222222")
      .text(`Mã: ${id} · Phiên bản: ${row.revision}`)
      .text(`Ngày đơn: ${order.date} · Trạng thái: ${order.status}`)
      .text(`Khách hàng: ${order.customerName}`)
      .text(
        `Người nhận: ${order.details?.recipient || ""} · Điện thoại: ${order.details?.phone || ""}`,
      )
      .text(`Địa chỉ: ${order.details?.address || "Nhận tại cửa hàng"}`)
      .moveDown();
    for (const [index, line] of order.items.entries()) {
      const product = products.find((product) => product.id === line.productId);
      if (doc.y > 670) doc.addPage();
      doc
        .fillColor("#123354")
        .fontSize(11)
        .text(`${index + 1}. ${product?.data.name || line.productId}`);
      doc
        .fillColor("#444444")
        .fontSize(10)
        .text(
          `Mã: ${product?.data.code || line.productId} · SL: ${line.quantity} ${product?.data.unit || ""}`,
        )
        .text(
          `Đơn giá: ${line.unitPrice.toLocaleString("vi-VN")} đ · Thành tiền: ${(line.unitPrice * line.quantity).toLocaleString("vi-VN")} đ`,
        )
        .moveDown(0.6);
    }
    if (doc.y > 590) doc.addPage();
    const money = (value: number) => `${value.toLocaleString("vi-VN")} đ`;
    doc
      .moveDown()
      .text(
        `Tiền hàng: ${money(order.items.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0))}`,
        { align: "right" },
      )
      .text(`Giao hàng: ${money(order.shipping || 0)}`, { align: "right" })
      .text(`Giảm giá: ${money(order.discount || 0)}`, { align: "right" });
    doc
      .fillColor("#123354")
      .fontSize(14)
      .text(`TỔNG CỘNG: ${money(order.total)}`, { align: "right" });
    doc
      .moveDown()
      .fontSize(10)
      .fillColor("#444444")
      .text(`Giao hàng: ${order.details?.delivery || ""}`)
      .text(`Thanh toán: ${order.details?.payment || ""}`);
    if (row.dueDate) doc.text(`Hạn thanh toán: ${row.dueDate}`);
    if (order.details?.note) doc.text(`Ghi chú: ${order.details.note}`);
    doc
      .moveDown()
      .fontSize(9)
      .text(
        "Tài liệu theo dữ liệu đơn hiện tại, không phải hóa đơn thuế. Báo giá cần Inside Sales xác nhận giá, tồn kho và công nợ.",
      );
    doc.end();
    const buffer = await bytes;
    response
      .set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="bao-tin-${kind === "quote" ? "quote" : "order"}-${id.replace(/[^a-zA-Z0-9_-]/g, "")}.pdf"`,
        "Cache-Control": "private, no-store",
      })
      .send(buffer);
  }
}
