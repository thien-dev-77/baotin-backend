import "reflect-metadata";
import { config } from "dotenv";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { startupErrorDetails } from "./runtime-assets";
import { configureProductMedia } from "./media/product-media";

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
  const media = await configureProductMedia(app);
  app.setGlobalPrefix("api");
  const host = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
  const port = Number(process.env.PORT || 4000);
  await app.listen(port, host);
  console.log(`Bao Tin API listening on ${host}:${port}, routes under /api`);
  console.log(`Bao Tin media root: ${media} (uploads, imported/fulco)`);
}
main().catch((error) => { console.error("Backend startup failed:", startupErrorDetails(error)); process.exit(1); });
