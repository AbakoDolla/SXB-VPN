/**
 * free-trial.test.ts — Régression « Essai gratuit ».
 *
 * Ces tests protègent la règle non négociable du propriétaire : le jeton
 * d'essai est un CODE D'INVITATION, jamais une configuration VPN. Ils
 * couvrent les quatre garanties exigées :
 *
 *   1. le jeton ne révèle aucune configuration ni information serveur ;
 *   2. deux appareils inscrits avec le MÊME jeton ne voient jamais la
 *      configuration l'un de l'autre ;
 *   3. « vérifier le statut » avant approbation ne renvoie rien d'autre
 *      que « en attente » ;
 *   4. après déploiement, seul l'appareil autorisé obtient sa configuration.
 *
 * Ils s'exécutent sans base de données : la logique de décision vit dans
 * `server/services/free-trial.ts`, et la route ne fait que l'appliquer. Un
 * contrôle de texte source vérifie en fin de fichier que la route continue
 * bien de déléguer plutôt que de rouvrir un chemin parallèle.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  CHAMPS_INTERDITS_MOBILE,
  CODES_ESSAI,
  INTERVALLE_VERIFICATION_MAX_S,
  INTERVALLE_VERIFICATION_MIN_S,
  MAX_LOT_ESSAI,
  MOTIF_JETON_ESSAI,
  RAISONS_LOT_ESSAI,
  STATUT_DEMANDE,
  STATUTS_ESSAI_CONSOMME,
  calculerFenetreEssai,
  champsInterditsPresents,
  deciderInscriptionParEmpreinte,
  demandeAppartientAuJeton,
  empreinteExploitable,
  estEssaiActif,
  etatJetonEssai,
  genererJetonEssai,
  genererSecretReclamation,
  hacherEmpreinteAppareil,
  hacherSecretReclamation,
  intervalleVerificationEssai,
  marqueEssaiPourClient,
  normaliserJetonEssai,
  normaliserLotEssai,
  refusDeploiement,
  refusEssaiDejaConsomme,
  refusJetonEssai,
  refusLotEssai,
  resumerEssais,
  secretCorrespond,
  statistiquesParPays,
  totauxParPays,
  verifierAucuneFuite,
  vueDemandePourAdmin,
  vueInscriptionEssai,
  vueJetonPourAdmin,
  vueStatutEssaiPourAppareil,
} from "../services/free-trial";
import {
  etFiltres,
  exclureIdentifiants,
  inclutEssaisGratuits,
  porteeEssaiDeploye,
} from "../services/free-trial-marks";
import { CODES_PAYS, estCodePaysValide, nomPays, normaliserCodePays } from "../services/countries";

const DEMAIN = new Date(Date.now() + 24 * 3600 * 1000);
const HIER = new Date(Date.now() - 24 * 3600 * 1000);

/** Jeton d'essai tel que l'admin le crée à l'étape 1. */
function jeton(overrides: Record<string, unknown> = {}) {
  return {
    id: "ft-token-1",
    token: "STUFF-X8K4-P92M",
    label: "Campagne septembre",
    maxUses: null,
    usedCount: 0,
    status: "active",
    expiresAt: null,
    createdAt: HIER,
    ...overrides,
  } as any;
}

/** Demande déposée à l'étape 2 : nom + appareil, et rien d'autre. */
function demande(overrides: Record<string, unknown> = {}) {
  return {
    id: "ft-req-1",
    tokenId: "ft-token-1",
    name: "Awa Ngo",
    deviceId: "device-aaa",
    platform: "android",
    appVersion: "1.4.0",
    claimSecretHash: hacherSecretReclamation("secret-de-awa"),
    status: STATUT_DEMANDE.PENDING,
    clientId: null,
    subscriptionId: null,
    deployedAt: null,
    deployedBy: null,
    rejectedAt: null,
    rejectedBy: null,
    reviewNote: null,
    createdAt: HIER,
    ...overrides,
  } as any;
}

/**
 * Tout ce que l'admin a attribué à l'étape 3. Aucune de ces valeurs ne doit
 * jamais franchir la frontière vers une réponse mobile prématurée.
 */
const CONFIG_SECRETE = {
  server: "Cameroon Server 1",
  serverId: "srv-cmr-1",
  host: "cmr1.sxbvpn.com",
  port: 443,
  uuid: "0d1f9c2e-4b5a-4f6d-9e8c-1a2b3c4d5e6f",
  sni: "cdn.sxbvpn.com",
  quotaBytes: "2147483648",
  expireAt: "2026-09-12T00:00:00.000Z",
};

// ─────────────────────────────────────────────────────────────────────────────
describe("étape 1 — le jeton d'essai ne transporte aucune configuration", () => {
  it("génère le format STUFF-XXXX-XXXX sans caractères ambigus", () => {
    for (let i = 0; i < 200; i += 1) {
      const brut = genererJetonEssai();
      assert.match(brut, MOTIF_JETON_ESSAI, `format inattendu : ${brut}`);
      // O/0 et I/1 sont bannis : le jeton se dicte au téléphone.
      assert.equal(/[OI01]/.test(brut.slice(6)), false, `caractère ambigu dans ${brut}`);
    }
  });

  it("produit des jetons distincts (aucune valeur devinable)", () => {
    const vus = new Set<string>();
    for (let i = 0; i < 500; i += 1) vus.add(genererJetonEssai());
    assert.ok(vus.size > 490, `entropie insuffisante : ${vus.size} jetons distincts sur 500`);
  });

  it("normalise la saisie utilisateur sans en changer le sens", () => {
    assert.equal(normaliserJetonEssai("  stuff-x8k4-p92m "), "STUFF-X8K4-P92M");
    assert.equal(normaliserJetonEssai(null), "");
  });

  it("la vue admin d'un jeton ne contient AUCUN champ technique VPN", () => {
    const vue = vueJetonPourAdmin(jeton({ requestCount: 3 })) as Record<string, unknown>;
    for (const interdit of ["host", "port", "server", "serverId", "uuid", "sni", "config", "quotaBytes", "expireAt", "profileId"]) {
      assert.equal(interdit in vue, false, `le jeton exposerait « ${interdit} »`);
    }
    // Ce qu'il contient : de la gestion de campagne, pas de l'accès. Les trois
    // compteurs par statut servent à afficher « 12 en attente · 3 déployées »
    // sur la ligne du jeton sans ouvrir son volet.
    assert.deepEqual(
      Object.keys(vue).sort(),
      ["createdAt", "deployedCount", "expiresAt", "id", "label", "maxUses", "pendingCount", "rejectedCount",
        "requestCount", "state", "status", "token", "usedCount"],
    );
  });

  it("un jeton ne peut donc PAS servir à retrouver une configuration", () => {
    // Le seul lien jeton → demande est l'identifiant de campagne. Il n'existe
    // aucun champ dans le jeton qui pointe vers un forfait, un profil ou un
    // serveur — ni en clair, ni sous forme d'identifiant.
    const vue = vueJetonPourAdmin(jeton()) as Record<string, unknown>;
    for (const interdit of ["profileId", "subscriptionId", "clientId", "serverId", "quotaBytes", "config", "host", "uuid"]) {
      assert.equal(interdit in vue, false, `le jeton exposerait « ${interdit} »`);
    }
    assert.equal(JSON.stringify(vue).includes("Cameroon"), false);
  });

  it("refuse un jeton révoqué, expiré ou épuisé avec des codes distincts", () => {
    assert.equal(etatJetonEssai(null), "not_found");
    assert.equal(etatJetonEssai(jeton({ status: "revoked" })), "revoked");
    assert.equal(etatJetonEssai(jeton({ expiresAt: HIER })), "expired");
    assert.equal(etatJetonEssai(jeton({ maxUses: 2, usedCount: 2 })), "exhausted");
    assert.equal(etatJetonEssai(jeton({ maxUses: 2, usedCount: 1 })), "active");
    assert.equal(etatJetonEssai(jeton({ maxUses: null, usedCount: 9999 })), "active");

    assert.equal(refusJetonEssai("active"), null);
    assert.equal(refusJetonEssai("not_found")!.status, 404);
    assert.equal(refusJetonEssai("revoked")!.status, 403);
    assert.equal(refusJetonEssai("expired")!.status, 410);
    assert.equal(refusJetonEssai("exhausted")!.status, 409);
    assert.equal(refusJetonEssai("not_found")!.body.code, CODES_ESSAI.TOKEN_NOT_FOUND);

    // Même un refus ne doit rien dire du contenu de la campagne.
    for (const etat of ["not_found", "revoked", "expired", "exhausted"] as const) {
      assert.deepEqual(champsInterditsPresents(refusJetonEssai(etat)!.body), []);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("étape 2 — l'inscription crée une demande EN ATTENTE et rien d'autre", () => {
  it("la réponse d'inscription ne déploie rien et ne révèle rien", () => {
    const vue = vueInscriptionEssai({
      demande: demande(),
      claimSecret: "secret-de-awa",
      pollIntervalSeconds: 180,
    });
    assert.equal(vue.status, STATUT_DEMANDE.PENDING);
    assert.equal(vue.requestId, "ft-req-1");
    assert.equal(vue.name, "Awa Ngo");
    assert.deepEqual(champsInterditsPresents(vue), []);
  });

  it("le secret de réclamation est remis à l'inscription, puis seulement haché", () => {
    const secret = genererSecretReclamation();
    assert.equal(secret.length, 64, "32 octets attendus en hexadécimal");
    const hachage = hacherSecretReclamation(secret);
    assert.notEqual(hachage, secret, "le secret ne doit pas être stocké en clair");
    assert.equal(secretCorrespond(secret, hachage), true);
    assert.equal(secretCorrespond(genererSecretReclamation(), hachage), false);
    assert.equal(secretCorrespond("", hachage), false);
    assert.equal(secretCorrespond(secret, null), false);
  });

  it("chaque inscription est une demande SÉPARÉE avec son propre secret", () => {
    const a = vueInscriptionEssai({ demande: demande({ id: "ft-req-a" }), claimSecret: "s-a" });
    const b = vueInscriptionEssai({ demande: demande({ id: "ft-req-b", deviceId: "device-bbb", name: "Bebe" }), claimSecret: "s-b" });
    assert.notEqual(a.requestId, b.requestId);
    assert.notEqual(a.claimSecret, b.claimSecret);
  });

  it("l'intervalle de vérification automatique reste dans la fenêtre 2–10 min", () => {
    assert.equal(intervalleVerificationEssai(300), 300);
    assert.equal(intervalleVerificationEssai("240"), 240);
    // Bornage : ni matraquage du serveur, ni attente interminable.
    assert.equal(intervalleVerificationEssai(5), INTERVALLE_VERIFICATION_MIN_S);
    assert.equal(intervalleVerificationEssai(99999), INTERVALLE_VERIFICATION_MAX_S);
    assert.equal(intervalleVerificationEssai(undefined) >= INTERVALLE_VERIFICATION_MIN_S, true);
    assert.equal(intervalleVerificationEssai("n'importe quoi") <= INTERVALLE_VERIFICATION_MAX_S, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("étape 2bis — « vérifier le statut » avant approbation ne dit QUE « en attente »", () => {
  it("répond « pending » nu, sans serveur, quota, date ni configuration", () => {
    const reponse = vueStatutEssaiPourAppareil({
      demande: demande(),
      deviceId: "device-aaa",
      claimSecret: "secret-de-awa",
      pollIntervalSeconds: 180,
    });
    assert.equal(reponse.ok, true);
    assert.equal(reponse.status, 200);
    assert.equal(reponse.body.status, STATUT_DEMANDE.PENDING);
    assert.equal(reponse.body.accountToken, undefined);
    assert.deepEqual(champsInterditsPresents(reponse.body), []);
    // Le corps se limite au strict nécessaire pour l'écran d'attente :
    // qui a demandé, quand, et quand revenir. Aucune donnée d'accès.
    assert.deepEqual(
      Object.keys(reponse.body).sort(),
      ["device", "message", "name", "pollIntervalSeconds", "requestId", "status", "submittedAt"],
    );
  });

  it("même une demande déjà instruite mais non déployée reste muette", () => {
    const reponse = vueStatutEssaiPourAppareil({
      demande: demande({ reviewNote: "à déployer sur Cameroon Server 1, 2 Go" }),
      deviceId: "device-aaa",
      claimSecret: "secret-de-awa",
    });
    assert.equal(reponse.body.status, STATUT_DEMANDE.PENDING);
    // La note d'instruction de l'admin ne fuit pas vers l'utilisateur.
    assert.equal(JSON.stringify(reponse.body).includes("Cameroon"), false);
  });

  it("un refus est annoncé comme refus, sans détail d'infrastructure", () => {
    const reponse = vueStatutEssaiPourAppareil({
      demande: demande({ status: STATUT_DEMANDE.REJECTED, rejectedAt: new Date(), reviewNote: "hors campagne" }),
      deviceId: "device-aaa",
      claimSecret: "secret-de-awa",
    });
    assert.equal(reponse.body.status, STATUT_DEMANDE.REJECTED);
    assert.deepEqual(champsInterditsPresents(reponse.body), []);
  });

  it("une demande marquée déployée mais sans compte utilisable retombe en attente", () => {
    // Incohérence interne : mieux vaut faire patienter que d'annoncer un accès
    // que l'application ne pourra pas ouvrir.
    const reponse = vueStatutEssaiPourAppareil({
      demande: demande({ status: STATUT_DEMANDE.DEPLOYED, deployedAt: new Date(), clientId: "cli-1" }),
      deviceId: "device-aaa",
      claimSecret: "secret-de-awa",
      accountToken: null,
    });
    assert.equal(reponse.body.status, STATUT_DEMANDE.PENDING);
    assert.equal(reponse.body.accountToken, undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("SÉCURITÉ — deux appareils sous le MÊME jeton restent cloisonnés", () => {
  // Awa et Bebe ont reçu le même « STUFF-X8K4-P92M » : c'est le cas que le
  // propriétaire a explicitement demandé de verrouiller.
  const secretAwa = "secret-de-awa";
  const secretBebe = "secret-de-bebe";
  const demandeAwa = () => demande({
    id: "ft-req-awa",
    name: "Awa Ngo",
    deviceId: "device-aaa",
    claimSecretHash: hacherSecretReclamation(secretAwa),
    status: STATUT_DEMANDE.DEPLOYED,
    deployedAt: new Date(),
    clientId: "cli-awa",
    subscriptionId: "sub-awa",
  });
  const demandeBebe = () => demande({
    id: "ft-req-bebe",
    name: "Bebe Fon",
    deviceId: "device-bbb",
    claimSecretHash: hacherSecretReclamation(secretBebe),
    status: STATUT_DEMANDE.PENDING,
  });

  it("l'appareil de Bebe ne peut pas lire la demande déployée d'Awa", () => {
    const vol = vueStatutEssaiPourAppareil({
      demande: demandeAwa(),
      deviceId: "device-bbb",
      claimSecret: secretAwa,
      accountToken: "SXB-USER-AAAA-BBBB-CCCC",
    });
    assert.equal(vol.ok, false);
    assert.equal(vol.status, 404);
    assert.equal(JSON.stringify(vol.body).includes("SXB-USER"), false);
  });

  it("le secret de Bebe ne déverrouille pas la demande d'Awa", () => {
    const vol = vueStatutEssaiPourAppareil({
      demande: demandeAwa(),
      deviceId: "device-aaa",
      claimSecret: secretBebe,
      accountToken: "SXB-USER-AAAA-BBBB-CCCC",
    });
    assert.equal(vol.ok, false);
    assert.equal(vol.status, 404);
    assert.equal(vol.body.accountToken, undefined);
  });

  it("connaître le jeton d'essai ne suffit jamais : il n'ouvre aucune lecture", () => {
    // Le jeton n'est pas un paramètre de `vueStatutEssaiPourAppareil` : il n'y
    // a structurellement pas de chemin « jeton → configuration ».
    const parametres = vueStatutEssaiPourAppareil.length;
    assert.equal(parametres, 1, "signature inattendue");
    const source = readFileSync(new URL("../services/free-trial.ts", import.meta.url), "utf8");
    const corps = source.slice(source.indexOf("export function vueStatutEssaiPourAppareil"));
    const fin = corps.indexOf("\nexport function vueInscriptionEssai");
    assert.equal(
      /\btoken\b\s*[:.]/.test(corps.slice(0, fin > 0 ? fin : corps.length).replace(/accountToken/g, "")),
      false,
      "la lecture de statut ne doit dépendre d'aucun jeton d'essai",
    );
  });

  it("les refus d'Awa et de Bebe sont INDISTINCTS (aucun oracle d'énumération)", () => {
    const inconnue = vueStatutEssaiPourAppareil({ demande: null, deviceId: "device-zzz", claimSecret: "x" });
    const mauvaisAppareil = vueStatutEssaiPourAppareil({ demande: demandeBebe(), deviceId: "device-aaa", claimSecret: secretBebe });
    const mauvaisSecret = vueStatutEssaiPourAppareil({ demande: demandeBebe(), deviceId: "device-bbb", claimSecret: "faux" });
    assert.deepEqual(inconnue.body, mauvaisAppareil.body);
    assert.deepEqual(inconnue.body, mauvaisSecret.body);
    assert.equal(inconnue.status, mauvaisAppareil.status);
    assert.equal(inconnue.status, mauvaisSecret.status);
  });

  it("Bebe voit sa PROPRE attente, jamais l'accès d'Awa", () => {
    const sienne = vueStatutEssaiPourAppareil({
      demande: demandeBebe(),
      deviceId: "device-bbb",
      claimSecret: secretBebe,
    });
    assert.equal(sienne.ok, true);
    assert.equal(sienne.body.status, STATUT_DEMANDE.PENDING);
    assert.equal(sienne.body.requestId, "ft-req-bebe");
    assert.equal(JSON.stringify(sienne.body).includes("awa"), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("étapes 4-5 — après déploiement, seul l'appareil autorisé obtient sa config", () => {
  const secret = "secret-de-awa";
  const deployee = () => demande({
    status: STATUT_DEMANDE.DEPLOYED,
    deployedAt: new Date(),
    clientId: "cli-awa",
    subscriptionId: "sub-awa",
    claimSecretHash: hacherSecretReclamation(secret),
  });

  it("l'appareil autorisé reçoit son jeton de COMPTE et l'invitation à recharger", () => {
    const reponse = vueStatutEssaiPourAppareil({
      demande: deployee(),
      deviceId: "device-aaa",
      claimSecret: secret,
      accountToken: "SXB-USER-AAAA-BBBB-CCCC",
    });
    assert.equal(reponse.ok, true);
    assert.equal(reponse.body.status, STATUT_DEMANDE.DEPLOYED);
    assert.equal(reponse.body.accountToken, "SXB-USER-AAAA-BBBB-CCCC");
    assert.equal(reponse.body.reloadRequired, true);
  });

  it("le jeton de compte n'est PAS la configuration : rien de technique ne transite", () => {
    const reponse = vueStatutEssaiPourAppareil({
      demande: deployee(),
      deviceId: "device-aaa",
      claimSecret: secret,
      accountToken: "SXB-USER-AAAA-BBBB-CCCC",
    });
    // Le serveur, le quota et les dates arrivent par le canal VPN normal,
    // après activation — pas par la réponse d'essai gratuit.
    assert.deepEqual(champsInterditsPresents(reponse.body), []);
    for (const valeur of Object.values(CONFIG_SECRETE)) {
      assert.equal(JSON.stringify(reponse.body).includes(String(valeur)), false, `fuite de « ${valeur} »`);
    }
  });

  it("un autre appareil présentant le bon secret est quand même refusé", () => {
    const reponse = vueStatutEssaiPourAppareil({
      demande: deployee(),
      deviceId: "device-intrus",
      claimSecret: secret,
      accountToken: "SXB-USER-AAAA-BBBB-CCCC",
    });
    assert.equal(reponse.ok, false);
    assert.equal(reponse.body.accountToken, undefined);
  });

  it("l'utilisateur n'a jamais à ressaisir le jeton d'essai", () => {
    const reponse = vueStatutEssaiPourAppareil({
      demande: deployee(),
      deviceId: "device-aaa",
      claimSecret: secret,
      accountToken: "SXB-USER-AAAA-BBBB-CCCC",
    });
    // L'application dispose de tout ce qu'il faut pour basculer seule.
    assert.ok(reponse.body.accountToken, "jeton de compte attendu");
    assert.equal(JSON.stringify(reponse.body).includes("STUFF-"), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("étape 3 — instruction admin : fenêtre d'accès et déploiement", () => {
  it("calcule une durée en jours arrondie à la hausse", () => {
    // Dates relatives : le test ne doit pas pourrir avec le calendrier.
    const debut = new Date(Date.now() + 24 * 3600 * 1000);
    const fin = new Date(debut.getTime() + 11.25 * 24 * 3600 * 1000);
    const res = calculerFenetreEssai({ startAt: debut, expireAt: fin });
    assert.equal(res.ok, true);
    // 11,25 jours → 12 : le forfait ne se ferme jamais avant la date annoncée.
    assert.equal(res.fenetre!.durationDays, 12);
    assert.equal(res.fenetre!.startAt.toISOString(), debut.toISOString());
    assert.equal(res.fenetre!.expireAt.toISOString(), fin.toISOString());
  });

  it("refuse une fenêtre incohérente ou déjà passée", () => {
    const inverse = calculerFenetreEssai({ startAt: DEMAIN, expireAt: HIER });
    assert.equal(inverse.ok, false);
    assert.equal(inverse.refus!.status, 400);
    assert.equal(inverse.refus!.body.code, CODES_ESSAI.WINDOW_INVALID);

    assert.equal(calculerFenetreEssai({ expireAt: HIER }).ok, false);
    assert.equal(calculerFenetreEssai({ expireAt: "pas une date" }).ok, false);
    assert.equal(calculerFenetreEssai({ startAt: "pas une date", expireAt: DEMAIN }).ok, false);
  });

  it("accepte les heures de début et de fin quand elles sont précisées", () => {
    // « du 12 à 08h30 au 15 à 18h45 » : l'heure est conservée telle quelle.
    const debut = new Date(Date.now() + 24 * 3600 * 1000);
    debut.setUTCHours(8, 30, 0, 0);
    const fin = new Date(debut.getTime() + 2 * 24 * 3600 * 1000);
    fin.setUTCHours(18, 45, 0, 0);
    const res = calculerFenetreEssai({ startAt: debut.toISOString(), expireAt: fin.toISOString() });
    assert.equal(res.ok, true);
    assert.equal(res.fenetre!.startAt.toISOString(), debut.toISOString());
    assert.equal(res.fenetre!.expireAt.toISOString(), fin.toISOString());
    assert.equal(res.fenetre!.expireAt.getUTCHours(), 18);
    assert.equal(res.fenetre!.expireAt.getUTCMinutes(), 45);
  });

  it("empêche le double déploiement d'une même demande", () => {
    assert.equal(refusDeploiement(demande()), null);
    assert.equal(refusDeploiement(null)!.status, 404);
    const deja = refusDeploiement(demande({ status: STATUT_DEMANDE.DEPLOYED }))!;
    assert.equal(deja.status, 409);
    assert.equal(deja.body.code, CODES_ESSAI.ALREADY_DEPLOYED);
    const refusee = refusDeploiement(demande({ status: STATUT_DEMANDE.REJECTED }))!;
    assert.equal(refusee.status, 409);
    assert.equal(refusee.body.code, CODES_ESSAI.NOT_PENDING);
  });

  it("la vue admin montre Nom | Appareil | Jeton | Statut, sans secret", () => {
    const vue = vueDemandePourAdmin(demande({ trialToken: { token: "STUFF-X8K4-P92M", label: "Campagne" } })) as Record<string, unknown>;
    assert.equal(vue.name, "Awa Ngo");
    assert.equal(vue.deviceId, "device-aaa");
    assert.equal(vue.trialToken, "STUFF-X8K4-P92M");
    assert.equal(vue.status, STATUT_DEMANDE.PENDING);
    // Le secret de réclamation ne quitte jamais le serveur après l'inscription.
    assert.equal("claimSecretHash" in vue, false);
    assert.equal("claimSecret" in vue, false);
    assert.equal(JSON.stringify(vue).includes(hacherSecretReclamation("secret-de-awa")), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("garde-fou anti-fuite — le filet qui rattrape une régression future", () => {
  it("détecte un champ interdit ajouté par mégarde, même imbriqué", () => {
    assert.deepEqual(champsInterditsPresents({ status: "pending" }), []);
    assert.deepEqual(champsInterditsPresents({ status: "pending", server: "Cameroon Server 1" }), ["server"]);
    assert.deepEqual(
      champsInterditsPresents({ status: "pending", meta: { detail: { host: "cmr1.sxbvpn.com" } } }),
      ["host"],
    );
    assert.deepEqual(champsInterditsPresents([{ ok: true }, { uuid: "x" }]), ["uuid"]);
  });

  it("verifierAucuneFuite lève plutôt que de laisser passer une configuration", () => {
    assert.doesNotThrow(() => verifierAucuneFuite({ status: "pending" }));
    assert.throws(
      () => verifierAucuneFuite({ status: "deployed", ...CONFIG_SECRETE }),
      /free[- ]?trial|fuite|leak/i,
    );
  });

  it("couvre les champs sensibles connus du modèle de données", () => {
    for (const attendu of ["host", "port", "server", "uuid", "sni", "config", "quotaBytes", "expireAt", "profileId", "password", "claimSecretHash"]) {
      assert.ok(
        CHAMPS_INTERDITS_MOBILE.includes(attendu),
        `« ${attendu} » devrait figurer dans la liste des champs interdits`,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("contrat de la route — la décision reste dans le service", () => {
  const source = readFileSync(new URL("../routes/free-trial.ts", import.meta.url), "utf8");

  it("expose les routes attendues par l'application et le tableau de bord", () => {
    for (const chemin of [
      "'/tokens'",
      "'/tokens/:id/revoke'",
      "'/enroll'",
      "'/status'",
      "'/requests'",
      "'/requests/deploy'",
      "'/requests/reject'",
      "'/stats/countries'",
      "'/stats/overview'",
    ]) {
      assert.ok(source.includes(chemin), `route ${chemin} manquante`);
    }
  });

  it("protège toutes les routes admin par requireAuth + requirePermission", () => {
    const adminRoutes = source.split(/router\.(?:get|post)\(/).slice(1)
      .filter((bloc) => !bloc.startsWith("'/enroll'") && !bloc.startsWith("'/status'"));
    // 8 routes internes : 3 jetons, 3 demandes (liste + deux récapitulatifs)
    // et 2 actions d'instruction (déploiement, refus).
    assert.equal(adminRoutes.length, 8, "nombre de routes admin inattendu");
    for (const bloc of adminRoutes) {
      const entete = bloc.slice(0, 600);
      assert.ok(entete.includes("requireAuth"), `route admin sans requireAuth : ${entete.slice(0, 40)}`);
      assert.ok(entete.includes("requirePermission"), `route admin sans requirePermission : ${entete.slice(0, 40)}`);
      // Le vivier des demandes, les jetons et les statistiques sont des
      // surfaces d'exploitation INTERNE : un revendeur porte `clients.view`,
      // la permission seule ne doit donc pas suffire à les lui ouvrir.
      assert.ok(
        entete.includes("interdireAccesRevendeur()"),
        `route admin ouverte aux revendeurs : ${entete.slice(0, 40)}`,
      );
    }
  });

  it("délègue la lecture de statut au service plutôt que de la réécrire", () => {
    assert.ok(source.includes("vueStatutEssaiPourAppareil"), "la route doit appeler le service");
    // Extraction robuste : du début de /status jusqu'au router suivant.
    const debut = source.indexOf("router.post('/status'");
    assert.ok(debut > 0, "route /status introuvable");
    const suivant = source.indexOf("router.get(", debut);
    assert.ok(suivant > debut, "fin de la route /status introuvable");
    const bloc = source.slice(debut, suivant);
    // Le jeton de compte n'est chargé qu'après contrôle du statut ET de
    // l'appareil : aucune lecture spéculative.
    assert.ok(bloc.includes("STATUT_DEMANDE.DEPLOYED"), "contrôle de statut attendu avant lecture du compte");
    assert.ok(bloc.includes("demande.deviceId === deviceId"), "contrôle d'appareil attendu avant lecture du compte");
    // Aucune lecture de forfait ni de profil dans la route de statut.
    assert.equal(/subscription\.find|vpnProfile\.find/.test(bloc), false, "la route de statut ne doit lire aucune configuration");
  });

  it("n'accepte aucun paramètre d'accès à la création du jeton", () => {
    const bloc = source.slice(source.indexOf("const creerJetonSchema"), source.indexOf("const inscriptionSchema"));
    for (const interdit of ["profileId", "quotaGB", "serverId", "startAt"]) {
      assert.equal(bloc.includes(interdit), false, `le schéma de jeton accepterait « ${interdit} »`);
    }
    assert.ok(bloc.includes(".strict()"), "le schéma de jeton doit être strict");
  });

  it("le déploiement exige quota + serveur + dates, et accepte plusieurs demandes", () => {
    const bloc = source.slice(source.indexOf("const deployerSchema"), source.indexOf("const refuserSchema"));
    for (const requis of ["requestIds", "profileId", "quotaGB", "expireAt"]) {
      assert.ok(bloc.includes(requis), `le schéma de déploiement doit exiger « ${requis} »`);
    }
    assert.ok(/requestIds:\s*z\s*\.array/.test(bloc.replace(/\s+/g, " ")), "sélection multiple attendue");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("non-régression — le modèle de données reste ADDITIF", () => {
  const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");

  it("ajoute FreeTrialToken et FreeTrialRequest", () => {
    assert.ok(schema.includes("model FreeTrialToken"));
    assert.ok(schema.includes("model FreeTrialRequest"));
    assert.ok(schema.includes('@@map("free_trial_tokens")'));
    assert.ok(schema.includes('@@map("free_trial_requests")'));
  });

  it("le modèle de jeton ne porte AUCUN champ de configuration VPN", () => {
    const debut = schema.indexOf("model FreeTrialToken");
    const bloc = schema.slice(debut, schema.indexOf("}", schema.indexOf("{", debut)));
    // On inspecte les DÉCLARATIONS de champs, pas les commentaires français
    // (où « port » se cache dans « supporte », « rapport »…).
    const champs = bloc
      .split(/\r?\n/)
      .map((ligne) => ligne.replace(/\/\/.*$/, "").trim())
      .map((ligne) => /^([A-Za-z_][A-Za-z0-9_]*)\s+\S/.exec(ligne)?.[1])
      .filter((nom): nom is string => Boolean(nom));
    for (const interdit of ["profileId", "serverId", "quotaBytes", "host", "port", "uuid", "config", "subscriptionId", "clientId"]) {
      assert.equal(champs.includes(interdit), false, `FreeTrialToken porterait « ${interdit} »`);
    }
    assert.ok(champs.includes("token"), "le champ token est attendu");
  });

  it("un appareil ne peut déposer qu'une demande par jeton", () => {
    const debut = schema.indexOf("model FreeTrialRequest");
    const bloc = schema.slice(debut, schema.indexOf("@@map(\"free_trial_requests\")", debut));
    assert.ok(bloc.includes("@@unique([tokenId, deviceId])"), "contrainte d'unicité attendue");
  });

  it("le SQL manuel est purement additif (aucun DROP ni NOT NULL rétroactif)", () => {
    const sql = readFileSync(new URL("../../prisma/migrations_manual.sql", import.meta.url), "utf8");
    // L'assertion porte sur les sections de l'ESSAI GRATUIT, pas sur tout ce
    // qui a été ajouté au fichier depuis. Le découpage par en-tête garde donc
    // exactement la même exigence — l'essai ne touche à aucune table existante
    // — sans se déclencher sur la migration additive d'un autre sujet.
    const sections = sql.slice(sql.indexOf("free_trial_tokens")).split(/\n(?=-- ──)/);
    const bloc = sections.filter(section => /free_trial|essai/i.test(section)).join("\n");
    assert.ok(bloc.includes("CREATE TABLE IF NOT EXISTS"), "création idempotente attendue");
    assert.equal(/DROP\s+(TABLE|COLUMN)/i.test(bloc), false, "aucune suppression tolérée");
    assert.equal(/ALTER\s+TABLE\s+"(?!free_trial)/i.test(bloc), false, "aucune table existante modifiée");
    // Et le fichier entier, toutes sections confondues, reste sans suppression.
    assert.equal(/DROP\s+(TABLE|COLUMN)/i.test(sql), false, "aucune suppression tolérée nulle part");
  });

  it("ajoute pays et empreinte en colonnes NULLABLES, avec leurs index", () => {
    const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
    const debut = schema.indexOf("model FreeTrialRequest");
    const bloc = schema.slice(debut, schema.indexOf('@@map("free_trial_requests")', debut));
    // Nullables : les demandes déposées AVANT l'ajout des colonnes restent
    // valides, donc la production ne casse pas au déploiement.
    assert.match(bloc, /country\s+String\?/, "le pays doit rester nullable");
    assert.match(bloc, /deviceFingerprint\s+String\?/, "l'empreinte doit rester nullable");
    // Le contrôle « un seul essai par appareil » tourne à chaque inscription :
    // il doit être une lecture indexée, pas un balayage.
    assert.ok(bloc.includes("@@index([deviceFingerprint, status])"), "index d'unicité d'essai attendu");
    assert.ok(bloc.includes("@@index([country, status])"), "index de statistiques par pays attendu");

    const sql = readFileSync(new URL("../../prisma/migrations_manual.sql", import.meta.url), "utf8");
    assert.ok(sql.includes('ADD COLUMN IF NOT EXISTS "country"'), "ajout idempotent du pays attendu");
    assert.ok(sql.includes('ADD COLUMN IF NOT EXISTS "deviceFingerprint"'), "ajout idempotent de l'empreinte attendu");
    assert.ok(sql.includes('"free_trial_requests_deviceFingerprint_status_idx"'), "index SQL d'empreinte attendu");
    // Aucune colonne existante rendue obligatoire après coup.
    assert.equal(/ALTER\s+TABLE[^;]*SET\s+NOT\s+NULL/i.test(sql.slice(sql.indexOf("free_trial_tokens"))), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("PAYS — la localisation est SAISIE, jamais mesurée", () => {
  it("n'accepte qu'un code d'une liste ISO 3166-1 alpha-2 FERMÉE", () => {
    assert.equal(estCodePaysValide("CM"), true);
    assert.equal(estCodePaysValide("cm"), true, "la casse ne doit pas faire échouer une saisie valide");
    assert.equal(estCodePaysValide("  fr  "), true);
    // Codes syntaxiquement plausibles mais inexistants : refusés, sinon le
    // récapitulatif « d'où viennent nos clients » mélangerait du bruit.
    for (const faux of ["XX", "ZZ", "AA", "QQ"]) {
      assert.equal(estCodePaysValide(faux), false, `« ${faux} » ne devrait pas être accepté`);
    }
    // Texte libre, code à trois lettres, valeur vide : tous refusés.
    for (const invalide of ["", "   ", "Cameroun", "CMR", "C", "12", null, undefined, 42, {}]) {
      assert.equal(estCodePaysValide(invalide as unknown), false, `« ${String(invalide)} » ne devrait pas être accepté`);
    }
    assert.ok(CODES_PAYS.length > 200, "la liste doit couvrir le monde, pas une poignée de pays");
  });

  it("normalise sans « réparer » : une saisie douteuse échoue au lieu d'être devinée", () => {
    assert.equal(normaliserCodePays(" cm "), "CM");
    assert.equal(normaliserCodePays("CMR"), "", "un code à trois lettres n'est pas tronqué à deux");
    assert.equal(normaliserCodePays("C1"), "");
    assert.equal(normaliserCodePays(null), "");
  });

  it("rend le nom du pays dans les deux langues", () => {
    assert.equal(nomPays("CM", "fr"), "Cameroun");
    assert.equal(nomPays("CM", "en"), "Cameroon");
    assert.equal(nomPays("XX", "fr"), null);
  });

  it("le pays saisi remonte jusqu'à la vue admin", () => {
    const vue = vueDemandePourAdmin(demande({ country: "cm" })) as Record<string, unknown>;
    // Normalisé à l'affichage : l'exploitation voit « CM », jamais « cm ».
    assert.equal(vue.country, "CM");
    const sansPays = vueDemandePourAdmin(demande({ country: null })) as Record<string, unknown>;
    assert.equal(sansPays.country, null, "une demande historique sans pays reste lisible");
    const bruit = vueDemandePourAdmin(demande({ country: "Cameroun" })) as Record<string, unknown>;
    assert.equal(bruit.country, null, "un pays en texte libre ne doit pas s'afficher comme un code");
  });

  it("le pays est renvoyé à l'appareil qui vient de s'inscrire", () => {
    const vue = vueInscriptionEssai({ demande: demande({ country: "CI" }), claimSecret: "s" });
    assert.equal(vue.country, "CI");
    assert.deepEqual(champsInterditsPresents(vue), []);
  });

  it("les trois copies de la table de pays sont IDENTIQUES", () => {
    // Serveur, application mobile et tableau de bord sont trois paquets
    // indépendants : sans ce contrôle, une copie dériverait en silence et un
    // pays valide côté application serait refusé côté serveur.
    const extraire = (chemin: string) => {
      const source = readFileSync(new URL(chemin, import.meta.url), "utf8");
      return [...source.matchAll(/\{\s*code:\s*"([A-Z]{2})",\s*fr:\s*"([^"]+)",\s*en:\s*"([^"]+)"\s*\}/g)]
        .map((m) => `${m[1]}|${m[2]}|${m[3]}`);
    };
    const serveur = extraire("../services/countries.ts");
    const mobile = extraire("../../app-mobile/services/countries.ts");
    const tableau = extraire("../../artifacts/sxb-dashboard/src/lib/countries.ts");
    assert.ok(serveur.length > 200, `table serveur trop courte : ${serveur.length}`);
    assert.deepEqual(mobile, serveur, "app-mobile/services/countries.ts a dérivé");
    assert.deepEqual(tableau, serveur, "artifacts/sxb-dashboard/src/lib/countries.ts a dérivé");
  });

  it("aucune géolocalisation ni service d'adresse IP n'intervient dans ce chemin", () => {
    // Exigence explicite du propriétaire : la localisation est déclarée, pas
    // observée. Le contrôle porte sur le texte des fichiers concernés.
    for (const chemin of [
      "../routes/free-trial.ts",
      "../services/free-trial.ts",
      "../services/countries.ts",
      "../../app-mobile/app/free-trial.tsx",
      "../../app-mobile/services/countries.ts",
    ]) {
      const source = readFileSync(new URL(chemin, import.meta.url), "utf8");
      assert.equal(
        /ipapi|ip-api|geoip|maxmind|ipinfo|geolocation|getCurrentPosition|watchPosition|expo-location/i.test(source),
        false,
        `${chemin} ne doit contenir aucune mesure de localisation`,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("UN SEUL ESSAI PAR APPAREIL — même après désinstallation", () => {
  const EMPREINTE = "a1b2c3d4e5f60718";
  const AUTRE_EMPREINTE = "ffeeddccbbaa9988";

  it("hache l'empreinte avec un sel : la valeur brute n'est jamais conservée", () => {
    const condensat = hacherEmpreinteAppareil(EMPREINTE, "sel-de-test")!;
    assert.match(condensat, /^[a-f0-9]{64}$/, "un SHA-256 hexadécimal est attendu");
    assert.notEqual(condensat, EMPREINTE);
    assert.equal(condensat.includes(EMPREINTE), false, "l'empreinte brute ne doit pas transparaître");
    // Le sel change tout : sans lui, l'espace des ANDROID_ID serait assez
    // petit pour être énuméré hors ligne.
    assert.notEqual(hacherEmpreinteAppareil(EMPREINTE, "autre-sel"), condensat);
    // Déterminisme : le même appareil produit toujours le même condensat,
    // sinon la protection ne tiendrait pas d'une inscription à l'autre.
    assert.equal(hacherEmpreinteAppareil(EMPREINTE, "sel-de-test"), condensat);
    // La casse et les espaces d'une même valeur ne créent pas deux identités.
    assert.equal(hacherEmpreinteAppareil("  A1B2C3D4E5F60718 ", "sel-de-test"), condensat);
  });

  it("refuse les empreintes inexploitables plutôt que d'accorder un essai intraçable", () => {
    // « 9774d56d682e549c » est l'ANDROID_ID partagé par des milliers
    // d'appareils bogués : l'accepter refuserait l'essai à tout le monde
    // après le premier.
    for (const inexploitable of ["", "   ", "null", "undefined", "0", "9774d56d682e549c", "0000000000", "abc"]) {
      assert.equal(empreinteExploitable(inexploitable), false, `« ${inexploitable} » devrait être refusé`);
      assert.equal(hacherEmpreinteAppareil(inexploitable, "sel"), null);
    }
    assert.equal(empreinteExploitable(EMPREINTE), true);
  });

  it("refuse une SECONDE demande depuis la même empreinte après un essai consommé", () => {
    // Le scénario exact du propriétaire : l'utilisateur désinstalle, réinstalle
    // (nouvel identifiant d'appareil), et présente un AUTRE jeton.
    const consommee = demande({
      id: "ft-req-1",
      tokenId: "ft-token-1",
      deviceId: "device-aaa",
      deviceFingerprint: "condensat",
      status: STATUT_DEMANDE.DEPLOYED,
      deployedAt: new Date(),
      clientId: "cli-1",
    });
    const decision = deciderInscriptionParEmpreinte([consommee]);
    assert.equal(decision.type, "refuse");
    assert.equal(decision.type === "refuse" && decision.refus.status, 409);
    assert.equal(decision.type === "refuse" && decision.refus.body.code, CODES_ESSAI.DEVICE_ALREADY_USED);
    // « quel que soit le jeton présenté et quel que soit le deviceId » : la
    // décision ne prend NI l'un NI l'autre en paramètre.
    assert.equal(deciderInscriptionParEmpreinte.length, 1, "signature inattendue");
  });

  it("un essai TERMINÉ compte comme consommé, un refus non", () => {
    assert.deepEqual([...STATUTS_ESSAI_CONSOMME], [STATUT_DEMANDE.DEPLOYED]);
    // Un essai déployé puis expiré reste « déployé » : il n'y a pas de
    // deuxième fois, exactement comme demandé.
    const expiree = demande({ status: STATUT_DEMANDE.DEPLOYED, deployedAt: HIER, clientId: "cli-1" });
    assert.equal(deciderInscriptionParEmpreinte([expiree]).type, "refuse");
    // Une demande REFUSÉE n'a jamais ouvert d'accès : fermer la porte à vie
    // serait une punition, pas une protection.
    const refusee = demande({ status: STATUT_DEMANDE.REJECTED, rejectedAt: HIER });
    assert.equal(deciderInscriptionParEmpreinte([refusee]).type, "autorise");
  });

  it("une demande encore EN ATTENTE est retrouvée, pas refusée ni dupliquée", () => {
    const enAttente = demande({ id: "ft-req-attente", status: STATUT_DEMANDE.PENDING, createdAt: HIER });
    const decision = deciderInscriptionParEmpreinte([enAttente]);
    assert.equal(decision.type, "reprise");
    assert.equal(decision.type === "reprise" && decision.demande.id, "ft-req-attente");

    // Plusieurs demandes en attente ne devraient pas coexister ; si cela
    // arrive, on retient la plus récente plutôt que d'en créer une de plus.
    const recente = demande({ id: "ft-req-recente", createdAt: new Date() });
    const choisie = deciderInscriptionParEmpreinte([enAttente, recente]);
    assert.equal(choisie.type === "reprise" && choisie.demande.id, "ft-req-recente");
  });

  it("un appareil inconnu est autorisé : la protection ne bloque personne à tort", () => {
    assert.equal(deciderInscriptionParEmpreinte([]).type, "autorise");
    assert.equal(deciderInscriptionParEmpreinte([null, undefined]).type, "autorise");
  });

  it("le refus ne divulgue AUCUNE donnée de la personne précédente", () => {
    const refus = refusEssaiDejaConsomme();
    const texte = JSON.stringify(refus.body);
    for (const fuite of ["Awa", "device-aaa", "CM", "ft-req-1", "cli-1", "STUFF-"]) {
      assert.equal(texte.includes(fuite), false, `le refus laisserait filtrer « ${fuite} »`);
    }
    // Corps minimal : un code, une clé de traduction, un message générique.
    assert.deepEqual(Object.keys(refus.body).sort(), ["code", "error", "message"]);
    assert.deepEqual(champsInterditsPresents(refus.body), []);
  });

  it("l'empreinte — même hachée — ne sort par AUCUNE vue", () => {
    const avecEmpreinte = demande({ deviceFingerprint: "condensat-secret-0123456789abcdef" });
    const vues: Record<string, unknown>[] = [
      vueDemandePourAdmin(avecEmpreinte) as Record<string, unknown>,
      vueInscriptionEssai({ demande: avecEmpreinte, claimSecret: "s" }),
      vueStatutEssaiPourAppareil({
        demande: { ...avecEmpreinte, claimSecretHash: hacherSecretReclamation("s") },
        deviceId: avecEmpreinte.deviceId,
        claimSecret: "s",
      }).body,
    ];
    for (const vue of vues) {
      const texte = JSON.stringify(vue);
      assert.equal("deviceFingerprint" in vue, false, "le condensat ne doit apparaître dans aucune vue");
      assert.equal(texte.includes("condensat-secret"), false, "le condensat ne doit pas transparaître");
    }
    // Filet de sécurité : le garde-fou anti-fuite connaît désormais le champ.
    assert.ok(CHAMPS_INTERDITS_MOBILE.includes("deviceFingerprint"));
    assert.throws(() => verifierAucuneFuite({ status: "pending", deviceFingerprint: "x" }));
  });

  it("l'empreinte n'est jamais journalisée par la route d'inscription", () => {
    const route = readFileSync(new URL("../routes/free-trial.ts", import.meta.url), "utf8");
    const debut = route.indexOf("router.post('/enroll'");
    const bloc = route.slice(debut, route.indexOf("router.post('/status'", debut));
    // Le seul usage autorisé de la valeur brute est son hachage immédiat.
    const usages = [...bloc.matchAll(/body\.deviceFingerprint/g)];
    assert.equal(usages.length, 1, "la valeur brute ne doit servir qu'au hachage");
    assert.ok(bloc.includes("hacherEmpreinteAppareil(body.deviceFingerprint)"));
    // Aucun journal ne reçoit l'empreinte, brute ou hachée.
    for (const journal of [...bloc.matchAll(/logDbActivity\([\s\S]{0,400}?\)/g)].map((m) => m[0])) {
      assert.equal(/empreinte|Fingerprint|fingerprint/.test(journal), false, "un journal recevrait l'empreinte");
    }
    assert.equal(/console\.(log|info|warn)\([^)]*[Ff]ingerprint/.test(bloc), false);
  });

  it("une reprise émet TOUJOURS un secret cohérent avec ce qui est stocké", () => {
    // Remettre à l'appareil un secret dont le condensat n'a pas été écrit le
    // laisserait bloqué : ses vérifications de statut échoueraient à jamais.
    const route = readFileSync(new URL("../routes/free-trial.ts", import.meta.url), "utf8");
    const debut = route.indexOf("router.post('/enroll'");
    const bloc = route.slice(debut, route.indexOf("router.post('/status'", debut));
    const reprise = bloc.slice(bloc.indexOf("const reprendre = async"), bloc.indexOf("const token ="));
    assert.ok(reprise.includes("const secret = genererSecretReclamation()"));
    assert.ok(reprise.includes("claimSecretHash: hacherSecretReclamation(secret)"));
    assert.ok(reprise.includes("claimSecret: secret"), "le secret remis doit être celui qui vient d'être haché");
    // Les trois reprises possibles (empreinte en attente, même jeton + même
    // appareil, course perdue) passent par ce seul chemin : aucune ne peut
    // renvoyer un secret orphelin.
    assert.equal([...bloc.matchAll(/return reprendre\(/g)].length, 3, "chemins de reprise inattendus");
    assert.equal(
      [...bloc.matchAll(/vueInscriptionEssai\(/g)].length, 2,
      "deux réponses d'inscription seulement : la reprise et la création",
    );
    // L'identifiant d'appareil est réaligné : après réinstallation il a changé,
    // et la lecture de statut exige qu'il corresponde.
    assert.ok(reprise.includes("deviceId,"), "l'appareil courant doit être réaligné sur la demande");
  });

  it("le contrôle d'empreinte précède la lecture du jeton, et se rejoue dans la transaction", () => {
    const route = readFileSync(new URL("../routes/free-trial.ts", import.meta.url), "utf8");
    const debut = route.indexOf("router.post('/enroll'");
    const bloc = route.slice(debut, route.indexOf("router.post('/status'", debut));
    const posEmpreinte = bloc.indexOf("deciderInscriptionParEmpreinte");
    const posJeton = bloc.indexOf("freeTrialToken.findUnique");
    assert.ok(posEmpreinte > 0 && posJeton > 0, "les deux contrôles doivent exister");
    assert.ok(
      posEmpreinte < posJeton,
      "le refus « appareil déjà servi » ne doit dépendre d'aucun jeton, donc précéder sa lecture",
    );
    // Deux inscriptions simultanées depuis le même appareil ne doivent pas
    // produire deux demandes : le contrôle est rejoué DANS la transaction.
    const transaction = bloc.slice(bloc.indexOf("prisma.$transaction"));
    assert.ok(transaction.includes("deciderInscriptionParEmpreinte"), "contrôle transactionnel attendu");
    // La lecture est indexée sur `deviceFingerprint`, jamais un balayage.
    assert.ok(bloc.includes("where: { deviceFingerprint: empreinte }"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("STATISTIQUES PAR PAYS — « d'où viennent nos clients »", () => {
  const lot = [
    { country: "CM", status: STATUT_DEMANDE.DEPLOYED, clientId: "cli-1" },
    { country: "CM", status: STATUT_DEMANDE.DEPLOYED, clientId: "cli-2" },
    { country: "CM", status: STATUT_DEMANDE.PENDING, clientId: null },
    { country: "CI", status: STATUT_DEMANDE.DEPLOYED, clientId: "cli-3" },
    { country: "CI", status: STATUT_DEMANDE.REJECTED, clientId: null },
    { country: "SN", status: STATUT_DEMANDE.PENDING, clientId: null },
    { country: null, status: STATUT_DEMANDE.PENDING, clientId: null },
  ];

  it("compte les clients et les demandes par pays, par volume décroissant", () => {
    const lignes = statistiquesParPays(lot);
    assert.deepEqual(lignes.map((l) => l.country), ["CM", "CI", "SN", null]);
    assert.deepEqual(lignes[0], { country: "CM", requests: 3, pending: 1, rejected: 0, clients: 2 });
    assert.deepEqual(lignes[1], { country: "CI", requests: 2, pending: 0, rejected: 1, clients: 1 });
  });

  it("ne compte jamais deux fois le même client", () => {
    // Deux demandes déployées sur le MÊME compte ne font pas deux clients,
    // sinon le tableau de bord surévaluerait la base installée.
    const lignes = statistiquesParPays([
      { country: "CM", status: STATUT_DEMANDE.DEPLOYED, clientId: "cli-1" },
      { country: "CM", status: STATUT_DEMANDE.DEPLOYED, clientId: "cli-1" },
    ]);
    assert.equal(lignes[0].clients, 1);
    assert.equal(lignes[0].requests, 2);
  });

  it("range les pays invalides avec les demandes sans pays, sans les inventer", () => {
    const lignes = statistiquesParPays([{ country: "XX", status: STATUT_DEMANDE.PENDING, clientId: null }]);
    assert.equal(lignes[0].country, null, "« XX » ne doit pas apparaître comme un pays");
  });

  it("l'ordre est TOTAL : deux appels sur les mêmes données rendent le même ordre", () => {
    const a = statistiquesParPays(lot).map((l) => l.country);
    const b = statistiquesParPays([...lot].reverse()).map((l) => l.country);
    assert.deepEqual(a, b, "un tableau qui se réordonne seul est illisible");
  });

  it("les totaux excluent le pays « non renseigné » du décompte de pays", () => {
    const totaux = totauxParPays(statistiquesParPays(lot));
    assert.equal(totaux.countries, 3);
    assert.equal(totaux.clients, 3);
    assert.equal(totaux.requests, 7);
  });

  it("le récapitulatif ne contient que des compteurs, jamais d'identité", () => {
    const texte = JSON.stringify(statistiquesParPays(lot));
    for (const fuite of ["Awa", "device-", "STUFF-", "cli-1"]) {
      assert.equal(texte.includes(fuite), false, `la statistique laisserait filtrer « ${fuite} »`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("MENTION « PÉRIODE D'ESSAI » — visible aussi côté revendeur", () => {
  it("construit la mention avec le pays et la date de fin", () => {
    const marque = marqueEssaiPourClient({
      demande: { country: "cm", deployedAt: HIER },
      expireAt: DEMAIN,
    })!;
    assert.equal(marque.trial, true);
    assert.equal(marque.country, "CM");
    assert.equal(marque.trialEndsAt, DEMAIN.toISOString());
    assert.equal(marque.trialStartedAt, HIER.toISOString());
  });

  it("ne marque rien sans demande d'essai", () => {
    assert.equal(marqueEssaiPourClient({ demande: null, expireAt: DEMAIN }), null);
  });

  it("seules les demandes DÉPLOYÉES marquent un client", () => {
    const marques = readFileSync(new URL("../services/free-trial-marks.ts", import.meta.url), "utf8");
    assert.ok(marques.includes("status: STATUT_DEMANDE.DEPLOYED"), "filtre sur le déploiement attendu");
    // Une lecture par page, jamais une par ligne.
    assert.ok(marques.includes("clientId: { in: ids }"));
  });

  it("la mention accompagne les appareils ET les clients", () => {
    const appareils = readFileSync(new URL("../services/device-quota.ts", import.meta.url), "utf8");
    assert.ok(appareils.includes("trial: trial ?? null"), "sanitizeDevice doit porter la mention");
    const clients = readFileSync(new URL("../routes/clients.ts", import.meta.url), "utf8");
    assert.ok(clients.includes("marquesEssaiParClient"), "la liste des clients doit charger la mention");
    const devices = readFileSync(new URL("../routes/devices.ts", import.meta.url), "utf8");
    assert.ok(devices.includes("marquesEssaiParClient"), "la liste des appareils doit charger la mention");
  });

  it("le REVENDEUR voit la mention sur ses clients, mais rien du vivier global", () => {
    // La mention passe par /clients et /devices, déjà cloisonnés par
    // `porteeClientsRevendeur` : elle n'élargit aucune portée.
    const clients = readFileSync(new URL("../routes/clients.ts", import.meta.url), "utf8");
    const listeClients = clients.slice(clients.indexOf('// GET /api/clients'), clients.indexOf('// GET /api/clients/'));
    assert.ok(listeClients.includes("porteeClientsRevendeur"), "cloisonnement revendeur attendu");
    assert.ok(listeClients.includes("marquesEssaiParClient"), "mention d'essai attendue");
    const marques = readFileSync(new URL("../services/free-trial-marks.ts", import.meta.url), "utf8");
    assert.equal(
      /reseller|revendeur/i.test(marques.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")),
      false,
      "le calcul de la mention ne doit contenir aucune logique de portée",
    );

    // À l'inverse, les surfaces GLOBALES sont fermées aux revendeurs.
    const route = readFileSync(new URL("../routes/free-trial.ts", import.meta.url), "utf8");
    for (const chemin of ["'/tokens'", "'/requests'", "'/stats/countries'", "'/requests/deploy'", "'/requests/reject'"]) {
      const debut = route.indexOf(`${chemin},`);
      assert.ok(debut > 0, `route ${chemin} introuvable`);
      const entete = route.slice(debut, debut + 400);
      assert.ok(entete.includes("interdireAccesRevendeur()"), `${chemin} doit refuser les revendeurs`);
    }
    const acces = readFileSync(new URL("../services/reseller-access.ts", import.meta.url), "utf8");
    assert.ok(acces.includes("export function interdireAccesRevendeur"), "garde attendue dans reseller-access");
    assert.ok(acces.includes('req.user?.role !== "RESELLER"'), "plafond de rôle en dur attendu");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("LOTS — les demandes vivent SOUS leur jeton, jamais mélangées", () => {
  it("une demande d'un autre jeton n'entre pas dans le lot", () => {
    const sienne = demande({ id: "a", tokenId: "ft-token-1" });
    const etrangere = demande({ id: "b", tokenId: "ft-token-2" });
    assert.equal(demandeAppartientAuJeton(sienne, "ft-token-1"), true);
    assert.equal(demandeAppartientAuJeton(etrangere, "ft-token-1"), false,
      "« tout sélectionner » sous un jeton ne doit jamais toucher un autre jeton");
    assert.equal(demandeAppartientAuJeton(null, "ft-token-1"), false);
    // Sans contexte de jeton (liste globale), le contrôle laisse passer : la
    // cohérence est alors assurée par les contrôles unitaires habituels.
    assert.equal(demandeAppartientAuJeton(etrangere, undefined), true);
  });

  it("refuse un lot trop grand avec un message explicite, sans troncature", () => {
    const trop = Array.from({ length: MAX_LOT_ESSAI + 1 }, (_, i) => `ft-req-${i}`);
    const lot = normaliserLotEssai(trop);
    assert.equal(lot.ok, false);
    assert.equal(lot.ok === false && lot.raison, RAISONS_LOT_ESSAI.LOT_TROP_GRAND);
    const refus = refusLotEssai(RAISONS_LOT_ESSAI.LOT_TROP_GRAND, MAX_LOT_ESSAI);
    assert.equal(refus.status, 400);
    assert.equal(refus.body.code, "FREE_TRIAL_BATCH_TOO_LARGE");
    assert.equal(refus.body.limit, MAX_LOT_ESSAI);
    assert.match(String(refus.body.message), new RegExp(String(MAX_LOT_ESSAI)));
    // Un lot exactement à la limite passe : la borne est inclusive.
    assert.equal(normaliserLotEssai(trop.slice(0, MAX_LOT_ESSAI)).ok, true);
  });

  it("retire les doublons : un identifiant deux fois ne déploie pas deux fois", () => {
    const lot = normaliserLotEssai(["a", "a", " a ", "b", "", null, 42]);
    assert.equal(lot.ok, true);
    assert.deepEqual(lot.ok && lot.ids, ["a", "b"]);
    assert.equal(normaliserLotEssai([]).ok, false);
    assert.equal(normaliserLotEssai([""]).ok === false && normaliserLotEssai([""]).raison, RAISONS_LOT_ESSAI.LOT_VIDE);
  });

  it("une demande déjà déployée ou refusée ne peut pas être redéployée par le lot", () => {
    assert.equal(refusDeploiement(demande({ status: STATUT_DEMANDE.DEPLOYED }))!.body.code, CODES_ESSAI.ALREADY_DEPLOYED);
    assert.equal(refusDeploiement(demande({ status: STATUT_DEMANDE.REJECTED }))!.body.code, CODES_ESSAI.NOT_PENDING);
    assert.equal(refusDeploiement(demande()), null, "une demande en attente reste déployable");
  });

  it("la route applique le lot demande par demande, sans annuler les réussites", () => {
    const route = readFileSync(new URL("../routes/free-trial.ts", import.meta.url), "utf8");
    const debut = route.indexOf("'/requests/deploy',");
    assert.ok(debut > 0, "route de déploiement introuvable");
    const bloc = route.slice(debut, route.indexOf("'/requests/reject',", debut));
    // Bornage explicite du lot AVANT toute écriture.
    assert.ok(bloc.includes("normaliserLotEssai(body.requestIds)"));
    assert.ok(bloc.includes("refusLotEssai("));
    // Cohérence jeton ↔ demande revérifiée côté serveur : la liste reçue
    // n'est jamais crue sur parole.
    assert.ok(bloc.includes("demandeAppartientAuJeton(demande, body.tokenId)"));
    assert.ok(bloc.includes(RAISONS_LOT_ESSAI.TOKEN_MISMATCH) || bloc.includes("RAISONS_LOT_ESSAI.TOKEN_MISMATCH"));
    // Chaque demande est traitée dans son propre try : un échec isolé est
    // rapporté, il n'annule pas les précédentes.
    assert.ok(/for \(const requestId of lot\.ids\)/.test(bloc), "itération sur le lot normalisé attendue");
    assert.ok(bloc.includes("resultats.push({ id: requestId, status: 'deployed' })"));
    assert.ok(/status: concurrent \? 'skipped' : 'failed'/.test(bloc));
    assert.ok(bloc.includes("results: resultats"), "résultat rapporté élément par élément");
    // Chaque déploiement reste conditionné à « encore en attente » : deux
    // admins simultanés ne créent pas deux forfaits.
    assert.ok(bloc.includes("status: STATUT_DEMANDE.PENDING"));
  });

  it("le refus groupé filtre lui aussi sur le jeton du contexte", () => {
    const route = readFileSync(new URL("../routes/free-trial.ts", import.meta.url), "utf8");
    const debut = route.indexOf("'/requests/reject',");
    assert.ok(debut > 0, "route de refus introuvable");
    const bloc = route.slice(debut);
    assert.ok(bloc.includes("normaliserLotEssai(body.requestIds)"));
    assert.ok(bloc.includes("...(body.tokenId ? { tokenId: body.tokenId } : {})"));
    assert.ok(bloc.includes("status: STATUT_DEMANDE.PENDING"), "seule une demande en attente est refusable");
  });

  it("la liste des demandes se lit par jeton et par page", () => {
    const route = readFileSync(new URL("../routes/free-trial.ts", import.meta.url), "utf8");
    const bloc = route.slice(route.indexOf("const listeDemandesSchema"), route.indexOf("// ═", route.indexOf("const listeDemandesSchema")));
    for (const champ of ["tokenId", "limit", "offset"]) {
      assert.ok(bloc.includes(champ), `le filtre de lecture doit accepter « ${champ} »`);
    }
    const liste = route.slice(route.indexOf("'/requests',"), route.indexOf("'/stats/countries',"));
    assert.ok(liste.includes("skip: decalage"), "pagination attendue");
    assert.ok(liste.includes("take: limite"), "bornage de page attendu");
    assert.ok(liste.includes("freeTrialRequest.count"), "total attendu pour la pagination");
  });

  it("les compteurs par statut accompagnent chaque jeton", () => {
    const vue = vueJetonPourAdmin(jeton({ pendingCount: 12, deployedCount: 3, rejectedCount: 1 }));
    assert.equal(vue.pendingCount, 12);
    assert.equal(vue.deployedCount, 3);
    assert.equal(vue.rejectedCount, 1);
    // Valeurs par défaut : un jeton sans demande n'affiche pas « NaN ».
    const nu = vueJetonPourAdmin(jeton());
    assert.equal(nu.pendingCount, 0);
    assert.equal(nu.deployedCount, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("séparation — les essais ne se mélangent plus aux clients principaux", () => {
  /**
   * Faux ORM minimal : deux à trois lectures suffisent à établir ce qui, dans
   * le parc, provient d'un essai. Le compteur d'appels est vérifié pour que la
   * séparation ne devienne jamais une requête par ligne affichée.
   */
  function baseFictive(params: {
    demandes?: Array<Record<string, unknown>>;
    forfaits?: Array<Record<string, unknown>>;
    comptes?: Array<Record<string, unknown>>;
    sansEssai?: boolean;
  }) {
    const appels: string[] = [];
    const db: any = {
      subscription: {
        findMany: async (args: any) => {
          appels.push("subscription.findMany");
          const ids: string[] = args?.where?.clientId?.in ?? [];
          return (params.forfaits ?? []).filter((f) => ids.includes(String(f.clientId)));
        },
      },
      vpnClient: {
        findMany: async (args: any) => {
          appels.push("vpnClient.findMany");
          const ids: string[] = args?.where?.id?.in ?? [];
          return (params.comptes ?? []).filter((c) => ids.includes(String(c.id)));
        },
      },
    };
    if (!params.sansEssai) {
      db.freeTrialRequest = {
        findMany: async (args: any) => {
          appels.push("freeTrialRequest.findMany");
          const statut = args?.where?.status;
          return (params.demandes ?? []).filter((d) => !statut || d.status === statut);
        },
      };
    }
    return { db, appels };
  }

  it("reconnaît rétroactivement les essais DÉJÀ déployés, sans migration", async () => {
    // C'est le cas de la capture du propriétaire : le forfait existe depuis
    // longtemps et ne porte aucune colonne dédiée. Le lien passe par la
    // demande d'essai, qui existe depuis l'origine.
    const { db, appels } = baseFictive({
      demandes: [
        { status: STATUT_DEMANDE.DEPLOYED, clientId: "cli-1", subscriptionId: "sub-essai" },
        { status: STATUT_DEMANDE.PENDING, clientId: null, subscriptionId: null },
      ],
      forfaits: [{ id: "sub-essai", clientId: "cli-1" }],
      comptes: [{ id: "cli-1", quotaTotal: null }],
    });
    const portee = await porteeEssaiDeploye(db);
    assert.equal(portee.exploitable, true);
    assert.deepEqual(portee.subscriptionIds, ["sub-essai"]);
    assert.deepEqual(portee.clientsEssaiUniquement, ["cli-1"]);
    // Trois lectures indexées pour toute une page, jamais une par ligne.
    assert.equal(appels.length, 3);
  });

  it("ne compte QUE les demandes déployées : une demande en attente n'a ouvert aucun accès", async () => {
    const { db } = baseFictive({
      demandes: [
        { status: STATUT_DEMANDE.PENDING, clientId: "cli-attente", subscriptionId: "sub-attente" },
        { status: STATUT_DEMANDE.REJECTED, clientId: "cli-refus", subscriptionId: "sub-refus" },
      ],
    });
    const portee = await porteeEssaiDeploye(db);
    assert.deepEqual(portee.clientIds, []);
    assert.deepEqual(portee.subscriptionIds, []);
  });

  it("un essayeur devenu client payant sort de la liste des comptes d'essai", async () => {
    const { db } = baseFictive({
      demandes: [
        { status: STATUT_DEMANDE.DEPLOYED, clientId: "cli-converti", subscriptionId: "sub-essai" },
        { status: STATUT_DEMANDE.DEPLOYED, clientId: "cli-pur", subscriptionId: "sub-essai-2" },
      ],
      forfaits: [
        { id: "sub-essai", clientId: "cli-converti" },
        { id: "sub-paye", clientId: "cli-converti" },
        { id: "sub-essai-2", clientId: "cli-pur" },
      ],
    });
    const portee = await porteeEssaiDeploye(db);
    // Les deux forfaits d'essai restent retranchés de « Forfaits Data »…
    assert.deepEqual([...portee.subscriptionIds].sort(), ["sub-essai", "sub-essai-2"]);
    // … mais le compte converti reste visible dans « Comptes VPN » et
    // « Appareils » : c'est un vrai client, le perdre de vue serait pire.
    assert.deepEqual(portee.clientsEssaiUniquement, ["cli-pur"]);
    assert.deepEqual([...portee.clientIds].sort(), ["cli-converti", "cli-pur"]);
  });

  it("un volume attribué directement au compte vaut accès ordinaire", async () => {
    // Cas sans forfait : l'appareil porte son propre quota (`quotaSource:
    // "client"`). Le manquer ferait disparaître un vrai client de
    // l'exploitation le jour où on lui accorde un essai.
    const { db } = baseFictive({
      demandes: [
        { status: STATUT_DEMANDE.DEPLOYED, clientId: "cli-quota", subscriptionId: "sub-essai" },
        { status: STATUT_DEMANDE.DEPLOYED, clientId: "cli-pur", subscriptionId: "sub-essai-2" },
      ],
      forfaits: [{ id: "sub-essai", clientId: "cli-quota" }, { id: "sub-essai-2", clientId: "cli-pur" }],
      comptes: [
        { id: "cli-quota", quotaTotal: BigInt(5) * BigInt(1024) ** BigInt(3) },
        { id: "cli-pur", quotaTotal: BigInt(0) },
      ],
    });
    const portee = await porteeEssaiDeploye(db);
    assert.deepEqual(portee.clientsEssaiUniquement, ["cli-pur"]);
  });

  it("sans fonctionnalité d'essai déployée, AUCUNE ligne n'est masquée", async () => {
    const { db } = baseFictive({ sansEssai: true });
    const portee = await porteeEssaiDeploye(db);
    assert.equal(portee.exploitable, false);
    assert.deepEqual(portee.clientsEssaiUniquement, []);
    // Une lecture qui échoue ne doit pas non plus amputer un écran critique.
    const casse = await porteeEssaiDeploye({
      freeTrialRequest: { findMany: async () => { throw new Error("base indisponible"); } },
    });
    assert.equal(casse.exploitable, false);
    assert.deepEqual(casse.subscriptionIds, []);
  });

  it("l'absence de paramètre ne change le contrat d'aucun appelant historique", () => {
    assert.equal(inclutEssaisGratuits(undefined), true);
    assert.equal(inclutEssaisGratuits(null), true);
    assert.equal(inclutEssaisGratuits(""), true);
    assert.equal(inclutEssaisGratuits("true"), true);
    assert.equal(inclutEssaisGratuits("1"), true);
    for (const refus of ["false", "0", "no", "off", "non", "FALSE", " False "]) {
      assert.equal(inclutEssaisGratuits(refus), false, `« ${refus} » doit masquer les essais`);
    }
    // Express rend un tableau quand le paramètre est répété.
    assert.equal(inclutEssaisGratuits(["false", "true"]), false);
  });

  it("le filtre d'essai RETRANCHE toujours, il n'élargit jamais la portée revendeur", () => {
    const portee = { resellerId: "res-1" };
    const exclusion = exclureIdentifiants("id", ["cli-essai"]);
    const combine = etFiltres(portee, exclusion)!;
    // Un `{ ...a, ...b }` aurait écrasé une clé commune et rendu une liste trop
    // large : la combinaison est un ET explicite.
    assert.deepEqual(combine, { AND: [{ resellerId: "res-1" }, { id: { notIn: ["cli-essai"] } }] });
    // Rien à retrancher : la requête d'origine reste strictement inchangée.
    assert.equal(exclureIdentifiants("id", []), null);
    assert.deepEqual(etFiltres(portee, null), portee);
    assert.equal(etFiltres(null, undefined), undefined);
  });

  it("les trois écrans d'exploitation filtrent CÔTÉ SERVEUR, pas dans le navigateur", () => {
    for (const [fichier, ancre] of [
      ["../routes/subscriptions.ts", "router.get('/',"],
      ["../routes/clients.ts", 'router.get("/",'],
      ["../routes/devices.ts", 'router.get("/",'],
    ] as const) {
      const source = readFileSync(new URL(fichier, import.meta.url), "utf8");
      const debut = source.indexOf(ancre);
      assert.ok(debut > 0, `route de liste introuvable dans ${fichier}`);
      const bloc = source.slice(debut, debut + 3000);
      assert.ok(bloc.includes("inclutEssaisGratuits(req.query.includeFreeTrial)"),
        `${fichier} doit lire le paramètre de requête`);
      assert.ok(bloc.includes("porteeEssaiDeploye(prisma)"), `${fichier} doit réutiliser le marqueur existant`);
      assert.ok(bloc.includes("exclureIdentifiants("), `${fichier} doit retrancher dans la requête`);
      assert.ok(bloc.includes("etFiltres("), `${fichier} doit composer sans écraser la portée revendeur`);
    }
    // Les compteurs de « Forfaits Data » suivent le MÊME filtre que la liste.
    const forfaits = readFileSync(new URL("../routes/subscriptions.ts", import.meta.url), "utf8");
    const stats = forfaits.slice(forfaits.indexOf("router.get('/stats',"), forfaits.indexOf("router.get('/:id',"));
    assert.ok(stats.includes("inclutEssaisGratuits(req.query.includeFreeTrial)"));
    assert.ok(stats.includes("exclureIdentifiants('id', portee.subscriptionIds)"));
  });

  it("les trois vues s'ouvrent TOUJOURS essais masqués", () => {
    for (const vue of ["SubscriptionsView", "ClientsView", "DevicesView"]) {
      const source = readFileSync(
        new URL(`../../artifacts/sxb-dashboard/src/components/${vue}.tsx`, import.meta.url),
        "utf8",
      );
      assert.ok(/useState\(false\)/.test(source.slice(source.indexOf("inclureEssais"), source.indexOf("inclureEssais") + 200)),
        `${vue} doit démarrer avec les essais masqués`);
      assert.ok(source.includes("includeFreeTrial: inclureEssais"),
        `${vue} doit transmettre le filtre au serveur`);
      assert.ok(source.includes("<FreeTrialToggle"), `${vue} doit porter l'interrupteur`);
      assert.ok(source.includes("}, [inclureEssais]);"), `${vue} doit recharger depuis le serveur à la bascule`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("indicateurs propres à l'essai gratuit", () => {
  const presence = { measured: true, reason: null, windowMinutes: 15, heartbeatMinutes: 5 };

  it("distingue « déployé » (histoire) de « actif » (maintenant)", () => {
    const futur = new Date(Date.now() + 3_600_000);
    const passe = new Date(Date.now() - 3_600_000);
    assert.equal(estEssaiActif({ status: "active", expireAt: futur }), true);
    assert.equal(estEssaiActif({ status: "active", expireAt: null }), true);
    assert.equal(estEssaiActif({ status: "active", expireAt: passe }), false);
    assert.equal(estEssaiActif({ status: "suspended", expireAt: futur }), false);
    assert.equal(estEssaiActif({ status: "revoked", expireAt: futur }), false);
    // Volume épuisé : l'accès existe sur le papier mais ne transporte plus rien.
    assert.equal(estEssaiActif({ status: "active", expireAt: futur, quotaBytes: 100, quotaUsed: 100 }), false);
    assert.equal(estEssaiActif({ status: "active", expireAt: futur, quotaBytes: 100, quotaUsed: 99 }), true);
    // Quota illimité (0) : l'épuisement n'a pas de sens.
    assert.equal(estEssaiActif({ status: "active", expireAt: futur, quotaBytes: 0, quotaUsed: 5 }), true);
    // Forfait introuvable : on ne suppose jamais un accès qu'on ne peut plus lire.
    assert.equal(estEssaiActif(null), false);
  });

  it("compte les inscrits, les états et les essais encore ouverts", () => {
    const futur = new Date(Date.now() + 3_600_000);
    const resume = resumerEssais({
      demandes: [
        { status: STATUT_DEMANDE.DEPLOYED, clientId: "cli-1", subscriptionId: "sub-1" },
        { status: STATUT_DEMANDE.DEPLOYED, clientId: "cli-2", subscriptionId: "sub-2" },
        { status: STATUT_DEMANDE.PENDING },
        { status: STATUT_DEMANDE.REJECTED },
      ],
      forfaits: new Map([
        ["sub-1", { status: "active", expireAt: futur }],
        ["sub-2", { status: "active", expireAt: new Date(Date.now() - 1_000) }],
      ]),
      clientsConnectes: new Set(["cli-1", "cli-2", "cli-inconnu"]),
      presence,
    });
    assert.equal(resume.total, 4);
    assert.equal(resume.deployed, 2);
    assert.equal(resume.pending, 1);
    assert.equal(resume.rejected, 1);
    assert.equal(resume.active, 1);
    // Ni un compte connecté étranger à l'essai, ni un ancien essayeur dont
    // l'essai est terminé : la section d'essai ne compte que des essais ouverts.
    assert.equal(resume.connectedNow, 1);
  });

  it("compte des COMPTES distincts, pas des demandes", () => {
    const futur = new Date(Date.now() + 3_600_000);
    const resume = resumerEssais({
      demandes: [
        { status: STATUT_DEMANDE.DEPLOYED, clientId: "cli-1", subscriptionId: "sub-1" },
        { status: STATUT_DEMANDE.DEPLOYED, clientId: "cli-1", subscriptionId: "sub-2" },
      ],
      forfaits: new Map([
        ["sub-1", { status: "active", expireAt: futur }],
        ["sub-2", { status: "active", expireAt: futur }],
      ]),
      clientsConnectes: new Set(["cli-1"]),
      presence,
    });
    assert.equal(resume.deployed, 2);
    assert.equal(resume.connectedNow, 1, "deux essais sur le même compte ne font pas deux connectés");
  });

  it("dit « non mesuré » plutôt que zéro quand la présence est indisponible", () => {
    const resume = resumerEssais({
      demandes: [{ status: STATUT_DEMANDE.DEPLOYED, clientId: "cli-1", subscriptionId: "sub-1" }],
      clientsConnectes: null,
      presence: { measured: false, reason: "not_configured", windowMinutes: 15, heartbeatMinutes: 5 },
    });
    assert.equal(resume.connectedNow, null, "zéro se lirait « personne n'est connecté »");
    assert.equal(resume.presence.measured, false);
    assert.equal(resume.presence.reason, "not_configured");
  });

  it("la route réutilise LA mesure de présence existante, sans en écrire une seconde", () => {
    const route = readFileSync(new URL("../routes/free-trial.ts", import.meta.url), "utf8");
    const bloc = route.slice(route.indexOf("'/stats/overview',"), route.indexOf("'/requests/deploy',"));
    assert.ok(bloc.includes("listerConnectes(prisma as any, secret"), "la présence vient de vpn-presence");
    assert.ok(bloc.includes("resumerEssais("), "la décision reste dans le service testable");
    // Aucune définition locale de « connecté » : pas de seconde vérité.
    assert.equal(/tunnelState/.test(bloc), false, "la route ne doit pas recalculer la présence");
    assert.ok(bloc.includes("interdireAccesRevendeur()") || route.slice(route.indexOf("'/stats/overview',") - 200,
      route.indexOf("'/stats/overview',") + 300).includes("interdireAccesRevendeur()"));
    // Le secret est LE même que celui de /api/presence, sinon aucun
    // rapprochement n'aboutirait et le compteur serait faussement à zéro.
    const lecture = route.slice(route.indexOf("function secretPresence()"), route.indexOf("function secretPresence()") + 300);
    assert.ok(lecture.includes("config.MOBILE_HEALTH_PSEUDONYM_SECRET"));
    assert.ok(lecture.includes("config.JWT_SECRET"));
  });
});
