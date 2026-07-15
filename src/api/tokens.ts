import { TokenSXB } from "../types";
import { apiRequest } from "./client";

export function generateTokenCode(): string {
  const segment = () => Math.random().toString(36).substring(2, 6).toUpperCase();
  return `SXB-${segment()}-${segment()}-${segment()}`;
}

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
  planName: string;
  quotaGb: number;
  durationDays: number;
  price?: number;
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

export async function assignTokenToClient(tokenId: string, clientId: string): Promise<TokenSXB> {
  return await apiRequest<TokenSXB>(`/tokens/${tokenId}/assign`, {
    method: "POST",
    body: { clientId },
  });
}
