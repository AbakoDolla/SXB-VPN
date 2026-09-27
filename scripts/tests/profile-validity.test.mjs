/**
 * profile-validity.test.mjs — Échéance des configurations du tableau de bord.
 *
 * DEMANDE : afficher le temps restant d'une configuration VPN ajoutée depuis le
 * tableau de bord, et la prolonger SANS saisir le mot de passe de la
 * configuration. Ces tests font tourner les vraies routes sur le magasin isolé
 * de `reseller-http.test.mjs` et vérifient les trois garanties :
 *   1. l'échéance est lisible verrou fermé, sans aucun champ technique ;
 *   2. la prolongation ne demande ni mot de passe ni preuve de déverrouillage,
 *      et ne touche à rien d'autre (verrou, technique, `updatedAt`) ;
 *   3. le contrôle de propriété reste celui de toutes les routes `/:id`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { api, ok, row } from "./reseller-http.test.mjs";

const DAY = 86_400_000;
const lockPassword = "validity-lock-password";

async function created(extra = {}, actor = "admin") {
  const response = await api(actor, "POST", "/vpn-profiles", {
    name: "Compte fournisseur", protocol: "ssh", host: "provider.example.test", port: 22,
    username: "provider-user", password: "provider-secret", lockPassword, ...extra,
  });
  ok(response, 201);
  return response.body.profile;
}

function withoutTechnique(profile) {
  assert.equal(profile.isLocked, true);
  for (const field of ["host", "port", "protocol", "username", "password", "canonicalConfigHash", "lockPasswordHash"]) {
    assert.equal(profile[field], undefined, `fuite : ${field}`);
  }
}

test("la durée fournisseur se fixe à la création et reste lisible verrou fermé", async () => {
  const before = Date.now();
  const profile = await created({ validityDays: 30 });
  withoutTechnique(profile);
  const expiresAt = Date.parse(profile.expiresAt);
  assert.ok(expiresAt >= before + 30 * DAY && expiresAt <= Date.now() + 30 * DAY);

  const list = await api("admin", "GET", "/vpn-profiles");
  ok(list);
  const listed = list.body.profiles.find(p => p.id === profile.id);
  withoutTechnique(listed);
  assert.equal(listed.expiresAt, profile.expiresAt);

  // Sans durée : aucune échéance inventée, comme pour tous les profils existants.
  const open = await created({ name: "Sans échéance" });
  assert.equal(open.expiresAt, null);

  for (const validityDays of [0, -1, 1.5, 3651, "abc"]) {
    ok(await api("admin", "POST", "/vpn-profiles", {
      name: "Durée invalide", protocol: "ssh", host: "h.example.test", port: 22,
      username: "u", password: "p", lockPassword, validityDays,
    }), 400);
  }
});

test("prolonger ne demande aucun mot de passe et ne touche qu'à l'échéance", async () => {
  const profile = await created({ validityDays: 10 });
  const stored = row("VpnProfile", profile.id);
  const snapshot = structuredClone(stored);

  // Aucune preuve de déverrouillage, aucun mot de passe dans le corps.
  const extended = await api("admin", "POST", `/vpn-profiles/${profile.id}/extend`, { days: 30 });
  ok(extended);
  withoutTechnique(extended.body.profile);
  assert.equal(Date.parse(extended.body.expiresAt), Date.parse(profile.expiresAt) + 30 * DAY,
    "les jours s'ajoutent à ce qui restait");

  const after = row("VpnProfile", profile.id);
  for (const [key, value] of Object.entries(snapshot)) {
    if (key === "expiresAt") continue;
    assert.deepEqual(after[key], value, `${key} ne doit pas changer`);
  }
  // L'empreinte d'un profil ancien inclut `updatedAt` : il est conservé, les
  // appareils n'ont donc aucune raison de réimporter.
  assert.equal(+after.updatedAt, +snapshot.updatedAt);

  // Toujours verrouillée : modifier la fiche exige encore le déverrouillage.
  ok(await api("admin", "PUT", `/vpn-profiles/${profile.id}`, { name: "Sans preuve" }), 423);
});

test("une configuration expirée ou sans échéance repart d'aujourd'hui", async () => {
  const expired = await created({ validityDays: 5 });
  row("VpnProfile", expired.id).expiresAt = new Date(Date.now() - 3 * DAY);
  const before = Date.now();
  const renewed = await api("admin", "POST", `/vpn-profiles/${expired.id}/extend`, { days: 7 });
  ok(renewed);
  const end = Date.parse(renewed.body.expiresAt);
  assert.ok(end >= before + 7 * DAY && end <= Date.now() + 7 * DAY);

  const open = await created({ name: "Sans échéance" });
  const defined = await api("admin", "POST", `/vpn-profiles/${open.id}/extend`, { days: 15 });
  ok(defined);
  assert.ok(Date.parse(defined.body.expiresAt) >= before + 15 * DAY);
});

test("la prolongation refuse les durées invalides et les champs étrangers", async () => {
  const profile = await created({ validityDays: 10 });
  const expiresAt = +row("VpnProfile", profile.id).expiresAt;
  for (const body of [{}, { days: 0 }, { days: 3651 }, { days: 2.5 }, { days: "30" + "x" },
    { days: 30, password: lockPassword }, { days: 30, expiresAt: "2099-01-01" }]) {
    ok(await api("admin", "POST", `/vpn-profiles/${profile.id}/extend`, body), 400);
  }
  assert.equal(+row("VpnProfile", profile.id).expiresAt, expiresAt);
});

test("la prolongation garde le contrôle de propriété des routes /:id", async () => {
  ok(await api("admin", "POST", "/vpn-profiles/inconnu/extend", { days: 30 }), 404);
  const foreign = await created({ name: "Profil d'un autre exploitant", validityDays: 10 }, "super");
  const expiresAt = +row("VpnProfile", foreign.id).expiresAt;
  ok(await api("admin", "POST", `/vpn-profiles/${foreign.id}/extend`, { days: 30 }), 404);
  assert.equal(+row("VpnProfile", foreign.id).expiresAt, expiresAt);
  ok(await api(null, "POST", `/vpn-profiles/${foreign.id}/extend`, { days: 30 }), 401);
  ok(await api("u1", "POST", `/vpn-profiles/${foreign.id}/extend`, { days: 30 }), 403);
});
