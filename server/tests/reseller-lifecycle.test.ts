import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  CODES_REVENDEUR,
  MESSAGE_ACCES_EXPIRE,
  calculerEtatAcces,
  calculerEtatQuota,
  estDateDepassee,
  etiquetteRevendeur,
  porteeClientsRevendeur,
  possedeClient,
  refusPourEtatAcces,
  refusPourQuotaAtteint,
  resumerAccesRevendeur,
} from "../services/reseller-state";
import { CODES_ACTIVATION, evaluerActivation } from "../services/device-activation";
import { sanitizeDevice } from "../services/device-quota";
import { calculerAllocation } from "../services/reseller-quota";

const GO = BigInt(1024) ** BigInt(3);
const DEMAIN = new Date(Date.now() + 24 * 3600 * 1000);
const HIER = new Date(Date.now() - 24 * 3600 * 1000);

function fiche(overrides: Record<string, unknown> = {}) {
  return {
    id: "res-1",
    userId: "user-res-1",
    status: "active",
    quotaBytes: 100n * GO,
    quotaUsedBytes: 10n * GO,
    accessExpiresAt: DEMAIN,
    user: { id: "user-res-1", name: "Revendeur Un", email: "un@sxb.local" },
    ...overrides,
  };
}

function compte(overrides: Record<string, unknown> = {}) {
  return {
    id: "cli-1",
    token: "SXB-USER-AAAA-BBBB-CCCC",
    status: "active",
    // Jeton fraîchement créé : échéance largement future.
    expireAt: new Date(Date.now() + 365 * 24 * 3600 * 1000),
    deviceId: null,
    activatedAt: null,
    userId: "user-res-1",
    user: { id: "user-dev-1", name: "Appareil", email: "device@sxbvpn.local" },
    subscriptions: [],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
describe("activation mobile — codes distincts et jeton frais jamais « expiré »", () => {
  it("accepte un jeton frais dont le deviceId a été pré-affecté au tableau de bord", () => {
    // CAUSE RACINE du bug : /api/devices/generate-token inscrit un deviceId à la
    // création ; le téléphone en présente un autre. L'ancien code renvoyait 403,
    // que le mobile affichait « expiré » alors que le jeton datait d'une minute.
    const decision = evaluerActivation({
      client: compte({ deviceId: "SAISI-AU-DASHBOARD", activatedAt: null }),
      deviceId: "ANDROID-REEL-123456",
    });
    assert.equal(decision.ok, true);
    assert.equal(decision.action, "rebind");
    assert.equal(decision.status, 200);
    assert.equal(decision.deviceId, "ANDROID-REEL-123456");
  });

  it("ne renvoie 410 TOKEN_EXPIRED que pour une échéance réellement dépassée", () => {
    const expire = evaluerActivation({ client: compte({ expireAt: HIER }), deviceId: "D1" });
    assert.equal(expire.ok, false);
    assert.equal(expire.status, 410);
    assert.equal(expire.code, CODES_ACTIVATION.TOKEN_EXPIRED);

    const frais = evaluerActivation({ client: compte(), deviceId: "D1" });
    assert.equal(frais.ok, true);
    assert.notEqual(frais.code, CODES_ACTIVATION.TOKEN_EXPIRED);
  });

  it("distingue jeton absent, compte suspendu, appareil déjà lié et jeton consommé", () => {
    const absent = evaluerActivation({ client: null, deviceId: "D1" });
    assert.equal(absent.status, 404);
    assert.equal(absent.code, CODES_ACTIVATION.TOKEN_NOT_FOUND);

    const suspendu = evaluerActivation({ client: compte({ status: "suspended" }), deviceId: "D1" });
    assert.equal(suspendu.status, 403);
    assert.equal(suspendu.code, CODES_ACTIVATION.ACCOUNT_SUSPENDED);

    const lie = evaluerActivation({
      client: compte({ deviceId: "AUTRE-APPAREIL", activatedAt: new Date() }),
      deviceId: "D1",
    });
    assert.equal(lie.status, 409);
    assert.equal(lie.code, CODES_ACTIVATION.DEVICE_BOUND);

    const consomme = evaluerActivation({ client: compte({ status: "used" }), deviceId: "D1" });
    assert.equal(consomme.status, 409);
    assert.equal(consomme.code, CODES_ACTIVATION.TOKEN_USED);
  });

  it("est idempotente pour le même couple jeton + appareil", () => {
    const client = compte({ deviceId: "D1", activatedAt: new Date() });
    const premier = evaluerActivation({ client, deviceId: "D1" });
    const second = evaluerActivation({ client, deviceId: "D1" });
    for (const decision of [premier, second]) {
      assert.equal(decision.ok, true);
      assert.equal(decision.action, "already_bound");
      assert.equal(decision.idempotent, true);
    }
  });

  it("confirme en base une pré-affectation identique lors de la première activation", () => {
    const premier = evaluerActivation({
      client: compte({ deviceId: "D1", activatedAt: null }),
      deviceId: "D1",
    });
    assert.equal(premier.ok, true);
    assert.equal(premier.action, "already_bound");
    assert.equal(premier.idempotent, false);
  });

  it("refuse l'activation sous un revendeur expiré avec un code qui lui est propre", () => {
    const decision = evaluerActivation({
      client: compte(),
      deviceId: "D1",
      reseller: fiche({ accessExpiresAt: HIER }),
    });
    assert.equal(decision.status, 403);
    assert.equal(decision.code, CODES_ACTIVATION.RESELLER_EXPIRED);
    assert.equal(decision.message, MESSAGE_ACCES_EXPIRE);
  });

  it("compare des Date et non des chaînes (aucun biais de fuseau)", () => {
    // « 2026-09-07 14:00 » (local, sans Z) se compare mal en chaîne face à un
    // ISO UTC ; en Date, l'ordre est correct.
    const futur = new Date(Date.now() + 3600 * 1000);
    const localSansZ = `${futur.getFullYear()}-${String(futur.getMonth() + 1).padStart(2, "0")}-${String(futur.getDate()).padStart(2, "0")} ${String(futur.getHours()).padStart(2, "0")}:${String(futur.getMinutes()).padStart(2, "0")}:00`;
    assert.equal(estDateDepassee(localSansZ), false);
    assert.equal(estDateDepassee(HIER.toISOString()), true);
    // Une valeur illisible ne doit jamais valoir « expiré ».
    assert.equal(estDateDepassee("pas-une-date"), false);
    assert.equal(estDateDepassee(null), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("appareil sans forfait — aucun plan n'est inventé", () => {
  it("sérialise un appareil sans souscription sans lui fabriquer de quota", () => {
    const vue = sanitizeDevice({
      id: "cli-1",
      deviceId: "D1",
      token: "SXB-USER-AAAA-BBBB-CCCC",
      status: "active",
      expireAt: DEMAIN,
      activatedAt: null,
      createdAt: new Date(),
      quotaTotal: null,
      quotaUsed: 0n,
      user: { name: "Appareil" },
      subscriptions: [],
    });
    assert.equal(vue.subscriptionId, null);
    assert.equal(vue.hasSubscription, false);
    assert.equal(vue.quotaSource, "client");
    assert.equal(vue.quotaTotal, "0");
    assert.equal(vue.quotaRemaining, "0");
  });

  it("expose l'identité du revendeur aux rôles supérieurs", () => {
    const vue = sanitizeDevice({
      id: "cli-2",
      deviceId: "D2",
      token: "SXB-USER-1111-2222-3333",
      status: "active",
      createdAt: new Date(),
      quotaTotal: 0n,
      quotaUsed: 0n,
      resellerId: "res-1",
      reseller: { id: "res-1", user: { name: "Revendeur Un", email: "un@sxb.local" } },
      subscriptions: [],
    });
    assert.equal(vue.resellerId, "res-1");
    assert.equal(vue.resellerName, "Revendeur Un");
  });

  it("ne crée aucun forfait dans les routes d'appareil et de client", () => {
    for (const chemin of ["../routes/devices.ts", "../routes/clients.ts"]) {
      const source = readFileSync(new URL(chemin, import.meta.url), "utf8");
      assert.equal(
        /subscription\.create|subscriptions\.create/.test(source),
        false,
        `${chemin} ne doit jamais créer de forfait`
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("propriété — un revendeur ne touche que ses clients", () => {
  it("reconnaît la propriété explicite et le rattachement historique", () => {
    const f = fiche();
    assert.equal(possedeClient({ resellerId: "res-1", userId: "autre" }, f), true);
    assert.equal(possedeClient({ resellerId: null, userId: "user-res-1" }, f), true);
    assert.equal(possedeClient({ resellerId: "res-2", userId: "user-res-1" }, f), false);
    assert.equal(possedeClient({ resellerId: null, userId: "user-res-9" }, f), false);
    assert.equal(possedeClient({ resellerId: "res-1" }, null), false);
  });

  it("construit une portée de lecture couvrant les deux rattachements", () => {
    assert.deepEqual(porteeClientsRevendeur(fiche()), {
      OR: [{ resellerId: "res-1" }, { resellerId: null, userId: "user-res-1" }],
    });
    // Sans fiche exploitable, la portée ne doit surtout pas être vide.
    assert.deepEqual(porteeClientsRevendeur(null), { id: "__aucun__" });
  });

  it("étiquette un client avec son revendeur", () => {
    assert.deepEqual(
      etiquetteRevendeur({ resellerId: "res-1", reseller: { id: "res-1", user: { name: "Revendeur Un" } } }),
      { resellerId: "res-1", resellerName: "Revendeur Un" }
    );
    assert.deepEqual(etiquetteRevendeur({ resellerId: null }), { resellerId: null, resellerName: null });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("validité et plafond du revendeur", () => {
  it("calcule l'engagement sur la propriété explicite et l'héritage non attribué", async () => {
    let where: unknown = null;
    const db = {
      voucher: { findMany: async () => [] },
      vpnClient: {
        findMany: async (args: any) => {
          where = args.where;
          return [
            {
              id: "cli-1",
              quotaTotal: 3n * GO,
              quotaUsed: 1n * GO,
              subscriptions: [],
            },
            {
              id: "cli-2",
              quotaTotal: 0n,
              quotaUsed: 0n,
              subscriptions: [
                { id: "sub-1", quotaBytes: 5n * GO, quotaUsed: 2n * GO, status: "active", expireAt: DEMAIN },
              ],
            },
          ];
        },
      },
    };
    const allocation = await calculerAllocation(db, fiche());
    assert.deepEqual(where, {
      OR: [
        { resellerId: "res-1" },
        { resellerId: null, userId: "user-res-1" },
      ],
    });
    assert.equal(allocation.alloue, 8n * GO);
    assert.equal(allocation.consomme, 3n * GO);
  });

  it("libère l'engagement sans effacer la consommation historique", async () => {
    const db = {
      voucher: { findMany: async () => [] },
      vpnClient: {
        findMany: async () => [{
          id: "cli-1",
          quotaTotal: 0n,
          quotaUsed: 0n,
          subscriptions: [
            { id: "active", quotaBytes: 5n * GO, quotaUsed: 2n * GO, status: "active", expireAt: DEMAIN },
            { id: "suspended", quotaBytes: 7n * GO, quotaUsed: 1n * GO, status: "suspended", expireAt: DEMAIN },
            { id: "revoked", quotaBytes: 9n * GO, quotaUsed: 1n * GO, status: "revoked", expireAt: DEMAIN },
            { id: "expired", quotaBytes: 11n * GO, quotaUsed: 1n * GO, status: "active", expireAt: HIER },
          ],
        }],
      },
    };
    const allocation = await calculerAllocation(db, fiche());
    assert.equal(allocation.alloue, 5n * GO);
    // Suspendre ou révoquer libère l'enveloppe, mais ne réécrit jamais le
    // trafic déjà consommé : l'historique reste exact.
    assert.equal(allocation.consomme, 5n * GO);
  });

  it("réserve les jetons actifs puis libère la réservation à leur fin", async () => {
    const db = {
      voucher: { findMany: async () => [] },
      vpnClient: {
        findMany: async () => [
          {
            id: "cli-active",
            status: "active",
            expireAt: DEMAIN,
            quotaTotal: 0n,
            quotaUsed: 0n,
            subscriptions: [],
            tokens: [
              { quota: 4n * GO, status: "active", expiration: DEMAIN },
              { quota: 7n * GO, status: "active", expiration: HIER },
              { quota: 9n * GO, status: "revoked", expiration: DEMAIN },
            ],
          },
          {
            id: "cli-suspended",
            status: "suspended",
            quotaTotal: 0n,
            quotaUsed: 3n * GO,
            subscriptions: [],
            tokens: [
              { quota: 12n * GO, status: "active", expiration: DEMAIN },
            ],
          },
        ],
      },
    };
    const allocation = await calculerAllocation(db, fiche());
    assert.equal(allocation.alloue, 4n * GO);
    assert.equal(allocation.consomme, 3n * GO);
  });

  it("calcule active / expired / suspended", () => {
    assert.equal(calculerEtatAcces(fiche()), "active");
    assert.equal(calculerEtatAcces(fiche({ accessExpiresAt: HIER })), "expired");
    assert.equal(calculerEtatAcces(fiche({ status: "suspended" })), "suspended");
    // Fiche héritée sans échéance : accès conservé, aucune coupure rétroactive.
    assert.equal(calculerEtatAcces(fiche({ accessExpiresAt: null })), "active");
    assert.equal(calculerEtatAcces(null), "suspended");
  });

  it("ne réengage pas l'ancien quota client quand on exclut son seul forfait", async () => {
    const db = { voucher: { findMany: async () => [] }, vpnClient: { findMany: async () => [{
      id: "client", status: "active", quotaTotal: 99n * GO, quotaUsed: 2n * GO,
      expireAt: HIER,
      subscriptions: [{ id: "plan", status: "active", quotaBytes: 5n * GO, quotaUsed: 2n * GO, expireAt: DEMAIN }],
    }] } };
    assert.equal((await calculerAllocation(db, fiche())).alloue, 5n * GO);
    assert.equal((await calculerAllocation(db, fiche(), { exclureSubscriptionId: "plan" })).alloue, 0n);
  });

  it("n'interprète jamais un plafond nul comme illimité", () => {
    assert.equal(calculerEtatQuota(BigInt(0), BigInt(0)), "reached");
    assert.equal(calculerEtatQuota(BigInt(-1), 999n * GO), "unlimited");
    assert.equal(calculerEtatQuota(100n * GO, 10n * GO), "available");
    assert.equal(calculerEtatQuota(100n * GO, 100n * GO), "reached");
    assert.equal(calculerEtatQuota(100n * GO, 150n * GO), "reached");
  });

  it("résume l'accès avec des BigInt en chaînes", () => {
    const resume = resumerAccesRevendeur(fiche(), 10n * GO);
    assert.equal(resume.resellerId, "res-1");
    assert.equal(resume.resellerName, "Revendeur Un");
    assert.equal(resume.accessState, "active");
    assert.equal(resume.quotaState, "available");
    assert.equal(typeof resume.quotaBytes, "string");
    assert.equal(resume.quotaBytes, (100n * GO).toString());
    assert.equal(resume.quotaAllocatedBytes, (10n * GO).toString());
    assert.equal(resume.quotaRemainingBytes, (90n * GO).toString());
    assert.equal(resume.quotaUnlimited, false);
    // Illimité : pas de reste chiffré, et surtout pas 0.
    const illimite = resumerAccesRevendeur(fiche({ quotaBytes: BigInt(-1) }), 5n * GO);
    assert.equal(illimite.quotaUnlimited, true);
    assert.equal(illimite.quotaRemainingBytes, null);
  });

  it("refuse les mutations d'un revendeur expiré avec le message attendu", () => {
    const refus = refusPourEtatAcces(resumerAccesRevendeur(fiche({ accessExpiresAt: HIER })));
    assert.ok(refus);
    assert.equal(refus!.status, 403);
    assert.equal(refus!.body.code, CODES_REVENDEUR.EXPIRED);
    assert.equal(refus!.body.message, "Accès expiré — veuillez renouveler");
    assert.equal(refus!.body.resellerAccess?.accessState, "expired");

    const suspendu = refusPourEtatAcces(resumerAccesRevendeur(fiche({ status: "suspended" })));
    assert.equal(suspendu!.body.code, CODES_REVENDEUR.SUSPENDED);

    // Accès valide : aucune entrave.
    assert.equal(refusPourEtatAcces(resumerAccesRevendeur(fiche())), null);
  });

  it("bloque le plafond atteint et laisse passer le plafond disponible", () => {
    const atteint = refusPourQuotaAtteint(resumerAccesRevendeur(fiche({ quotaBytes: 10n * GO }), 10n * GO));
    assert.ok(atteint);
    assert.equal(atteint!.status, 409);
    assert.equal(atteint!.body.code, CODES_REVENDEUR.QUOTA_REACHED);
    assert.equal(atteint!.body.resellerAccess?.quotaState, "reached");

    assert.equal(refusPourQuotaAtteint(resumerAccesRevendeur(fiche(), 10n * GO)), null);
    assert.equal(refusPourQuotaAtteint(resumerAccesRevendeur(fiche({ quotaBytes: BigInt(-1) }), 10n * GO)), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("gardes posées sur les routes", () => {
  const lire = (chemin: string) => readFileSync(new URL(chemin, import.meta.url), "utf8");

  it("laisse ouvertes les actions qui réduisent l'exposition", () => {
    // Suspendre, révoquer et supprimer libèrent du volume : les fermer quand le
    // plafond est atteint enfermerait l'exploitant avec un parc incontrôlable.
    const clients = lire("../routes/clients.ts");
    const devices = lire("../routes/devices.ts");
    const subs = lire("../routes/subscriptions.ts");
    for (const source of [clients, devices, subs]) {
      assert.ok(
        source.includes("exigerAccesRevendeur({ autoriserReduction: true })"),
        "une action réductrice doit être marquée comme telle"
      );
    }
    // La création, elle, reste soumise au plafond.
    assert.ok(subs.includes("refusSiPlafondAtteint"));
    assert.ok(devices.includes("refusSiPlafondAtteint"));
  });

  it("garde les modifications client cohérentes et atomiques", () => {
    const clients = lire("../routes/clients.ts");
    const access = lire("../services/reseller-access.ts");
    const clientAccessState = lire("../services/client-access-state.ts");
    const renouvellement = clients.slice(
      clients.indexOf('// POST /api/clients/:id/renew'),
      clients.indexOf('// POST /api/clients/:id/reset-access')
    );

    assert.doesNotMatch(clients, /updates\.name\s*=/);
    assert.ok(clients.includes("user: { update: { name: body.name } }"));
    assert.ok(clients.includes("updates.deviceLimit = body.deviceLimit"));
    assert.match(clients, /deviceLimit: body\.deviceLimit/g);
    assert.ok(renouvellement.includes("executerMutationQuota(prisma"));
    assert.ok(renouvellement.includes('synchroniserEtatAccesClient(tx, id, "active")'));
    assert.ok(renouvellement.includes("err instanceof PlafondQuotaDepasse"));
    assert.ok(clients.includes('synchroniserEtatAccesClient(tx, id, "expired")') || clients.includes("if (body.status) await synchroniserEtatAccesClient(tx, id, body.status)"));
    assert.ok(clientAccessState.includes("activationSession.updateMany"));
    assert.ok(clientAccessState.includes("appRegistration.updateMany"));
    assert.doesNotMatch(clients, /\.catch\(\(\) => \{\}\)/);
    assert.doesNotMatch(access, /reseller\.findUnique[\s\S]{0,120}catch/);
  });

  it("ferme les mutations métier au rôle SUPPORT quelles que soient ses permissions", () => {
    for (const chemin of [
      "../routes/clients.ts",
      "../routes/devices.ts",
      "../routes/subscriptions.ts",
      "../routes/resellers.ts",
      "../routes/tokens.ts",
    ]) {
      assert.ok(lire(chemin).includes("interdireMutationSupport()"), `${chemin} doit poser le plafond SUPPORT`);
    }
  });

  it("lie chaque session mobile à son client exact sans hériter du rôle porteur", () => {
    const mobile = lire("../routes/mobile.ts");
    const auth = lire("../middleware/auth.ts");
    const clients = lire("../routes/clients.ts");
    assert.ok(mobile.includes("clientId: client.id"));
    assert.ok(mobile.includes("req.user!.clientId, deviceIdFromRequest(req)"));
    assert.ok(auth.includes('const jetonMobile = decoded.role === "CLIENT"'));
    assert.ok(auth.includes('dbRoleName = "CLIENT"'));
    assert.match(auth, /if \(dbRoleName === "CLIENT"\) \{[\s\S]{0,180}permissions = \[\]/);
    assert.doesNotMatch(clients, /targetUserId = req\.user\.userId/);
    assert.ok(clients.includes("await tx.user.create"));
    assert.ok(mobile.includes("deviceIdFromRequest(req)"));
  });

  it("rend la matrice RBAC effective et prévient le verrouillage administratif", () => {
    const rbac = lire("../routes/rbac.ts");
    const auth = lire("../middleware/auth.ts");
    assert.match(rbac, /router\.get\("\/roles", requireAuth, requireRole\(\["SUPER_ADMIN", "ADMIN"\]\)/);
    assert.match(rbac, /roleCible\.name === OWNER_ROLE/);
    assert.match(rbac, /RBAC_LOCKOUT_PREVENTED/);
    assert.doesNotMatch(auth, /RESELLER_REQUIRED_PERMISSIONS|CORE_DATA_PERMISSIONS/);
  });

  it("n'accepte qu'un profil VPN attribué au revendeur, y compris en groupé", () => {
    const subs = lire("../routes/subscriptions.ts");
    const occurrences = subs.split("assertResellerCanUseProfile").length - 1;
    // Définition + création unitaire + modification + déploiement groupé.
    assert.ok(occurrences >= 4, `contrôle d'attribution attendu partout, vu ${occurrences} fois`);
  });

  it("n'expose pas le token d'un appareil appartenant à un autre revendeur", () => {
    const devices = lire("../routes/devices.ts");
    assert.ok(devices.includes("const peutVoirJeton"));
    assert.ok(devices.includes("possedeClient(existing, fiche)"));
    assert.ok(devices.includes("...(peutVoirJeton ? { device: sanitizeDevice(existing) } : {})"));
  });

  it("confirme la première activation et transforme les collisions uniques en 409", () => {
    const mobile = lire("../routes/mobile.ts");
    assert.ok(mobile.includes('import { CODES_ACTIVATION, evaluerActivation }'));
    assert.ok(mobile.includes('decision.action === "already_bound" && !client.activatedAt'));
    assert.ok(mobile.includes('updateError?.code === "P2002"'));
    assert.ok(mobile.includes("CODES_ACTIVATION.DEVICE_CLAIMED"));
  });

  it("refuse les écritures de trafic sur le forfait ou l'appareil d'un autre client", () => {
    const mobile = lire("../routes/mobile.ts");
    assert.match(mobile, /subscription\.updateMany\(\{[\s\S]{0,120}where: \{ id: subId, clientId \}/);
    assert.ok(mobile.includes('reason: "subscription_not_owned"'));
    assert.doesNotMatch(
      mobile,
      /if \(!client && deviceId && prisma\)[\s\S]{0,120}vpnClient\.findUnique\(\{ where: \{ deviceId \}/
    );
    assert.match(mobile, /connections\/:id\/status[\s\S]{0,700}where: \{ id, clientId: client\.id \}/);
  });

  it("exige une échéance d'accès à la création d'un revendeur", () => {
    const resellers = lire("../routes/resellers.ts");
    assert.ok(resellers.includes("accessExpiresAt: dateAccesFuture"));
    assert.ok(resellers.includes("doit être dans le futur"));
    // Le rapport de réconciliation reste en lecture seule.
    assert.ok(resellers.includes("/reconciliation"));
    assert.ok(resellers.includes("readOnly: true"));
    assert.ok(resellers.includes('router.get("/me/access", requireAuth'));
    assert.ok(resellers.includes("resumerAccesRevendeur(fiche, alloue)"));
  });

  it("réserve les cartes de quota aux enveloppes des revendeurs", () => {
    const dashboardApi = lire("../routes/dashboard.ts");
    const dashboardUi = readFileSync(
      new URL("../../artifacts/sxb-dashboard/src/components/DashboardView.tsx", import.meta.url),
      "utf8"
    );

    assert.ok(dashboardApi.includes("resellerQuota: statistiquesQuotaRevendeurs"));
    assert.ok(dashboardApi.includes("calculerAllocation(prisma, fiche)"));
    assert.ok(dashboardUi.includes("stats?.resellerQuota"));
    assert.ok(dashboardUi.includes("Quota attribué"));
    assert.ok(dashboardUi.includes("Quota engagé"));
    assert.ok(dashboardUi.includes("Quota disponible"));
    for (const libelleInterdit of ["Quota provisionné", "aux clients", "sur les clients"]) {
      assert.equal(
        dashboardUi.includes(libelleInterdit),
        false,
        `le libellé ambigu « ${libelleInterdit} » ne doit plus apparaître`
      );
    }
  });

  it("rend les jetons cryptographiques, atomiques et sans fuite imbriquée", () => {
    const tokens = lire("../routes/tokens.ts");
    assert.ok(tokens.includes('from "crypto"'));
    assert.ok(tokens.includes("randomInt("));
    assert.doesNotMatch(tokens, /Math\.random/);
    assert.equal(
      (tokens.match(/tx\.tokenSXB\.create\(/g) || []).length,
      1,
      "les deux URL de création doivent partager un seul gestionnaire"
    );
    assert.match(tokens, /quotaGb:[\s\S]{0,80}\.int\(\)/);
    assert.match(tokens, /durationDays:[\s\S]{0,80}\.int\(\)/);
    assert.ok(tokens.includes('requirePermission("tokens.view")'));
    assert.ok(tokens.includes('requirePermission("tokens.revoke")'));
    assert.ok(tokens.includes('status: "active",'));
    assert.ok(tokens.includes('expiration: { gt: new Date() }'));
    assert.ok(tokens.includes("consumed.count !== 1"));
    assert.ok(tokens.includes("synchroniserEtatAccesClient("));
    assert.ok(tokens.includes('key !== "passwordHash"'));
    assert.ok(tokens.includes('depth > 0 && key === "token"'));
    assert.doesNotMatch(tokens, /Created SXB Token:|Validated & applied SXB Token:/);
  });

  it("supprime l'ancien routeur vpn-manager qui contournait RBAC et quotas", () => {
    const obsolete = new URL("../routes/vpn-manager.ts", import.meta.url);
    assert.equal(existsSync(obsolete), false);
    const server = readFileSync(new URL("../../server.ts", import.meta.url), "utf8");
    assert.doesNotMatch(server, /vpn-manager|vpnManager/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("schéma et migration", () => {
  const racine = new URL("../../", import.meta.url);

  it("garde les deux schémas Prisma strictement identiques", () => {
    const principal = readFileSync(new URL("prisma/schema.prisma", racine), "utf8");
    const deploye = readFileSync(new URL("backend/prisma/schema.prisma", racine), "utf8");
    assert.equal(deploye, principal, "backend/prisma/schema.prisma doit rester identique à prisma/schema.prisma");
    // Les deux colonnes ajoutées sont nullables : compatibilité ascendante.
    assert.ok(principal.includes("accessExpiresAt DateTime?"));
    assert.ok(principal.includes("resellerId      String?"));
  });

  it("n'ajoute qu'une migration additive et rejouable", () => {
    const sql = readFileSync(
      new URL("backend/prisma/migrations/20260907120000_reseller_access_and_client_ownership/migration.sql", racine),
      "utf8"
    );
    // Idempotence : chaque objet est créé sous condition d'absence.
    assert.ok(sql.includes("IF NOT EXISTS"));
    assert.ok(sql.includes("CREATE INDEX IF NOT EXISTS"));
    assert.ok(sql.includes("ON DELETE SET NULL"));
    assert.ok(sql.includes("migration.reseller_lifecycle_rbac.v1"));
    assert.ok(sql.includes("'rbac.manage'"));
    assert.ok(sql.includes('ON CONFLICT ("roleId", "permissionId") DO NOTHING'));
    assert.ok(sql.includes("migration.reseller_lifecycle_rbac.v1"));
    // Aucune destruction de données métier.
    for (const interdit of ["DROP TABLE", "DELETE FROM", "TRUNCATE", "DROP COLUMN"]) {
      assert.equal(sql.toUpperCase().includes(interdit), false, `${interdit} est proscrit`);
    }
    // Le seul UPDATE autorisé ne remplit que la colonne vide.
    const updates = sql.split(/^UPDATE /gim).length - 1;
    assert.equal(updates, 1);
    assert.ok(sql.includes(`"resellerId" IS NULL`));
    // Le fichier manuel reste synchronisé entre les deux emplacements.
    const manuelPrincipal = readFileSync(new URL("prisma/migrations_manual.sql", racine), "utf8");
    const manuelDeploye = readFileSync(new URL("backend/prisma/migrations_manual.sql", racine), "utf8");
    assert.equal(manuelDeploye, manuelPrincipal);
    assert.ok(manuelPrincipal.includes("vpn_clients_resellerId_fkey"));

    const permissionJeton = readFileSync(
      new URL(
        "backend/prisma/migrations/20260907130000_token_revoke_permission/migration.sql",
        racine
      ),
      "utf8"
    );
    assert.ok(permissionJeton.includes("'tokens.revoke'"));
    assert.ok(permissionJeton.includes("migration.token_revoke_permission.v1"));
    assert.ok(permissionJeton.includes("ON CONFLICT"));
    assert.equal(permissionJeton.toUpperCase().includes("DELETE FROM"), false);
  });
});
