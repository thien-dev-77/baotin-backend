import "reflect-metadata";
import { config } from "dotenv";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { AppModule } from "./app.module";

async function main() {
  config({ path: process.env.ENV_FILE || ".env", quiet: true });
  const origins = (process.env.FRONTEND_ORIGINS || "http://localhost:3010").split(",");
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ["log", "warn", "error"] });
  app.enableShutdownHooks();
  app.use(helmet({ crossOriginResourcePolicy: { policy: "same-site" } }));
  app.use(cookieParser());
  app.use((request: { method: string; path: string; headers: Record<string, string> }, response: { status: (code: number) => { json: (body: unknown) => void } }, next: () => void) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && (!origins.includes(request.headers.origin) || request.headers["x-baotin-client"] !== "web")) { response.status(403).json({ message: "Origin or CSRF header is invalid." }); return; }
    next();
  });
  app.enableCors({ origin: origins, credentials: true, allowedHeaders: ["Content-Type", "X-BaoTin-Client", "Idempotency-Key"] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  const media = resolve(process.env.MEDIA_DIR || "media");
  await mkdir(resolve(media, "uploads"), { recursive: true });
  app.useStaticAssets(media, { prefix: "/media/", dotfiles: "deny", index: false, redirect: false, maxAge: "1d" });
  app.setGlobalPrefix("api");
  await app.listen(Number(process.env.PORT || 4000), "127.0.0.1");
  console.log(`Bao Tin API ready at http://localhost:${process.env.PORT || 4000}/api`);
}
main().catch((error) => { console.error("Backend startup failed:", error.code || error.name || "Error", "Check database connectivity and environment configuration."); process.exit(1); });
