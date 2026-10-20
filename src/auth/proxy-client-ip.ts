import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export const PROXY_IP_HEADERS = { ip: "x-baotin-client-ip", timestamp: "x-baotin-proxy-timestamp", signature: "x-baotin-proxy-signature" } as const;
const SIGNATURE_MAX_AGE_SECONDS = 60;
const MIN_PROXY_SECRET_LENGTH = 32;
type ProxyRequest = { method: string; originalUrl: string; headers: Record<string, string | string[] | undefined> };

export function verifiedProxyClientIp(request: ProxyRequest, secret = process.env.PROXY_CLIENT_IP_SECRET || "", now = Date.now()) {
  if (secret.length < MIN_PROXY_SECRET_LENGTH) return undefined;
  const ip = request.headers[PROXY_IP_HEADERS.ip];
  const timestamp = request.headers[PROXY_IP_HEADERS.timestamp];
  const signature = request.headers[PROXY_IP_HEADERS.signature];
  if (typeof ip !== "string" || !isIP(ip) || typeof timestamp !== "string" || !/^\d{10}$/.test(timestamp) || typeof signature !== "string" || !/^[a-f0-9]{64}$/.test(signature)) return undefined;
  if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > SIGNATURE_MAX_AGE_SECONDS) return undefined;
  const message = ["v1", timestamp, request.method.toUpperCase(), request.originalUrl, ip].join("\n");
  const expected = createHmac("sha256", secret).update(message).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex")) ? ip : undefined;
}
