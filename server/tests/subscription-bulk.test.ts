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
  MAX_BULK_PROFILES,
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
import { comparerForfaitsParClient } from "../../artifacts/sxb-dashboard/src/lib/planOrder";
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

// ─────────────────────────────────────────────────────────────────────────────
describe("attribuer plusieurs forfaits à un appareil en une fois", () => {
  const route = lire("../routes/subscriptions.ts");

  it("crée un forfait par couple appareil × configuration", () => {
    // La demande de l'exploitant : cocher un appareil, puis lui attribuer
    // plusieurs forfaits d'un coup — un par opérateur, plus un de secours.
    assert.ok(route.includes("for (const profileTarget of profileTargets)"));
    assert.ok(route.includes("clientId, profileId: profileTarget"));
    // La forme historique à une seule configuration reste acceptée : des
    // intégrations déployées l'appellent encore.
    assert.ok(route.includes("body.profileIds?.length ? body.profileIds : [profileId!]"));
  });

  it("projette le plafond revendeur sur le produit, pas sur le seul nombre d'appareils", () => {
    // Sans ce facteur, dix configurations à 5 Go sur un appareil ne pesaient
    // que 5 Go dans la projection : le revendeur dépassait son enveloppe en
    // un seul envoi, exactement le contournement que le lot existe pour fermer.
    assert.ok(
      route.includes("projected += unit * BigInt(ownedTargets) * BigInt(profileTargets.length)"),
      "le cumul doit compter appareils × configurations",
    );
  });

  it("refuse le lot entier avant d'écrire quand une configuration est interdite", () => {
    const deploiement = route.slice(route.indexOf("} else if (action === 'deploy') {"), route.indexOf("accessStateHub.invalidate({ clientId });"));
    const controle = deploiement.indexOf("assertResellerCanUseProfile(req, id)");
    const ecriture = deploiement.indexOf("subscription.create");
    assert.ok(controle >= 0 && ecriture > controle, "les configurations sont validées avant toute écriture");
    assert.ok(deploiement.includes("return res.status(404).json({ error: 'Profil VPN introuvable', profileId: id })"));
  });

  it("borne le nombre de configurations et dédoublonne le lot", () => {
    assert.ok(route.includes("normaliserLot(body.profileIds?.length ? body.profileIds : [profileId!], MAX_BULK_PROFILES)"));
    assert.equal(MAX_BULK_PROFILES, 20);
    // `normaliserLot` dédoublonne : deux fois la même configuration ne doit pas
    // écrire deux forfaits identiques.
    const lot = normaliserLot(["p1", "p2", "p1"], MAX_BULK_PROFILES);
    assert.deepEqual(lot.ok && lot.ids, ["p1", "p2"]);
    assert.equal(normaliserLot(Array.from({ length: MAX_BULK_PROFILES + 1 }, (_, i) => `p${i}`), MAX_BULK_PROFILES).ok, false);
  });

  it("rapporte le forfait concerné et compte les forfaits réellement visés", () => {
    // Un compte rendu qui annonce « 2 sélectionnés » pour six forfaits créés
    // serait incompréhensible.
    assert.ok(route.includes("targetIds.length * profileTargets.length"));
    assert.ok(route.includes("details.push({ id: clientId, profileId: profileTarget, status: 'ok' })"));

    // L'interface doit annoncer le MÊME nombre avant l'envoi : le bouton, la
    // confirmation et l'avertissement comptaient les lignes cochées, donc « 1 »
    // là où trois configurations écriront trois forfaits.
    const vue = lire("../../artifacts/sxb-dashboard/src/components/SubscriptionsView.tsx");
    assert.ok(vue.includes("return clients.size * bulkProfiles.length"));
    assert.ok(!/bulk\.apply', \{ count: formatNumber\(selection\.size\)/.test(vue),
      "le bouton ne doit plus compter les lignes cochées");
    assert.equal((vue.match(/formatNumber\(bulkTargetCount\)/g) || []).length, 3,
      "bouton, confirmation et avertissement comptent la même chose");

    const panneau = lire("../../artifacts/sxb-dashboard/src/components/ClientBulkPlans.tsx");
    assert.ok(panneau.includes("count: formatNumber(clientIds.length * profileIds.length)"));
  });

  it("n'accepte `profileIds` que pour un déploiement", () => {
    assert.ok(route.includes("body.action !== 'deploy' && body.profileIds !== undefined"));
    // `apply` remplace la configuration des forfaits visés : plusieurs valeurs
    // n'y auraient aucun sens défini.
    assert.ok(route.includes("profileIds n’est accepté que par l’action « deploy »"));
  });

  it("propose la sélection multiple dans les deux écrans qui attribuent", () => {
    for (const chemin of [
      "../../artifacts/sxb-dashboard/src/components/SubscriptionsView.tsx",
      "../../artifacts/sxb-dashboard/src/components/ClientBulkPlans.tsx",
    ]) {
      const vue = lire(chemin);
      assert.ok(vue.includes("ProfileMultiSelect"), `${chemin} : sélection multiple absente`);
      assert.ok(vue.includes("MAX_BULK_PROFILES"), `${chemin} : borne serveur non reprise`);
      assert.ok(vue.includes("profileIds"), `${chemin} : le lot n'est pas envoyé`);
    }
    // Le composant partagé reste cloisonné à la seule liste qu'on lui donne.
    const composant = lire("../../artifacts/sxb-dashboard/src/components/ProfileMultiSelect.tsx");
    assert.ok(!composant.includes("apiRequest") && !composant.includes("fetch("));
    assert.ok(composant.includes('role="checkbox"') && composant.includes("aria-checked"));
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

describe("ordre d'affichage — les forfaits d'un client restent groupés", () => {
  // CAUSE RACINE : le serveur trie par `createdAt: 'desc'`. Les forfaits d'une
  // même personne se retrouvaient éparpillés sur toute la liste, au gré de la
  // date d'attribution de chacun.
  const forfaitDe = (clientId: string, createdAt: string) => ({ clientId, createdAt });
  const noms: Record<string, string> = {
    "cli-evans": "Evans",
    "cli-benbilal": "Benbilal",
    "cli-muet": "",
    "cli-app2": "Appareil 2",
    "cli-app10": "Appareil 10",
    "cli-homonyme": "Evans",
  };
  const trier = (items: Array<{ clientId: string; createdAt: string }>) =>
    [...items].sort((a, b) => comparerForfaitsParClient(a, b, item => noms[item.clientId] ?? ""));

  it("réunit les forfaits d'un même client, quelles que soient leurs dates", () => {
    const eparpille = [
      forfaitDe("cli-evans", "2026-03-01T00:00:00.000Z"),
      forfaitDe("cli-benbilal", "2026-02-01T00:00:00.000Z"),
      forfaitDe("cli-evans", "2026-01-01T00:00:00.000Z"),
      forfaitDe("cli-benbilal", "2026-04-01T00:00:00.000Z"),
    ];
    assert.deepEqual(
      trier(eparpille).map(f => f.clientId),
      ["cli-benbilal", "cli-benbilal", "cli-evans", "cli-evans"],
      "les forfaits d'un client doivent se suivre",
    );
  });

  it("classe du plus récent au plus ancien À L'INTÉRIEUR d'un client", () => {
    const ordonne = trier([
      forfaitDe("cli-evans", "2026-01-01T00:00:00.000Z"),
      forfaitDe("cli-evans", "2026-03-01T00:00:00.000Z"),
      forfaitDe("cli-evans", "2026-02-01T00:00:00.000Z"),
    ]);
    assert.deepEqual(ordonne.map(f => f.createdAt.slice(0, 7)), ["2026-03", "2026-02", "2026-01"]);
  });

  it("renvoie un client sans nom EN FIN de liste, pas en tête", () => {
    // Une chaîne vide trie avant toutes les lettres : sans règle explicite, une
    // fiche incomplète s'installerait en première position.
    const ordonne = trier([
      forfaitDe("cli-muet", "2026-01-01T00:00:00.000Z"),
      forfaitDe("cli-evans", "2026-01-01T00:00:00.000Z"),
    ]);
    assert.equal(ordonne[0].clientId, "cli-evans");
    assert.equal(ordonne[1].clientId, "cli-muet");
  });

  it("classe « Appareil 2 » avant « Appareil 10 »", () => {
    // Un tri lexical placerait « 10 » avant « 2 ».
    const ordonne = trier([
      forfaitDe("cli-app10", "2026-01-01T00:00:00.000Z"),
      forfaitDe("cli-app2", "2026-01-01T00:00:00.000Z"),
    ]);
    assert.deepEqual(ordonne.map(f => f.clientId), ["cli-app2", "cli-app10"]);
  });

  it("ne fusionne JAMAIS deux comptes portant le même nom affiché", () => {
    // Deux personnes peuvent s'appeler « Evans » : les réunir sous une seule
    // bannière laisserait croire qu'un compte détient les forfaits des deux.
    const ordonne = trier([
      forfaitDe("cli-evans", "2026-01-01T00:00:00.000Z"),
      forfaitDe("cli-homonyme", "2026-02-01T00:00:00.000Z"),
      forfaitDe("cli-evans", "2026-03-01T00:00:00.000Z"),
    ]);
    assert.deepEqual(
      ordonne.map(f => f.clientId),
      ["cli-evans", "cli-evans", "cli-homonyme"],
      "chaque identifiant garde son propre groupe",
    );
  });

  it("garde un ordre total cohérent (jamais deux éléments 'égaux' distincts)", () => {
    // Un comparateur incohérent produit un ordre qui dépend de l'implémentation
    // de tri du navigateur : la même liste s'afficherait différemment ailleurs.
    const tous = Object.keys(noms).map(id => forfaitDe(id, "2026-01-01T00:00:00.000Z"));
    for (const a of tous) {
      for (const b of tous) {
        const ab = comparerForfaitsParClient(a, b, item => noms[item.clientId] ?? "");
        const ba = comparerForfaitsParClient(b, a, item => noms[item.clientId] ?? "");
        if (a.clientId === b.clientId) assert.equal(ab, 0);
        else assert.ok(ab !== 0 && Math.sign(ab) === -Math.sign(ba), `incohérent : ${a.clientId} / ${b.clientId}`);
      }
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
