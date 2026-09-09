export async function synchroniserEtatAccesClient(
  tx: any,
  clientId: string,
  status: string,
  options: { deviceId?: string | null; expireAt?: Date | null } = {},
): Promise<void> {
  const activeBinding = status === "active"
    ? options.deviceId ?? (await tx.vpnClient.findUnique({ where: { id: clientId }, select: { deviceId: true } }))?.deviceId
    : null;
  const binding = status === "active" ? { deviceId: activeBinding ?? "" } : {};
  await tx.activationSession.updateMany({
    where: { clientId, ...binding },
    data: { status, ...(options.expireAt !== undefined ? { expirationDate: options.expireAt } : {}) },
  });
  await tx.appRegistration.updateMany({
    where: { clientId, ...binding },
    data: { status: status === "active" ? "matched" : status },
  });
}

export async function dissocierAccesClient(tx: any, clientId: string): Promise<void> {
  await tx.appRegistration.updateMany({
    where: { clientId },
    data: { clientId: null, status: "pending" },
  });
  await tx.activationSession.deleteMany({ where: { clientId } });
}
