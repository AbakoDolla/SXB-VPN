import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const configSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z.string().optional(),
  JWT_SECRET: z.string().default("sxb-vpn-jwt-secure-access-token-key-for-saas-platform"),
  REFRESH_SECRET: z.string().default("sxb-vpn-jwt-secure-refresh-token-key-for-saas-platform"),
  ENCRYPTION_KEY: z.string().length(32, "Encryption key must be exactly 32 characters").default("sxb-vpn-32-byte-encryption-key-!"),
});

const parsed = configSchema.safeParse(process.env);

if (!parsed.success) {
  console.warn("⚠️ Configuration Validation Warnings:", parsed.error.format());
}

export const config = parsed.success ? parsed.data : configSchema.parse({
  PORT: 3000,
  NODE_ENV: "development",
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: process.env.JWT_SECRET || "sxb-vpn-jwt-secure-access-token-key-for-saas-platform",
  REFRESH_SECRET: process.env.REFRESH_SECRET || "sxb-vpn-jwt-secure-refresh-token-key-for-saas-platform",
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || "sxb-vpn-32-byte-encryption-key-!",
});
