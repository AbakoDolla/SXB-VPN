import { apiRequest } from "./client";

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

export interface Voucher {
  id: string;
  code: string;
  quota: string; // BigInt serialisé en string (bytes)
  durationDays: number;
  isRedeemed: boolean;
  redeemedBy?: string | null;
  createdAt: string;
  updatedAt: string;
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

// Activation simple d un voucher par l utilisateur connecte (sans clientId requis)
export async function useVoucher(
  code: string
): Promise<{ success: boolean; message?: string }> {
  return await apiRequest<{ success: boolean; message?: string }>("/vouchers/use", {
    method: "POST",
    body: { code },
  });
}
