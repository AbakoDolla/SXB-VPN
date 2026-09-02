import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const configSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z.string().min(1).optional(),
  FRONTEND_URL: z.url().default("https://vpnsxb.afrihall.com"),
  JWT_SECRET: z.string().min(32, "JWT secret must contain at least 32 characters"),
  REFRESH_SECRET: z.string().min(32, "Refresh secret must contain at least 32 characters"),
  ENCRYPTION_KEY: z.string().length(32, "Encryption key must be exactly 32 characters"),
}).superRefine((value, context) => {
  if (value.NODE_ENV === "production" && !value.DATABASE_URL) {
    context.addIssue({
      code: "custom",
      path: ["DATABASE_URL"],
      message: "DATABASE_URL is required in production",
    });
  }
});

export function loadConfig(environment: NodeJS.ProcessEnv) {
  const isProduction = environment.NODE_ENV === "production";
  const parsed = configSchema.safeParse({
    ...environment,
    JWT_SECRET: environment.JWT_SECRET || (isProduction ? undefined : "dev-only-access-token-key-32-bytes"),
    REFRESH_SECRET:
      environment.REFRESH_SECRET ||
      environment.JWT_REFRESH_SECRET ||
      (isProduction ? undefined : "dev-only-refresh-token-key-32-byte"),
    ENCRYPTION_KEY: environment.ENCRYPTION_KEY || (isProduction ? undefined : "dev-only-encryption-key-32-byte!"),
  });

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "configuration"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid SXB configuration: ${details}`);
  }

  return parsed.data;
}

export const config = loadConfig(process.env);
