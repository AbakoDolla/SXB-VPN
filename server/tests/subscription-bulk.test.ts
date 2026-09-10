/**
 * Application groupée sur les forfaits — tests de régression.
 *
 * Ce que ces tests protègent, dans l'ordre des dégâts qu'un retour en arrière
 * causerait en exploitation :
 *
 *  1. un champ laissé vide ne réécrit RIEN — c'est la promesse faite à l'écran,
 *     et la casser reviendrait à remettre à zéro le serveur, la date ou le
 *     volume de forfaits que l'exploitant ne visait pas ;
 *  2. plusieurs attributs partent en UNE opération — le motif même du
 *     correctif : l'écran n'acceptait qu'une action à la fois ;
 *  3. le plafond revendeur est évalué sur le CUMUL du lot — sinon 100 × 5 Go
 *     passent pour un revendeur qui n'a que 100 Go ;
 *  4. un échec isolé est rapporté sans annuler les réussites déjà écrites.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  GIB,
  JOUR_MS,
  MAX_BULK_APPLY,
  RAISONS_GROUPEES,
  aucunChampRenseigne,
  deltaAllocationGroupee,
  estEngage,
  gigaoctetsEnOctets,
  normaliserLot,
  planifierApplication,
  statutApresApplication,
  type ChangementsGroupes,
  type ForfaitCible,
} from "../services/subscription-bulk";
import { calculerAllocation } from "../services/reseller-quota";
import { possedeClient } from "../services/reseller-state";

const GO = BigInt(GIB);
const MAINTENANT = new Date("2026-03-01T12:00:00.000Z");
const DEMAIN = new Date(MAINTENANT.getTime() + JOUR_MS);
const HIER = new Date(MAINTENANT.getTime() - JOUR_MS);

function forfait(overrides: Partial<ForfaitCible> = {}): ForfaitCible {
  return {
    id: "sub-1",
    profileId: "prof-1",
    quotaBytes: 10n * GO,
    quotaUsed: 2n * GO,
    durationDays: 30,
    startAt: HIER,
    expireAt: new Date(MAINTENANT.getTime() + 29 * JOUR_MS),
    status: "active",
    ...overrides,
  };
}

const lire = (chemin: string) => readFileSync(new URL(chemin, import.meta.url), "utf8");

describe("champs vides — ce qui n'est pas renseigné n'est pas réécrit", () => {
  it("ne planifie aucune écriture quand rien n'est renseigné", () => {
    assert.equal(aucunChampRenseigne({}), true);
    const plan = planifierApplication(forfait(), {}, MAINTENANT);
    assert.equal(plan.statut, "skipped");
    assert.equal(plan.statut === "skipped" && plan.raison, RAISONS_GROUPEES.AUCUN_CHAMP);
  });

  it("n'écrit QUE le champ renseigné et laisse les autres intacts", () => {
    const plan = planifierApplication(forfait(), { quotaGB: 50 }, MAINTENANT);
    assert.equal(plan.statut, "ok");
    if (plan.statut !== "ok") return;
    // Le serveur, le début et l'échéance n'apparaissent pas : Prisma ne les
    // touchera donc pas. Une régression les ferait passer à `undefined`/null.
    assert.deepEqual(Object.keys(plan.data).sort(), ["quotaBytes"]);
    assert.equal(plan.data.quotaBytes, 50n * GO);
  });

  it("ne considère pas un champ vide comme un zéro", () => {
    // Un quota renseigné à 0 est un choix explicite ; `undefined` ne l'est pas.
    const explicite = planifierApplication(forfait({ quotaUsed: 0n }), { quotaGB: 0 }, MAINTENANT);
    assert.equal(explicite.statut, "ok");
    assert.equal(explicite.statut === "ok" && explicite.data.quotaBytes, BigInt(0));
    const absent = planifierApplication(forfait(), { startAt: DEMAIN }, MAINTENANT);
    assert.equal(absent.statut === "ok" && "quotaBytes" in absent.data, false);
  });

  it("ignore un forfait dont les valeurs sont déjà celles demandées", () => {
    const cible = forfait();
    const plan = planifierApplication(cible, { profileId: "prof-1" }, MAINTENANT);
    assert.equal(plan.statut, "skipped");
    assert.equal(plan.statut === "skipped" && plan.raison, RAISONS_GROUPEES.AUCUN_CHANGEMENT);
  });
});

describe("plusieurs attributs en une seule opération", () => {
  it("applique serveur, volume, début et durée d'un seul coup", () => {
    const changements: ChangementsGroupes = {
      profileId: "prof-2",
      quotaGB: 100,
      quotaMode: "set",
      startAt: MAINTENANT,
      durationDays: 60,
      durationMode: "set",
    };
    const plan = planifierApplication(forfait(), changements, MAINTENANT);
    assert.equal(plan.statut, "ok");
    if (plan.statut !== "ok") return;
    assert.equal(plan.data.profileId, "prof-2");
    assert.equal(plan.data.quotaBytes, 100n * GO);
    assert.equal((plan.data.startAt as Date).toISOString(), MAINTENANT.toISOString());
    assert.equal(plan.data.durationDays, 60);
    assert.equal(
      (plan.data.expireAt as Date).toISOString(),
      new Date(MAINTENANT.getTime() + 60 * JOUR_MS).toISOString(),
    );
  });

  it("distingue « remplacer » de « ajouter » sur le volume", () => {
    const remplace = planifierApplication(forfait(), { quotaGB: 5, quotaMode: "set" }, MAINTENANT);
    const ajoute = planifierApplication(forfait(), { quotaGB: 5, quotaMode: "add" }, MAINTENANT);
    assert.equal(remplace.statut === "ok" && remplace.data.quotaBytes, 5n * GO);
    // Confondre les deux ferait perdre au client les 10 Go déjà payés.
    assert.equal(ajoute.statut === "ok" && ajoute.data.quotaBytes, 15n * GO);
  });

  it("distingue « remplacer » de « ajouter » sur la durée", () => {
    const echeance = new Date(MAINTENANT.getTime() + 10 * JOUR_MS);
    const cible = forfait({ expireAt: echeance, durationDays: 11 });
    const remplace = planifierApplication(cible, { durationDays: 7, durationMode: "set" }, MAINTENANT);
    const ajoute = planifierApplication(cible, { durationDays: 7, durationMode: "add" }, MAINTENANT);
    // « Remplacer » repart du début du forfait, « ajouter » de son échéance.
    assert.equal(remplace.statut === "ok" && remplace.data.durationDays, 7);
    assert.equal(ajoute.statut === "ok" && ajoute.data.durationDays, 18);
    assert.equal(
      ajoute.statut === "ok" && (ajoute.data.expireAt as Date).toISOString(),
      new Date(echeance.getTime() + 7 * JOUR_MS).toISOString(),
    );
  });

  it("prolonge un forfait expiré à partir d'aujourd'hui, pas de sa date passée", () => {
    const plan = planifierApplication(
      forfait({ expireAt: HIER, status: "expired", durationDays: 1 }),
      { durationDays: 30, durationMode: "add" },
      MAINTENANT,
    );
    assert.equal(plan.statut, "ok");
    if (plan.statut !== "ok") return;
    // Repartir de HIER laisserait la nouvelle échéance dans le passé.
    assert.ok((plan.data.expireAt as Date).getTime() > MAINTENANT.getTime());
  });

  it("aligne la durée affichée sur une échéance fixée à la date", () => {
    const echeance = new Date(MAINTENANT.getTime() + 45 * JOUR_MS);
    const plan = planifierApplication(forfait({ startAt: MAINTENANT }), { expireAt: echeance }, MAINTENANT);
    assert.equal(plan.statut, "ok");
    // Sans cela le forfait annoncerait « 30 jours » avec une échéance à 45.
    assert.equal(plan.statut === "ok" && plan.data.durationDays, 45);
  });

  it("refuse d'appliquer une échéance et une durée ensemble", () => {
    const plan = planifierApplication(forfait(), { expireAt: DEMAIN, durationDays: 30 }, MAINTENANT);
    assert.equal(plan.statut, "failed");
    assert.equal(plan.statut === "failed" && plan.raison, RAISONS_GROUPEES.ECHEANCE_ET_DUREE);
  });

  it("refuse une échéance antérieure au début", () => {
    const plan = planifierApplication(forfait(), { startAt: DEMAIN, expireAt: MAINTENANT }, MAINTENANT);
    assert.equal(plan.statut, "failed");
    assert.equal(plan.statut === "failed" && plan.raison, RAISONS_GROUPEES.ECHEANCE_AVANT_DEBUT);
  });

  it("refuse un volume inférieur à ce qui est déjà consommé", () => {
    const plan = planifierApplication(forfait({ quotaUsed: 8n * GO }), { quotaGB: 5 }, MAINTENANT);
    assert.equal(plan.statut, "failed");
    assert.equal(plan.statut === "failed" && plan.raison, RAISONS_GROUPEES.QUOTA_SOUS_CONSOMMATION);
  });
});

describe("statuts — une opération groupée ne rouvre pas un accès fermé", () => {
  for (const statut of ["suspended", "revoked"]) {
    it(`ne lève pas un forfait « ${statut} »`, () => {
      const plan = planifierApplication(
        forfait({ status: statut, quotaUsed: 10n * GO }),
        { quotaGB: 500 },
        MAINTENANT,
      );
      assert.equal(plan.statut, "ok");
      // Recharger un lot entier ne doit pas rouvrir des accès fermés à dessein.
      assert.equal(plan.statut === "ok" && plan.data.status, undefined);
      assert.equal(statutApresApplication(statut, 500n * GO, BigInt(0), null, MAINTENANT.getTime()), statut);
    });
  }

  it("réactive un forfait épuisé qui retrouve volume ET durée", () => {
    const plan = planifierApplication(
      forfait({ status: "exhausted", quotaBytes: 2n * GO, quotaUsed: 2n * GO }),
      { quotaGB: 20, quotaMode: "add" },
      MAINTENANT,
    );
    assert.equal(plan.statut === "ok" && plan.data.status, "active");
  });

  it("ne réactive pas un forfait épuisé dont l'échéance reste dépassée", () => {
    const plan = planifierApplication(
      forfait({ status: "exhausted", quotaBytes: 2n * GO, quotaUsed: 2n * GO, expireAt: HIER }),
      { quotaGB: 20, quotaMode: "add" },
      MAINTENANT,
    );
    assert.equal(plan.statut === "ok" && plan.data.status, undefined);
  });
});

describe("plafond revendeur — le CUMUL du lot est projeté, pas chaque élément", () => {
  it("additionne la variation de tous les forfaits du lot", () => {
    const lot = Array.from({ length: 100 }, (_, i) => forfait({ id: `sub-${i}` }));
    const delta = deltaAllocationGroupee(lot, { quotaGB: 5, quotaMode: "add" }, MAINTENANT);
    // 100 × 5 Go : évalué un par un, chaque appel serait valide sous un plafond
    // de 100 Go. Le cumul, lui, le fait sauter.
    assert.equal(delta, 500n * GO);
  });

  it("ne compte ni les forfaits ignorés ni les forfaits refusés", () => {
    const lot = [
      forfait({ id: "ok" }),
      forfait({ id: "identique", profileId: "prof-9" }),
      forfait({ id: "refuse", quotaUsed: 999n * GO }),
    ];
    // Seul « ok » change de serveur : les deux autres ne pèsent rien.
    const delta = deltaAllocationGroupee(lot, { profileId: "prof-9" }, MAINTENANT);
    assert.equal(delta, BigInt(0));
  });

  it("compte la réactivation d'un forfait expiré comme un réengagement", () => {
    const expire = forfait({ status: "expired", expireAt: HIER, quotaBytes: 40n * GO, quotaUsed: 0n });
    const delta = deltaAllocationGroupee([expire], { durationDays: 30, durationMode: "add" }, MAINTENANT);
    // Un forfait expiré ne pesait rien ; prolongé, il réengage tout son volume.
    assert.equal(delta, 40n * GO);
  });

  it("libère l'enveloppe quand le lot réduit un volume", () => {
    const delta = deltaAllocationGroupee([forfait()], { quotaGB: 4 }, MAINTENANT);
    assert.equal(delta, -6n * GO);
  });

  it("partage la définition d'engagement de calculerAllocation", () => {
    // Si les deux divergeaient, le plafond deviendrait contournable par une
    // opération groupée : la projection annoncerait un total que le calcul réel
    // ne constaterait pas.
    const instant = MAINTENANT.getTime();
    for (const statut of ["revoked", "suspended", "expired"]) {
      assert.equal(estEngage(statut, DEMAIN, instant), false, statut);
    }
    assert.equal(estEngage("active", DEMAIN, instant), true);
    assert.equal(estEngage("active", HIER, instant), false);
    assert.equal(estEngage("active", null, instant), true);

    const source = lire("../services/reseller-quota.ts");
    for (const statut of ["revoked", "suspended", "expired"]) {
      assert.ok(source.includes(`'${statut}'`) || source.includes(`"${statut}"`), statut);
    }
  });

  it("projette exactement ce que calculerAllocation constatera après écriture", async () => {
    // Dates calées sur l'horloge réelle : `calculerAllocation` lit `Date.now()`
    // et ne prend pas d'instant en paramètre. Un jeu de dates figé ferait
    // diverger les deux calculs le jour où il tomberait dans le passé.
    const maintenant = new Date();
    const echeance = new Date(maintenant.getTime() + 30 * JOUR_MS);
    const cibles = [
      forfait({ id: "a", quotaBytes: 10n * GO, expireAt: echeance, status: "active" }),
      forfait({ id: "b", quotaBytes: 20n * GO, expireAt: echeance, status: "active" }),
    ];
    const changements: ChangementsGroupes = { quotaGB: 5, quotaMode: "add" };
    const delta = deltaAllocationGroupee(cibles, changements, maintenant);

    // Allocation réelle telle que la calculera le service, une fois les
    // écritures planifiées appliquées.
    const apres = cibles.map(cible => {
      const plan = planifierApplication(cible, changements, maintenant);
      return {
        ...cible,
        quotaBytes: plan.statut === "ok" ? (plan.data.quotaBytes as bigint) : (cible.quotaBytes as bigint),
      };
    });
    const faussePrisma = (forfaits: readonly ForfaitCible[]) => ({
      vpnClient: {
        findMany: async () => [
          {
            id: "cli-1",
            status: "active",
            expireAt: null,
            quotaTotal: BigInt(0),
            quotaUsed: BigInt(0),
            subscriptions: forfaits,
            tokens: [],
          },
        ],
      },
      voucher: { findMany: async () => [] },
    });
    const avant = await calculerAllocation(faussePrisma(cibles), { id: "res-1", userId: "user-res-1" });
    const total = await calculerAllocation(faussePrisma(apres), { id: "res-1", userId: "user-res-1" });
    assert.equal(total.alloue - avant.alloue, delta);
  });
});

describe("propriété revendeur — le contrôle porte sur CHAQUE élément du lot", () => {
  const fiche = { id: "res-1", userId: "user-res-1" };
  const mien = { userId: "u-1", resellerId: "res-1" };
  const autrui = { userId: "u-2", resellerId: "res-2" };

  it("refuse un forfait dont le client appartient à un autre revendeur", () => {
    assert.equal(possedeClient(mien, fiche), true);
    assert.equal(possedeClient(autrui, fiche), false);
    assert.equal(possedeClient(null, fiche), false);
  });

  it("borne le lot pour que chaque élément reste contrôlable", () => {
    const trop = Array.from({ length: MAX_BULK_APPLY + 1 }, (_, i) => `sub-${i}`);
    const refus = normaliserLot(trop);
    assert.equal(refus.ok, false);
    assert.equal(refus.ok === false && refus.raison, RAISONS_GROUPEES.LOT_TROP_GRAND);
  });

  it("refuse un lot vide", () => {
    const refus = normaliserLot([]);
    assert.equal(refus.ok, false);
    assert.equal(refus.ok === false && refus.raison, RAISONS_GROUPEES.LOT_VIDE);
  });

  it("dédoublonne le lot — deux fois le même identifiant ajouterait deux fois le volume", () => {
    const lot = normaliserLot(["a", "b", "a", "b", "c"]);
    assert.equal(lot.ok, true);
    assert.deepEqual(lot.ok === true && lot.ids, ["a", "b", "c"]);
  });
});

describe("échec partiel — les réussites survivent aux échecs", () => {
  it("classe chaque forfait indépendamment de ses voisins", () => {
    const lot = [
      forfait({ id: "reussite" }),
      forfait({ id: "refuse", quotaUsed: 999n * GO }),
      forfait({ id: "ignore", quotaBytes: 50n * GO }),
    ];
    const resultats = lot.map(cible => ({
      id: cible.id,
      plan: planifierApplication(cible, { quotaGB: 50, quotaMode: "set" }, MAINTENANT),
    }));
    assert.equal(resultats[0].plan.statut, "ok");
    assert.equal(resultats[1].plan.statut, "failed");
    // Le troisième est déjà à 50 Go : rien à écrire, mais aucun échec non plus.
    assert.equal(resultats[2].plan.statut, "skipped");
    const reussites = resultats.filter(r => r.plan.statut === "ok");
    assert.equal(reussites.length, 1, "un refus ne doit pas annuler les réussites");
  });

  it("chaque motif d'échec est une clé i18n traduite dans les deux langues", () => {
    const fr = JSON.parse(lire("../../artifacts/sxb-dashboard/src/locales/fr/errors.json"));
    const en = JSON.parse(lire("../../artifacts/sxb-dashboard/src/locales/en/errors.json"));
    // `errors` est le nom du fichier de traduction, pas une racine à l'intérieur.
    const resoudre = (source: any, cle: string) =>
      cle.replace(/^errors\./, "").split(".")
        .reduce((noeud, segment) => (noeud == null ? undefined : noeud[segment]), source);
    for (const cle of Object.values(RAISONS_GROUPEES)) {
      // Un motif non traduit s'afficherait à l'exploitant sous sa forme brute.
      assert.equal(typeof resoudre(fr, cle), "string", `FR manquant : ${cle}`);
      assert.equal(typeof resoudre(en, cle), "string", `EN manquant : ${cle}`);
    }
  });
});

describe("gardes posées sur la route groupée", () => {
  const route = lire("../routes/subscriptions.ts");

  it("borne le lot et refuse la sélection vide avant toute écriture", () => {
    assert.ok(route.includes("normaliserLot("), "le lot doit passer par normaliserLot");
    assert.ok(route.includes("MAX_BULK_APPLY"), "la borne doit venir du service");
  });

  it("contrôle la propriété revendeur forfait par forfait", () => {
    assert.ok(
      route.includes("possedeClient(sub.client, ficheBulk)"),
      "chaque forfait du lot doit être vérifié, pas seulement le premier",
    );
  });

  it("projette le plafond sur le cumul du lot", () => {
    assert.ok(
      route.includes("deltaAllocationGroupee(cibles, changements)"),
      "le plafond doit être évalué sur le total, pas élément par élément",
    );
    assert.ok(route.includes("executerMutationQuota"), "l'écriture doit rester sous le verrou de quota");
  });

  it("replanifie dans la transaction avant d'écrire", () => {
    // Entre la planification et l'écriture, la consommation a pu franchir le
    // nouveau quota : sans relecture, on écrirait un quota déjà dépassé.
    assert.ok(route.includes("tx.subscription.findUnique({ where: { id: subId } })"));
    assert.ok(route.includes("planifierApplication(courant, changements)"));
  });

  it("valide la configuration demandée une seule fois, avant le lot", () => {
    assert.ok(route.includes("assertResellerCanUseProfile(req, changements.profileId)"));
  });

  it("conserve les quatre actions historiques", () => {
    // Les intégrations et anciens dashboards déployés les appellent encore.
    for (const action of ["deploy", "set", "add_data", "extend_duration", "apply"]) {
      assert.ok(route.includes(`'${action}'`), `action absente : ${action}`);
    }
  });
});

describe("écran des forfaits — le sélecteur de serveur est toujours rendu", () => {
  const vue = lire("../../artifacts/sxb-dashboard/src/components/SubscriptionsView.tsx");

  it("n'enferme plus le sélecteur derrière une action unique", () => {
    // CAUSE RACINE : le sélecteur n'était rendu que par `needsProfile`, vrai
    // pour la seule action « déployer ». Sur « ajouter des données » — la
    // valeur par défaut du menu — il n'existait tout simplement pas.
    assert.ok(!vue.includes("needsProfile"), "le rendu conditionnel par action doit avoir disparu");
    assert.ok(!vue.includes("BULK_ACTIONS"), "le menu d'action unique doit avoir disparu");
  });

  it("charge les configurations par la route de sélection, sans permission technique", () => {
    // `/vpn-profiles` exige `vpnprofile.view` : un administrateur habilité à
    // vendre ne la porte pas forcément, l'appel répondait 403 et faisait
    // échouer le chargement entier. Le rôle supérieur se replie donc sur la
    // route de sélection, qui n'exige aucune permission technique.
    assert.ok(vue.includes("return fetchAssignedVpnProfiles();"), "le repli doit exister");
    // Le partage d'origine reste intact : un revendeur ne lit jamais le parc
    // entier, et n'a donc aucun repli.
    assert.ok(vue.includes("isReseller ? fetchAssignedVpnProfiles() : fetchVpnProfiles()"));
    assert.ok(vue.includes("if (isReseller) throw err;"), "le revendeur ne doit pas se replier");
  });

  it("isole l'échec de chargement des configurations du reste de la vue", () => {
    assert.ok(vue.includes("setProfilesError"), "l'échec doit être conservé, pas propagé");
    assert.ok(
      vue.includes("profilesUnavailable") &&
        vue.includes("noProfilesReseller") &&
        vue.includes("noProfilesAdmin"),
      "une liste vide doit dire pourquoi elle est vide",
    );
  });

  it("expose volume, serveur, début et échéance en même temps", () => {
    for (const cle of ["bulkProfile", "bulkQuota", "bulkStart", "bulkExpire", "bulkDays"]) {
      assert.ok(vue.includes(cle), `champ absent : ${cle}`);
    }
    assert.ok(vue.includes("emptyMeansUnchanged"), "l'écran doit dire qu'un champ vide n'est pas réécrit");
  });

  it("récapitule l'opération avant de la confirmer", () => {
    assert.ok(vue.includes("bulkPlan.summary"), "le récapitulatif doit lister ce qui va changer");
    assert.ok(vue.includes("bulkConfirm"), "une confirmation doit rester exigée");
  });

  it("traduit chaque clé de l'écran groupé dans les deux langues", () => {
    const fr = JSON.parse(lire("../../artifacts/sxb-dashboard/src/locales/fr/commerce.json"));
    const en = JSON.parse(lire("../../artifacts/sxb-dashboard/src/locales/en/commerce.json"));
    const clefs = [...vue.matchAll(/commerce\.subscriptions\.bulk\.([A-Za-z]+)/g)].map(m => m[1]);
    assert.ok(clefs.length > 10, "l'écran doit passer par i18n, pas par des chaînes en dur");
    for (const cle of new Set(clefs)) {
      assert.equal(typeof fr.subscriptions.bulk[cle], "string", `FR manquant : ${cle}`);
      assert.equal(typeof en.subscriptions.bulk[cle], "string", `EN manquant : ${cle}`);
    }
  });
});

describe("conversions", () => {
  it("convertit les gigaoctets en octets binaires", () => {
    assert.equal(gigaoctetsEnOctets(1), GO);
    assert.equal(gigaoctetsEnOctets(0.5), GO / BigInt(2));
    assert.equal(gigaoctetsEnOctets(0), BigInt(0));
  });
});
