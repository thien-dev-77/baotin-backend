import { readFile } from "node:fs/promises";
import type { EntityManager } from "typeorm";
import {
  ContentEntity,
  type ContentData,
} from "../database/experience.entities";
import { runtimeAssetPath } from "../runtime-assets";

export async function seedContent(manager: EntityManager) {
  const fixture = JSON.parse(
    await readFile(runtimeAssetPath("seed/mock.json"), "utf8"),
  ) as {
    guides: {
      slug: string;
      title: string;
      description: string;
      image: string;
      category: string;
      minutes: number;
    }[];
  };
  const base: ContentData = {
    slug: "",
    title: "",
    description: "",
    image: "",
    href: "",
    category: "",
    body: "",
    minutes: 5,
    width: 1600,
    height: 700,
    position: 0,
  };
  const banners = [
    ["kitchen-lighting-hd.jpg", "Phụ kiện tủ bếp", "phu-kien-bep", 888],
    ["cabinet-lighting-hd.jpg", "Ánh sáng LED tủ kệ", "led-tu-ke", 1250],
    ["wood-kitchen-hd.jpg", "Hoàn thiện nội thất", "phu-kien-lap-dat", 1250],
  ] as const;
  const solutions = [
    [
      "bo-led-tu-bep",
      "Bộ LED tủ bếp",
      "Sáng đẹp, tiết kiệm điện",
      "/images/solutions/bo-led-tu-bep.png",
      "led-tu-ke",
    ],
    [
      "bo-phu-kien-tu-bep",
      "Bộ phụ kiện tủ bếp",
      "Đầy đủ, đồng bộ",
      "/images/catalog/solution-kitchen.png",
      "phu-kien-bep",
    ],
    [
      "bo-ray-ban-le",
      "Bộ ray - bản lề",
      "Êm ái, bền bỉ",
      "/images/catalog/solution-hinge.png",
      "ray-truot",
    ],
    [
      "bo-khoa",
      "Bộ khóa cửa/cửa tủ",
      "An toàn, thẩm mỹ",
      "/images/catalog/solution-lock.png",
      "khoa",
    ],
    [
      "phu-kien-hoan-thien",
      "Phụ kiện hoàn thiện nội thất",
      "Tạo điểm nhấn cho không gian",
      "/images/catalog/solution-finish.png",
      "phu-kien-lap-dat",
    ],
  ];
  const entries = [
    ...banners.map(([image, title, category, height], position) => ({
      kind: "banner" as const,
      data: {
        ...base,
        slug: `banner-${position + 1}`,
        title,
        category,
        image: `/images/hero/${image}`,
        href: `/category/${category}`,
        width: 3750,
        height,
        position,
      },
    })),
    ...fixture.guides.map((guide, position) => ({
      kind: "guide" as const,
      data: {
        ...base,
        ...guide,
        href: `/guides/${guide.slug}`,
        position,
        body: `${guide.description}\n\nĐo kích thước và kiểm tra vị trí lắp đặt thực tế. Đối chiếu thông số theo mã hàng và tài liệu nhà sản xuất.\n\nChọn phụ kiện đồng bộ với kết cấu tủ, nguồn điện và tải trọng sử dụng. Liên hệ Bảo Tín để đối chiếu mã hàng trước khi đặt.`,
      },
    })),
    ...solutions.map(
      ([slug, title, description, image, category], position) => ({
        kind: "solution" as const,
        data: {
          ...base,
          slug,
          title,
          description,
          image,
          category,
          href: `/category/${category}`,
          position,
        },
      }),
    ),
  ];
  for (const entry of entries) {
    if (
      await manager
        .getRepository(ContentEntity)
        .createQueryBuilder("c")
        .where("c.kind = :kind AND c.data->>'slug' = :slug", {
          kind: entry.kind,
          slug: entry.data.slug,
        })
        .getExists()
    )
      continue;
    await manager
      .createQueryBuilder()
      .insert()
      .into(ContentEntity)
      .values({
        id: `${entry.kind}:${entry.data.slug}`,
        ...entry,
        published: true,
      })
      .orIgnore()
      .execute();
  }
  return { initialized: true };
}
