import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { productMediaRoot } from "../dist/media/product-media.js";

const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const DOWNLOAD_CONCURRENCY = 2;
const UPLOAD_BATCH = 10;
const UPLOAD_INTERVAL_MS = 5300;
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function downloadFulcoImage(url, fetcher = fetch) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "fulco.vn" || parsed.port || parsed.username || parsed.password || !parsed.pathname.startsWith("/static/media/")) throw new Error("Source image URL is not allowed.");
  const response = await fetcher(parsed, { redirect: "manual", signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Source image HTTP ${response.status}.`);
  if (!/^image\/(?:jpeg|png|webp)(?:;|$)/i.test(response.headers.get("content-type") || "")) throw new Error("Source response is not an image.");
  if (Number(response.headers.get("content-length")) > MAX_SOURCE_BYTES) throw new Error("Source image is too large.");
  const chunks = []; let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.byteLength;
    if (size > MAX_SOURCE_BYTES) { await response.body?.cancel().catch(() => {}); throw new Error("Source image is too large."); }
    chunks.push(Buffer.from(chunk));
  }
  const image = sharp(Buffer.concat(chunks), { limitInputPixels: 100_000_000 });
  const metadata = await image.metadata();
  if (!["jpeg", "png", "webp"].includes(metadata.format || "")) throw new Error("Source image bytes are invalid.");
  const bytes = await image.rotate().resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true }).webp({ quality: 88 }).toBuffer();
  if (bytes.length > MAX_UPLOAD_BYTES) throw new Error("Converted image exceeds upload size.");
  return { bytes, hash: createHash("sha256").update(bytes).digest("hex") };
}

export async function prepareFulcoMedia(sourceURLs, { cacheDir, remote, progress = console.log }) {
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const manifestPath = join(cacheDir, "manifest.json");
  let manifest = { version: 1, remote: remote.base, items: {}, uploaded: {} };
  try {
    const previous = JSON.parse(await readFile(manifestPath, "utf8"));
    if (previous.version !== 1 || previous.remote !== remote.base) throw new Error("Media cache belongs to another backend.");
    manifest = previous;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const save = async () => { const pending = `${manifestPath}.tmp`; await writeFile(pending, JSON.stringify(manifest, null, 2), { mode: 0o600 }); await rename(pending, manifestPath); };
  const urls = [...new Set(sourceURLs)];
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, async () => {
    while (next < urls.length) {
      const url = urls[next++];
      try {
        const cached = manifest.items[url];
        if (!cached?.hash || !/^[a-f0-9]{64}$/.test(cached.hash) || !await access(join(cacheDir, `${cached.hash}.webp`)).then(() => true).catch(() => false)) {
          const image = await downloadFulcoImage(url);
          await writeFile(join(cacheDir, `${image.hash}.webp`), image.bytes, { mode: 0o600 });
          manifest.items[url] = { hash: image.hash };
        }
      } catch (error) { manifest.items[url] = { error: error.message }; }
      done++;
      if (done % 25 === 0 || done === urls.length) progress(`Images downloaded/checked: ${done}/${urls.length}`);
    }
  }));
  await save();
  const hashes = [...new Set(Object.values(manifest.items).map(item => item.hash).filter(Boolean))];
  const pending = hashes.filter(hash => !manifest.uploaded[hash]);
  let lastRequest = 0;
  for (let offset = 0; offset < pending.length; offset += UPLOAD_BATCH) {
    const batch = pending.slice(offset, offset + UPLOAD_BATCH);
    await wait(Math.max(0, UPLOAD_INTERVAL_MS - (Date.now() - lastRequest)));
    const form = new FormData();
    for (const hash of batch) form.append("images", new Blob([await readFile(join(cacheDir, `${hash}.webp`))], { type: "image/webp" }), `${hash}.webp`);
    let result;
    for (let attempt = 0; attempt < 3; attempt++) {
      lastRequest = Date.now();
      const response = await fetch(`${remote.base}/api/media/product-images`, { method: "POST", body: form, headers: { Cookie: remote.cookie, Origin: remote.origin, "X-BaoTin-Client": "web" }, signal: AbortSignal.timeout(60000), redirect: "error" });
      if (response.status === 429 || response.status >= 500) { if (attempt === 2) throw new Error(`Remote media upload HTTP ${response.status}; rerun to resume.`); await wait(30000); continue; }
      if (!response.ok) throw new Error(`Remote media upload HTTP ${response.status}.`);
      result = await response.json(); break;
    }
    if (!Array.isArray(result?.urls) || result.urls.length !== batch.length || result.urls.some(url => typeof url !== "string" || !/^\/media\/uploads\/[a-zA-Z0-9_-]+\.webp$/.test(url))) throw new Error("Invalid media upload response.");
    batch.forEach((hash, index) => { manifest.uploaded[hash] = result.urls[index]; });
    await save();
    progress(`Images stored on backend: ${Object.keys(manifest.uploaded).length}/${hashes.length}`);
  }
  const imageURLs = new Map(urls.flatMap(url => { const item = manifest.items[url]; const uploaded = item.hash && manifest.uploaded[item.hash]; return uploaded ? [[url, uploaded]] : []; }));
  const failures = urls.filter(url => !imageURLs.has(url)).map(url => ({ url, error: manifest.items[url]?.error || "Not stored" }));
  return { imageURLs, failures, uniqueImages: hashes.length, manifestPath };
}

export async function exportImportedMedia(manifestPath, destination = join(productMediaRoot(), "imported", "fulco")) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.version !== 1) throw new Error("Unsupported media manifest.");
  await mkdir(destination, { recursive: true });
  let bytes = 0;
  for (const [hash, url] of Object.entries(manifest.uploaded)) {
    const match = /^\/media\/uploads\/([a-zA-Z0-9_-]+\.webp)$/.exec(url);
    if (!/^[a-f0-9]{64}$/.test(hash) || !match) throw new Error("Invalid imported media reference.");
    const image = await readFile(new URL(`${hash}.webp`, pathToDirectoryURL(manifestPath)));
    if (createHash("sha256").update(image).digest("hex") !== hash) throw new Error("Imported image checksum does not match cache.");
    await writeFile(join(destination, match[1]), image, { mode: 0o644 });
    bytes += image.length;
  }
  return { files: Object.keys(manifest.uploaded).length, bytes };
}

function pathToDirectoryURL(filename) {
  return pathToFileURL(`${dirname(filename)}/`);
}
