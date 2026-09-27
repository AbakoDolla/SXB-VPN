/**
 * config-secours.test.ts — Plusieurs configurations, et une issue quand l'une échoue.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LA DEMANDE
 * ═══════════════════════════════════════════════════════════════════════════
 * « Je voudrais que l'app prenne en charge plusieurs configurations, qu'elle
 * puisse les utiliser. »
 *
 * L'application gardait déjà jusqu'à quatre configurations et savait passer de
 * l'une à l'autre. Il manquait une chose : quand la connexion ÉCHOUAIT sur la
 * configuration active, rien ne proposait les autres — le bandeau de secours
 * n'apparaissait que pour un accès retiré. Ce fichier tient les garanties du
 * correctif :
 *   1. la configuration proposée est réellement utilisable — ni l'active, ni
 *      une qui vient d'échouer, ni une expirée (date locale, date serveur ou
 *      compte fournisseur), ni une retirée ;
 *   2. un échec se compte une fois, et l'épisode se clôt sur un succès ;
 *   3. la connexion ne part qu'APRÈS la bascule, jamais pendant une autre
 *      tentative : un seul tunnel à la fois ;
 *   4. l'accueil est câblé sur ces règles ;
 *   5. le secours ne touche jamais à l'imputation : il choisit une
 *      configuration, pas un forfait.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  ETATS_BLOQUANTS,
  choisirConfigDeSecours,
  suiteApresBascule,
  suivreEchecs,
  type ConfigCandidate,
  type ConnexionServeur,
} from '../services/configDeSecours';

const RACINE = path.resolve(__dirname, '..');
const ACCUEIL = readFileSync(path.join(RACINE, 'app/(tabs)/index.tsx'), 'utf8');
const CONTEXTE = readFileSync(path.join(RACINE, 'contexts/VpnContext.tsx'), 'utf8');
const SECOURS = readFileSync(path.join(RACINE, 'services/configDeSecours.ts'), 'utf8');
const TYPES = readFileSync(path.join(RACINE, 'types/api.ts'), 'utf8');
const SERVEUR = readFileSync(path.join(RACINE, '../server/routes/mobile.ts'), 'utf8');

const MAINTENANT = new Date('2026-06-15T12:00:00.000Z');
const HIER = '2026-06-14T12:00:00.000Z';
const DEMAIN = '2026-06-16T12:00:00.000Z';

type Config = ConfigCandidate & { name: string; source?: 'backend' | 'manual'; subscriptionId?: string };
const config = (id: string, extra: Partial<Config> = {}): Config => ({
  id, name: `Config ${id}`, isActive: false, status: 'active', expiryDate: DEMAIN, ...extra,
});
const choisir = (configs: Config[], options: {
  connexions?: ConnexionServeur[]; dejaEssayees?: string[];
} = {}) => choisirConfigDeSecours(configs, { ...options, maintenant: MAINTENANT })?.id;

describe('la configuration proposée mène quelque part', () => {
  it('jamais l’active, et dans l’ordre du sélecteur', () => {
    const configs = [config('a', { isActive: true }), config('b'), config('c')];
    assert.equal(choisir(configs), 'b');
    assert.equal(choisir([config('a', { isActive: true })]), undefined);
  });

  it('écarte chaque état bloquant connu de l’appareil', () => {
    for (const etat of ['deleted', 'revoked', 'suspended', 'expired', 'exhausted']) {
      assert.ok(ETATS_BLOQUANTS.has(etat), `${etat} absent des états bloquants`);
      const configs = [config('a', { isActive: true }), config('b', { status: etat }), config('c')];
      assert.equal(choisir(configs), 'c', `${etat} ne doit pas être proposé`);
    }
  });

  it('écarte un état bloquant connu du serveur même si l’appareil l’ignore encore', () => {
    const configs = [config('a', { isActive: true }), config('b'), config('c')];
    assert.equal(choisir(configs, { connexions: [{ id: 'b', status: 'suspended' }] }), 'c');
  });

  it('écarte une échéance passée, qu’elle vienne du registre (hors ligne) ou du serveur', () => {
    const configs = [config('a', { isActive: true }), config('b', { expiryDate: HIER }), config('c')];
    assert.equal(choisir(configs), 'c', 'date locale passée, statut encore « active »');

    const fraiches = [config('a', { isActive: true }), config('b'), config('c')];
    assert.equal(choisir(fraiches, { connexions: [{ id: 'b', status: 'active', expiresAt: HIER }] }), 'c');

    // Sans échéance connue : rien n'est inventé.
    assert.equal(choisir([config('a', { isActive: true }), config('b', { expiryDate: null })]), 'b');
  });

  it('écarte une configuration dont le compte fournisseur a expiré', () => {
    const configs = [config('a', { isActive: true }), config('b'), config('c')];
    const connexions: ConnexionServeur[] = [
      { id: 'b', status: 'active', expiresAt: DEMAIN, providerExpired: true },
      { id: 'c', status: 'active', expiresAt: DEMAIN, providerExpired: false },
    ];
    assert.equal(choisir(configs, { connexions }), 'c');
    // Un serveur plus ancien n'envoie pas le champ : la configuration reste proposable.
    assert.equal(choisir(configs, { connexions: [{ id: 'b', status: 'active' }] }), 'b');
  });

  it('ne repropose jamais une configuration qui vient d’échouer', () => {
    const configs = [config('a', { isActive: true }), config('b'), config('c')];
    assert.equal(choisir(configs, { dejaEssayees: ['a', 'b'] }), 'c');
    assert.equal(choisir(configs, { dejaEssayees: ['a', 'b', 'c'] }), undefined);
  });

  it('quatre configurations du tableau de bord, de sources mixtes : une à la fois, jusqu’à épuisement', () => {
    // Saisie SSH manuelle, lien VLESS importé, forfait d'essai, compte expiré
    // chez le fournisseur : pour l'application, quatre forfaits attribués.
    const ids = ['ssh-saisi', 'vless-lien', 'essai', 'fournisseur-expire'];
    const connexions: ConnexionServeur[] = ids.map((id) => ({
      id, status: 'active', expiresAt: DEMAIN, providerExpired: id === 'fournisseur-expire',
    }));
    assert.deepEqual(parcourir(ids, connexions), ['ssh-saisi', 'vless-lien', 'essai'],
      'chaque configuration utilisable est essayée une fois ; le compte fournisseur expiré jamais');
  });

  it('une configuration manuelle de l’appareil, sans forfait serveur, reste une issue parmi celles du tableau de bord', () => {
    // Le serveur ne connaît pas `manuelle` : seules comptent sa date et son
    // état locaux. Les trois autres viennent du tableau de bord.
    const ids = ['forfait-a', 'manuelle', 'forfait-b', 'fournisseur-expire'];
    const connexions: ConnexionServeur[] = ids.filter((id) => id !== 'manuelle').map((id) => ({
      id, status: 'active', expiresAt: DEMAIN, providerExpired: id === 'fournisseur-expire',
    }));
    const manuelle: Partial<Config> = { source: 'manual' };
    assert.deepEqual(parcourir(ids, connexions, { manuelle }), ['forfait-a', 'manuelle', 'forfait-b']);
    // Échue localement, la manuelle est écartée comme les autres.
    assert.deepEqual(parcourir(ids, connexions, { manuelle: { ...manuelle, expiryDate: HIER } }), ['forfait-a', 'forfait-b']);
  });

  it('la configuration manuelle proposée reste manuelle et sans forfait', () => {
    // Le rapporteur de consommation en déduit une imputation « non liée ». Le
    // secours ne doit ni la réécrire ni lui prêter le forfait de la
    // configuration qui vient d'échouer.
    const echouee = config('forfait-a', { isActive: true, source: 'backend', subscriptionId: 'forfait-a' });
    const manuelle = config('manuelle', { source: 'manual' });
    const choisie = choisirConfigDeSecours([echouee, manuelle], {
      connexions: [{ id: 'forfait-a', status: 'active', expiresAt: DEMAIN }],
      dejaEssayees: ['forfait-a'],
      maintenant: MAINTENANT,
    });
    assert.equal(choisie, manuelle, 'la même configuration, pas une copie retouchée');
    assert.equal(choisie?.source, 'manual');
    assert.equal('subscriptionId' in (choisie ?? {}), false, 'aucun forfait prêté');
  });
});

/**
 * Essaie les configurations comme l'utilisateur qui appuie sur « Essayer
 * maintenant » après chaque échec : renvoie l'ordre des configurations
 * activées, une seule à la fois.
 */
function parcourir(
  ids: string[],
  connexions: ConnexionServeur[],
  surcharges: Record<string, Partial<Config>> = {},
): string[] {
  const echouees: string[] = [];
  let active = ids[0];
  const parcours: string[] = [active];
  for (;;) {
    echouees.push(active);
    const configs = ids.map((id) => config(id, { isActive: id === active, ...surcharges[id] }));
    const suivante = choisir(configs, { connexions, dejaEssayees: echouees });
    if (!suivante) return parcours;
    active = suivante;
    parcours.push(active);
  }
}

describe('le secours n’emprunte aucun forfait', () => {
  it('le choix ne manipule que des identifiants de configuration', () => {
    // L'imputation de la consommation appartient au contexte VPN : la
    // configuration choisie connecte avec SON forfait, ou sans forfait si elle
    // n'en a pas. Jamais avec celui de la configuration qui vient d'échouer.
    assert.doesNotMatch(SECOURS, /subscriptionId|ledger|usage|reportMode|attribution|unlinked/i);
  });

  it('le geste de l’accueil passe par la bascule et la connexion habituelles', () => {
    const debut = ACCUEIL.indexOf('const essayerConfigDeSecours = useCallback(');
    const corps = ACCUEIL.slice(debut, ACCUEIL.indexOf('}, [switchConfig]);', debut));
    assert.doesNotMatch(corps, /subscriptionId|ledger|flushUsage/);
    // Le mode de rapport (« non lié » pour une manuelle) se déduit dans le
    // rapporteur de consommation, jamais à l'écran.
    assert.doesNotMatch(ACCUEIL, /reportMode|attribution|unlinked/);
  });
});

describe('un échec se compte une fois par épisode', () => {
  const etape = (echouees: ReadonlyArray<string>, avant: string, apres: string, configId: string | null, connecte = false) =>
    suivreEchecs(echouees, { avant, apres, configId, connecte });

  it('le passage à « error » retient la configuration active', () => {
    assert.deepEqual(etape([], 'connecting', 'error', 'a'), ['a']);
    assert.deepEqual(etape(['a'], 'connecting', 'error', 'b'), ['a', 'b']);
  });

  it('un état resté en erreur, ou un second échec de la même, ne compte pas double', () => {
    const une = ['a'];
    assert.equal(etape(une, 'error', 'error', 'a'), une, 'même liste : rien à redessiner');
    assert.equal(etape(une, 'connecting', 'error', 'a'), une);
    assert.equal(etape(une, 'connecting', 'error', null), une);
    assert.equal(etape(une, 'disconnected', 'connecting', 'a'), une);
  });

  it('une connexion réussie clôt l’épisode', () => {
    assert.deepEqual(etape(['a', 'b'], 'connecting', 'connected', 'c', true), []);
    const vide: string[] = [];
    assert.equal(etape(vide, 'connecting', 'connected', 'c', true), vide);
  });
});

describe('un seul tunnel : on bascule, puis on connecte', () => {
  const etat = (extra: Partial<Parameters<typeof suiteApresBascule>[0]> = {}) => suiteApresBascule({
    cible: 'b', basculeEnCours: false, activeConfigId: 'b', connecte: false, enConnexion: false, ...extra,
  });

  it('rien tant qu’aucune bascule n’est demandée', () => {
    assert.equal(etat({ cible: null }), 'rien');
  });

  it('attend la fin de la bascule', () => {
    assert.equal(etat({ basculeEnCours: true, activeConfigId: 'a' }), 'attendre');
  });

  it('connecte seulement quand la cible est active et que rien ne tourne', () => {
    assert.equal(etat(), 'connecter');
  });

  it('abandonne si la bascule a échoué : l’ancienne configuration n’est pas relancée', () => {
    assert.equal(etat({ activeConfigId: 'a' }), 'abandonner');
  });

  it('abandonne si une connexion est déjà en route ou établie : jamais deux tunnels', () => {
    assert.equal(etat({ enConnexion: true }), 'abandonner');
    assert.equal(etat({ connecte: true }), 'abandonner');
  });
});

describe('l’accueil est câblé sur ces règles', () => {
  it('le secours est choisi avec l’état du serveur et les échecs de l’épisode', () => {
    assert.match(ACCUEIL, /choisirConfigDeSecours\(savedConfigs, \{ connexions: connections, dejaEssayees: configsEnEchec \}\)/);
    assert.match(ACCUEIL, /suivreEchecs\(echouees, \{\s*avant, apres: vpnState, configId: activeConfigId, connecte: isConnected,\s*\}\)/);
    assert.doesNotMatch(ACCUEIL, /const ETATS_BLOQUANTS/, 'une seule définition des états bloquants');
  });

  it('le bandeau paraît après un échec comme après un retrait, et seulement s’il y a où aller', () => {
    assert.match(ACCUEIL, /\(revokedStatus !== 'none' \|\| echecActif\) && configDeSecours &&/);
    assert.match(ACCUEIL, /const echecActif = vpnState === 'error' && !isConnected && !isConnecting/);
    assert.match(ACCUEIL, /!!activeConfigId && configsEnEchec\.includes\(activeConfigId\)/);
    // Un appareil bloqué n'a rien à gagner d'une autre configuration.
    assert.match(ACCUEIL, /&& !blocksDevice\(deviceAccess\)/);
  });

  it('après un échec, le geste bascule puis connecte ; après un retrait, il bascule seulement', () => {
    assert.match(ACCUEIL, /const basculeApresEchec = revokedStatus === 'none' && echecActif;/);
    assert.match(ACCUEIL, /basculeApresEchec\s*\?\s*essayerConfigDeSecours\(configDeSecours\.id\)\s*:\s*switchConfig\(configDeSecours\.id\)/);
    // Pas de second appui pendant une bascule. Après un échec, le bandeau
    // n'existe d'ailleurs que hors connexion (`echecActif`).
    assert.match(ACCUEIL, /switchConfig\(configDeSecours\.id\)\)\}\s*disabled=\{isSwitchingConfig\}/);
  });

  it('la connexion est demandée après la bascule, puis honorée au rendu suivant', () => {
    const debut = ACCUEIL.indexOf('const essayerConfigDeSecours = useCallback(');
    assert.ok(debut > 0, 'essayerConfigDeSecours absent');
    const corps = ACCUEIL.slice(debut, ACCUEIL.indexOf('}, [switchConfig]);', debut));
    const bascule = corps.indexOf('await switchConfig(id);');
    const demande = corps.indexOf('setConnexionApresBascule(id);');
    assert.ok(bascule > 0 && demande > bascule, 'la demande doit suivre la bascule');
    assert.doesNotMatch(corps, /connect\(\)/, 'connect() lirait ici l’ancienne configuration');
    assert.match(corps, /if \(essaiSecoursRef\.current\) return;/, 'un second appui ne relance pas de bascule');
    assert.match(ACCUEIL, /const suite = suiteApresBascule\(\{/);
    assert.match(ACCUEIL, /if \(suite === 'connecter'\) void connect\(\);/);
  });

  it('le bandeau se nomme dans les deux langues', () => {
    for (const langue of ['fr', 'en']) {
      const libelles = readFileSync(path.join(RACINE, `localization/${langue}.ts`), 'utf8');
      assert.match(libelles, /switch_after_failure:/, `switch_after_failure manquant en ${langue}`);
      assert.match(libelles, /switch_try_action:/, `switch_try_action manquant en ${langue}`);
    }
  });
});

describe('les échéances parviennent jusqu’au choix', () => {
  it('l’échéance du registre accompagne chaque configuration résumée', () => {
    assert.match(CONTEXTE, /savedConfigs: +Array<\{[^}]*expiryDate\?: string \| null \}>;/);
    const resumes = CONTEXTE.match(/expiryDate: entry\.expiryDate \?\? null,/g) || [];
    assert.equal(resumes.length, 2, 'rechargement ET suppression doivent porter l’échéance');
  });

  it('le serveur signale le compte fournisseur expiré par un simple booléen', () => {
    assert.match(TYPES, /providerExpired\?: boolean;/);
    assert.match(SERVEUR, /providerExpired: accessDateExpired\(profile\?\.expiresAt, now\),/);
  });
});
