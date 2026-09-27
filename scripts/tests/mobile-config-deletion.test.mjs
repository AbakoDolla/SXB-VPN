/**
 * mobile-config-deletion.test.mjs — Une configuration supprimée dans
 * l'application disparaît aussi du tableau de bord.
 *
 * DEMANDE : « quand un utilisateur supprime une configuration dans l'app, elle
 * doit aussi être supprimée dans le tableau de bord ». Une même configuration
 * VPN (le profil) est souvent attribuée à PLUSIEURS utilisateurs, chacun par son
 * propre forfait. Le comportement retenu est le plus sûr : seul le forfait de
 * l'utilisateur qui supprime est retiré ; le profil et les forfaits des autres
 * restent intacts. Les vraies routes tournent sur le magasin isolé de
 * `reseller-http.test.mjs`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { api, ok, row, db, GO } from "./reseller-http.test.mjs";

async function appareil(clientId, deviceId) {
  const activation = await api(null, "POST", "/mobile/auth/activate", {
    token: row("VpnClient", clientId).token, deviceId,
  });
  ok(activation);
  return { Authorization: "Bearer " + activation.body.accessToken, "X-SXB-Device-ID": deviceId };
}

async function forfait(actor, clientId, quotaGB = 5) {
  const created = await api(actor, "POST", "/subscriptions", { clientId, profileId: "p1", quotaGB, durationDays: 30 });
  ok(created, 201);
  return created.body.subscription.id;
}

test("supprimer dans l'app retire le forfait de l'utilisateur, jamais la configuration partagée", async () => {
  const mien = await forfait("r1", "c1");
  const autre = await forfait("admin", "c2");
  const direct = await forfait("admin", "direct");
  const engageAvant = row("Reseller", "res-r1").quotaUsedBytes;
  assert.equal(engageAvant, 5n * GO);
  const moi = await appareil("c1", "DELETE-DEVICE-ONE");

  const supprime = await api(null, "DELETE", `/mobile/connections/${mien}`, undefined, moi);
  ok(supprime);
  assert.deepEqual(supprime.body, { success: true, id: mien, deleted: true });
  assert.equal(row("Subscription", mien), undefined, "le forfait disparaît du tableau de bord");

  // La configuration partagée et les forfaits des autres utilisateurs restent.
  assert.ok(row("VpnProfile", "p1"), "le profil VPN n'est jamais supprimé");
  assert.ok(row("Subscription", autre));
  assert.ok(row("Subscription", direct));
  // Même comptabilité que la suppression par l'exploitant : le volume engagé
  // par le revendeur est libéré, et le mouvement est tracé.
  assert.equal(row("Reseller", "res-r1").quotaUsedBytes, 0n);
  assert.ok(db.state.ResellerQuotaMovement.some(m => m.referenceId === mien && m.kind === "QUOTA_RELEASE"));

  const liste = await api(null, "GET", "/mobile/connections", undefined, moi);
  ok(liste);
  assert.ok(!liste.body.connections.some(c => c.id === mien));

  // Rejouer la demande (hors réseau, puis resynchronisation) est sans effet.
  ok(await api(null, "DELETE", `/mobile/connections/${mien}`, undefined, moi), 404);
});

test("un utilisateur ne peut supprimer que ses propres forfaits", async () => {
  const autre = await forfait("admin", "c2");
  await forfait("r1", "c1");
  const moi = await appareil("c1", "DELETE-DEVICE-TWO");
  ok(await api(null, "DELETE", `/mobile/connections/${autre}`, undefined, moi), 404);
  assert.ok(row("Subscription", autre), "le forfait d'autrui reste intact");
  ok(await api(null, "DELETE", `/mobile/connections/${autre}`), 401);
  ok(await api(null, "DELETE", `/mobile/connections/${"x".repeat(129)}`, undefined, moi), 400);
});
