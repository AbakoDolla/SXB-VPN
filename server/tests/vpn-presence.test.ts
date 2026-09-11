import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  PRESENCE_HEARTBEAT_MINUTES,
  PRESENCE_WINDOW_MINUTES,
  calculerDebutSession,
  compterConnectes,
  estConnecteMaintenant,
  filtrerPresences,
  indexerPseudonymes,
  listerConnectes,
  listerRevendeursConnectes,
  normaliserPagination,
  rapprocherPresences,
  regrouperParRevendeur,
  viderCachePresence,
} from "../services/vpn-presence";
import { pseudonymizeMobileDevice } from "../services/mobile-pseudonym";

const SECRET = "0123456789abcdef0123456789abcdef";
const MAINTENANT = new Date("2026-09-11T12:00:00.000Z");
const source = (chemin: string) => readFileSync(new URL(`../../${chemin}`, import.meta.url), "utf8");

function ilYA(minutes: number): Date {
  return new Date(MAINTENANT.getTime() - minutes * 60_000);
}

function signal(overrides: Record<string, unknown> = {}) {
  return {
    id: "dev-1",
    pseudonym: "pseudo-1",
    tunnelState: "connected",
    lastSeenAt: ilYA(1),
    protocol: "vless",
    appVersion: "1.9.0",
    deviceModel: "Pixel 8",
    ...overrides,
  } as any;
}

function identite(overrides: Record<string, unknown> = {}) {
  return {
    clientId: "cli-1",
    clientName: "Client Un",
    userId: "user-1",
    deviceId: "SXBDEVICE0000001",
    resellerId: null,
    resellerName: null,
    ...overrides,
  } as any;
}

/**
 * Base simulée : elle IGNORE volontairement les clauses `where`.
 *
 * C'est le seul moyen de prouver que la règle « connecté maintenant » tient
 * dans le code et pas seulement dans une requête SQL. Si demain la requête
 * changeait, ces tests continueraient de garantir qu'un appareil muet n'est pas
 * compté comme connecté.
 */
function baseSimulee(options: {
  signaux?: any[];
  clients?: any[];
  rapports?: any[];
  revendeurs?: any[];
  compteurs?: any[];
}) {
  return {
    mobileHealthDevice: {
      findMany: async () => options.signaux ?? [],
    },
    mobileHealthReport: {
      findMany: async () => options.rapports ?? [],
    },
    vpnClient: {
      findMany: async () => options.clients ?? [],
      groupBy: async () => options.compteurs ?? [],
    },
    reseller: {
      findMany: async () => options.revendeurs ?? [],
    },
  } as any;
}

/** Client tel que le renvoie Prisma à `lireIdentites`. */
function client(overrides: Record<string, unknown> = {}) {
  return {
    id: "cli-1",
    userId: "user-1",
    deviceId: "SXBDEVICE0000001",
    resellerId: null,
    user: { name: "Client Un", email: "un@sxb.local", role: { name: "CLIENT" } },
    reseller: null,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
describe("présence VPN — définition honnête de « connecté maintenant »", () => {
  it("la fenêtre vaut trois battements, pour tolérer deux signaux perdus", () => {
    // Si ce rapport change, la justification écrite en tête du service et le
    // texte affiché à l'exploitant deviennent faux : le lien est volontaire.
    assert.equal(PRESENCE_WINDOW_MINUTES, 3 * PRESENCE_HEARTBEAT_MINUTES);
  });

  it("ne compte PAS un appareil muet, même si son dernier état connu était « connecté »", () => {
    // CAUSE RACINE : les rapports ne partaient qu'aux changements d'état. Un
    // appareil ayant perdu le réseau n'émet jamais de « disconnected » et
    // restait donc « connecté » indéfiniment.
    const frais = signal({ lastSeenAt: ilYA(PRESENCE_WINDOW_MINUTES - 1) });
    const muet = signal({ pseudonym: "pseudo-2", lastSeenAt: ilYA(PRESENCE_WINDOW_MINUTES + 1) });
    const tresAncien = signal({ pseudonym: "pseudo-3", lastSeenAt: ilYA(48 * 60) });

    assert.equal(estConnecteMaintenant(frais, MAINTENANT), true);
    assert.equal(estConnecteMaintenant(muet, MAINTENANT), false);
    assert.equal(estConnecteMaintenant(tresAncien, MAINTENANT), false);

    const retenus = filtrerPresences([frais, muet, tresAncien], MAINTENANT);
    assert.deepEqual(retenus.map((item) => item.pseudonym), ["pseudo-1"]);
  });

  it("ne compte comme connecté ni « connecting », ni « error », ni « disconnected »", () => {
    // Une tentative en cours ou en échec ne fait transiter aucun trafic : la
    // compter reviendrait à réinventer le mensonge qu'on corrige.
    for (const etat of ["connecting", "error", "disconnected"]) {
      const recent = signal({ tunnelState: etat, lastSeenAt: ilYA(0) });
      assert.equal(estConnecteMaintenant(recent, MAINTENANT), false, etat);
    }
    assert.equal(estConnecteMaintenant(signal({ lastSeenAt: ilYA(0) }), MAINTENANT), true);
  });

  it("date la session en cours, et avoue quand elle ne le peut pas", () => {
    // Suite ininterrompue de « connected » précédée d'un état contraire : le
    // début est la plus ancienne ligne de cette suite.
    const date = calculerDebutSession([
      { tunnelState: "connected", reportedAt: ilYA(10) },
      { tunnelState: "connected", reportedAt: ilYA(40) },
      { tunnelState: "disconnected", reportedAt: ilYA(90) },
    ]);
    assert.equal(date.mesure, true);
    assert.equal(date.debut?.toISOString(), ilYA(40).toISOString());

    // Historique tronqué ou vide : on ne devine pas une date plausible.
    assert.deepEqual(calculerDebutSession([]), { debut: null, mesure: false });
    assert.deepEqual(
      calculerDebutSession([{ tunnelState: "connected", reportedAt: ilYA(10) }]),
      { debut: null, mesure: false },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("présence VPN — rapprochement sans dénominaliser la table de santé", () => {
  it("recalcule le pseudonyme depuis les couples connus, jamais l'inverse", () => {
    const pseudonyme = pseudonymizeMobileDevice("user-1", "SXBDEVICE0000001", SECRET);
    const index = indexerPseudonymes([identite()], SECRET);
    assert.equal(index.get(pseudonyme)?.clientId, "cli-1");
    // Le pseudonyme ne porte aucune trace exploitable de ses entrées.
    assert.equal(pseudonyme.includes("user-1"), false);
    assert.equal(pseudonyme.includes("SXBDEVICE"), false);
  });

  it("n'écrit jamais dans la table de santé et n'y ajoute aucune colonne nominative", () => {
    const service = source("server/services/vpn-presence.ts");
    const schema = source("prisma/schema.prisma");
    const modele = schema.slice(
      schema.indexOf("model MobileHealthDevice"),
      schema.indexOf("model MobileHealthReport"),
    );

    // La vue de présence est en LECTURE SEULE sur la santé mobile.
    for (const ecriture of ["mobileHealthDevice.create", "mobileHealthDevice.update", "mobileHealthDevice.upsert"]) {
      assert.equal(service.includes(ecriture), false, `${ecriture} interdit`);
    }
    // La table reste anonyme : aucun rattachement direct à un compte.
    for (const colonne of ["clientId", "userId", "deviceId ", "token", "email", "ipAddress"]) {
      assert.equal(modele.includes(colonne), false, `${colonne} ne doit pas être persisté`);
    }
    assert.match(modele, /pseudonym\s+String\s+@unique/);
  });

  it("compte les orphelins à part, sans jamais les ajouter au total listé", () => {
    const index = indexerPseudonymes([identite()], SECRET);
    const connu = signal({ pseudonym: pseudonymizeMobileDevice("user-1", "SXBDEVICE0000001", SECRET) });
    const inconnu = signal({ pseudonym: "pseudonyme-orphelin", lastSeenAt: ilYA(2) });

    const { lignes, orphelins } = rapprocherPresences([connu, inconnu], index, MAINTENANT);
    assert.equal(lignes.length, 1);
    assert.equal(orphelins, 1);
    assert.equal(lignes[0].connectedSinceMeasured, false);
    assert.equal(lignes[0].connectedSinceAt, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("présence VPN — cloisonnement revendeur", () => {
  const clientsBase = [
    client({ id: "cli-a", userId: "user-a", deviceId: "SXBDEVA", resellerId: "res-1", reseller: { id: "res-1", user: { name: "Revendeur Un" } } }),
    client({ id: "cli-b", userId: "user-b", deviceId: "SXBDEVB", resellerId: "res-2", reseller: { id: "res-2", user: { name: "Revendeur Deux" } } }),
    client({ id: "cli-c", userId: "user-c", deviceId: "SXBDEVC", resellerId: null, reseller: null }),
  ];
  const signauxBase = clientsBase.map((item, rang) => signal({
    id: `dev-${rang}`,
    pseudonym: pseudonymizeMobileDevice(item.userId, item.deviceId as string, SECRET),
    lastSeenAt: ilYA(rang + 1),
  }));

  it("ne rend au revendeur que SES clients connectés", async () => {
    viderCachePresence();
    const db = baseSimulee({ signaux: signauxBase, clients: clientsBase });
    const vue = await listerConnectes(db, SECRET, {
      // Exactement ce que renvoie porteeClientsRevendeur pour la fiche res-1.
      porteeClients: { OR: [{ resellerId: "res-1" }, { resellerId: null, userId: "user-res-1" }] },
      now: MAINTENANT,
    });

    assert.deepEqual(vue.lignes.map((ligne) => ligne.clientId), ["cli-a"]);
    // Les connectés des autres revendeurs deviennent des orphelins invisibles,
    // jamais des lignes, jamais un chiffre exploitable.
    assert.equal(vue.orphelins, 2);
  });

  it("rend à l'administration la plateforme entière", async () => {
    viderCachePresence();
    const db = baseSimulee({ signaux: signauxBase, clients: clientsBase });
    const vue = await listerConnectes(db, SECRET, { now: MAINTENANT });
    assert.deepEqual(vue.lignes.map((ligne) => ligne.clientId).sort(), ["cli-a", "cli-b", "cli-c"]);
    assert.equal(vue.orphelins, 0);
  });

  it("masque les comptes OWNER hors OWNER", async () => {
    const avecProprietaire = [
      ...clientsBase,
      client({ id: "cli-own", userId: "user-own", deviceId: "SXBDEVOWN", user: { name: "Propriétaire", email: "own@sxb.local", role: { name: "OWNER" } } }),
    ];
    const signaux = avecProprietaire.map((item, rang) => signal({
      id: `dev-${rang}`,
      pseudonym: pseudonymizeMobileDevice(item.userId, item.deviceId as string, SECRET),
      lastSeenAt: ilYA(rang + 1),
    }));

    viderCachePresence();
    const masque = await listerConnectes(baseSimulee({ signaux, clients: avecProprietaire }), SECRET, {
      masquerProprietaire: true,
      now: MAINTENANT,
    });
    assert.equal(masque.lignes.some((ligne) => ligne.clientId === "cli-own"), false);

    viderCachePresence();
    const complet = await listerConnectes(baseSimulee({ signaux, clients: avecProprietaire }), SECRET, {
      now: MAINTENANT,
    });
    assert.equal(complet.lignes.some((ligne) => ligne.clientId === "cli-own"), true);
  });

  it("refuse au revendeur la vue globale des revendeurs", () => {
    // La route ne doit pas se contenter de filtrer : elle doit REFUSER, sans
    // quoi un revendeur apprendrait au moins combien de revendeurs existent.
    const routes = source("server/routes/presence.ts");
    assert.match(routes, /router\.get\("\/resellers"[\s\S]{0,200}requireAuth/);
    assert.match(routes, /req\.user\?\.role === "RESELLER"[\s\S]{0,200}status\(403\)/);
    assert.match(routes, /PRESENCE_RESELLER_SCOPE/);
    // La route nominative reste, elle, cloisonnée plutôt que refusée.
    assert.match(routes, /porteeClientsRevendeur\(fiche\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("présence VPN — un seul calcul, donc aucun total divergent", () => {
  const clients = Array.from({ length: 5 }, (_, rang) => client({
    id: `cli-${rang}`,
    userId: `user-${rang}`,
    deviceId: `SXBDEV${rang}`,
    resellerId: rang < 3 ? "res-1" : null,
    reseller: rang < 3 ? { id: "res-1", user: { name: "Revendeur Un" } } : null,
  }));
  const signaux = clients.map((item, rang) => signal({
    id: `dev-${rang}`,
    pseudonym: pseudonymizeMobileDevice(item.userId, item.deviceId as string, SECRET),
    // Le dernier appareil est muet depuis trop longtemps : il ne doit apparaître
    // ni dans le total, ni dans la liste, ni dans le compteur du revendeur.
    lastSeenAt: rang === 4 ? ilYA(PRESENCE_WINDOW_MINUTES + 5) : ilYA(rang + 1),
  }));

  it("le compteur du tableau de bord égale le nombre de lignes listées", async () => {
    viderCachePresence();
    const vue = await listerConnectes(baseSimulee({ signaux, clients }), SECRET, { now: MAINTENANT });
    viderCachePresence();
    const compteur = await compterConnectes(baseSimulee({ signaux, clients }), SECRET, { now: MAINTENANT });

    assert.equal(vue.lignes.length, 4);
    assert.equal(compteur, vue.lignes.length);
  });

  it("le compteur d'un revendeur égale le détail qu'on déplie sous son nom", async () => {
    viderCachePresence();
    const vue = await listerRevendeursConnectes(
      baseSimulee({
        signaux,
        clients,
        revendeurs: [{ id: "res-1", status: "active", user: { name: "Revendeur Un" } }],
        compteurs: [{ resellerId: "res-1", status: "active", _count: { _all: 3 } }],
      }),
      SECRET,
      { now: MAINTENANT },
    );

    const groupe = vue.resellers[0];
    assert.equal(groupe.connectedNow, groupe.users.length);
    assert.equal(groupe.connectedNow, 3);
    assert.equal(groupe.totalClients, 3);
    assert.equal(vue.direct.connectedNow, vue.direct.users.length);
    // Total = revendeurs + clients directs, sans double comptage ni orphelin.
    const somme = vue.resellers.reduce((acc, item) => acc + item.connectedNow, 0) + vue.direct.connectedNow;
    assert.equal(vue.totalConnected, somme);
    assert.equal(vue.totalConnected, 4);
  });

  it("regroupe sans jamais perdre ni dupliquer une ligne", () => {
    const lignes = rapprocherPresences(
      filtrerPresences(signaux, MAINTENANT),
      indexerPseudonymes(
        clients.map((item) => identite({
          clientId: item.id,
          userId: item.userId,
          deviceId: item.deviceId,
          resellerId: item.resellerId,
        })),
        SECRET,
      ),
      MAINTENANT,
    ).lignes;

    const { groupes, direct } = regrouperParRevendeur(lignes, [
      { id: "res-1", name: "Revendeur Un", status: "active", totalClients: 3, activeClients: 3 },
      { id: "res-vide", name: "Revendeur Vide", status: "active", totalClients: 0, activeClients: 0 },
    ]);
    const total = groupes.reduce((acc, item) => acc + item.users.length, 0) + direct.users.length;
    assert.equal(total, lignes.length);
    assert.equal(groupes.find((item) => item.resellerId === "res-vide")?.connectedNow, 0);
  });

  it("borne la pagination sans faire confiance au client", () => {
    assert.deepEqual(normaliserPagination(undefined, undefined), { limit: 50, offset: 0 });
    assert.deepEqual(normaliserPagination("10", "5"), { limit: 10, offset: 5 });
    assert.deepEqual(normaliserPagination("100000", "-3"), { limit: 200, offset: 0 });
    assert.deepEqual(normaliserPagination("abc", "abc"), { limit: 50, offset: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("présence VPN — le tableau de bord ne présente plus un compte pour une connexion", () => {
  it("sépare comptes actifs et connexions réelles, et avoue le non-mesuré", () => {
    const routes = source("server/routes/dashboard.ts");
    const vue = source("artifacts/sxb-dashboard/src/components/DashboardView.tsx");

    // Le compteur de comptes ne s'appelle plus « utilisateurs actifs ».
    assert.match(routes, /let activeAccounts = 0;/);
    assert.match(routes, /activeUsers: activeAccounts/);
    // La présence est mesurée, et null quand elle ne peut pas l'être.
    assert.match(routes, /let connectedNow: number \| null = null;/);
    assert.match(routes, /connectedNowMeasured: connectedNow !== null/);
    assert.match(routes, /compterConnectes\(/);

    // La carte « CONNECTÉS » lit la présence, pas le nombre de comptes, et
    // ouvre la liste des connectés.
    assert.match(vue, /stats\?\.connectedNow/);
    assert.match(vue, /onNavigate\('connected-users'\)/);
    assert.doesNotMatch(vue, /operations\.dashboard\.connected"\)\} value=\{formatNumber\(stats\?\.activeUsers/);
    // « Non mesuré » reste distinct de zéro connecté.
    assert.match(vue, /operations\.dashboard\.connectedUnmeasured/);
  });

  it("expose la vue de suivi à tous les rôles, revendeurs compris", () => {
    const app = source("artifacts/sxb-dashboard/src/App.tsx");
    const layout = source("artifacts/sxb-dashboard/src/components/Layout.tsx");
    const serveur = source("server.ts");

    assert.match(app, /case 'connected-users'/);
    assert.match(layout, /id: 'connected-users'[\s\S]{0,140}roles: ALL_ROLES/);
    assert.match(serveur, /app\.use\("\/api\/presence", presenceRouter\)/);
  });
});
