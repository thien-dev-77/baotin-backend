import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { runtimeAssetPath } from "../runtime-assets";

export async function assertProductImageExists(url: string) {
  const media = runtimeAssetPath(process.env.MEDIA_DIR || "media");
  const relative = url.startsWith("/images/") ? url.slice(1) : url.slice("/media/".length);
  try { await access(resolve(media, relative)); return; } catch { /* Imported assets also survive a runtime upload reset. */ }
  if (!url.startsWith("/media/uploads/")) throw new Error("Image file does not exist.");
  await access(resolve(runtimeAssetPath("media/imported/fulco"), url.slice("/media/uploads/".length)));
}
