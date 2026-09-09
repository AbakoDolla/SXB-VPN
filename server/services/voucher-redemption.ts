import { synchroniserEtatAccesClient } from "./client-access-state";
import { executerMutationQuota } from "./reseller-quota";

export class VoucherRedemptionError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "VoucherRedemptionError";
  }
}

export async function appliquerVoucherAuClient(
  db: any,
  params: {
    voucherId: string;
    clientId: string;
    resellerId?: string | null;
    resellerUserId?: string | null;
    actorUserId?: string | null;
    actorEmail?: string | null;
  }
) {
  const now = new Date();
  return executerMutationQuota(
    db,
    {
      resellerId: params.resellerId,
      resellerUserId: params.resellerUserId,
      auteur: { userId: params.actorUserId, email: params.actorEmail },
      reason: "Activation d'un voucher sur un client",
      referenceType: "voucher",
      referenceId: params.voucherId,
    },
    async (tx) => {
      const [voucher, client] = await Promise.all([
        tx.voucher.findUnique({ where: { id: params.voucherId } }),
        tx.vpnClient.findUnique({
          where: { id: params.clientId },
          select: {
            id: true,
            userId: true,
            status: true,
            quotaTotal: true,
            expireAt: true,
            resellerId: true,
            subscriptions: { select: { id: true } },
          },
        }),
      ]);

      if (!voucher) {
        throw new VoucherRedemptionError(
          "errors.vouchers.not_found",
          404,
          "Code voucher introuvable"
        );
      }
      if (!client) {
        throw new VoucherRedemptionError(
          "errors.clients.not_found",
          404,
          "Compte VPN introuvable"
        );
      }
      const actualOwner = client.resellerId
        ? client.resellerId === params.resellerId
        : !params.resellerId || client.userId === params.resellerUserId;
      if (!actualOwner || !["active", "expired"].includes(client.status)) {
        throw new VoucherRedemptionError("errors.vouchers.client_unavailable", 409, "Le client a été réattribué ou suspendu.");
      }
      if (voucher.resellerId && voucher.resellerId !== params.resellerId) {
        throw new VoucherRedemptionError(
          "errors.vouchers.not_found",
          404,
          "Code voucher introuvable"
        );
      }
      if (!voucher.resellerId && voucher.expiresAt) {
        throw new VoucherRedemptionError("errors.vouchers.owner_missing", 409, "L'agrément propriétaire de ce voucher a été retiré.");
      }
      if (
        voucher.isRedeemed ||
        voucher.status === "used" ||
        voucher.status === "revoked"
      ) {
        throw new VoucherRedemptionError(
          "errors.vouchers.already_redeemed",
          409,
          "Ce voucher a déjà été utilisé ou révoqué"
        );
      }
      if (voucher.expiresAt && new Date(voucher.expiresAt).getTime() <= now.getTime()) {
        throw new VoucherRedemptionError(
          "errors.vouchers.expired",
          410,
          "Ce voucher a expiré"
        );
      }
      if ((client.subscriptions || []).length > 0) {
        throw new VoucherRedemptionError(
          "errors.vouchers.subscription_required",
          409,
          "Ce client possède déjà un forfait. Utilisez un jeton data lié explicitement à ce forfait."
        );
      }

      const consumed = await tx.voucher.updateMany({
        where: {
          id: voucher.id,
          isRedeemed: false,
          status: "active",
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        data: {
          isRedeemed: true,
          status: "used",
          redeemedBy: params.actorUserId ?? null,
          redeemedClientId: client.id,
        },
      });
      if (consumed.count !== 1) {
        throw new VoucherRedemptionError(
          "errors.vouchers.state_changed",
          409,
          "Ce voucher vient d'être utilisé, révoqué ou a expiré."
        );
      }

      const currentExpiry = client.expireAt
        ? new Date(client.expireAt).getTime()
        : Number.NaN;
      const baseExpiry = Number.isFinite(currentExpiry) && currentExpiry > now.getTime()
        ? currentExpiry
        : now.getTime();
      const expireAt = new Date(
        baseExpiry + Number(voucher.durationDays) * 24 * 60 * 60 * 1000
      );
      const updatedClient = await tx.vpnClient.update({
        where: { id: client.id },
        data: {
          quotaTotal: BigInt(client.quotaTotal ?? 0) + BigInt(voucher.quota ?? 0),
          expireAt,
          status: "active",
        },
      });
      await synchroniserEtatAccesClient(tx, client.id, "active");

      return { voucher, client: updatedClient };
    }
  );
}
