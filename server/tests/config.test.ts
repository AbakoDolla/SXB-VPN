import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../config";

const productionEnvironment = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://127.0.0.1:5432/database",
  JWT_SECRET: "production-access-secret-with-32-chars",
  ENCRYPTION_KEY: "production-encryption-key-32-cha",
} satisfies NodeJS.ProcessEnv;

test("production configuration requires secrets and a database", () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: "production" }),
    /JWT_SECRET.*REFRESH_SECRET.*ENCRYPTION_KEY/,
  );
  assert.throws(
    () => loadConfig({
      ...productionEnvironment,
      DATABASE_URL: undefined,
      REFRESH_SECRET: "production-refresh-secret-with-32-chars",
    }),
    /DATABASE_URL/,
  );
});

test("JWT_REFRESH_SECRET remains a supported refresh-secret alias", () => {
  const loaded = loadConfig({
    ...productionEnvironment,
    JWT_REFRESH_SECRET: "production-refresh-secret-with-32-chars",
  });

  assert.equal(loaded.REFRESH_SECRET, "production-refresh-secret-with-32-chars");
});

test("REFRESH_SECRET takes precedence over its legacy alias", () => {
  const loaded = loadConfig({
    ...productionEnvironment,
    REFRESH_SECRET: "preferred-production-refresh-secret-32",
    JWT_REFRESH_SECRET: "legacy-production-refresh-secret-32",
  });

  assert.equal(loaded.REFRESH_SECRET, "preferred-production-refresh-secret-32");
});
