/**
 * Tokens API — SXB-XXXX-XXXX-XXXX (recharge de compte, distincte des forfaits)
 * Les tokens sont TOUJOURS générés côté serveur. Ne jamais générer côté client.
 *
 * `fetchTokenById` et `updateToken` ont été retirés : aucun appelant, et les
 * routes visées n'existent pas. Le serveur n'expose aucun PATCH sur ce routeur,
 * et son `GET /api/tokens/:token` cherche par CHAÎNE de jeton
 * (`findUnique({ where: { token } })`), pas par identifiant — les deux
 * fonctions répondaient donc 404 à chaque appel.
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

export async function revokeToken(id: string): Promise<TokenSXB> {
  return await apiRequest<TokenSXB>(`/tokens/${id}/revoke`, {
    method: "POST",
  });
}
