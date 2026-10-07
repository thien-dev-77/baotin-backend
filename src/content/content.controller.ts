import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from "@nestjs/common";
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { AuthService, type AuthRequest } from "../auth/auth.service";
import { DatabaseService } from "../database/database.service";
import { AuditEntity, CategoryEntity } from "../database/entities";
import {
  ContentEntity,
  type ContentKind,
} from "../database/experience.entities";
import { runtimeAssetPath } from "../runtime-assets";
import { seedContent } from "./content-seed";

class ContentDto {
  @IsIn(["banner", "guide", "solution"]) kind!: ContentKind;
  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  @MaxLength(100)
  slug!: string;
  @IsString() @MaxLength(150) title!: string;
  @IsString() @MaxLength(500) description!: string;
  @IsString() @MaxLength(300) image!: string;
  @IsString() @MaxLength(300) href!: string;
  @IsString() @MaxLength(100) category!: string;
  @IsString() @MaxLength(20000) body!: string;
  @IsInt() @Min(1) @Max(120) minutes!: number;
  @IsInt() @Min(1) @Max(10000) width!: number;
  @IsInt() @Min(1) @Max(10000) height!: number;
  @IsInt() @Min(0) @Max(1000) position!: number;
  @IsBoolean() published!: boolean;
  @IsOptional() @IsInt() @Min(1) revision?: number;
}
@Controller("content")
export class PublicContentController {
  constructor(private readonly db: DatabaseService) {}
  @Get() async list() {
    const items = await this.db.source
      .getRepository(ContentEntity)
      .find({ where: { published: true } });
    return {
      items: items
        .sort(
          (a, b) =>
            a.data.position - b.data.position || a.id.localeCompare(b.id),
        )
        .map(({ id, kind, data }) => ({ id, kind, ...data })),
    };
  }
}
@Controller("admin/content")
export class AdminContentController {
  constructor(
    private readonly db: DatabaseService,
    private readonly auth: AuthService,
  ) {}
  private async manager(request: AuthRequest) {
    const user = (await this.auth.authenticate(request))!;
    if (!["admin", "boss"].includes(user.role)) throw new ForbiddenException();
    return user;
  }
  @Get() async list(@Req() request: AuthRequest) {
    await this.manager(request);
    return {
      items: await this.db.source
        .getRepository(ContentEntity)
        .find({ order: { updatedAt: "DESC" } }),
    };
  }
  @Post("initialize") async initialize(@Req() request: AuthRequest) {
    const user = await this.manager(request);
    return this.db.transaction(async (manager) => {
      const result = await seedContent(manager);
      await manager
        .getRepository(AuditEntity)
        .save({
          actorId: user.id,
          action: "content-initialize",
          resourceId: "content",
          detail: {},
        });
      return result;
    });
  }
  @Post() create(@Body() input: ContentDto, @Req() request: AuthRequest) {
    return this.save(request, input);
  }
  @Patch(":id") update(
    @Param("id") id: string,
    @Body() input: ContentDto,
    @Req() request: AuthRequest,
  ) {
    return this.save(request, input, id);
  }
  private async save(request: AuthRequest, input: ContentDto, id?: string) {
    const user = await this.manager(request);
    if (
      !input.title.trim() ||
      (input.published &&
        (!input.image || (input.kind === "guide" && !input.body.trim())))
    )
      throw new BadRequestException(
        "Nội dung công khai cần tiêu đề, ảnh và bài viết đầy đủ.",
      );
    if (
      input.href &&
      (!/^\/(?!\/)/.test(input.href) || /[\\\r\n]/.test(input.href))
    )
      throw new BadRequestException("Liên kết phải là đường dẫn nội bộ.");
    if (input.image) {
      if (
        !/^\/(?:images\/[a-zA-Z0-9_/-]+\.(?:jpg|jpeg|png|webp)|media\/uploads\/[a-zA-Z0-9_-]+\.webp)$/.test(
          input.image,
        )
      )
        throw new BadRequestException("Chọn ảnh đã tải lên backend.");
      try {
        await access(
          resolve(
            runtimeAssetPath(process.env.MEDIA_DIR || "media"),
            input.image.startsWith("/images/")
              ? input.image.slice(1)
              : input.image.slice(7),
          ),
        );
      } catch {
        throw new BadRequestException("Ảnh không tồn tại.");
      }
    }
    return this.db.transaction(async (manager) => {
      const repo = manager.getRepository(ContentEntity);
      const previous = id ? await repo.findOneByOrFail({ id }) : null;
      if (previous && previous.revision !== input.revision)
        throw new ConflictException(
          "Nội dung đã thay đổi. Làm mới trước khi lưu.",
        );
      if (previous && previous.kind !== input.kind)
        throw new BadRequestException("Không đổi loại nội dung đã tạo.");
      if (
        input.category &&
        !(await manager
          .getRepository(CategoryEntity)
          .existsBy({ slug: input.category }))
      )
        throw new BadRequestException("Danh mục không hợp lệ.");
      if (
        await repo
          .createQueryBuilder("c")
          .where("c.kind = :kind AND c.data->>'slug' = :slug AND c.id <> :id", {
            kind: input.kind,
            slug: input.slug,
            id: id || "",
          })
          .getExists()
      )
        throw new ConflictException("Đường dẫn đã được sử dụng.");
      const { kind, published, revision: _revision, ...data } = input;
      const result = await repo.save({
        ...previous,
        id: id || randomUUID(),
        kind,
        published,
        data,
      });
      await manager
        .getRepository(AuditEntity)
        .save({
          actorId: user.id,
          action: "content-save",
          resourceId: result.id,
          detail: { published, revision: result.revision },
        });
      return result;
    });
  }
}
