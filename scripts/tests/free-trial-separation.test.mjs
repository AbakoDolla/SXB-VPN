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
 * SÉPARATION DEVENUE TOTALE : le propriétaire a refusé l'interrupteur
 * « Inclure les essais gratuits » qui ramenait les essais dans « Forfaits
 * Data ». Les garanties protégées ici sont donc PLUS STRICTES qu'avant :
 *   1. le marqueur est STRUCTUREL (la demande déployée et le forfait qui la
 *      cite), jamais le nom ;
 *   2. l'exclusion est la RÈGLE PAR DÉFAUT du serveur — même sans aucun
 *      paramètre —, et les COMPTEURS comptent exactement ce qui est affiché ;
 *   3. AUCUNE option d'inclusion n'est atteignable depuis l'interface : le
 *      composant interrupteur n'existe plus et aucune fonction de `src/api/`
 *      n'envoie le paramètre ;
 *   4. tout ce qui a été retiré de ces écrans est DISPONIBLE dans la section
 *      Essais, sur une sélection multiple ;
 *   5. un essayeur devenu client payant ne disparaît PAS de l'exploitation ;
 *   6. le cloisonnement revendeur ne bouge pas d'un pouce.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { api, db, ok, row } from "./reseller-http.test.mjs";

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = relatif => readFileSync(path.join(racine, relatif), "utf8");

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

/** Étape 4 : l'admin choisit serveur(s), volume et dates pour cet inscrit. */
async function deployer(jeton, requestId, { quotaGB = 2, jours = 7, profileIds = ["p1"] } = {}) {
  const reponse = await api("admin", "POST", "/free-trial/requests/deploy", {
    requestIds: [requestId],
    tokenId: jeton.id,
    profileIds,
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

/**
 * Seconde configuration VPN, créée à la demande dans le magasin isolé.
 *
 * Le jeu d'essai partagé n'en fournit qu'une (`p1`) ; l'ajouter ici plutôt que
 * dans la fixture commune évite de changer ce que voient les autres suites.
 */
function garantirProfil(id) {
  if (!db.state.VpnProfile.some(profil => profil.id === id)) {
    db.state.VpnProfile.push({
      id, name: `Service ${id}`, status: "active", protocol: "ssh",
      host: "second.invalid", password: "encrypted", port: 22,
      lockVersion: 0, lockPasswordHash: null,
    });
  }
  return id;
}

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

  // L'EXCLUSION EST LA RÈGLE PAR DÉFAUT : sans aucun paramètre, « Forfaits
  // Data » ne reçoit QUE les abonnements payants. C'est le durcissement exigé
  // par le propriétaire — le serveur ne dépend plus de ce que l'interface
  // pense à envoyer.
  const defaut = await api("admin", "GET", "/subscriptions");
  ok(defaut);
  assert.deepEqual(identifiants(defaut.body.subscriptions), [paye.body.subscription.id]);

  // Les COMPTEURS suivent exactement le même périmètre, par défaut aussi :
  // jamais un total qui compte des lignes invisibles.
  const compteursDefaut = await api("admin", "GET", "/subscriptions/stats");
  ok(compteursDefaut);
  assert.equal(compteursDefaut.body.total, defaut.body.subscriptions.length);

  // Un `includeFreeTrial=false` explicite donne le même résultat : le défaut
  // et la demande explicite ne peuvent pas diverger.
  const masque = await api("admin", "GET", "/subscriptions?includeFreeTrial=false");
  ok(masque);
  assert.deepEqual(identifiants(masque.body.subscriptions), [paye.body.subscription.id]);
  const compteursMasques = await api("admin", "GET", "/subscriptions/stats?includeFreeTrial=false");
  ok(compteursMasques);
  assert.equal(compteursMasques.body.total, masque.body.subscriptions.length);

  // Le paramètre d'inclusion SUBSISTE côté API — aucune route n'a été retirée —
  // mais il n'est plus atteignable depuis l'interface : c'est ce que prouve le
  // test « aucune option de l'interface ne peut ramener un essai » plus bas.
  const affiche = await api("admin", "GET", "/subscriptions?includeFreeTrial=true");
  ok(affiche);
  assert.deepEqual(identifiants(affiche.body.subscriptions), [paye.body.subscription.id, demande.subscriptionId].sort());
  const compteursAffiches = await api("admin", "GET", "/subscriptions/stats?includeFreeTrial=true");
  ok(compteursAffiches);
  assert.equal(compteursAffiches.body.total, affiche.body.subscriptions.length);
});

test("le marqueur est structurel : renommer le forfait d'essai ne le fait pas réapparaître", async () => {
  const { demande } = await essaiDeploye();
  // Le propriétaire renomme la ligne : aucun rapport avec sa nature.
  row("Subscription", demande.subscriptionId).name = "Forfait entreprise";
  const masque = await api("admin", "GET", "/subscriptions");
  ok(masque);
  assert.equal(masque.body.subscriptions.length, 0);
  // …et inversement : un forfait ordinaire nommé « Essai gratuit — … » reste visible.
  const piege = await api("admin", "POST", "/subscriptions", {
    clientId: "direct", profileId: "p1", quotaGB: 1, durationDays: 10, name: "Essai gratuit — Orange unlimited stuff",
  });
  ok(piege, 201);
  const apres = await api("admin", "GET", "/subscriptions");
  ok(apres);
  assert.deepEqual(identifiants(apres.body.subscriptions), [piege.body.subscription.id]);
});

test("comptes VPN et appareils : les essais sont exclus par défaut, sans paramètre", async () => {
  const { demande } = await essaiDeploye();

  for (const route of ["/clients", "/devices"]) {
    // Sans aucun paramètre : l'essai est absent. C'est exactement ce que
    // l'écran affiche, puisqu'il n'envoie plus rien.
    const defaut = await api("admin", "GET", route);
    ok(defaut);
    const lignesDefaut = route === "/clients" ? defaut.body : defaut.body.devices;
    assert.equal(lignesDefaut.some(ligne => ligne.id === demande.clientId), false,
      `${route} montre l'essai alors qu'aucun paramètre n'est passé`);

    // `includeFreeTrial=false` explicite : même résultat, aucune divergence.
    const masque = await api("admin", "GET", `${route}?includeFreeTrial=false`);
    ok(masque);
    const lignes = route === "/clients" ? masque.body : masque.body.devices;
    assert.equal(lignes.some(ligne => ligne.id === demande.clientId), false, `${route} montre encore l'essai`);

    // La route conserve son paramètre d'inclusion pour les lectures internes,
    // et la mention « Période d'essai » reste exacte quand il est employé.
    const affiche = await api("admin", "GET", `${route}?includeFreeTrial=true`);
    ok(affiche);
    const toutes = route === "/clients" ? affiche.body : affiche.body.devices;
    const essai = toutes.find(ligne => ligne.id === demande.clientId);
    assert.ok(essai, `${route} devrait ramener l'essai sur demande explicite`);
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

  const clients = await api("admin", "GET", "/clients");
  ok(clients);
  assert.equal(clients.body.some(ligne => ligne.id === demande.clientId), true);

  const appareils = await api("admin", "GET", "/devices");
  ok(appareils);
  const ligne = appareils.body.devices.find(entree => entree.id === demande.clientId);
  assert.ok(ligne, "le compte converti doit rester visible");
  // La LIGNE de cet appareil ne doit pas non plus retomber sur le forfait
  // d'essai : `selectDeviceSubscription` privilégie le forfait lié à
  // l'appareil, et c'est exactement le cas du forfait d'essai.
  assert.equal(ligne.subscriptionId, paye.body.subscription.id);
  assert.equal(ligne.subscriptionName, paye.body.subscription.name);

  // Seul son forfait d'ESSAI reste retranché de « Forfaits Data ».
  const forfaits = await api("admin", "GET", "/subscriptions");
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

  // Le DÉFAUT vaut « sans essais », y compris pour un revendeur, et sa portée
  // ne s'élargit pas pour autant.
  const parDefaut = await api("r1", "GET", "/clients");
  ok(parDefaut);
  const vusDefaut = new Set(parDefaut.body.map(ligne => ligne.id));
  assert.equal(vusDefaut.has(demande.clientId), false, "l'essai apparaît alors qu'aucun paramètre n'est passé");
  assert.equal(vusDefaut.has("c1"), true, "r1 doit voir son propre client");
  assert.equal(vusDefaut.has("c2"), false, "r1 verrait le client de r2");
  assert.equal(vusDefaut.has("direct"), false, "r1 verrait le parc direct");

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
  // La gestion des essais déployés est réservée à l'exploitation interne, au
  // même titre que le déploiement : un revendeur ne peut pas s'en servir pour
  // toucher un accès d'essai, même le sien.
  ok(await api("r1", "POST", "/free-trial/requests/manage", {
    requestIds: ["peu-importe"], state: "suspend",
  }), 403);
});

/**
 * SÉPARATION TOTALE — ce que le propriétaire a exigé mot pour mot : « Je dis
 * bien TOUT. » Ces tests épinglent le TEXTE SOURCE, parce que la garantie n'est
 * pas seulement « l'essai est masqué » mais « RIEN ne peut le ramener ».
 */
test("aucune option de l'interface ne peut ramener un essai dans les trois écrans", () => {
  // 1. L'interrupteur n'existe plus. Pas désactivé : SUPPRIMÉ.
  assert.equal(
    existsSync(path.join(racine, "artifacts/sxb-dashboard/src/components/FreeTrialToggle.tsx")),
    false,
    "FreeTrialToggle.tsx doit avoir disparu, pas seulement être masqué",
  );

  // 2. Les trois écrans ne le mentionnent plus, ne portent plus d'état
  //    d'inclusion, et n'envoient plus aucun paramètre d'essai.
  for (const vue of ["SubscriptionsView", "ClientsView", "DevicesView"]) {
    const code = source(`artifacts/sxb-dashboard/src/components/${vue}.tsx`);
    assert.doesNotMatch(code, /FreeTrialToggle/, `${vue} référence encore l'interrupteur`);
    assert.doesNotMatch(code, /inclureEssais/, `${vue} garde un état d'inclusion des essais`);
    assert.doesNotMatch(code, /includeFreeTrial/, `${vue} envoie encore le paramètre d'inclusion`);
  }

  // 3. AUCUNE fonction d'accès HTTP du tableau de bord ne construit ce
  //    paramètre : il n'est atteignable par aucun chemin d'interface.
  for (const fichier of ["subscriptions", "clients", "devices"]) {
    const code = source(`artifacts/sxb-dashboard/src/api/${fichier}.ts`);
    assert.doesNotMatch(code, /includeFreeTrial/, `src/api/${fichier}.ts peut encore demander les essais`);
  }
});

test("l'exclusion est la règle par défaut du serveur, pas un choix de l'interface", () => {
  const code = source("server/services/free-trial-marks.ts");
  const bloc = code.slice(code.indexOf("export function inclutEssaisGratuits"));
  // Sans valeur, et sur une valeur vide, la réponse est FAUX : le serveur
  // n'attend rien de l'interface pour exclure.
  assert.match(bloc, /valeur === undefined \|\| valeur === null\) return false/);
  assert.match(bloc, /texte === ""\) return false/);
  // L'inclusion devient une liste FERMÉE : tout ce qui n'y figure pas exclut.
  assert.match(bloc, /\["1", "true", "yes", "on", "oui"\]\.includes\(texte\)/);

  // Les trois routes de liste continuent de retrancher DANS la requête, pour
  // que les compteurs ne puissent pas compter des lignes invisibles.
  for (const [fichier, ancre] of [
    ["server/routes/subscriptions.ts", "router.get('/',"],
    ["server/routes/clients.ts", 'router.get("/",'],
    ["server/routes/devices.ts", 'router.get("/",'],
  ]) {
    const route = source(fichier);
    const debut = route.indexOf(ancre);
    assert.ok(debut > 0, `route de liste introuvable dans ${fichier}`);
    const extrait = route.slice(debut, debut + 3000);
    assert.ok(extrait.includes("inclutEssaisGratuits(req.query.includeFreeTrial)"), fichier);
    assert.ok(extrait.includes("porteeEssaiDeploye(prisma)"), fichier);
    assert.ok(extrait.includes("exclureIdentifiants("), fichier);
    assert.ok(extrait.includes("etFiltres("), fichier);
  }
});

test("chaque capacité retirée des trois écrans est disponible dans la section Essais", async () => {
  const { jeton, demande } = await essaiDeploye();
  const forfaitAvant = row("Subscription", demande.subscriptionId);
  const quotaAvant = BigInt(forfaitAvant.quotaBytes);

  // ── Voir l'accès courant : serveur(s), quota accordé ET consommé, échéance,
  //    état — sans quitter la section Essais.
  const vue = await api("admin", "GET", `/free-trial/requests?tokenId=${jeton.id}&status=deployed`);
  ok(vue);
  const lue = vue.body.requests.find(ligne => ligne.id === demande.id);
  assert.ok(lue?.access, "la demande déployée doit exposer son accès courant");
  assert.equal(lue.access.subscriptions.length, 1);
  assert.equal(lue.access.subscriptions[0].profileId, "p1");
  assert.equal(lue.access.quotaBytes, String(quotaAvant));
  assert.equal(lue.access.quotaUsed, "0");
  assert.equal(lue.access.active, true);
  assert.ok(lue.access.expireAt, "l'échéance doit être lisible");

  // ── Modifier le quota et prolonger l'échéance, sur une SÉLECTION.
  const recharge = await api("admin", "POST", "/free-trial/requests/manage", {
    requestIds: [demande.id], tokenId: jeton.id, quotaGB: 5, quotaMode: "add", durationDays: 10, durationMode: "add",
  });
  ok(recharge);
  assert.equal(recharge.body.succeeded, 1);
  assert.equal(recharge.body.updated, 1);
  assert.ok(BigInt(row("Subscription", demande.subscriptionId).quotaBytes) > quotaAvant,
    "le quota devait augmenter");

  // ── Suspendre, puis réactiver : deux gestes EXPLICITES et réversibles.
  ok(await api("admin", "POST", "/free-trial/requests/manage", {
    requestIds: [demande.id], tokenId: jeton.id, state: "suspend",
  }));
  assert.equal(row("Subscription", demande.subscriptionId).status, "suspended");
  ok(await api("admin", "POST", "/free-trial/requests/manage", {
    requestIds: [demande.id], tokenId: jeton.id, state: "resume",
  }));
  assert.equal(row("Subscription", demande.subscriptionId).status, "active");

  // ── Remplacer le serveur attribué.
  garantirProfil("p2");
  ok(await api("admin", "POST", "/free-trial/requests/manage", {
    requestIds: [demande.id], tokenId: jeton.id, profileId: "p2",
  }));
  assert.equal(row("Subscription", demande.subscriptionId).profileId, "p2");

  // ── Révoquer l'accès : geste terminal, et il le reste.
  ok(await api("admin", "POST", "/free-trial/requests/manage", {
    requestIds: [demande.id], tokenId: jeton.id, state: "revoke",
  }));
  assert.equal(row("Subscription", demande.subscriptionId).status, "revoked");

  // Rien de tout cela n'a fait réapparaître l'essai dans « Forfaits Data ».
  const forfaits = await api("admin", "GET", "/subscriptions");
  ok(forfaits);
  assert.equal(forfaits.body.subscriptions.length, 0);
});

test("plusieurs serveurs pour plusieurs profils d'essai : un forfait par configuration", async () => {
  garantirProfil("p2");
  const jeton = await creerJeton("Campagne multi-serveurs");
  const premier = await inscrire(jeton);
  const second = await inscrire(jeton, {
    deviceId: "SXB-TRIAL-DEVICE-20", empreinte: "android-id-fixture-0020", name: "Koffi", country: "CI",
  });

  // DEUX inscrits × DEUX configurations = QUATRE forfaits, d'un seul geste.
  const reponse = await api("admin", "POST", "/free-trial/requests/deploy", {
    requestIds: [premier.requestId, second.requestId],
    tokenId: jeton.id,
    profileIds: ["p1", "p2"],
    quotaGB: 3,
    expireAt: new Date(Date.now() + 7 * 86400000).toISOString(),
  });
  ok(reponse);
  assert.equal(reponse.body.deployed, 2);
  assert.equal(reponse.body.profiles, 2);
  assert.equal(reponse.body.subscriptionsCreated, 4);
  // L'aperçu de l'interface annonce ce même nombre AVANT confirmation ; la
  // réponse le confirme après, élément par élément.
  for (const ligne of reponse.body.results) assert.equal(ligne.subscriptions, 2);

  // Chaque inscrit détient bien ses DEUX forfaits, chacun sur sa configuration,
  // avec le même quota et la même échéance.
  for (const inscription of [premier, second]) {
    const demande = db.state.FreeTrialRequest.find(ligne => ligne.id === inscription.requestId);
    const siens = db.state.Subscription.filter(forfait => forfait.clientId === demande.clientId);
    assert.equal(siens.length, 2);
    assert.deepEqual(siens.map(forfait => forfait.profileId).sort(), ["p1", "p2"]);
    // Le marqueur STRUCTUREL est porté par CHAQUE forfait : le surnuméraire ne
    // peut pas passer pour un forfait ordinaire.
    for (const forfait of siens) assert.equal(forfait.freeTrialRequestId, demande.id);
  }

  // …et aucun des quatre n'apparaît dans « Forfaits Data ».
  const forfaits = await api("admin", "GET", "/subscriptions");
  ok(forfaits);
  assert.equal(forfaits.body.subscriptions.length, 0);

  // L'accès courant agrège les deux configurations de l'inscrit.
  const vue = await api("admin", "GET", `/free-trial/requests?tokenId=${jeton.id}&status=deployed`);
  ok(vue);
  assert.equal(vue.body.requests.find(l => l.id === premier.requestId).access.subscriptions.length, 2);
});

test("le déploiement multi-configurations refuse un lot hors limite, sans rien écrire", async () => {
  const jeton = await creerJeton("Campagne bornée");
  const inscription = await inscrire(jeton, {
    deviceId: "SXB-TRIAL-DEVICE-30", empreinte: "android-id-fixture-0030", name: "Mariam", country: "SN",
  });

  // Plus de configurations que la borne : refus MOTIVÉ, jamais une troncature.
  const trop = await api("admin", "POST", "/free-trial/requests/deploy", {
    requestIds: [inscription.requestId],
    tokenId: jeton.id,
    profileIds: Array.from({ length: 11 }, (_, index) => `p${index + 1}`),
    quotaGB: 1,
    expireAt: new Date(Date.now() + 86400000).toISOString(),
  });
  assert.equal(trop.status, 400);
  assert.equal(trop.body.code, "FREE_TRIAL_TOO_MANY_PROFILES");
  assert.equal(trop.body.limit, 10);

  // Aucune écriture : la demande est toujours en attente, sans forfait.
  const apres = db.state.FreeTrialRequest.find(ligne => ligne.id === inscription.requestId);
  assert.equal(apres.status, "pending");
  assert.equal(apres.subscriptionId, null);

  // Un serveur inconnu arrête l'opération AVANT la première écriture.
  const inconnu = await api("admin", "POST", "/free-trial/requests/deploy", {
    requestIds: [inscription.requestId],
    tokenId: jeton.id,
    profileIds: ["p1", "profil-qui-nexiste-pas"],
    quotaGB: 1,
    expireAt: new Date(Date.now() + 86400000).toISOString(),
  });
  assert.equal(inconnu.status, 404);
  assert.equal(db.state.FreeTrialRequest.find(l => l.id === inscription.requestId).status, "pending");

  // Le contrat historique à UN profil continue de fonctionner à l'identique.
  const historique = await api("admin", "POST", "/free-trial/requests/deploy", {
    requestIds: [inscription.requestId],
    tokenId: jeton.id,
    profileId: "p1",
    quotaGB: 1,
    expireAt: new Date(Date.now() + 86400000).toISOString(),
  });
  ok(historique);
  assert.equal(historique.body.deployed, 1);
  assert.equal(historique.body.subscriptionsCreated, 1);
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

test("la section essai s'ouvre sur TOUS les statuts, pas seulement les demandes en attente", () => {
  // Le filtre partait sur « En attente de vérification », donc tout essai déjà
  // déployé était masqué : déplier un jeton entièrement traité affichait
  // « Aucune demande d'essai gratuit pour ce filtre », alors que la ligne
  // existait avec son forfait attribué, son quota et son échéance. C'est
  // pourtant ICI, et nulle part ailleurs, que ces accès se consultent et se
  // gèrent : partir d'une vue qui en cache une partie fait croire qu'ils ne
  // sont pas affichés du tout.
  const vue = source("artifacts/sxb-dashboard/src/components/FreeTrialView.tsx");
  assert.match(vue, /const \[statusFilter, setStatusFilter\] = useState<string>\(''\)/);
  assert.doesNotMatch(vue, /useState<string>\(FREE_TRIAL_STATUS\.PENDING\)/);
  // La valeur vide correspond bien à l'option « tous les statuts ».
  assert.match(vue, /<option value="">\{t\('operations\.freeTrial\.status\.all'\)\}<\/option>/);
});
