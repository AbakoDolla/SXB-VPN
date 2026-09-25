/**
 * « Données ajoutées » — parcours HTTP réels contre la base isolée.
 *
 * Chaque test part d'un exploitant qui ajoute des Go à une connexion, puis lit
 * ce que le tableau de bord afficherait : l'historique, le résumé par serveur
 * et le détail d'un serveur.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { db, api, row, ok, GO } from "./reseller-http.test.mjs";

const ajouts = () => db.state.DataAddition;
const creerForfait = (acteur, clientId, quotaGB, profileId = "p1") =>
  api(acteur, "POST", "/subscriptions", { clientId, profileId, quotaGB, durationDays: 30 });
const ajouterDonnees = (acteur, id, quotaGB) =>
  api(acteur, "POST", "/subscriptions/bulk", { action: "add_data", subscriptionIds: [id], quotaGB });
const go = gigaoctets => String(BigInt(gigaoctets) * GO);

test("chaque Go ajouté à une connexion est consigné aussitôt, sur son serveur, sans remplacer l'entrée précédente", async () => {
  row("Reseller", "res-r1").quotaBytes = -1n;
  const cree = await creerForfait("r1", "c1", 5);
  ok(cree, 201);
  const id = cree.body.subscription.id;
  await delay(5);
  ok(await ajouterDonnees("r1", id, 10));
  await delay(5);
  ok(await ajouterDonnees("r1", id, 20));

  assert.deepEqual(ajouts().map(a => [a.kind, a.addedBytes, a.quotaBeforeBytes, a.quotaAfterBytes]), [
    ["creation", 5n * GO, 0n, 5n * GO],
    ["ajout", 10n * GO, 5n * GO, 15n * GO],
    ["ajout", 20n * GO, 15n * GO, 35n * GO],
  ]);
  for (const ajout of ajouts()) {
    assert.equal(ajout.profileId, "p1");
    assert.equal(ajout.profileName, "Service privé");
    assert.equal(ajout.subscriptionId, id);
    assert.equal(ajout.clientId, "c1");
    // Qui a ajouté : le nom du compte, pas un identifiant opaque.
    assert.equal(ajout.actorUserId, "r1");
    assert.equal(ajout.actorName, "r1");
    assert.equal(ajout.freeTrial, false);
  }

  const historique = await api("root", "GET", "/data-additions");
  ok(historique);
  assert.deepEqual(historique.body.additions.map(a => a.addedBytes), [go(20), go(10), go(5)]);
  assert.deepEqual(historique.body.totals, { count: 3, addedBytes: go(35) });
  assert.equal(historique.body.next, null);

  // Le consommé et le restant suivent la réalité du forfait.
  row("Subscription", id).quotaUsed = 7n * GO;
  const serveurs = await api("root", "GET", "/data-additions/servers");
  ok(serveurs);
  assert.equal(serveurs.body.servers.length, 1);
  const [mtn] = serveurs.body.servers;
  assert.ok(mtn.lastAddedAt);
  assert.deepEqual({ ...mtn, lastAddedAt: null }, {
    profileId: "p1", profileName: "Service privé", additions: 3, addedBytes: go(35), lastAddedAt: null,
    subscriptions: 1, usedBytes: go(7), remainingBytes: go(28), unlimited: false,
  });

  const detail = await api("root", "GET", "/data-additions/servers/p1");
  ok(detail);
  assert.equal(detail.body.server.addedBytes, go(35));
  assert.deepEqual(detail.body.additions.map(a => [a.kind, a.addedBytes, a.actorName]), [
    ["ajout", go(20), "r1"], ["ajout", go(10), "r1"], ["creation", go(5), "r1"],
  ]);
});

test("un ajout annulé ne laisse aucune trace, une baisse n'est pas un ajout, et chaque serveur garde son historique", async () => {
  row("Reseller", "res-r1").quotaBytes = -1n;
  db.state.VpnProfile.push({
    id: "p2", name: "Serveur Orange", status: "active", protocol: "ssh", host: "orange.invalid",
    password: "encrypted", port: 22, lockVersion: 0, lockPasswordHash: null, createdBy: "admin",
  });
  db.state.VpnProfileReseller.push({ profileId: "p2", resellerId: "res-r1" });
  const mtn = await creerForfait("r1", "c1", 4, "p1");
  const orange = await creerForfait("r1", "c1", 3, "p2");
  ok(mtn, 201); ok(orange, 201);
  assert.equal(ajouts().length, 2);

  // La transaction échoue APRÈS l'écriture : ni hausse de quota, ni trace.
  db.beforeCommit = async () => { throw new Error("coupure simulée avant validation"); };
  const echoue = await ajouterDonnees("root", mtn.body.subscription.id, 9);
  ok(echoue);
  assert.equal(echoue.body.failed, 1);
  db.beforeCommit = null;
  assert.equal(ajouts().length, 2);
  assert.equal(row("Subscription", mtn.body.subscription.id).quotaBytes, 4n * GO);

  // Réduire un forfait n'est pas « ajouter des données ».
  ok(await api("r1", "PUT", `/subscriptions/${orange.body.subscription.id}`, { quotaGB: 1 }));
  assert.equal(ajouts().length, 2);

  const serveurs = await api("root", "GET", "/data-additions/servers");
  ok(serveurs);
  const parServeur = Object.fromEntries(serveurs.body.servers.map(s => [s.profileName, [s.addedBytes, s.additions, s.remainingBytes]]));
  assert.deepEqual(parServeur, {
    "Service privé": [go(4), 1, go(4)],
    "Serveur Orange": [go(3), 1, go(1)],
  });
});

test("un revendeur ne lit que les ajouts faits aux connexions de SES clients", async () => {
  row("Reseller", "res-r1").quotaBytes = -1n;
  row("Reseller", "res-r2").quotaBytes = -1n;
  db.state.VpnProfileReseller.push({ profileId: "p1", resellerId: "res-r2" });
  ok(await creerForfait("r1", "c1", 2), 201);
  ok(await creerForfait("r2", "c2", 6), 201);

  const r1 = await api("r1", "GET", "/data-additions");
  ok(r1);
  assert.deepEqual(r1.body.additions.map(a => a.clientId), ["c1"]);
  assert.deepEqual(r1.body.totals, { count: 1, addedBytes: go(2) });

  const r2 = await api("r2", "GET", "/data-additions/servers/p1");
  ok(r2);
  assert.deepEqual(r2.body.additions.map(a => a.clientId), ["c2"]);
  assert.equal(r2.body.server.addedBytes, go(6));
  assert.equal(r2.body.server.subscriptions, 1);

  const proprietaire = await api("root", "GET", "/data-additions");
  ok(proprietaire);
  assert.equal(proprietaire.body.totals.count, 2);

  // Un serveur sans rien de visible n'est pas révélé.
  ok(await api("r1", "GET", "/data-additions/servers/p-inconnu"), 404);
});

test("les forfaits d'essai gratuit sont consignés mais jamais montrés dans l'historique commercial", async () => {
  row("Reseller", "res-r1").quotaBytes = -1n;
  const forfait = await creerForfait("r1", "c1", 2);
  ok(forfait, 201);
  const id = forfait.body.subscription.id;
  row("Subscription", id).freeTrialRequestId = "demande-essai-1";
  ok(await ajouterDonnees("r1", id, 3));
  assert.equal(ajouts().length, 2);
  assert.equal(ajouts()[1].freeTrial, true);

  const historique = await api("root", "GET", "/data-additions");
  ok(historique);
  assert.deepEqual(historique.body.additions, []);
  assert.deepEqual(historique.body.totals, { count: 0, addedBytes: "0" });
  const serveurs = await api("root", "GET", "/data-additions/servers");
  ok(serveurs);
  assert.deepEqual(serveurs.body.servers, []);
});

test("l'historique se lit par pages sans perdre ni répéter une entrée", async () => {
  row("Reseller", "res-r1").quotaBytes = -1n;
  const forfait = await creerForfait("r1", "c1", 1);
  ok(forfait, 201);
  await delay(5);
  ok(await ajouterDonnees("r1", forfait.body.subscription.id, 2));
  await delay(5);
  ok(await ajouterDonnees("r1", forfait.body.subscription.id, 3));

  const premiere = await api("root", "GET", "/data-additions?limit=2");
  ok(premiere);
  assert.equal(premiere.body.additions.length, 2);
  assert.ok(premiere.body.next);
  const { before, beforeId } = premiere.body.next;
  const seconde = await api("root", "GET", `/data-additions?limit=2&before=${encodeURIComponent(before)}&beforeId=${beforeId}`);
  ok(seconde);
  assert.equal(seconde.body.next, null);
  assert.deepEqual([...premiere.body.additions, ...seconde.body.additions].map(a => a.addedBytes), [go(3), go(2), go(1)]);
  ok(await api("root", "GET", "/data-additions?limit=0"), 400);
});
