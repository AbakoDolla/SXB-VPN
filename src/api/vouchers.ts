import { Voucher } from "../types";
import { getVouchers, saveVouchers, getCurrentUser, logActivity } from "./db";

export function generateVoucherCode(): string {
  const segment = () => Math.random().toString(36).substring(2, 7).toUpperCase();
  return `VCH-${segment()}-${segment()}`;
}

export async function fetchVouchers(): Promise<Voucher[]> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(getVouchers());
    }, 150);
  });
}

export async function createVoucher(data: Omit<Voucher, "id" | "code" | "status">): Promise<Voucher> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const vouchers = getVouchers();
      const newVoucher: Voucher = {
        ...data,
        id: `voucher-${Date.now()}`,
        code: generateVoucherCode(),
        status: "active",
      };
      
      saveVouchers([...vouchers, newVoucher]);
      const actor = getCurrentUser().name;
      logActivity(`Création du Voucher prépayé: ${newVoucher.code}`, actor, "success");
      resolve(newVoucher);
    }, 200);
  });
}

export async function useVoucher(code: string): Promise<Voucher> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      const vouchers = getVouchers();
      const index = vouchers.findIndex((v) => v.code === code);
      if (index === -1) return reject(new Error("Voucher invalide ou introuvable"));
      
      const voucher = vouchers[index];
      if (voucher.status !== "active") {
        return reject(new Error(`Ce voucher ne peut pas être activé car il est déjà ${voucher.status}`));
      }
      
      voucher.status = "used";
      vouchers[index] = voucher;
      saveVouchers(vouchers);
      
      const actor = getCurrentUser().name;
      logActivity(`Activation réussie du Voucher: ${code} (+${voucher.quota} Go)`, actor, "success");
      resolve(voucher);
    }, 250);
  });
}
