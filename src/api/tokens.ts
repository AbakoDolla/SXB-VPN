import { TokenSXB } from "../types";
import { getTokens, saveTokens, getCurrentUser, logActivity } from "./db";

export function generateTokenCode(): string {
  // Returns a code in the exact format requested: SXB-XXXX-XXXX-XXXX
  const segment = () => Math.random().toString(36).substring(2, 6).toUpperCase();
  return `SXB-${segment()}-${segment()}-${segment()}`;
}

export async function fetchTokens(): Promise<TokenSXB[]> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(getTokens());
    }, 200);
  });
}

export async function createToken(tokenData: Omit<TokenSXB, "id" | "code" | "status">): Promise<TokenSXB> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const tokens = getTokens();
      const newToken: TokenSXB = {
        ...tokenData,
        id: `token-${Date.now()}`,
        code: generateTokenCode(),
        status: "active",
      };
      
      saveTokens([...tokens, newToken]);
      const actor = getCurrentUser().name;
      logActivity(`Génération du token SXB: ${newToken.code}`, actor, "success");
      resolve(newToken);
    }, 250);
  });
}

export async function updateToken(id: string, updates: Partial<TokenSXB>): Promise<TokenSXB> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      const tokens = getTokens();
      const index = tokens.findIndex((t) => t.id === id);
      if (index === -1) return reject(new Error("Token non trouvé"));
      
      const updated = { ...tokens[index], ...updates };
      tokens[index] = updated;
      saveTokens(tokens);
      
      const actor = getCurrentUser().name;
      logActivity(`Mise à jour du token ${updated.code}`, actor, "info");
      resolve(updated);
    }, 200);
  });
}

export async function revokeToken(id: string): Promise<TokenSXB> {
  return updateToken(id, { status: "revoked" });
}
