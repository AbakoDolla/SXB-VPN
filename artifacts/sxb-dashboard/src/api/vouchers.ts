import { apiRequest } from "./client";
import type { Voucher } from "../types";
export type { Voucher } from "../types";

// Génère un code voucher unique en utilisant crypto (pas Math.random)
export function generateVoucherCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const array = new Uint8Array(10);
  crypto.getRandomValues(array);
  const part = (start: number, len: number) =>
    Array.from(array.slice(start, start + len))
      .map((b) => chars[b % chars.length])
      .join("");
  return `VCH-${part(0, 5)}-${part(5, 5)}`;
}

export async function fetchVouchers(): Promise<Voucher[]> {
  const data = await apiRequest<{ vouchers: Voucher[] }>("/vouchers");
  return data.vouchers;
}

export async function createVoucher(data: {
  quotaGb: number;
  durationDays: number;
  activationDays: number;
  resellerId?: string;
  count?: number; // Nombre de vouchers à créer (défaut 1)
}): Promise<{ vouchers: Voucher[] }> {
  return await apiRequest<{ vouchers: Voucher[] }>("/vouchers", {
    method: "POST",
    body: data,
  });
}

export async function redeemVoucher(
  code: string,
  clientId: string
): Promise<{ success: boolean; message: string; quotaAdded?: number }> {
  return await apiRequest<{ success: boolean; message: string; quotaAdded?: number }>("/vouchers/redeem", {
    method: "POST",
    body: { code, clientId },
  });
}

export async function revokeVoucher(id: string): Promise<Voucher> {
  return apiRequest<Voucher>(`/vouchers/${id}/revoke`, { method: "POST" });
}
