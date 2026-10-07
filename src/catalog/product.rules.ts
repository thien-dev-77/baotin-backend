import { BadRequestException } from "@nestjs/common";
import type { Product } from "../types/domain.types";

export function assertPublishable(product: Product) {
  if (![product.name, product.code, product.category, product.brand, product.unit, product.specification, product.image].every(value => value?.trim()) || !product.gallery?.length || product.price <= 0) {
    throw new BadRequestException("Sản phẩm công khai cần tên, mã hàng, danh mục, thương hiệu, đơn vị, thông số, giá bán lớn hơn 0 và ít nhất một ảnh.");
  }
}
