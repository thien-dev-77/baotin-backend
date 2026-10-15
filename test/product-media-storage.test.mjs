import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import sharp from "sharp";
import { configureProductMedia, assertProductImageExists, productMediaRoot } from "../dist/media/product-media.js";
import { runtimeAssetPath } from "../dist/runtime-assets.js";

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
    const imported = await sharp({ create: { width: 24, height: 24, channels: 3, background: "blue" } }).webp().toBuffer();
    const uploaded = await sharp({ create: { width: 24, height: 24, channels: 3, background: "green" } }).webp().toBuffer();
    await writeFile(join(media, "imported/fulco/imported-only.webp"), imported);
    await writeFile(join(media, "imported/fulco/shared.webp"), imported);
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
