/**
 * free-trial-separation.test.mjs — Les essais gratuits ne se mélangent plus.
 *
 * DÉFAUT CORRIGÉ, capture du propriétaire à l'appui : la ligne « Essai gratuit
 * — Orange unlimited stuff » apparaissait au milieu de ses abonnements payants,
 * dans « Forfaits Data ». Le déploiement d'un essai crée un forfait ORDINAIRE
 * dont seul le NOM le distinguait — rien de structurel.
 *
 * Ces tests font tourner les VRAIES routes sur le magasin isolé de
 * `reseller-http.test.mjs` : le parcours complet est joué de bout en bout,
 * inscription → attente → déploiement admin → configuration reçue par
 * l'appareil, puis on vérifie ce que chaque écran d'exploitation affiche.
 *
 * Ils protègent quatre garanties :
 *   1. le marqueur est STRUCTUREL (la demande déployée), jamais le nom ;
 *   2. les trois écrans d'exploitation masquent les essais par défaut, et
 *      leurs COMPTEURS comptent exactement ce qui est affiché ;
 *   3. l'interrupteur « inclure » les ramène, sans jamais élargir la portée
 *      d'un revendeur ;
 *   4. un essayeur devenu client payant ne disparaît PAS de l'exploitation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { api, db, ok, row } from "./reseller-http.test.mjs";

const EMPREINTE = "android-id-fixture-0001";
const APPAREIL = "SXB-TRIAL-DEVICE-01";

/** Étape 1 : l'admin fabrique le code d'invitation. */
async function creerJeton(label = "Campagne test") {
  const reponse = await api("admin", "POST", "/free-trial/tokens", { label });
  ok(reponse, 201);
  return reponse.body.token;
}

/** Étape 2 : l'appareil s'inscrit. Il n'obtient qu'une demande EN ATTENTE. */
async function inscrire(jeton, { deviceId = APPAREIL, empreinte = EMPREINTE, name = "Awa Ngo", country = "CM" } = {}) {
  const reponse = await api(null, "POST", "/free-trial/enroll", {
    token: jeton.token, name, country, deviceFingerprint: empreinte, deviceId,
  }, { "X-SXB-Device-ID": deviceId });
  ok(reponse, 201);
  assert.equal(reponse.body.status, "pending");
  return reponse.body;
}

/** Étape 4 : l'admin choisit serveur, volume et dates pour cet inscrit. */
async function deployer(jeton, requestId, { quotaGB = 2, jours = 7 } = {}) {
  const reponse = await api("admin", "POST", "/free-trial/requests/deploy", {
    requestIds: [requestId],
    tokenId: jeton.id,
    profileId: "p1",
    quotaGB,
    expireAt: new Date(Date.now() + jours * 86400000).toISOString(),
  });
  ok(reponse);
  assert.equal(reponse.body.deployed, 1);
  return reponse.body;
}

/** Parcours complet, du code d'invitation au forfait déployé. */
async function essaiDeploye(options = {}) {
  const jeton = await creerJeton();
  const inscription = await inscrire(jeton, options);
  await deployer(jeton, inscription.requestId, options);
  const demande = db.state.FreeTrialRequest.find(ligne => ligne.id === inscription.requestId);
  return { jeton, inscription, demande };
}

const identifiants = liste => liste.map(ligne => ligne.id).sort();

test("essai gratuit : le parcours complet aboutit à une configuration utilisable", async () => {
  const { inscription, demande } = await essaiDeploye();

  // Étape 3 : la demande a bien été instruite, avec son compte et son forfait.
  assert.equal(demande.status, "deployed");
  assert.ok(demande.clientId, "le déploiement doit rattacher un compte");
  assert.ok(demande.subscriptionId, "le déploiement doit créer un forfait");

  // Étape 5 : l'appareil récupère son jeton de compte — et rien d'autre.
  const statut = await api(null, "POST", "/free-trial/status", {
    requestId: inscription.requestId, claimSecret: inscription.claimSecret, deviceId: APPAREIL,
  }, { "X-SXB-Device-ID": APPAREIL });
  ok(statut);
  assert.equal(statut.body.status, "deployed");
  assert.match(statut.body.accountToken, /^SXB-USER-/);
  for (const interdit of ["host", "port", "uuid", "config", "quotaBytes", "profileId"]) {
    assert.equal(statut.body[interdit], undefined, `l'essai exposerait « ${interdit} »`);
  }

  // L'activation mobile standard reconnaît l'appareil…
  const activation = await api(null, "POST", "/mobile/auth/activate", {
    token: statut.body.accountToken, deviceId: APPAREIL,
  });
  ok(activation);

  // … et la configuration arrive par le canal VPN ordinaire : connexion possible.
  const liste = await api(null, "GET", "/mobile/connections", undefined, {
    Authorization: `Bearer ${activation.body.accessToken}`,
    "X-SXB-Device-ID": APPAREIL,
  });
  ok(liste);
  assert.equal(liste.body.connections.length, 1);
  assert.equal(liste.body.connections[0].id, demande.subscriptionId);
  assert.equal(liste.body.connections[0].status, "active");
  assert.match(liste.body.connections[0].dataToken, /^SXB-DATA-/);
});

test("forfaits data : l'essai n'apparaît plus au milieu des abonnements payants", async () => {
  const paye = await api("admin", "POST", "/subscriptions", {
    clientId: "direct", profileId: "p1", quotaGB: 50, durationDays: 30, name: "Orange illimité",
  });
  ok(paye, 201);
  const { demande } = await essaiDeploye();

  // Le forfait d'essai EXISTE — rien n'a été supprimé.
  assert.ok(row("Subscription", demande.subscriptionId));

  const masque = await api("admin", "GET", "/subscriptions?includeFreeTrial=false");
  ok(masque);
  assert.deepEqual(identifiants(masque.body.subscriptions), [paye.body.subscription.id]);

  // Les COMPTEURS suivent exactement le même périmètre : jamais un total qui
  // compte des lignes invisibles.
  const compteursMasques = await api("admin", "GET", "/subscriptions/stats?includeFreeTrial=false");
  ok(compteursMasques);
  assert.equal(compteursMasques.body.total, masque.body.subscriptions.length);

  const affiche = await api("admin", "GET", "/subscriptions?includeFreeTrial=true");
  ok(affiche);
  assert.deepEqual(identifiants(affiche.body.subscriptions), [paye.body.subscription.id, demande.subscriptionId].sort());
  const compteursAffiches = await api("admin", "GET", "/subscriptions/stats?includeFreeTrial=true");
  ok(compteursAffiches);
  assert.equal(compteursAffiches.body.total, affiche.body.subscriptions.length);

  // Aucun appelant historique ne change de contrat : sans paramètre, tout vient.
  const defaut = await api("admin", "GET", "/subscriptions");
  ok(defaut);
  assert.equal(defaut.body.subscriptions.length, 2);
});

test("le marqueur est structurel : renommer le forfait d'essai ne le fait pas réapparaître", async () => {
  const { demande } = await essaiDeploye();
  // Le propriétaire renomme la ligne : aucun rapport avec sa nature.
  row("Subscription", demande.subscriptionId).name = "Forfait entreprise";
  const masque = await api("admin", "GET", "/subscriptions?includeFreeTrial=false");
  ok(masque);
  assert.equal(masque.body.subscriptions.length, 0);
  // …et inversement : un forfait ordinaire nommé « Essai gratuit — … » reste visible.
  const piege = await api("admin", "POST", "/subscriptions", {
    clientId: "direct", profileId: "p1", quotaGB: 1, durationDays: 10, name: "Essai gratuit — Orange unlimited stuff",
  });
  ok(piege, 201);
  const apres = await api("admin", "GET", "/subscriptions?includeFreeTrial=false");
  ok(apres);
  assert.deepEqual(identifiants(apres.body.subscriptions), [piege.body.subscription.id]);
});

test("comptes VPN et appareils : les essais sont masqués par défaut et revenables à la demande", async () => {
  const { demande } = await essaiDeploye();

  for (const route of ["/clients", "/devices"]) {
    const masque = await api("admin", "GET", `${route}?includeFreeTrial=false`);
    ok(masque);
    const lignes = route === "/clients" ? masque.body : masque.body.devices;
    assert.equal(lignes.some(ligne => ligne.id === demande.clientId), false, `${route} montre encore l'essai`);

    const affiche = await api("admin", "GET", `${route}?includeFreeTrial=true`);
    ok(affiche);
    const toutes = route === "/clients" ? affiche.body : affiche.body.devices;
    const essai = toutes.find(ligne => ligne.id === demande.clientId);
    assert.ok(essai, `${route} devrait ramener l'essai sur demande`);
    // La mention « Période d'essai » reste visible quand les essais sont affichés.
    assert.equal(essai.trial?.trial, true);
    assert.equal(essai.trial.country, "CM");
  }
});

test("un essayeur devenu client payant reste visible dans l'exploitation", async () => {
  const { demande } = await essaiDeploye();
  // L'admin lui attribue un vrai forfait sur le MÊME compte : c'est désormais
  // un client comme les autres, le faire disparaître serait une perte de vue.
  const paye = await api("admin", "POST", "/subscriptions", {
    clientId: demande.clientId, profileId: "p1", quotaGB: 100, durationDays: 30,
  });
  ok(paye, 201);

  const clients = await api("admin", "GET", "/clients?includeFreeTrial=false");
  ok(clients);
  assert.equal(clients.body.some(ligne => ligne.id === demande.clientId), true);

  const appareils = await api("admin", "GET", "/devices?includeFreeTrial=false");
  ok(appareils);
  const ligne = appareils.body.devices.find(entree => entree.id === demande.clientId);
  assert.ok(ligne, "le compte converti doit rester visible");
  // La LIGNE de cet appareil ne doit pas non plus retomber sur le forfait
  // d'essai : `selectDeviceSubscription` privilégie le forfait lié à
  // l'appareil, et c'est exactement le cas du forfait d'essai.
  assert.equal(ligne.subscriptionId, paye.body.subscription.id);
  assert.equal(ligne.subscriptionName, paye.body.subscription.name);

  // Seul son forfait d'ESSAI reste retranché de « Forfaits Data ».
  const forfaits = await api("admin", "GET", "/subscriptions?includeFreeTrial=false");
  ok(forfaits);
  assert.deepEqual(identifiants(forfaits.body.subscriptions), [paye.body.subscription.id]);

  // Essais affichés : la ligne redevient celle de l'essai, mention comprise.
  const avecEssais = await api("admin", "GET", "/devices?includeFreeTrial=true");
  ok(avecEssais);
  assert.equal(avecEssais.body.devices.find(entree => entree.id === demande.clientId).trial?.trial, true);
});

test("cloisonnement revendeur inchangé : ses propres clients, essais compris, ni plus ni moins", async () => {
  const { demande } = await essaiDeploye();
  // L'essai est rattaché au parc administrateur ; on le confie explicitement à
  // r1 pour vérifier que le filtre d'essai ne change RIEN à la portée.
  row("VpnClient", demande.clientId).resellerId = "res-r1";
  row("Subscription", demande.subscriptionId).name = "Essai r1";
  ok(await api("r2", "POST", "/subscriptions", { clientId: "c2", profileId: "p1", quotaGB: 1, durationDays: 5 }), 403);

  for (const inclure of ["false", "true"]) {
    const clients = await api("r1", "GET", `/clients?includeFreeTrial=${inclure}`);
    ok(clients);
    const vus = new Set(clients.body.map(ligne => ligne.id));
    // Jamais le client d'un autre revendeur, jamais le parc direct.
    assert.equal(vus.has("c2"), false, "r1 verrait le client de r2");
    assert.equal(vus.has("direct"), false, "r1 verrait le parc direct");
    assert.equal(vus.has("c1"), true, "r1 doit voir son propre client");
    // Son client d'essai : masqué par défaut, présent quand il le demande.
    assert.equal(vus.has(demande.clientId), inclure === "true");

    const appareils = await api("r1", "GET", `/devices?includeFreeTrial=${inclure}`);
    ok(appareils);
    const parc = new Set(appareils.body.devices.map(ligne => ligne.id));
    assert.equal(parc.has("c2"), false);
    assert.equal(parc.has("direct"), false);
    assert.equal(parc.has(demande.clientId), inclure === "true");

    const forfaits = await api("r1", "GET", `/subscriptions?includeFreeTrial=${inclure}`);
    ok(forfaits);
    const vendus = new Set(forfaits.body.subscriptions.map(ligne => ligne.id));
    assert.equal(vendus.has(demande.subscriptionId), inclure === "true");
    for (const forfait of forfaits.body.subscriptions) {
      assert.equal(forfait.client.resellerId, "res-r1", "un forfait d'un autre revendeur a fui");
    }
  }

  // Le vivier des inscriptions reste fermé au revendeur, comme avant.
  ok(await api("r1", "GET", "/free-trial/requests"), 403);
  ok(await api("r1", "GET", "/free-trial/stats/overview"), 403);
});

/**
 * Passage ESSAI → COMPTE NORMAL, côté serveur : ce qui se produit RÉELLEMENT.
 *
 * Le propriétaire craignait que les deux accès entrent en conflit. Ces deux
 * tests fixent le comportement observé, pour qu'il cesse d'être une supposition.
 */
test("essai → compte normal : l'appareil garde SON compte, qui reçoit le forfait ordinaire", async () => {
  const { demande } = await essaiDeploye();

  // L'exploitant demande « un jeton de compte » pour ce téléphone : le serveur
  // rend le jeton EXISTANT au lieu d'en fabriquer un second. Il n'y a donc
  // jamais deux comptes en concurrence sur le même appareil.
  const jetonCompte = await api("admin", "POST", "/devices/generate-token", { deviceId: APPAREIL, durationDays: 30 });
  assert.equal(jetonCompte.status, 409);
  assert.equal(jetonCompte.body.code, "DEVICE_ALREADY_REGISTERED");
  assert.equal(jetonCompte.body.device.token, row("VpnClient", demande.clientId).token);

  // Le forfait ordinaire s'attache à ce même compte : les deux coexistent, et
  // l'application reçoit les deux configurations du compte ACTIF.
  const paye = await api("admin", "POST", "/subscriptions", {
    clientId: demande.clientId, profileId: "p1", quotaGB: 100, durationDays: 30,
  });
  ok(paye, 201);

  const statut = await api(null, "POST", "/free-trial/status", {
    requestId: (await api("admin", "GET", "/free-trial/requests")).body.requests[0].id,
    claimSecret: "peu-importe", deviceId: APPAREIL,
  }, { "X-SXB-Device-ID": APPAREIL });
  assert.equal(statut.status, 404, "un secret invalide ne doit jamais ouvrir la demande");

  const activation = await api(null, "POST", "/mobile/auth/activate", {
    token: row("VpnClient", demande.clientId).token, deviceId: APPAREIL,
  });
  ok(activation);
  const connexions = await api(null, "GET", "/mobile/connections", undefined, {
    Authorization: `Bearer ${activation.body.accessToken}`,
    "X-SXB-Device-ID": APPAREIL,
  });
  ok(connexions);
  assert.deepEqual(
    [...connexions.body.connections.map(entree => entree.id)].sort(),
    [demande.subscriptionId, paye.body.subscription.id].sort(),
  );
});

test("essai → compte normal : un SECOND compte ne peut pas s'emparer de l'appareil en silence", async () => {
  const { demande } = await essaiDeploye();
  // Un compte distinct pré-affecté au même téléphone : l'activation est
  // refusée avec un code EXPLICITE, jamais une prise de contrôle silencieuse
  // qui laisserait deux accès se disputer l'appareil.
  const autre = row("VpnClient", "direct");
  const refus = await api(null, "POST", "/mobile/auth/activate", { token: autre.token, deviceId: APPAREIL });
  assert.equal(refus.status, 409);
  assert.equal(refus.body.code, "DEVICE_CLAIMED_BY_ANOTHER_ACCOUNT");
  // Le compte d'essai n'a pas bougé : rien n'a été délié ni supprimé.
  assert.equal(row("VpnClient", demande.clientId).deviceId, APPAREIL);
  assert.equal(row("VpnClient", "direct").deviceId, null);
});

test("indicateurs d'essai : comptés séparément, et honnêtes sur ce qu'ils ne mesurent pas", async () => {
  const jeton = await creerJeton();
  const premier = await inscrire(jeton);
  await deployer(jeton, premier.requestId);
  const second = await inscrire(jeton, { deviceId: "SXB-TRIAL-DEVICE-02", empreinte: "android-id-fixture-0002", name: "Koffi", country: "CI" });
  const troisieme = await inscrire(jeton, { deviceId: "SXB-TRIAL-DEVICE-03", empreinte: "android-id-fixture-0003", name: "Mariam", country: "SN" });
  ok(await api("admin", "POST", "/free-trial/requests/reject", { requestIds: [troisieme.requestId], tokenId: jeton.id }));

  // Un forfait payant du parc principal ne doit modifier AUCUN de ces chiffres.
  ok(await api("admin", "POST", "/subscriptions", { clientId: "direct", profileId: "p1", quotaGB: 10, durationDays: 30 }), 201);

  const vue = await api("admin", "GET", "/free-trial/stats/overview");
  ok(vue);
  assert.equal(vue.body.total, 3);
  assert.equal(vue.body.deployed, 1);
  assert.equal(vue.body.pending, 1);
  assert.equal(vue.body.rejected, 1);
  assert.equal(vue.body.active, 1);
  void second;

  // La présence vient de la mesure existante : fenêtre et battement annoncés.
  assert.equal(vue.body.presence.measured, true);
  assert.equal(vue.body.presence.windowMinutes, 15);
  assert.equal(vue.body.presence.heartbeatMinutes, 5);
  // Personne n'a encore rapporté de tunnel monté : zéro, et c'est une mesure.
  assert.equal(vue.body.connectedNow, 0);

  // Un essai dont l'accès est terminé n'est plus « actif », mais reste déployé.
  const demande = db.state.FreeTrialRequest.find(ligne => ligne.id === premier.requestId);
  row("Subscription", demande.subscriptionId).expireAt = new Date(Date.now() - 86400000);
  const apres = await api("admin", "GET", "/free-trial/stats/overview");
  ok(apres);
  assert.equal(apres.body.deployed, 1);
  assert.equal(apres.body.active, 0);
});
