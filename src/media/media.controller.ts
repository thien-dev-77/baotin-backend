import { BadRequestException, Controller, ForbiddenException, NotFoundException, Param, Post, Req, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Throttle } from "@nestjs/throttler";
import sharp from "sharp";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { AuthService, type AuthRequest } from "../auth/auth.service";
import { DatabaseService } from "../database/database.service";
import { AuditEntity, ProductEntity } from "../database/entities";

@Controller("media")
export class MediaController {
  constructor(private readonly auth: AuthService, private readonly db: DatabaseService) {}
  @Post("products/:id/image")
  @Throttle({ default: { limit: 12, ttl: 60000 } })
  @UseInterceptors(FileInterceptor("image", { limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0 } }))
  async upload(@Param("id") id: string, @UploadedFile() file: Express.Multer.File, @Req() request: AuthRequest) {
    const user = (await this.auth.authenticate(request))!;
    if (!["admin", "boss", "sales"].includes(user.role)) throw new ForbiddenException();
    if (!file || !["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) throw new BadRequestException("Chỉ nhận ảnh JPEG, PNG hoặc WebP, tối đa 5 MB.");
    let image: Buffer;
    try {
      const processor = sharp(file.buffer, { limitInputPixels: 20_000_000 });
      const metadata = await processor.metadata();
      if (!["jpeg", "png", "webp"].includes(metadata.format || "")) throw new Error("Invalid format");
      image = await processor.rotate().resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true }).webp({ quality: 88 }).toBuffer();
    } catch { throw new BadRequestException("Không đọc được ảnh hợp lệ."); }
    const directory = resolve(process.env.MEDIA_DIR || "media", "uploads");
    await mkdir(directory, { recursive: true });
    const filename = `${randomUUID()}.webp`; const path = resolve(directory, filename);
    await writeFile(path, image, { flag: "wx" });
    const url = `/media/uploads/${filename}`;
    try {
      await this.db.transaction(async (manager) => {
        const product = await manager.getRepository(ProductEntity).findOneBy({ id });
        if (!product) throw new NotFoundException("Không tìm thấy sản phẩm.");
        product.data = { ...product.data, image: url, gallery: [url, ...product.data.gallery].slice(0, 10) };
        await manager.getRepository(ProductEntity).save(product);
        await manager.getRepository(AuditEntity).save({ actorId: user.id, action: "product-image", resourceId: id, detail: { url } });
      });
    } catch (error) { await unlink(path); throw error; }
    return { url };
  }
}
