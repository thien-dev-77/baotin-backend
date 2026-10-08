import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
} from "@nestjs/common";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { AuthService, type AuthRequest } from "../auth/auth.service";
import { DatabaseService } from "../database/database.service";
import {
  AuditEntity,
  CategoryEntity,
  ProductEntity,
} from "../database/entities";
import { runtimeAssetPath } from "../runtime-assets";
import { CategoryDto } from "./category.dto";
import { categoryView, orderedCategories } from "./category.rules";

@Controller("categories")
export class CategoriesController {
  constructor(private readonly db: DatabaseService) {}
  @Get() async list() {
    return {
      items: orderedCategories(
        await this.db.source.getRepository(CategoryEntity).find(),
        true,
      ),
    };
  }
  @Get(":slug") async detail(@Param("slug") slug: string) {
    const row = await this.db.source
      .getRepository(CategoryEntity)
      .findOneBy({ slug });
    if (!row || row.data.visible === false)
      throw new NotFoundException("Không tìm thấy danh mục.");
    return categoryView(row);
  }
}

@Controller("admin/categories")
export class AdminCategoriesController {
  constructor(
    private readonly db: DatabaseService,
    private readonly auth: AuthService,
  ) {}
  private async authorize(request: AuthRequest, writing = false) {
    const user = (await this.auth.authenticate(request))!;
    if (
      !(
        writing ? ["admin", "boss"] : ["admin", "boss", "sales", "accountant"]
      ).includes(user.role)
    )
      throw new ForbiddenException();
    return user;
  }
  @Get() async list(@Req() request: AuthRequest) {
    await this.authorize(request);
    const counts = await this.db.source
      .getRepository(ProductEntity)
      .createQueryBuilder("p")
      .select("p.data->>'category'", "slug")
      .addSelect("COUNT(*)::int", "count")
      .groupBy("p.data->>'category'")
      .getRawMany<{ slug: string; count: number }>();
    return {
      items: orderedCategories(
        await this.db.source.getRepository(CategoryEntity).find(),
      ).map((category) => ({
        ...category,
        productCount:
          counts.find((item) => item.slug === category.slug)?.count || 0,
      })),
    };
  }
  @Post() create(@Body() input: CategoryDto, @Req() request: AuthRequest) {
    return this.save(input, request);
  }
  @Patch(":slug") update(
    @Param("slug") slug: string,
    @Body() input: CategoryDto,
    @Req() request: AuthRequest,
  ) {
    if (!input.revision)
      throw new BadRequestException(
        "Thiếu phiên bản danh mục. Làm mới và thử lại.",
      );
    return this.save(input, request, slug);
  }
  private async save(input: CategoryDto, request: AuthRequest, slug?: string) {
    const user = await this.authorize(request, true);
    if (
      new Set(input.subcategories.map((name) => name.toLocaleLowerCase("vi")))
        .size !== input.subcategories.length
    )
      throw new BadRequestException("Tên nhóm sản phẩm không được trùng nhau.");
    if (input.visible && !input.image)
      throw new BadRequestException("Danh mục hiển thị cần ảnh đại diện.");
    if (input.image) {
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
        throw new BadRequestException(
          "Ảnh không tồn tại trên backend. Vui lòng tải ảnh lại.",
        );
      }
    }
    return this.db.transaction(async (manager) => {
      const repository = manager.getRepository(CategoryEntity);
      const previous = slug ? await repository.findOneBy({ slug }) : null;
      if (slug && !previous)
        throw new NotFoundException("Không tìm thấy danh mục.");
      if (previous && previous.revision !== input.revision)
        throw new ConflictException(
          "Danh mục đã thay đổi. Làm mới dữ liệu trước khi lưu lại.",
        );
      if (slug && slug !== input.slug)
        throw new BadRequestException("Không đổi đường dẫn danh mục đã tạo.");
      const nameKey = input.name.toLocaleLowerCase("vi");
      const duplicate = (await repository.find()).some(
        (row) =>
          row.slug !== slug &&
          (row.slug === input.slug ||
            row.data.name.normalize("NFC").trim().toLocaleLowerCase("vi") ===
              nameKey),
      );
      if (duplicate)
        throw new ConflictException(
          "Tên hoặc đường dẫn danh mục đã được sử dụng.",
        );
      if (previous) {
        const used = await manager
          .getRepository(ProductEntity)
          .createQueryBuilder("p")
          .select("DISTINCT p.data->>'subcategory'", "name")
          .where("p.data->>'category' = :slug", { slug })
          .getRawMany<{ name: string }>();
        const removed = used.filter(
          (group) => group.name && !input.subcategories.includes(group.name),
        );
        if (removed.length)
          throw new ConflictException(
            `Không xóa hoặc đổi tên nhóm đang có sản phẩm: ${removed.map((group) => group.name).join(", ")}.`,
          );
      }
      const { revision: _revision, ...data } = input;
      const row = await repository.save(
        repository.create({
          ...previous,
          slug: input.slug,
          data,
          ...(previous ? { revision: previous.revision + 1 } : {}),
        }),
      );
      await manager
        .getRepository(AuditEntity)
        .save({
          actorId: user.id,
          action: previous ? "category-update" : "category-create",
          resourceId: row.slug,
          detail: {
            visible: input.visible,
            sortOrder: input.sortOrder,
            revision: row.revision,
          },
        });
      return { category: categoryView(row) };
    });
  }
}
