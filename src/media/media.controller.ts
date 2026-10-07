import { BadRequestException, Controller, ForbiddenException, NotFoundException, Param, Post, Req, UploadedFile, UploadedFiles, UseInterceptors } from "@nestjs/common";
import { FileInterceptor, FilesInterceptor } from "@nestjs/platform-express";
import { Throttle } from "@nestjs/throttler";
import sharp from "sharp";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { AuthService, type AuthRequest } from "../auth/auth.service";
import { DatabaseService } from "../database/database.service";
import { AuditEntity, ProductEntity } from "../database/entities";
import { runtimeAssetPath } from "../runtime-assets";

@Controller("media")
export class MediaController {
  constructor(private readonly auth: AuthService, private readonly db: DatabaseService) {}
  @Post("product-images")
  @Throttle({ default: { limit: 12, ttl: 60000 } })
  @UseInterceptors(FilesInterceptor("images", 10, { limits: { fileSize: 5 * 1024 * 1024, files: 10, fields: 0 } }))
  async uploadMany(@UploadedFiles() files: Express.Multer.File[], @Req() request: AuthRequest) {
    await this.authorize(request);
    const stored = await this.store(files);
    return { urls: stored.map(file => file.url) };
  }

  private async authorize(request: AuthRequest) {
    const user = (await this.auth.authenticate(request))!;
    if (!["admin", "boss", "sales"].includes(user.role)) throw new ForbiddenException();
    return user;
  }

  private async store(files: Express.Multer.File[]) {
    if (!files?.length) throw new BadRequestException("Chọn ít nhất một ảnh.");
    const images: Buffer[] = [];
    for (const file of files) {
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) throw new BadRequestException("Chỉ nhận ảnh JPEG, PNG hoặc WebP, tối đa 5 MB mỗi ảnh.");
      try {
        const processor = sharp(file.buffer, { limitInputPixels: 20_000_000 });
        const metadata = await processor.metadata();
        if (!["jpeg", "png", "webp"].includes(metadata.format || "")) throw new Error("Invalid format");
        images.push(await processor.rotate().resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true }).webp({ quality: 88 }).toBuffer());
      } catch { throw new BadRequestException("Không đọc được ảnh hợp lệ."); }
    }
    const directory = resolve(runtimeAssetPath(process.env.MEDIA_DIR || "media"), "uploads");
    await mkdir(directory, { recursive: true });
    const stored: { path: string; url: string }[] = [];
    try {
      for (const image of images) {
        const filename = `${randomUUID()}.webp`;
        const path = resolve(directory, filename);
        await writeFile(path, image, { flag: "wx" });
        stored.push({ path, url: `/media/uploads/${filename}` });
      }
    } catch (error) {
      await Promise.all(stored.map(file => unlink(file.path)));
      throw error;
    }
    return stored;
  }

  @Post("products/:id/image")
  @Throttle({ default: { limit: 12, ttl: 60000 } })
  @UseInterceptors(FileInterceptor("image", { limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0 } }))
  async upload(@Param("id") id: string, @UploadedFile() file: Express.Multer.File, @Req() request: AuthRequest) {
    const user = await this.authorize(request);
    const [{ path, url }] = await this.store(file ? [file] : []);
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
