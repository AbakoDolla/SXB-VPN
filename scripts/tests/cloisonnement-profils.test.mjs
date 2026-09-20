/**
 * cloisonnement-profils.test.mjs — Les configurations sont cloisonnées.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LE TROU QUI RESTAIT
 * ═══════════════════════════════════════════════════════════════════════════
 * Le cloisonnement s'était arrêté aux clients et à tout ce qui pointe vers eux.
 * Les CONFIGURATIONS, elles, n'ont pas de client : rien ne les bornait, et
 * `/api/vpn-profiles` les rendait ENTIÈREMENT à quiconque détient
 * `vpnprofile.view`.
 *
 * Conséquence directe pour l'exploitant : un administrateur créé pour revendre
 * l'accès voyait, dès sa première connexion, tout le catalogue de la maison —
 * chaque configuration, son nom commercial, son compte de forfaits. Ce n'était
 * pas « un tableau de bord tout neuf », c'était celui du propriétaire.
 *
 * Un profil n'a pas de gestionnaire mais il porte son AUTEUR (`createdBy`) :
 * c'est `managedById` sous un autre nom. Encore fallait-il l'inscrire — il ne
 * l'était nulle part, et sans cela un administrateur n'aurait jamais vu ses
 * propres imports.
 *
 * Exécution : npx tsx --test scripts/tests/cloisonnement-profils.test.mjs
 */
import './register-hooks.mjs';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const lire = (relatif) => readFileSync(path.join(ROOT, relatif), 'utf8');

const PORTEE = lire('server/services/portee-donnees.ts');
const ROUTE = lire('server/routes/vpn-profiles.ts');

describe('cloisonnement des configurations VPN', () => {
  it('définit la règle au point UNIQUE de cloisonnement', () => {
    // Recopier la règle dans la route la ferait diverger à la première
    // évolution — c'est déjà arrivé pour les clients, et trois surfaces
    // avaient alors leur propre version du filtre.
    //
    // DURCISSEMENT : la règle ne vit plus dans `porteeProfils` mais dans
    // `porteeParAuteur`, qui la porte pour les CINQ surfaces sans client —
    // configurations, campagnes d'essai, revendeurs, serveurs, bons. Cinq
    // copies auraient fini par diverger exactement comme les trois d'avant.
    assert.match(PORTEE, /async function porteeParAuteur/);
    assert.match(PORTEE, /return \{ \[champ\]: requerant\.userId \};/);
    // Un administrateur sans identité exploitable ne voit rien plutôt que tout.
    assert.match(PORTEE, /if \(!requerant\?\.userId\) return \{ id: \{ in: \[\] \} \};/);

    // Chaque surface NOMME la règle au lieu de la réécrire.
    for (const surface of [
      'porteeProfils', 'porteeJetonsEssai', 'porteeRevendeurs', 'porteeServeurs', 'porteeBons',
    ]) {
      assert.match(PORTEE, new RegExp(`export async function ${surface}[\\s\\S]{0,260}porteeParAuteur\\(`),
        `${surface} doit déléguer à la règle commune`);
    }
    // Une seule écriture de la règle, jamais deux.
    assert.equal((PORTEE.match(/\[champ\]: requerant\.userId/g) || []).length, 1,
      'la règle ne doit être écrite qu’une seule fois');
  });

  it('borne les DEUX chemins de liste', () => {
    // La route a un repli quand la table des attributions n'existe pas encore.
    // Ne borner que le chemin principal laisserait le repli tout rendre.
    assert.match(ROUTE, /const portee = await porteeProfils\(prisma, req\.user\);/);
    const bornes = ROUTE.match(/\.\.\.\(portee \? \{ where: portee \} : \{\}\)/g) ?? [];
    assert.ok(bornes.length >= 2, `les deux chemins doivent être bornés (vu ${bornes.length})`);
  });

  it('protège aussi l’accès direct par identifiant', () => {
    // Un filtre de liste ne protège pas une lecture par identifiant : sans ce
    // contrôle, un administrateur lisait n'importe quelle configuration en
    // devinant son identifiant.
    assert.match(ROUTE, /async function profilVisible/);
    assert.match(ROUTE, /if \(!\(await profilVisible\(p, req\)\)\) return res\.status\(404\)/);
  });

  it('inscrit l’auteur sur CHAQUE chemin de création', () => {
    // Sans lui, la portée d'un administrateur serait vide en permanence : il ne
    // verrait même pas ce qu'il vient d'importer.
    const auteurs = ROUTE.match(/createdBy: req\.user\?\.userId \?\? null/g) ?? [];
    assert.ok(auteurs.length >= 3, `chaque création doit inscrire son auteur (vu ${auteurs.length})`);
  });

  it('couvre les CINQ surfaces sans client, mesurées en production', () => {
    // Le cloisonnement s'était arrêté aux clients et à ce qui pointe vers eux.
    // Mesuré en production, un administrateur créé à l'instant voyait encore :
    // 10 campagnes d'essai, 200 inscriptions, 5 revendeurs, 3 serveurs et les
    // bons de la maison. Aucun de ces objets n'a de client — donc rien ne les
    // rattachait à personne.

    // Essais : la campagne porte l'auteur, l'inscription hérite de la campagne.
    const essais = lire('server/routes/free-trial.ts');
    assert.match(essais, /porteeJetonsEssai\(prisma, req\.user\)/, 'les campagnes doivent être bornées');
    const parCampagne = essais.match(/porteeDemandesEssai\(prisma, req\.user\)/g) ?? [];
    assert.ok(parCampagne.length >= 3,
      `la liste ET les deux compteurs doivent être bornés (vu ${parCampagne.length})`);
    // Les compteurs suivent la même portée : sinon « 594 essais » s'afficherait
    // au-dessus d'un tableau vide, et l'arithmétique trahirait la liste.
    assert.match(essais, /porteeCampagne \? \{ where: porteeCampagne \} : \{\}/);

    // Revendeurs, serveurs, bons : lecture bornée ET création estampillée.
    for (const [fichier, portee, libelle] of [
      ['server/routes/resellers.ts', 'porteeRevendeurs', 'revendeurs'],
      ['server/routes/servers.ts', 'porteeServeurs', 'serveurs'],
      ['server/routes/vouchers.ts', 'porteeBons', 'bons'],
    ]) {
      const source = lire(fichier);
      assert.match(source, new RegExp(`${portee}\\(prisma, req\\.user\\)`),
        `${libelle} : lecture non bornée`);
      assert.match(source, /auteurAInscrire\(req\.user\)/,
        `${libelle} : création sans estampille — la portée de l’admin resterait vide à jamais`);
    }
  });

  it('laisse visibles les configurations sans auteur', () => {
    // Les profils existants n'ont pas d'auteur. Les exclure de la vue du
    // super-administrateur les ferait disparaître d'un coup de toutes les
    // listes — une migration ne doit jamais cacher ce qui marchait.
    assert.match(PORTEE, /OR: \[\{ \[champ\]: null \}, \{ \[champ\]: \{ notIn: identifiants \} \}\]/);
  });
});
