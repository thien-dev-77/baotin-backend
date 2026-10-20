import { ForbiddenException, Injectable } from "@nestjs/common";
import type { ObjectLiteral, SelectQueryBuilder } from "typeorm";
import { DatabaseService } from "../database/database.service";
import { CustomerEntity, ProductEntity, type UserEntity } from "../database/entities";
import { LedgerEntity } from "../database/operations.entities";
import { applyAdminSearch } from "../admin/admin-browse.service";
import { LedgerService } from "./ledger.service";
import type { LedgerPageDto } from "./ledger-page.dto";

@Injectable()
export class LedgerQueryService {
  constructor(private readonly db: DatabaseService, private readonly ledger: LedgerService) {}
  private async window<T extends ObjectLiteral>(query: SelectQueryBuilder<T>, input: LedgerPageDto) {
    const read = (page: number) => query.clone().skip((page - 1) * input.pageSize).take(input.pageSize).getMany();
    const [total, requested] = await Promise.all([query.clone().getCount(), read(input.page)]);
    const totalPages = Math.max(1, Math.ceil(total / input.pageSize));
    const page = Math.min(input.page, totalPages);
    return { rows: page === input.page ? requested : await read(page), pagination: { total, totalPages, page, pageSize: input.pageSize } };
  }
  async page(user: UserEntity, input: LedgerPageDto) {
    if (user.role === "b2b" || !user.branches.includes(input.branch) || input.tab === "credit" && user.role === "warehouse") throw new ForbiddenException("Không có quyền xem dữ liệu này.");
    if (input.tab === "stock") {
      const query = this.db.source.getRepository(ProductEntity).createQueryBuilder("p");
      applyAdminSearch(query, input.q, ["p.data->>'code'", "p.data->>'name'", "p.data->>'alternateCode'"]);
      const read = (page: number) => query.clone().select("p.id", "id").addSelect("p.data->>'code'", "code")
        .addSelect("p.data->>'name'", "name").addSelect("p.data->>'unit'", "unit").addSelect("(p.data->>'stock')::integer", "stock")
        .orderBy("p.data->>'name'", "ASC").addOrderBy("p.id", "ASC").offset((page - 1) * input.pageSize).limit(input.pageSize)
        .getRawMany<{ id: string; code: string; name: string; unit: string; stock: number }>();
      const [total, requested] = await Promise.all([query.clone().getCount(), read(input.page)]);
      const totalPages = Math.max(1, Math.ceil(total / input.pageSize)), page = Math.min(input.page, totalPages);
      const inventory = await this.ledger.stock(page === input.page ? requested : await read(page), input.branch);
      return { inventory, customers: [], entries: [], pagination: { total, totalPages, page, pageSize: input.pageSize } };
    }
    if (input.tab === "credit") {
      const query = this.db.source.getRepository(CustomerEntity).createQueryBuilder("c").where("c.branch = :branch", { branch: input.branch })
        .orderBy("c.data->>'name'", "ASC").addOrderBy("c.id", "ASC");
      applyAdminSearch(query, input.q, ["c.id", "c.data->>'name'", "c.data->>'contact'", "c.data->>'phone'"]);
      const { rows, pagination } = await this.window(query, input);
      const customers = await this.ledger.customers(rows.map(row => ({ ...row.data, revision: row.revision })));
      return { inventory: [], customers, entries: [], pagination };
    }
    const query = this.db.source.getRepository(LedgerEntity).createQueryBuilder("e").where("e.branch = :branch", { branch: input.branch })
      .orderBy("e.at", "DESC").addOrderBy("e.id", "DESC");
    if (user.role === "warehouse") query.andWhere("e.kind = :kind", { kind: "stock" });
    applyAdminSearch(query, input.q, ["e.resourceId", "e.reason"]);
    const { rows: entries, pagination } = await this.window(query, input);
    return { inventory: [], customers: [], entries, pagination };
  }
}
