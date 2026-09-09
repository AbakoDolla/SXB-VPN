import { randomInt } from "node:crypto";

export function makeUserToken(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const part = () => Array.from({ length: 4 }, () => chars[randomInt(chars.length)]).join("");
  return `SXB-USER-${part()}-${part()}-${part()}`;
}

export function renewedDeviceExpiry(expireAt: Date | string | null, durationDays: number): Date {
  return new Date(Math.max(Date.now(), expireAt ? new Date(expireAt).getTime() : 0) + durationDays * 86_400_000);
}
