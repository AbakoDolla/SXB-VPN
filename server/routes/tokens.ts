import { randomInt, randomUUID } from "crypto";
import { Response, Router } from "express";
import { z } from "zod";
import { inMemoryDb, logDbActivity, prisma } from "../database";
import { AuthenticatedRequest, requireAuth, requirePermission } from "../middleware/auth";
import { synchroniserEtatAccesClient } from "../services/client-access-state";
import {
  chargerFicheProprietaireClient,
  chargerFicheRevendeur,
  exigerAccesRevendeur,
  interdireMutationSupport,
  porteeClientsRevendeur,
  possedeClient,
  refusPourEtatAcces,
  refusPropriete,
  reponsePlafondDepasse,
  resumerAccesRevendeur,
} from "../services/reseller-access";
import {
  executerMutationQuota,
  PlafondQuotaDepasse,
  verifierPlafond,
} from "../services/reseller-quota";

const router = Router();
const GIB = BigInt(1024) ** BigInt(3);
const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_TOKEN_CREATION_ATTEMPTS = 10;

const generateTokenSchema = z.object({
  clientId: z.string().trim().min(1),
  quotaGb: z.coerce.number().int().min(1).max(1_000_000).default(50),
  durationDays: z.coerce.number().int().min(1).max(3_650).default(30),
  deviceLimit: z.coerce.number().int().min(1).max(10).default(1),
}).strict();

const validateTokenSchema = z.object({
  token: z.string()
    .trim()
    .transform((value) => value.toUpperCase())
    .refine(
      (value) => /^SXB-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(value),
      "Invalid SXB token format"
    ),
}).strict();

type RouteRefusal = { status: number; body: Record<string, unknown> };
type TokenTarget = { client: any; fiche: any };

class TokenStateConflict extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "TokenStateConflict";
  }
}

function sanitizeValue(value: any, depth = 0): any {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1));

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "passwordHash" && !(depth > 0 && key === "token"))
      .map(([key, item]) => [key, sanitizeValue(item, depth + 1)])
  );
}

function sanitizeToken(token: any) {
  if (!token) return null;
  const expiration = token.expiration ? new Date(token.expiration).getTime() : null;
  const status =
    token.status === "active" &&
    expiration !== null &&
    !Number.isNaN(expiration) &&
    expiration <= Date.now()
      ? "expired"
      : token.status;
  return sanitizeValue({ ...token, status, quota: BigInt(token.quota ?? 0) });
}

function makeSxbToken(): string {
  const part = () =>
    Array.from(
      { length: 4 },
      () => TOKEN_ALPHABET[randomInt(0, TOKEN_ALPHABET.length)]
    ).join("");
  return `SXB-${part()}-${part()}-${part()}`;
}

function isTokenCollision(error: any): boolean {
  if (error?.code !== "P2002") return false;
  const target = Array.isArray(error?.meta?.target)
    ? error.meta.target.join(",")
    : String(error?.meta?.target ?? "");
  return !target || target.includes("token");
}

function ownerContext(fiche: any) {
  return {
    resellerId: fiche?.id ?? null,
    resellerUserId: fiche?.userId ?? null,
  };
}

async function chargerCibleToken(
  req: AuthenticatedRequest,
  clientId: string,
  demandeQuota?: bigint,
  options: { verifierAcces?: boolean } = { verifierAcces: true }
): Promise<TokenTarget | RouteRefusal> {
  const client = prisma
    ? await prisma.vpnClient.findUnique({
        where: { id: clientId },
        select: {
          id: true,
          userId: true,
          resellerId: true,
          status: true,
          expireAt: true,
          quotaTotal: true,
          deviceLimit: true,
        },
      })
    : inMemoryDb.vpnClients.find((candidate: any) => candidate.id === clientId);

  if (!client) {
    return {
      status: 404,
      body: { error: "errors.clients.not_found", message: "Client VPN introuvable" },
    };
  }

  const fiche = await chargerFicheProprietaireClient(prisma, client);
  if (req.user?.role === "RESELLER") {
    const ownRecord =
      (req as any).reseller ??
      (await chargerFicheRevendeur(prisma, req.user.userId));
    if (!possedeClient(client, ownRecord)) return refusPropriete();
  }
  if (!fiche && client.resellerId) {
    return {
      status: 403,
      body: {
        error: "errors.resellers.not_found",
        message: "Aucun revendeur propriétaire : impossible d'attribuer du quota.",
      },
    };
  }

  if (fiche && options.verifierAcces !== false) {
    const accessError = refusPourEtatAcces(resumerAccesRevendeur(fiche));
    if (accessError) return accessError;
  }

  if (prisma && fiche && demandeQuota !== undefined) {
    const quotaError = await verifierPlafond(prisma, fiche, demandeQuota);
    if (quotaError) return quotaError;
  }

  return { client, fiche };
}

function isRouteRefusal(result: TokenTarget | RouteRefusal): result is RouteRefusal {
  return "status" in result && "body" in result;
}

/** Portée de lecture des jetons pour un revendeur (propriété du client). */
async function porteeTokens(req: AuthenticatedRequest) {
  if (req.user?.role !== "RESELLER") return undefined;
  const fiche =
    (req as any).reseller ??
    (await chargerFicheRevendeur(prisma, req.user.userId));
  return { client: porteeClientsRevendeur(fiche) } as any;
}

async function creerToken(req: AuthenticatedRequest, res: Response) {
  try {
    const body = generateTokenSchema.parse(req.body);
    const quotaBytes = BigInt(body.quotaGb) * GIB;
    const target = await chargerCibleToken(req, body.clientId, quotaBytes);
    if (isRouteRefusal(target)) return res.status(target.status).json(target.body);

    const expiration = new Date();
    expiration.setUTCDate(expiration.getUTCDate() + body.durationDays);

    let newToken: any = null;
    if (prisma) {
      for (let attempt = 0; attempt < MAX_TOKEN_CREATION_ATTEMPTS; attempt += 1) {
        const id = randomUUID();
        const token = makeSxbToken();
        try {
          newToken = await executerMutationQuota(
            prisma,
            {
              ...ownerContext(target.fiche),
              auteur: { userId: req.user?.userId, email: req.user?.email },
              reason: "Création d'un jeton d'attribution",
              referenceType: "token",
              referenceId: id,
            },
            (tx) =>
              tx.tokenSXB.create({
                data: {
                  id,
                  token,
                  clientId: body.clientId,
                  quota: quotaBytes,
                  expiration,
                  deviceLimit: body.deviceLimit,
                  status: "active",
                },
              })
          );
          break;
        } catch (error) {
          if (!isTokenCollision(error)) throw error;
        }
      }
      if (!newToken) {
        return res.status(503).json({
          error: "errors.tokens.generation_failed",
          message: "Impossible de générer un jeton unique. Veuillez réessayer.",
        });
      }
    } else {
      let token = makeSxbToken();
      for (
        let attempt = 1;
        inMemoryDb.tokens.some((candidate: any) => candidate.token === token) &&
        attempt < MAX_TOKEN_CREATION_ATTEMPTS;
        attempt += 1
      ) {
        token = makeSxbToken();
      }
      if (inMemoryDb.tokens.some((candidate: any) => candidate.token === token)) {
        return res.status(503).json({
          error: "errors.tokens.generation_failed",
          message: "Impossible de générer un jeton unique. Veuillez réessayer.",
        });
      }
      newToken = {
        id: randomUUID(),
        token,
        clientId: body.clientId,
        quota: quotaBytes,
        expiration,
        deviceLimit: body.deviceLimit,
        status: "active",
        createdAt: new Date(),
      };
      inMemoryDb.tokens.push(newToken);
    }

    await logDbActivity(
      req.user?.userId || null,
      `Created SXB Token ID: ${newToken.id} for Client ID: ${body.clientId}`,
      "success",
      req.ip
    );
    return res.status(201).json(sanitizeToken(newToken));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "errors.validation", message: error.issues });
    }
    if (error instanceof PlafondQuotaDepasse) {
      return res.status(409).json(reponsePlafondDepasse(error.alloue, error.plafond));
    }
    console.error("Token creation error:", error);
    return res.status(500).json({ error: "errors.server", message: "Failed to create token" });
  }
}

async function revoquerToken(req: AuthenticatedRequest, res: Response) {
  try {
    const { id } = req.params;
    let updated: any = null;

    if (prisma) {
      const existing = await prisma.tokenSXB.findUnique({
        where: { id },
        include: { client: true },
      });
      if (!existing) return res.status(404).json({ error: "errors.tokens.not_found" });

      if (
        req.user?.role === "RESELLER" &&
        !possedeClient(
          existing.client,
          (req as any).reseller ??
            (await chargerFicheRevendeur(prisma, req.user.userId))
        )
      ) {
        return res.status(404).json({ error: "errors.tokens.not_found" });
      }
      if (existing.status === "used") {
        return res.status(409).json({
          error: "errors.tokens.already_applied",
          message: "Ce jeton a déjà été appliqué au client et ne peut plus être révoqué.",
        });
      }
      if (existing.status === "revoked") return res.json(sanitizeToken(existing));

      const expiration = new Date(existing.expiration).getTime();
      if (
        existing.status === "expired" ||
        (!Number.isNaN(expiration) && expiration <= Date.now())
      ) {
        await prisma.tokenSXB.updateMany({
          where: { id, status: "active" },
          data: { status: "expired" },
        });
        return res.status(409).json({
          error: "errors.tokens.expired",
          message: "Ce jeton est déjà expiré.",
        });
      }

      const target = await chargerCibleToken(
        req,
        existing.clientId,
        undefined,
        { verifierAcces: false }
      );
      if (isRouteRefusal(target)) return res.status(target.status).json(target.body);

      updated = await executerMutationQuota(
        prisma,
        {
          ...ownerContext(target.fiche),
          auteur: { userId: req.user?.userId, email: req.user?.email },
          reason: "Révocation d'un jeton non utilisé",
          referenceType: "token",
          referenceId: existing.id,
          autoriserReductionAuDessusDuPlafond: true,
        },
        async (tx) => {
          const result = await tx.tokenSXB.updateMany({
            where: { id, status: "active", expiration: { gt: new Date() } },
            data: { status: "revoked" },
          });
          if (result.count !== 1) {
            throw new TokenStateConflict(
              "errors.tokens.state_changed",
              "Le jeton a déjà été utilisé, révoqué ou expiré."
            );
          }
          return tx.tokenSXB.findUnique({ where: { id } });
        }
      );
    } else {
      const tokenIndex = inMemoryDb.tokens.findIndex((token: any) => token.id === id);
      if (tokenIndex === -1) {
        return res.status(404).json({ error: "errors.tokens.not_found" });
      }
      const existing: any = inMemoryDb.tokens[tokenIndex];
      const client = inMemoryDb.vpnClients.find(
        (candidate: any) => candidate.id === existing.clientId
      );
      if (
        req.user?.role === "RESELLER" &&
        !possedeClient(client, await chargerFicheRevendeur(null, req.user.userId))
      ) {
        return res.status(404).json({ error: "errors.tokens.not_found" });
      }
      if (existing.status === "used") {
        return res.status(409).json({
          error: "errors.tokens.already_applied",
          message: "Ce jeton a déjà été appliqué au client et ne peut plus être révoqué.",
        });
      }
      existing.status = "revoked";
      updated = existing;
    }

    await logDbActivity(
      req.user?.userId || null,
      `Revoked SXB Token ID: ${id}`,
      "warning",
      req.ip
    );
    return res.json(sanitizeToken(updated));
  } catch (error) {
    if (error instanceof TokenStateConflict) {
      return res.status(409).json({ error: error.code, message: error.message });
    }
    console.error("Revoke token error:", error);
    return res.status(500).json({ error: "errors.server", message: "Failed to revoke token" });
  }
}

async function validerToken(req: AuthenticatedRequest, res: Response) {
  try {
    const body = validateTokenSchema.parse(req.body);
    let tokenRecord: any = null;

    if (prisma) {
      tokenRecord = await prisma.tokenSXB.findUnique({
        where: { token: body.token },
        include: { client: true },
      });
    } else {
      const token = inMemoryDb.tokens.find(
        (candidate: any) => candidate.token === body.token
      );
      if (token) {
        const client = inMemoryDb.vpnClients.find(
          (candidate: any) => candidate.id === token.clientId
        );
        tokenRecord = { ...token, client };
      }
    }

    if (!tokenRecord) {
      return res.status(404).json({
        error: "errors.tokens.invalid",
        message: "Invalid activation token",
      });
    }
    if (
      req.user?.role === "RESELLER" &&
      !possedeClient(
        tokenRecord.client,
        await chargerFicheRevendeur(prisma, req.user.userId)
      )
    ) {
      return res.status(404).json({
        error: "errors.tokens.invalid",
        message: "Invalid activation token",
      });
    }
    if (tokenRecord.status !== "active") {
      return res.status(409).json({
        error: "errors.tokens.already_used",
        message: `Token has already been ${tokenRecord.status}`,
      });
    }

    const now = new Date();
    if (new Date(tokenRecord.expiration).getTime() <= now.getTime()) {
      if (prisma) {
        await prisma.tokenSXB.updateMany({
          where: { id: tokenRecord.id, status: "active" },
          data: { status: "expired" },
        });
      } else {
        tokenRecord.status = "expired";
      }
      return res.status(410).json({
        error: "errors.tokens.expired",
        message: "Token has expired",
      });
    }

    const target = await chargerCibleToken(req, tokenRecord.clientId);
    if (isRouteRefusal(target)) return res.status(target.status).json(target.body);

    let updatedToken: any = null;
    if (prisma) {
      updatedToken = await executerMutationQuota(
        prisma,
        {
          ...ownerContext(target.fiche),
          auteur: { userId: req.user?.userId, email: req.user?.email },
          reason: "Application d'un jeton au client",
          referenceType: "token",
          referenceId: tokenRecord.id,
        },
        async (tx) => {
          const consumed = await tx.tokenSXB.updateMany({
            where: {
              id: tokenRecord.id,
              status: "active",
              expiration: { gt: new Date() },
            },
            data: { status: "used" },
          });
          if (consumed.count !== 1) {
            throw new TokenStateConflict(
              "errors.tokens.already_used",
              "Ce jeton a déjà été utilisé ou a expiré."
            );
          }

          const currentClient = await tx.vpnClient.findUnique({
            where: { id: tokenRecord.clientId },
            select: { quotaTotal: true, expireAt: true, status: true, subscriptions: { select: { id: true } } },
          });
          if (!currentClient) {
            throw new TokenStateConflict(
              "errors.clients.not_found",
              "Le client associé au jeton n'existe plus."
            );
          }
          if (currentClient.subscriptions.length) {
            throw new TokenStateConflict(
              "errors.tokens.subscription_required",
              "Ce client possède un forfait : modifiez ce forfait plutôt que son ancien quota client."
            );
          }
          if (currentClient.status === "suspended" || currentClient.status === "revoked") {
            throw new TokenStateConflict("errors.tokens.client_suspended", "Réactivez le client avant d'appliquer un jeton.");
          }
          const currentExpiration = currentClient.expireAt
            ? new Date(currentClient.expireAt)
            : null;
          const tokenExpiration = new Date(tokenRecord.expiration);
          const expireAt =
            currentExpiration && currentExpiration > tokenExpiration
              ? currentExpiration
              : tokenExpiration;

          await tx.vpnClient.update({
            where: { id: tokenRecord.clientId },
            data: {
              quotaTotal:
                BigInt(currentClient.quotaTotal ?? 0) +
                BigInt(tokenRecord.quota ?? 0),
              expireAt,
              deviceLimit: tokenRecord.deviceLimit,
              status: "active",
            },
          });
          await synchroniserEtatAccesClient(
            tx,
            tokenRecord.clientId,
            "active"
          );
          return tx.tokenSXB.findUnique({
            where: { id: tokenRecord.id },
            include: { client: { include: { user: true } } },
          });
        }
      );
    } else {
      const storedToken = inMemoryDb.tokens.find(candidate => candidate.id === tokenRecord.id);
      const client = inMemoryDb.vpnClients.find(
        (candidate: any) => candidate.id === tokenRecord.clientId
      );
      if (!client) {
        return res.status(404).json({ error: "errors.clients.not_found" });
      }
      if (!storedToken || storedToken.status !== "active") {
        return res.status(409).json({ error: "errors.tokens.already_used", message: "Jeton déjà utilisé" });
      }
      storedToken.status = "used";
      tokenRecord.status = "used";
      client.quotaTotal =
        BigInt(client.quotaTotal ?? 0) + BigInt(tokenRecord.quota ?? 0);
      const currentExpiration = client.expireAt ? new Date(client.expireAt) : null;
      const tokenExpiration = new Date(tokenRecord.expiration);
      client.expireAt =
        currentExpiration && currentExpiration > tokenExpiration
          ? currentExpiration
          : tokenExpiration;
      client.deviceLimit = tokenRecord.deviceLimit;
      client.status = "active";
      updatedToken = tokenRecord;
    }

    await logDbActivity(
      req.user?.userId || null,
      `Validated SXB Token ID: ${tokenRecord.id} for Client ID: ${tokenRecord.clientId}`,
      "success",
      req.ip
    );
    return res.json({
      success: true,
      message: "Token validated and applied successfully",
      token: sanitizeToken(updatedToken),
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "errors.validation", message: error.issues });
    }
    if (error instanceof TokenStateConflict || error?.code === "P2034") {
      return res.status(409).json({
        error:
          error instanceof TokenStateConflict
            ? error.code
            : "errors.tokens.already_used",
        message:
          error instanceof TokenStateConflict
            ? error.message
            : "Le jeton a été modifié par une autre requête.",
      });
    }
    if (error instanceof PlafondQuotaDepasse) {
      return res.status(409).json(reponsePlafondDepasse(error.alloue, error.plafond));
    }
    console.error("Token validation error:", error);
    return res.status(500).json({ error: "errors.server", message: "Failed to validate token" });
  }
}

router.get(
  "/",
  requireAuth,
  requirePermission("tokens.view"),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      let tokens: any[] = [];
      if (prisma) {
        tokens = await prisma.tokenSXB.findMany({
          where: await porteeTokens(req),
          include: { client: { include: { user: true } } },
          orderBy: { createdAt: "desc" },
        });
      } else {
        tokens = inMemoryDb.tokens.map((token: any) => {
          const client = inMemoryDb.vpnClients.find(
            (candidate: any) => candidate.id === token.clientId
          );
          const user = client
            ? inMemoryDb.users.find((candidate: any) => candidate.id === client.userId)
            : null;
          return { ...token, client: client ? { ...client, user } : null };
        });
        if (req.user?.role === "RESELLER") {
          const fiche = await chargerFicheRevendeur(null, req.user.userId);
          tokens = tokens.filter((token: any) => possedeClient(token.client, fiche));
        }
      }
      return res.json({ tokens: tokens.map(sanitizeToken) });
    } catch (error) {
      console.error("Fetch tokens list error:", error);
      return res.status(500).json({
        error: "errors.server",
        message: "Failed to fetch tokens",
      });
    }
  }
);

router.post(
  "/",
  requireAuth,
  interdireMutationSupport(),
  requirePermission("tokens.create"),
  exigerAccesRevendeur(),
  creerToken
);

router.post(
  "/generate",
  requireAuth,
  interdireMutationSupport(),
  requirePermission("tokens.create"),
  exigerAccesRevendeur(),
  creerToken
);

router.post(
  "/validate",
  requireAuth,
  interdireMutationSupport(),
  requirePermission("tokens.create"),
  exigerAccesRevendeur(),
  validerToken
);

router.post(
  "/:id/revoke",
  requireAuth,
  interdireMutationSupport(),
  requirePermission("tokens.revoke"),
  exigerAccesRevendeur({ autoriserReduction: true }),
  revoquerToken
);

router.delete(
  "/:id",
  requireAuth,
  interdireMutationSupport(),
  requirePermission("tokens.revoke"),
  exigerAccesRevendeur({ autoriserReduction: true }),
  revoquerToken
);

router.get(
  "/:token",
  requireAuth,
  requirePermission("tokens.view"),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const normalized = req.params.token.trim().toUpperCase();
      let tokenRecord: any = null;

      if (prisma) {
        tokenRecord = await prisma.tokenSXB.findUnique({
          where: { token: normalized },
          include: { client: { include: { user: true } } },
        });
      } else {
        const token = inMemoryDb.tokens.find(
          (candidate: any) => candidate.token === normalized
        );
        if (token) {
          const client = inMemoryDb.vpnClients.find(
            (candidate: any) => candidate.id === token.clientId
          );
          tokenRecord = { ...token, client };
        }
      }

      if (!tokenRecord) {
        return res.status(404).json({
          error: "errors.tokens.not_found",
          message: "Token not found",
        });
      }
      if (
        req.user?.role === "RESELLER" &&
        !possedeClient(
          tokenRecord.client,
          await chargerFicheRevendeur(prisma, req.user.userId)
        )
      ) {
        return res.status(404).json({
          error: "errors.tokens.not_found",
          message: "Token not found",
        });
      }
      return res.json(sanitizeToken(tokenRecord));
    } catch (error) {
      console.error("Retrieve token error:", error);
      return res.status(500).json({
        error: "errors.server",
        message: "Failed to fetch token",
      });
    }
  }
);

export default router;
