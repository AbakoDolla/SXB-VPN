import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeDevice as sanitize, selectDeviceSubscription } from "../../../server/services/device-quota.ts";

test("devices: la souscription liée explicitement à l'appareil est prioritaire", () => {
  const client = {
    id: "client-1",
    deviceId: "device-1",
    quotaTotal: 0n,
    quotaUsed: 999n,
    expireAt: null,
    subscriptions: [
      {
        id: "sub-unbound",
        name: "Plan global récent",
        status: "active",
        quotaBytes: 20_000n,
        quotaUsed: 2_000n,
        createdAt: new Date("2026-08-20T10:00:00Z"),
        deviceId: null,
        devices: [],
      },
      {
        id: "sub-device",
        name: "Plan appareil",
        status: "active",
        quotaBytes: 10_000n,
        quotaUsed: 1_000n,
        createdAt: new Date("2026-08-19T10:00:00Z"),
        deviceId: "device-1",
        devices: [],
        expireAt: new Date("2026-09-19T10:00:00Z"),
      },
    ],
  };

  const selected = selectDeviceSubscription(client);
  assert.equal(selected?.id, "sub-device");
  const result = sanitize(client, { download: 700n, upload: 300n }, selected);
  assert.equal(result.quotaSource, "subscription");
  assert.equal(result.subscriptionId, "sub-device");
  assert.equal(result.quotaTotal, "10000");
  assert.equal(result.quotaUsed, "1000");
  assert.equal(result.quotaRemaining, "9000");
  assert.equal(result.trafficTotal, "1000");
  assert.equal(result.expireAt?.toISOString(), "2026-09-19T10:00:00.000Z");
});

test("devices: SubscriptionDevice lie l'appareil quand subscription.deviceId est nul", () => {
  const selected = selectDeviceSubscription({
    deviceId: "device-2",
    subscriptions: [
      {
        id: "sub-other",
        status: "active",
        quotaBytes: 20n,
        quotaUsed: 1n,
        deviceId: null,
        devices: [{ deviceId: "device-other" }],
      },
      {
        id: "sub-bound",
        status: "active",
        quotaBytes: 30n,
        quotaUsed: 2n,
        deviceId: null,
        devices: [{ deviceId: "device-2" }],
      },
    ],
  });
  assert.equal(selected?.id, "sub-bound");
});

test("devices: sans souscription, sanitize conserve le quota legacy du client", () => {
  const result = sanitize({
    id: "client-legacy",
    deviceId: "device-legacy",
    quotaTotal: 500n,
    quotaUsed: 125n,
    subscriptions: [],
  }, { download: 80n, upload: 20n });
  assert.equal(result.quotaSource, "client");
  assert.equal(result.quotaTotal, "500");
  assert.equal(result.quotaUsed, "125");
  assert.equal(result.quotaRemaining, "375");
});
