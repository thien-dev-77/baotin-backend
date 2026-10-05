import { Controller, Get, NotFoundException, Param, Req } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { CategoryEntity, ProductEntity } from "../database/entities";
import { AuthService, type AuthRequest } from "../auth/auth.service";
import { priceFor } from "./pricing";

@Controller("catalog")
export class CatalogController {
  constructor(private readonly db: DatabaseService, private readonly auth: AuthService) {}
  @Get() async catalog(@Req() request: AuthRequest) {
    const user = await this.auth.authenticate(request, false);
    const session = user ? await this.auth.userView(user) : null;
    const rows = await this.db.source.getRepository(ProductEntity).find({ where: { published: true }, order: { id: "ASC" } });
    const products = rows.map((row) => ({ ...row.data, ...(session?.customer?.status === "active" ? { customerPrice: priceFor(row.data, session.customer) } : {}) }));
    return { products, categories: (await this.db.source.getRepository(CategoryEntity).find()).map((row) => row.data) };
  }
  @Get(":slug") async product(@Param("slug") slug: string) {
    const row = await this.db.source.getRepository(ProductEntity).findOne({ where: [{ slug, published: true }, { id: slug, published: true }] });
    if (!row) throw new NotFoundException("Không tìm thấy sản phẩm.");
    return row.data;
  }
}
