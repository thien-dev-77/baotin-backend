import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifiedProxyClientIp, PROXY_IP_HEADERS } from "../dist/auth/proxy-client-ip.js";

const secret = "QA-proxy-key-32-characters-required-only-for-tests";
const now = 1792454400000;
const ip = "2001:db8::12";
const request = { method: "POST", originalUrl: "/api/auth/login", headers: {} };
const sign = (changes = {}) => {
  const value = { ...request, ...changes };
  const timestamp = String(Math.floor(now / 1000));
  const signature = createHmac("sha256", secret).update(["v1", timestamp, value.method, value.originalUrl, ip].join("\n")).digest("hex");
  return { ...value, headers: { [PROXY_IP_HEADERS.ip]: ip, [PROXY_IP_HEADERS.timestamp]: timestamp, [PROXY_IP_HEADERS.signature]: signature } };
};

test("Only a fresh request-bound proxy signature supplies the client IP", () => {
  const signed = sign();
  assert.equal(verifiedProxyClientIp(signed, secret, now), ip);
  for (const changed of [
    { ...signed, method: "GET" }, { ...signed, originalUrl: "/api/auth/register" },
    { ...signed, originalUrl: "/api/auth/login?changed=1" },
    { ...signed, headers: { ...signed.headers, [PROXY_IP_HEADERS.ip]: "192.0.2.42" } },
    { ...signed, headers: { ...signed.headers, [PROXY_IP_HEADERS.signature]: "0".repeat(64) } },
    { ...signed, headers: { ...signed.headers, [PROXY_IP_HEADERS.signature]: "bad" } },
  ]) assert.equal(verifiedProxyClientIp(changed, secret, now), undefined);
  assert.equal(verifiedProxyClientIp(signed, secret, now + 61000), undefined);
  assert.equal(verifiedProxyClientIp(signed, secret, now - 61000), undefined);
  assert.equal(verifiedProxyClientIp(signed, "short", now), undefined);
  assert.equal(verifiedProxyClientIp(signed, secret + "different", now), undefined);
});

test("Unsigned forwarding headers and duplicate/invalid client IPs are ignored", () => {
  assert.equal(verifiedProxyClientIp({ ...request, headers: { "x-forwarded-for": "192.0.2.2", "x-real-ip": "192.0.2.3", [PROXY_IP_HEADERS.ip]: "192.0.2.4" } }, secret, now), undefined);
  const signed = sign();
  for (const value of [[ip, "192.0.2.2"], "2001:db8::12,192.0.2.2", "not-an-ip"]) assert.equal(verifiedProxyClientIp({ ...signed, headers: { ...signed.headers, [PROXY_IP_HEADERS.ip]: value } }, secret, now), undefined);
});
