import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { runtimeAssetPath } from "../runtime-assets";

export const productMediaRoot = (directory = process.env.MEDIA_DIR || "media") => runtimeAssetPath(directory);

export async function configureProductMedia(app: Pick<NestExpressApplication, "useStaticAssets">) {
  const media = productMediaRoot();
  await mkdir(resolve(media, "uploads"), { recursive: true });
  const options = { dotfiles: "deny" as const, index: false as const, redirect: false, maxAge: "1d" };
  // Uploads and imported images share one configured root. Prefer current uploads
  // over the compatibility alias that preserves imported /media/uploads URLs.
  app.useStaticAssets(media, { ...options, prefix: "/media/" });
  app.useStaticAssets(resolve(media, "imported", "fulco"), { ...options, prefix: "/media/uploads/" });
  return media;
}

export async function resolveProductImagePath(url: string): Promise<string> {
  const media = productMediaRoot();
  const relative = url.startsWith("/images/") ? url.slice(1) : url.slice("/media/".length);
  const path = resolve(media, relative);
  try { await access(path); return path; } catch { /* Imported images use the same persistent media root. */ }
  if (!url.startsWith("/media/uploads/")) throw new Error("Image file does not exist.");
  const imported = resolve(media, "imported", "fulco", url.slice("/media/uploads/".length));
  await access(imported);
  return imported;
}

export async function assertProductImageExists(url: string) {
  await resolveProductImagePath(url);
}
