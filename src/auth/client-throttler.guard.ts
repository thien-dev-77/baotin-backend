import { Injectable } from "@nestjs/common";
import { ThrottlerGuard, type ThrottlerRequest } from "@nestjs/throttler";
import { createHash } from "node:crypto";
import type { Request } from "express";
import { authCookie } from "./auth.service";
import { verifiedProxyClientIp } from "./proxy-client-ip";

const SHARED_AUTH_SOURCE_LIMIT = 240;
const MAX_SUBJECT_LENGTH = 512;
const subjectHash = (value: string) => createHash("sha256").update(value).digest("hex");

function authSubject(request: Request, handler: string) {
  const fields: Record<string, string> = { login: "identity", register: "email", forgot: "email", reset: "token" };
  const field = fields[handler];
  const value: unknown = handler === "change" ? request.cookies?.[authCookie] : field ? request.body?.[field] : undefined;
  if (typeof value !== "string" || !value.trim() || value.length > MAX_SUBJECT_LENGTH) return undefined;
  const normalized = handler === "login" && !value.includes("@") ? value.trim().replace(/[\s()-]/g, "") : handler === "login" || field === "email" ? value.trim().toLowerCase() : value;
  return subjectHash(normalized);
}

@Injectable()
export class ClientThrottlerGuard extends ThrottlerGuard {
  protected errorMessage = "Bạn đã thao tác quá nhiều lần. Vui lòng chờ một phút rồi thử lại.";

  protected async handleRequest(properties: ThrottlerRequest) {
    const request = properties.context.switchToHttp().getRequest<Request>();
    const trustedIp = verifiedProxyClientIp(request);
    const authentication = properties.context.getClass().name === "AuthController";
    const subject = authentication ? authSubject(request, properties.context.getHandler().name) : undefined;
    // Keep the existing small per-account limit even when the hosting proxy's
    // real client IP is unavailable. Identifiers never enter storage in plaintext.
    if (subject) await super.handleRequest({ ...properties, getTracker: async () => `subject:${subject}` });
    // An unsigned X-Forwarded-For/client-IP header never changes the tracker.
    // Shared hosting falls back to an aggregate source cap, rather than sharing
    // eight login attempts among every customer behind the frontend server.
    return super.handleRequest({ ...properties,
      limit: authentication && !trustedIp ? Math.max(properties.limit, SHARED_AUTH_SOURCE_LIMIT) : properties.limit,
      getTracker: async () => `network:${trustedIp || request.ip || request.socket.remoteAddress || "unknown"}`,
    });
  }
}
