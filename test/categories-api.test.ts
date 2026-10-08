import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "dotenv";
import { Client } from "pg";
import sharp from "sharp";

config({ path: ".env.local", quiet: true });
if (
  !process.env.DATABASE_URL ||
  new URL(process.env.DATABASE_URL).hostname !== "127.0.0.1"
)
  throw new Error("Category QA only targets local PostgreSQL.");
const base = "http://127.0.0.1:4007/api";
class Actor {
  cookie = "";
  async call(path: string, method = "GET", body?: object | FormData) {
    const headers = new Headers({
      Origin: "http://localhost:3010",
      "X-BaoTin-Client": "web",
      Cookie: this.cookie,
    });
    if (!(body instanceof FormData))
      headers.set("Content-Type", "application/json");
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(body
        ? { body: body instanceof FormData ? body : JSON.stringify(body) }
        : {}),
    });
    if (response.headers.getSetCookie().length)
      this.cookie = response.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
    return { status: response.status, data: await response.json() };
  }
}

test(
  "Category management, visibility and product references",
  { timeout: 120000 },
  async (t) => {
    const schema = `categories_qa_${randomBytes(6).toString("hex")}`;
    const password = `QA-${randomBytes(16).toString("hex")}`;
    const media = await mkdtemp(join(tmpdir(), "baotin-category-media-"));
    const sql = new Client({ connectionString: process.env.DATABASE_URL });
    await sql.connect();
    const child = spawn(process.execPath, ["dist/main.js"], {
      env: {
        ...process.env,
        ENV_FILE: ".env.local",
        PORT: "4007",
        HOST: "127.0.0.1",
        DB_SCHEMA: schema,
        DB_SYNCHRONIZE: "true",
        DB_SSL: "false",
        NODE_ENV: "development",
        COOKIE_SECURE: "false",
        SEED_MOCK_DATA: "true",
        SEED_PASSWORD: password,
        FRONTEND_ORIGINS: "http://localhost:3010",
        MEDIA_DIR: media,
        SMTP_URL: "",
        KIOTVIET_ENABLED: "false",
        KIOTVIET_POLL_ENABLED: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    child.stdout.on("data", (data) => {
      logs += data;
    });
    child.stderr.on("data", (data) => {
      logs += data;
    });
    const admin = new Actor(),
      boss = new Actor(),
      sales = new Actor(),
      accountant = new Actor(),
      warehouse = new Actor(),
      b2b = new Actor(),
      guest = new Actor();
    const slug = `qa-category-${randomBytes(5).toString("hex")}`;
    let draft = {
      slug,
      name: "Danh mục QA mới",
      image: "",
      description: "Mô tả danh mục mới",
      subcategories: ["Nhóm QA"],
      visible: false,
      sortOrder: 150,
    };
    let revision = 0;
    const patch = (changes: object = {}) =>
      admin.call(`/admin/categories/${slug}`, "PATCH", {
        ...draft,
        revision,
        ...changes,
      });
    try {
      for (let attempt = 0; attempt < 120; attempt++) {
        if (child.exitCode !== null) throw new Error(`API failed: ${logs}`);
        if (
          await fetch(`${base}/health`)
            .then((response) => response.ok)
            .catch(() => false)
        )
          break;
        if (attempt === 119) throw new Error(`Startup timeout: ${logs}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      for (const [actor, identity] of [
        [admin, "admin"],
        [boss, "boss"],
        [sales, "sales"],
        [accountant, "accountant"],
        [warehouse, "warehouse"],
        [b2b, "kh001"],
      ] as const)
        assert.equal(
          (
            await actor.call("/auth/login", "POST", {
              identity: `${identity}@baotin.local`,
              password,
            })
          ).status,
          201,
        );
      await t.test(
        "Legacy categories retain their default visibility, order and versions",
        async () => {
          const result = await guest.call("/categories");
          assert.equal(result.status, 200);
          assert.equal(result.data.items.length, 8);
          assert.equal(result.data.items[0].slug, "phu-kien-bep");
          assert.equal(result.data.items[1].slug, "led-tu-ke");
          assert.ok(
            result.data.items.every(
              (row: any) => row.visible && row.revision === 1,
            ),
          );
          assert.equal((await guest.call("/categories/missing")).status, 404);
        },
      );
      await t.test(
        "Only admin and boss mutate; Sales and accountant can read",
        async () => {
          assert.equal((await guest.call("/admin/categories")).status, 401);
          for (const actor of [warehouse, b2b])
            assert.equal((await actor.call("/admin/categories")).status, 403);
          for (const actor of [sales, accountant])
            assert.equal((await actor.call("/admin/categories")).status, 200);
          for (const actor of [sales, accountant, warehouse, b2b]) {
            assert.equal(
              (await actor.call("/admin/categories", "POST", draft)).status,
              403,
            );
            assert.equal(
              (
                await actor.call(`/admin/categories/${slug}`, "PATCH", {
                  ...draft,
                  revision: 1,
                })
              ).status,
              403,
            );
          }
          assert.equal(
            (await guest.call("/admin/categories", "POST", draft)).status,
            401,
          );
        },
      );
      await t.test(
        "Create an initially hidden category and count products",
        async () => {
          const result = await boss.call("/admin/categories", "POST", draft);
          assert.equal(result.status, 201, JSON.stringify(result.data));
          revision = result.data.category.revision;
          assert.equal(revision, 1);
          const item = (await admin.call("/admin/categories")).data.items.find(
            (item: any) => item.slug === slug,
          );
          assert.equal(item.productCount, 0);
          assert.equal(item.visible, false);
          assert.equal((await guest.call(`/categories/${slug}`)).status, 404);
          assert.ok(
            !(await guest.call("/catalog")).data.categories.some(
              (item: any) => item.slug === slug,
            ),
          );
        },
      );
      await t.test(
        "Reject duplicate identities, malformed values, remote and missing images",
        async () => {
          assert.equal(
            (
              await admin.call("/admin/categories", "POST", {
                ...draft,
                name: "Other",
              })
            ).status,
            409,
          );
          assert.equal(
            (
              await admin.call("/admin/categories", "POST", {
                ...draft,
                slug: `${slug}-other`,
                name: ` ${draft.name.toUpperCase()} `,
              })
            ).status,
            409,
          );
          for (const changes of [
            { name: " " },
            { slug: "bad/slug" },
            { sortOrder: -1 },
            { sortOrder: 1.5 },
            { visible: "true" },
            { description: "x".repeat(2001) },
            { subcategories: ["Nhóm", " nhóm "] },
            { subcategories: [""] },
            { subcategories: new Array(51).fill("A") },
            { productCount: 999 },
            { image: "https://example.com/image.png" },
            { image: "/media/uploads/../secret.png" },
            { image: "/media/uploads/missing.webp" },
            { visible: true },
          ])
            assert.equal(
              (await patch(changes)).status,
              400,
              JSON.stringify(changes),
            );
        },
      );
      await t.test(
        "Upload a cover, publish and order a new category in every public response",
        async () => {
          const bytes = await sharp({
            create: { width: 120, height: 80, channels: 3, background: "blue" },
          })
            .png()
            .toBuffer();
          const form = new FormData();
          form.append(
            "images",
            new Blob([bytes], { type: "image/png" }),
            "category.png",
          );
          const upload = await admin.call(
            "/media/product-images",
            "POST",
            form,
          );
          assert.equal(upload.status, 201);
          draft = {
            ...draft,
            image: upload.data.urls[0],
            visible: true,
            sortOrder: 0,
          };
          const result = await patch();
          assert.equal(result.status, 200, JSON.stringify(result.data));
          revision = result.data.category.revision;
          const detail = await guest.call(`/categories/${slug}`);
          assert.equal(detail.status, 200);
          assert.equal(detail.data.image, draft.image);
          assert.deepEqual(detail.data.subcategories, draft.subcategories);
          const list = (await guest.call("/categories")).data.items;
          assert.ok(
            list.findIndex((row: any) => row.slug === slug) <
              list.findIndex((row: any) => row.slug === "led-tu-ke"),
          );
          assert.ok(
            (await guest.call("/catalog")).data.categories.some(
              (row: any) => row.slug === slug,
            ),
          );
          assert.ok(
            (await admin.call("/admin/state")).data.categories.some(
              (row: any) => row.slug === slug && row.revision === revision,
            ),
          );
        },
      );
      await t.test(
        "A product can use the new category and used groups cannot be removed or renamed",
        async () => {
          const product = {
            name: "QA product",
            code: `QA-${randomUUID()}`,
            slug: `qa-product-${randomUUID()}`,
            category: slug,
            subcategory: "Nhóm QA",
            brand: "Bảo Tín",
            unit: "cái",
            price: 100000,
            specification: "QA",
            material: "",
            color: "",
            size: "",
            origin: "",
            description: "",
            gallery: [draft.image],
            featured: false,
            published: true,
          };
          const created = await sales.call("/admin/products", "POST", product);
          assert.equal(created.status, 201, JSON.stringify(created.data));
          assert.equal(
            (await guest.call(`/catalog/${product.slug}`)).data.category,
            slug,
          );
          const listed = (
            await admin.call("/admin/categories")
          ).data.items.find((row: any) => row.slug === slug);
          assert.equal(listed.productCount, 1);
          assert.equal((await patch({ subcategories: [] })).status, 409);
          assert.equal(
            (await patch({ subcategories: ["Nhóm đổi tên"] })).status,
            409,
          );
          const changed = await patch({
            subcategories: ["Nhóm QA", "Nhóm mới"],
          });
          assert.equal(changed.status, 200);
          revision = changed.data.category.revision;
          draft.subcategories = changed.data.category.subcategories;
        },
      );
      await t.test(
        "Immutable routes and stale edits cannot overwrite newer changes",
        async () => {
          assert.equal((await patch({ slug: `${slug}-renamed` })).status, 400);
          assert.equal(
            (await admin.call(`/admin/categories/${slug}`, "PATCH", draft))
              .status,
            400,
          );
          assert.equal(
            (
              await admin.call("/admin/categories/missing", "PATCH", {
                ...draft,
                revision,
              })
            ).status,
            404,
          );
          const previous = revision;
          const identical = await patch();
          assert.equal(identical.status, 200);
          revision = identical.data.category.revision;
          assert.equal(revision, previous + 1);
          assert.equal((await patch({ revision: previous })).status, 409);
          const responses = await Promise.all([
            patch({ name: "First editor" }),
            patch({ name: "Second editor" }),
          ]);
          assert.deepEqual(
            responses.map((row) => row.status).sort(),
            [200, 409],
          );
          const winner = responses.find((row) => row.status === 200)!;
          revision = winner.data.category.revision;
          draft.name = winner.data.category.name;
        },
      );
      await t.test(
        "Hiding a category hides navigation and its page, without privatizing its products",
        async () => {
          const changed = await patch({ visible: false });
          assert.equal(changed.status, 200);
          revision = changed.data.category.revision;
          assert.equal((await guest.call(`/categories/${slug}`)).status, 404);
          assert.ok(
            !(await guest.call("/categories")).data.items.some(
              (row: any) => row.slug === slug,
            ),
          );
          const catalog = (await guest.call("/catalog")).data;
          assert.ok(!catalog.categories.some((row: any) => row.slug === slug));
          assert.ok(catalog.products.some((row: any) => row.category === slug));
          const audit = (
            await sql.query(
              `SELECT action FROM "${schema}".audit_events WHERE "resourceId"=$1`,
              [slug],
            )
          ).rows;
          assert.ok(audit.some((row) => row.action === "category-create"));
          assert.ok(audit.some((row) => row.action === "category-update"));
        },
      );
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
      await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
      await rm(media, { recursive: true, force: true });
    }
  },
);
