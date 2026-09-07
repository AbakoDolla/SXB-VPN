import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mobileHealthReportSchema,
  pseudonymizeMobileDevice,
  summarizeMobileHealth,
} from "../services/mobile-health";

const validReport = {
  reportId: "550e8400-e29b-41d4-a716-446655440000",
  appVersion: "1.2.1",
  versionCode: 8,
  androidApi: 35,
  deviceModel: "Pixel 8",
  tunnelState: "connected",
  protocol: "vless",
  outcome: "success",
  errorCode: null,
  sessionDurationSeconds: 125,
  reconnectCount: 1,
  activeDurationSeconds: 60,
  backgroundDurationSeconds: 30,
  wakeCount: 1,
  batteryOptimization: "optimized",
};

describe("mobile health privacy contract", () => {
  it("accepts only the minimal allowlisted payload", () => {
    assert.equal(mobileHealthReportSchema.safeParse(validReport).success, true);
    for (const forbidden of ["host", "ip", "payload", "credentials", "rawLog"]) {
      const parsed = mobileHealthReportSchema.safeParse({ ...validReport, [forbidden]: "secret" });
      assert.equal(parsed.success, false, `${forbidden} must be rejected`);
    }
  });

  it("accepts only non-sensitive error codes", () => {
    const parsed = mobileHealthReportSchema.safeParse({
      ...validReport,
      outcome: "failure",
      errorCode: "dial tcp 10.0.0.1:443 with password=secret",
    });
    assert.equal(parsed.success, false);
  });

  it("creates a stable non-reversible pseudonym", () => {
    const first = pseudonymizeMobileDevice("user-a", "SXBDEVICE123456789", "0123456789abcdef0123456789abcdef");
    const second = pseudonymizeMobileDevice("user-a", "SXBDEVICE123456789", "0123456789abcdef0123456789abcdef");
    assert.equal(first, second);
    assert.equal(first.length, 22);
    assert.equal(first.includes("user-a"), false);
    assert.equal(first.includes("DEVICE"), false);
  });
});

describe("mobile health aggregation", () => {
  it("computes activity, versions, failures and updates without identifiers", () => {
    const now = new Date("2026-09-07T04:00:00.000Z");
    const summary = summarizeMobileHealth([
      {
        pseudonym: "anon-a",
        appVersion: "1.2.1",
        versionCode: 8,
        androidApi: 35,
        deviceModel: "Pixel 8",
        lastSeenAt: new Date("2026-09-07T03:00:00.000Z"),
        tunnelState: "connected",
        protocol: "vless",
        lastOutcome: "success",
        lastErrorCode: null,
        sessionDurationSeconds: 100,
        reconnectCount: 1,
        activeDurationSeconds: 60,
        backgroundDurationSeconds: 40,
        wakeCount: 2,
        reportCount: 3,
        batteryOptimization: "optimized",
      },
      {
        pseudonym: "anon-b",
        appVersion: "1.1.0",
        versionCode: 7,
        androidApi: 33,
        deviceModel: null,
        lastSeenAt: new Date("2026-09-01T03:00:00.000Z"),
        tunnelState: "error",
        protocol: "ssh",
        lastOutcome: "failure",
        lastErrorCode: "TUNNEL_TIMEOUT",
        sessionDurationSeconds: 20,
        reconnectCount: 2,
        activeDurationSeconds: 20,
        backgroundDurationSeconds: 80,
        wakeCount: 1,
        reportCount: 2,
        batteryOptimization: "unknown",
      },
    ], 8, [
      { outcome: "success", count: 3 },
      { outcome: "failure", count: 1 },
      { outcome: "none", count: 2 },
    ], now);

    assert.deepEqual(summary.totals, {
      devices: 2,
      active: 1,
      inactive: 1,
      reports: 6,
      successes: 3,
      failures: 1,
      successRate: 75,
      updatesNeeded: 1,
    });
    assert.equal(summary.devices[1].needsUpdate, true);
    assert.equal("host" in summary.devices[0], false);
    assert.equal("ip" in summary.devices[0], false);
  });
});
