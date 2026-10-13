import type { Product } from "../types/domain.types";

const protectedNames = new Map([
  ["fulco", "Fulco"], ["kanger", "Kanger"], ["nhật", "Nhật"],
  ["led", "LED"], ["sus", "SUS"], ["abs", "ABS"], ["pvc", "PVC"],
  ["usb", "USB"], ["rfid", "RFID"], ["nfc", "NFC"],
]);

export function sentenceCaseProductName(product: Pick<Product, "name" | "code" | "alternateCode" | "brand">): string {
  const identities = [product.code, product.alternateCode, product.brand].filter((value): value is string => Boolean(value));
  const protectedTokens = new Map(identities.map(value => [value.toLocaleLowerCase("vi"), value]));
  const lower = product.name.normalize("NFC").trim().replace(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu, token => {
    const key = token.toLocaleLowerCase("vi");
    const identity = protectedTokens.get(key) || protectedNames.get(key);
    if (identity) return identity;
    if (/^[a-z]$/i.test(token)) return token.toUpperCase();
    if (/^sus\d+$/i.test(token)) return token.toUpperCase();
    const unit = token.match(/^(\d+(?:[.,]\d+)?)(l|w|v|hz)$/i);
    if (unit) return unit[1] + (unit[2].toLowerCase() === "hz" ? "Hz" : unit[2].toUpperCase());
    return key;
  });
  return lower.replace(/\p{L}/u, letter => letter.toLocaleUpperCase("vi"));
}
