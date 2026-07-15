import { Voucher } from "../types";
import { apiRequest } from "./client";

export function generateVoucherCode(): string {
  const segment = () => Math.random().toString(36).substring(2, 7).toUpperCase();
  return `VCH-${segment()}-${segment()}`;
}

export async function fetchVouchers(): Promise<Voucher[]> {
  try {
    const data = await apiRequest<{ vouchers: Voucher[] }>("/vouchers");
    return data.vouchers || [];
  } catch (error) {
    console.error("Error fetching vouchers:", error);
    return [];
  }
}

export async function createVoucher(data: {
  quotaGb: number;
  durationDays: number;
  count?: number;
}): Promise<Voucher[]> {
  const response = await apiRequest<{ vouchers: Voucher[] }>("/vouchers", {
    method: "POST",
    body: data,
  });
  return response.vouchers || [];
}

export async function redeemVoucher(code: string): Promise<{ success: boolean; message: string; quotaAdded?: number }> {
  return await apiRequest<{ success: boolean; message: string; quotaAdded?: number }>(`/vouchers/redeem`, {
    method: "POST",
    body: { code },
  });
}
