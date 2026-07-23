/**
 * Tokens API — SXB-DATA-XXXX-XXXX-XXXX
 * Les tokens sont TOUJOURS générés côté serveur. Ne jamais générer côté client.
 */
import { TokenSXB } from "../types";
import { apiRequest } from "./client";

export async function fetchTokens(): Promise<TokenSXB[]> {
  try {
    const data = await apiRequest<{ tokens: TokenSXB[] }>("/tokens");
    return data.tokens || [];
  } catch (error) {
    console.error("Error fetching tokens:", error);
    return [];
  }
}

export async function fetchTokenById(id: string): Promise<TokenSXB | null> {
  try {
    return await apiRequest<TokenSXB>(`/tokens/${id}`);
  } catch (error) {
    console.error("Error fetching token:", error);
    return null;
  }
}

export async function createToken(tokenData: {
  clientId: string;
  quotaGb: number;
  durationDays: number;
  deviceLimit?: number;
}): Promise<TokenSXB> {
  return await apiRequest<TokenSXB>("/tokens", {
    method: "POST",
    body: tokenData,
  });
}

export async function updateToken(id: string, updates: Partial<TokenSXB>): Promise<TokenSXB> {
  return await apiRequest<TokenSXB>(`/tokens/${id}`, {
    method: "PATCH",
    body: updates,
  });
}

export async function revokeToken(id: string): Promise<TokenSXB> {
  return await apiRequest<TokenSXB>(`/tokens/${id}/revoke`, {
    method: "POST",
  });
}
