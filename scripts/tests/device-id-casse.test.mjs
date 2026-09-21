// ═══════════════════════════════════════════════════════════════════════════
// L'IDENTIFIANT D'APPAREIL SAISI AU TABLEAU DE BORD EST RAMENÉ EN MAJUSCULES
// ═══════════════════════════════════════════════════════════════════════════
//
// Deux pannes tenaient à cette seule ligne :
//
//   1. Une fiche saisie « sxb66… » était créée sans erreur, puis n'était
//      JAMAIS rejointe par l'appareil, qui annonce « SXB66… » et dont
//      l'appariement est exact partout. La vente semblait faite, l'accès ne
//      fonctionnait pas, et rien ne l'expliquait à l'écran.
//   2. La même variante de casse contournait l'unicité par propriétaire :
//      un même appareil comptait deux fois dans le parc et dans le plafond
//      du revendeur.
//
// Ce banc verrouille la normalisation ET le fait qu'elle reste branchée sur
// les deux seules routes de saisie. Il ne touche à aucune base.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const racine = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lire = (p) => readFileSync(join(racine, p), "utf8");

const SERVICE = "server/services/vpn-client-device-scope.ts";

test("la normalisation met l'identifiant en majuscules", () => {
  const source = lire(SERVICE);
  const corps = source.slice(source.indexOf("export function normaliserDeviceIdClient("));
  const fin = corps.indexOf("\n}");
  const fonction = corps.slice(0, fin);
  assert.match(
    fonction,
    /\.trim\(\)\s*\.toUpperCase\(\)/,
    "normaliserDeviceIdClient doit ramener la casse : sans cela une fiche saisie "
      + "en minuscules n'est jamais rejointe par l'appareil, qui annonce en majuscules.",
  );
});

test("la normalisation reste branchée sur les deux routes de saisie", () => {
  for (const route of ["server/routes/clients.ts", "server/routes/devices.ts"]) {
    const source = lire(route);
    assert.match(
      source,
      /normaliserDeviceIdClient\(\s*body\.deviceId\s*\)/,
      `${route} doit normaliser l'identifiant reçu avant de le chercher puis de l'écrire.`,
    );
  }
});

test("la recherche de conflit emploie la valeur normalisée, jamais la brute", () => {
  const source = lire(SERVICE);
  const bloc = source.slice(source.indexOf("export async function chercherConflitDeviceClient("));
  const fonction = bloc.slice(0, bloc.indexOf("\n}"));
  assert.match(
    fonction,
    /const normalise = normaliserDeviceIdClient\(deviceId\)/,
    "le conflit doit être cherché sur la forme canonique, sinon la casse le contourne.",
  );
  assert.match(
    fonction,
    /deviceId: normalise/,
    "le filtre doit porter la valeur normalisée et non l'entrée brute.",
  );
  assert.doesNotMatch(
    fonction,
    /deviceId: deviceId\b/,
    "l'entrée brute ne doit jamais servir de filtre.",
  );
});

test("le conflit est cherché DANS la portée du requérant, pas globalement", () => {
  // La règle validée : portée d'unicité = portée de visibilité. Un admin ne
  // doit jamais être bloqué par un client qu'il ne peut pas voir — c'est ce
  // qui l'empêchait de vendre.
  const source = lire(SERVICE);
  const bloc = source.slice(source.indexOf("export async function chercherConflitDeviceClient("));
  const fonction = bloc.slice(0, bloc.indexOf("\n}"));
  assert.match(
    fonction,
    /etFiltres\(\s*portee\s*,/,
    "la recherche doit être bornée par la portée reçue ; une recherche globale "
      + "rendrait un identifiant déjà vendu ailleurs inutilisable.",
  );
});

test("les deux routes bornent le conflit par la portée du requérant", () => {
  for (const route of ["server/routes/clients.ts", "server/routes/devices.ts"]) {
    const source = lire(route);
    assert.match(
      source,
      /porteeClients\(prisma, req\.user\)/,
      `${route} doit chercher le conflit sous porteeClients, jamais sur tout le parc.`,
    );
  }
});

test("l'alphabet des identifiants engendrés reste sans minuscule", () => {
  // C'est la prémisse qui rend la normalisation inoffensive. Si l'application
  // se mettait un jour à engendrer des minuscules, deux appareils distincts
  // pourraient ne différer que par la casse et ce banc doit alors tomber.
  const source = lire("app-mobile/contexts/AuthContext.tsx");
  const ligne = source.match(/const DEVICE_ID_ALPHABET = '([^']+)'/);
  assert.ok(ligne, "DEVICE_ID_ALPHABET doit rester lisible depuis ce banc.");
  assert.equal(
    /[a-z]/.test(ligne[1]),
    false,
    "l'alphabet contient désormais des minuscules : la normalisation en "
      + "majuscules pourrait confondre deux appareils réellement distincts.",
  );
});
