import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { branches, type Branch } from "../types/domain.types";

export type RemoteRow = Record<string, unknown> & { id: number };
export class KiotHttpError extends Error {
  constructor(readonly status: number) {
    super(`KiotViet HTTP ${status}`);
  }
}
export function branchMap(value = process.env.KIOTVIET_BRANCH_MAP || "{}") {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ServiceUnavailableException(
      "KIOTVIET_BRANCH_MAP không phải JSON hợp lệ.",
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.entries(parsed).some(
      ([name, id]) =>
        !branches.includes(name as Branch) ||
        !Number.isSafeInteger(id) ||
        Number(id) <= 0,
    ) ||
    new Set(Object.values(parsed)).size !== Object.values(parsed).length
  )
    throw new ServiceUnavailableException(
      "Mỗi chi nhánh cần một ID KiotViet riêng, là số nguyên dương.",
    );
  return parsed as Partial<Record<Branch, number>>;
}
@Injectable()
export class KiotClient {
  private token = "";
  private expires = 0;
  configuration() {
    const missing = [
      "KIOTVIET_RETAILER",
      "KIOTVIET_CLIENT_ID",
      "KIOTVIET_CLIENT_SECRET",
    ].filter((name) => !process.env[name]);
    return {
      enabled: process.env.KIOTVIET_ENABLED === "true",
      configured: !missing.length,
      missing,
      branches: branchMap(),
    };
  }
  async request(
    path: string,
    options: RequestInit = {},
  ): Promise<Record<string, unknown>> {
    const configuration = this.configuration();
    if (!configuration.enabled || !configuration.configured)
      throw new ServiceUnavailableException(
        "KiotViet chưa được bật hoặc thiếu cấu hình kết nối.",
      );
    if (!/^\/(products|customers|branches|orders)(\?|$)/.test(path))
      throw new Error("Unsupported KiotViet resource");
    if (this.expires <= Date.now()) {
      const response = await fetch("https://id.kiotviet.vn/connect/token", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(12000),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          scopes: "PublicApi.Access",
          grant_type: "client_credentials",
          client_id: process.env.KIOTVIET_CLIENT_ID!,
          client_secret: process.env.KIOTVIET_CLIENT_SECRET!,
        }),
      });
      if (!response.ok) throw new KiotHttpError(response.status);
      const value = (await response.json()) as {
        access_token?: string;
        expires_in?: number;
      };
      if (
        typeof value.access_token !== "string" ||
        !value.access_token ||
        !Number.isFinite(value.expires_in)
      )
        throw new ServiceUnavailableException(
          "Phản hồi xác thực KiotViet không hợp lệ.",
        );
      this.token = value.access_token;
      this.expires =
        Date.now() + Math.max(0, Number(value.expires_in) - 60) * 1000;
    }
    const response = await fetch(`https://public.kiotapi.com${path}`, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(20000),
      headers: {
        Authorization: `Bearer ${this.token}`,
        Retailer: process.env.KIOTVIET_RETAILER!,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      if (response.status === 401) this.expires = 0;
      throw new KiotHttpError(response.status);
    }
    const value = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ServiceUnavailableException("Phản hồi KiotViet không hợp lệ.");
    return value as Record<string, unknown>;
  }
  async list(
    resource: "branches" | "products" | "customers" | "orders",
    filters: Record<string, string> = {},
  ) {
    const rows: RemoteRow[] = [];
    for (let page = 0; page < 100; page++) {
      const query = new URLSearchParams({
        ...filters,
        pageSize: "100",
        currentItem: String(page * 100),
      });
      const result = await this.request(`/${resource}?${query}`);
      if (
        !Array.isArray(result.data) ||
        !Number.isSafeInteger(result.total) ||
        Number(result.total) < 0 ||
        Number(result.total) > 10000 ||
        result.data.some(
          (row) => !row || !Number.isSafeInteger(row.id) || row.id <= 0,
        )
      )
        throw new ServiceUnavailableException(
          "Dữ liệu KiotViet không hợp lệ hoặc vượt giới hạn 10.000 bản ghi.",
        );
      rows.push(...(result.data as RemoteRow[]));
      if (rows.length >= Number(result.total)) {
        if (
          rows.length !== Number(result.total) ||
          new Set(rows.map((row) => row.id)).size !== rows.length
        )
          throw new ServiceUnavailableException(
            "Dữ liệu KiotViet thay đổi trong khi tải. Vui lòng thử lại.",
          );
        return rows;
      }
      if (!result.data.length) break;
    }
    throw new ServiceUnavailableException(
      "Chưa tải đủ dữ liệu KiotViet; không áp dụng dữ liệu một phần.",
    );
  }
}
