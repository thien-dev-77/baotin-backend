import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import sharp from "sharp";
import { configureProductMedia, assertProductImageExists, productMediaRoot, resolveProductImagePath } from "../dist/media/product-media.js";
import { runtimeAssetPath } from "../dist/runtime-assets.js";
import { exportImportedMedia } from "../scripts/fulco-media.mjs";
import { validateHomepageImages } from "../scripts/repair-homepage.mjs";

class MediaTestModule {}
Module({})(MediaTestModule);

test("configured media storage serves and validates imported images from the persistent root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baotin-media-storage-"));
  const previous = process.env.MEDIA_DIR;
  const media = join(directory, "baotin-media");
  process.env.MEDIA_DIR = media;
  let app;
  try {
    await mkdir(join(media, "imported/fulco"), { recursive: true });
    await mkdir(join(media, "images/hero"), { recursive: true });
    const imported = await sharp({ create: { width: 24, height: 24, channels: 3, background: "blue" } }).webp().toBuffer();
    const uploaded = await sharp({ create: { width: 24, height: 24, channels: 3, background: "green" } }).webp().toBuffer();
    await writeFile(join(media, "imported/fulco/imported-only.webp"), imported);
    await writeFile(join(media, "imported/fulco/shared.webp"), imported);
    await writeFile(join(media, "images/hero/banner.webp"), imported);
    app = await NestFactory.create(MediaTestModule, { logger: false });
    assert.equal(await configureProductMedia(app), media);
    assert.equal(productMediaRoot(), media);
    await writeFile(join(media, "uploads/shared.webp"), uploaded);
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();
    const readImage = async path => {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /^image\/webp/);
      return Buffer.from(await response.arrayBuffer());
    };
    assert.deepEqual(await readImage("/media/uploads/imported-only.webp"), imported);
    assert.deepEqual(await readImage("/media/uploads/shared.webp"), uploaded, "new uploads take precedence over imported copies");
    assert.deepEqual(await readImage("/media/imported/fulco/imported-only.webp"), imported);
    assert.deepEqual(await readImage("/media/images/hero/banner.webp"), imported);
    assert.equal(await resolveProductImagePath("/images/hero/banner.webp"), join(media, "images/hero/banner.webp"));
    assert.equal(await resolveProductImagePath("/media/images/hero/banner.webp"), join(media, "images/hero/banner.webp"));
    assert.equal(await resolveProductImagePath("/media/uploads/shared.webp"), join(media, "uploads/shared.webp"));
    assert.equal(await resolveProductImagePath("/media/uploads/imported-only.webp"), join(media, "imported/fulco/imported-only.webp"));
    await validateHomepageImages({
      featured: [{ data: { image: "/media/uploads/imported-only.webp" } }],
      banners: ["/images/hero/banner.webp", "/media/images/hero/banner.webp", "/media/uploads/shared.webp", "/media/uploads/imported-only.webp"].map((image, id) => ({ id, data: { image } })),
    });
    await writeFile(join(media, "uploads/invalid.webp"), "not an image");
    await assert.rejects(validateHomepageImages({ featured: [], banners: [{ id: "invalid", data: { image: "/media/uploads/invalid.webp" } }] }));
    await assertProductImageExists("/media/uploads/imported-only.webp");
    await assertProductImageExists("/media/uploads/shared.webp");
    // Deleting only the upload must reveal the copy in this same media root.
    await rm(join(media, "uploads/shared.webp"));
    assert.deepEqual(await readImage("/media/uploads/shared.webp"), imported);
    await assertProductImageExists("/media/uploads/shared.webp");
    const bundled = runtimeAssetPath("media/imported/fulco");
    const legacy = (await readdir(bundled).catch(() => [])).find(file => file.endsWith(".webp"));
    if (legacy) {
      assert.ok((await readFile(join(bundled, legacy))).length > 0);
      assert.equal((await fetch(`${base}/media/uploads/${legacy}`)).status, 404, "a configured root never reads the release's bundled import");
      await assert.rejects(assertProductImageExists(`/media/uploads/${legacy}`));
    }
    await rm(join(media, "imported/fulco/imported-only.webp"));
    assert.equal((await fetch(`${base}/media/uploads/imported-only.webp`)).status, 404);
    await assert.rejects(assertProductImageExists("/media/uploads/imported-only.webp"));
  } finally {
    if (app) await app.close();
    if (previous === undefined) delete process.env.MEDIA_DIR;
    else process.env.MEDIA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Fulco export writes to the configured media root and remains readable through existing URLs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baotin-media-export-"));
  const previous = process.env.MEDIA_DIR;
  const media = join(directory, "persistent-media");
  process.env.MEDIA_DIR = media;
  try {
    const image = await sharp({ create: { width: 24, height: 24, channels: 3, background: "red" } }).webp().toBuffer();
    const hash = createHash("sha256").update(image).digest("hex");
    const filename = "imported-export.webp";
    const manifest = join(directory, "manifest.json");
    await writeFile(join(directory, `${hash}.webp`), image);
    await writeFile(manifest, JSON.stringify({ version: 1, uploaded: { [hash]: `/media/uploads/${filename}` } }));
    assert.deepEqual(await exportImportedMedia(manifest), { files: 1, bytes: image.length });
    const path = await resolveProductImagePath(`/media/uploads/${filename}`);
    assert.equal(path, join(media, "imported/fulco", filename));
    assert.deepEqual(await readFile(path), image);
    assert.equal(productMediaRoot(join(directory, "explicit-root")), join(directory, "explicit-root"));
    await writeFile(join(directory, `${hash}.webp`), "corrupted cache");
    await assert.rejects(exportImportedMedia(manifest), /checksum/);
    assert.deepEqual(await readFile(path), image, "a corrupt cache never replaces a valid imported image");
  } finally {
    if (previous === undefined) delete process.env.MEDIA_DIR;
    else process.env.MEDIA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
