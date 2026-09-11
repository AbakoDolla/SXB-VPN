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
  MOTIF_JETON_ESSAI,
  STATUT_DEMANDE,
  calculerFenetreEssai,
  champsInterditsPresents,
  etatJetonEssai,
  genererJetonEssai,
  genererSecretReclamation,
  hacherSecretReclamation,
  intervalleVerificationEssai,
  normaliserJetonEssai,
  refusDeploiement,
  refusJetonEssai,
  secretCorrespond,
  verifierAucuneFuite,
  vueDemandePourAdmin,
  vueInscriptionEssai,
  vueJetonPourAdmin,
  vueStatutEssaiPourAppareil,
} from "../services/free-trial";

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
    // Ce qu'il contient : de la gestion de campagne, pas de l'accès.
    assert.deepEqual(
      Object.keys(vue).sort(),
      ["createdAt", "expiresAt", "id", "label", "maxUses", "requestCount", "state", "status", "token", "usedCount"],
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
    ]) {
      assert.ok(source.includes(chemin), `route ${chemin} manquante`);
    }
  });

  it("protège toutes les routes admin par requireAuth + requirePermission", () => {
    const adminRoutes = source.split(/router\.(?:get|post)\(/).slice(1)
      .filter((bloc) => !bloc.startsWith("'/enroll'") && !bloc.startsWith("'/status'"));
    assert.equal(adminRoutes.length, 6, "nombre de routes admin inattendu");
    for (const bloc of adminRoutes) {
      const entete = bloc.slice(0, 400);
      assert.ok(entete.includes("requireAuth"), `route admin sans requireAuth : ${entete.slice(0, 40)}`);
      assert.ok(entete.includes("requirePermission"), `route admin sans requirePermission : ${entete.slice(0, 40)}`);
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
    const bloc = sql.slice(sql.indexOf("free_trial_tokens"));
    assert.ok(bloc.includes("CREATE TABLE IF NOT EXISTS"), "création idempotente attendue");
    assert.equal(/DROP\s+(TABLE|COLUMN)/i.test(bloc), false, "aucune suppression tolérée");
    assert.equal(/ALTER\s+TABLE\s+"(?!free_trial)/i.test(bloc), false, "aucune table existante modifiée");
  });
});
