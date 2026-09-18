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
    assert.match(PORTEE, /export async function porteeProfils/);
    assert.match(PORTEE, /return \{ createdBy: requerant\.userId \};/);
    // Un administrateur sans identité exploitable ne voit rien plutôt que tout.
    assert.match(PORTEE, /if \(!requerant\?\.userId\) return \{ id: \{ in: \[\] \} \};/);
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

  it('laisse visibles les configurations sans auteur', () => {
    // Les profils existants n'ont pas d'auteur. Les exclure de la vue du
    // super-administrateur les ferait disparaître d'un coup de toutes les
    // listes — une migration ne doit jamais cacher ce qui marchait.
    assert.match(PORTEE, /OR: \[\{ createdBy: null \}, \{ createdBy: \{ notIn: identifiants \} \}\]/);
  });
});
