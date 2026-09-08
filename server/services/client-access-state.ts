export async function synchroniserEtatAccesClient(
  tx: any,
  clientId: string,
  status: string
): Promise<void> {
  await tx.activationSession.updateMany({
    where: { clientId },
    data: { status },
  });
  await tx.appRegistration.updateMany({
    where: { clientId },
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
