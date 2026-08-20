export type DeviceUsage = {
  download?: bigint | number;
  upload?: bigint | number;
  lastSeenAt?: Date | null;
};

/** Select the subscription authoritative for one device. */
export function selectDeviceSubscription(client: any): any | null {
  const subscriptions = Array.isArray(client?.subscriptions) ? client.subscriptions : [];
  const deviceId = client?.deviceId ? String(client.deviceId) : null;
  const isActive = (sub: any) => sub?.status === "active";
  const isExactDevice = (sub: any) => {
    if (!deviceId) return false;
    if (sub?.deviceId && String(sub.deviceId) === deviceId) return true;
    return Array.isArray(sub?.devices) && sub.devices.some((binding: any) => String(binding?.deviceId || "") === deviceId);
  };
  const priority = (sub: any) => (
    isExactDevice(sub)
      ? 4
      : isActive(sub) && !sub?.deviceId && !(sub?.devices?.length)
        ? 3
        : isActive(sub) ? 2 : 1
  );
  return [...subscriptions].sort((a, b) => {
    const scoreDiff = priority(b) - priority(a);
    if (scoreDiff !== 0) return scoreDiff;
    const aDate = new Date(a?.lastProvisionAt || a?.createdAt || 0).getTime();
    const bDate = new Date(b?.lastProvisionAt || b?.createdAt || 0).getTime();
    return bDate - aDate;
  })[0] || null;
}

export function sanitizeDevice(c: any, usage?: DeviceUsage, subscription?: any | null) {
  const selected = subscription ?? selectDeviceSubscription(c);
  const quotaTotal = Number(selected?.quotaBytes ?? c.quotaTotal ?? 0);
  const quotaUsed = Number(selected?.quotaUsed ?? c.quotaUsed ?? 0);
  const trafficDownload = Number(usage?.download ?? 0);
  const trafficUpload = Number(usage?.upload ?? 0);
  return {
    id: c.id,
    deviceId: c.deviceId,
    token: c.token,
    status: c.status,
    expireAt: selected?.expireAt ?? c.expireAt,
    activatedAt: c.activatedAt,
    createdAt: c.createdAt,
    label: c.user?.name || null,
    subscriptionId: selected?.id ?? null,
    subscriptionName: selected?.name ?? null,
    quotaSource: selected ? "subscription" : "client",
    quotaTotal: quotaTotal.toString(),
    quotaUsed: quotaUsed.toString(),
    quotaRemaining: Math.max(quotaTotal - quotaUsed, 0).toString(),
    trafficDownload: trafficDownload.toString(),
    trafficUpload: trafficUpload.toString(),
    trafficTotal: (trafficDownload + trafficUpload).toString(),
    lastTrafficAt: usage?.lastSeenAt ? new Date(usage.lastSeenAt).toISOString() : null,
  };
}
