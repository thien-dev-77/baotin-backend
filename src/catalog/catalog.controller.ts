import { Controller, Get, NotFoundException, Param, Query, Req } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { CategoryEntity, CustomerEntity, ProductEntity } from "../database/entities";
import { AuthService, type AuthRequest } from "../auth/auth.service";
import { PricePolicyService } from "./price-policy.service";
import { LedgerService } from "../ledger/ledger.service";
import { orderedCategories } from "./category.rules";
import { CatalogQueryService } from "./catalog-query.service";
import { CatalogQueryDto, CatalogSelectionDto } from "./catalog-query.dto";

@Controller("catalog")
export class CatalogController {
  constructor(private readonly db: DatabaseService, private readonly auth: AuthService, private readonly pricing: PricePolicyService, private readonly ledger: LedgerService, private readonly queries: CatalogQueryService) {}
  @Get("bootstrap") async bootstrap(@Req() request: AuthRequest) {
    return this.queries.bootstrap(await this.auth.authenticate(request, false));
  }
  @Get("search") async search(@Query() input: CatalogQueryDto, @Req() request: AuthRequest) {
    return this.queries.search(input, await this.auth.authenticate(request, false));
  }
  @Get("selection") async selection(@Query() input: CatalogSelectionDto, @Req() request: AuthRequest) {
    return this.queries.selection(input, await this.auth.authenticate(request, false));
  }
  @Get() async catalog(@Req() request: AuthRequest) {
    const [user, rows, categories] = await Promise.all([
      this.auth.authenticate(request, false),
      this.db.source.getRepository(ProductEntity).find({ select: { data: true }, where: { published: true }, order: { id: "ASC" } }),
      this.db.source.getRepository(CategoryEntity).find(),
    ]);
    const customer = user?.customerId ? await this.db.source.getRepository(CustomerEntity).findOneBy({ id: user.customerId }) : null;
    const products = await this.pricing.personalize(await this.ledger.stock(rows.map(row => row.data), customer?.branch || "Quy Nhơn"), customer?.data);
    return { products, categories: orderedCategories(categories, true) };
  }
  @Get(["product/:slug", ":slug"]) async product(@Param("slug") slug: string) {
    const row = await this.db.source.getRepository(ProductEntity).findOne({ where: [{ slug, published: true }, { id: slug, published: true }] });
    if (!row) throw new NotFoundException("Không tìm thấy sản phẩm.");
    return (await this.ledger.stock([row.data], "Quy Nhơn"))[0];
  }
}
