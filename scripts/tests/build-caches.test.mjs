/**
 * build-caches.test.mjs — Le build ne doit pas refaire ce qu'il a déjà fait.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CE QUI A ÉTÉ MESURÉ
 * ═══════════════════════════════════════════════════════════════════════════
 * Sur le build `5c4a2ad`, 630 secondes au total, dont :
 *
 *     208 s  Build APK (release)
 *     173 s  Expo prebuild (clean)
 *      95 s  Politiques natives sur la JVM
 *
 * La troisième ne compilait presque rien d'utile : elle retéléchargeait le
 * compilateur Kotlin (~80 Mo) et recompilait sing-box avec six étiquettes,
 * à chaque build, parce que `setup-go` avait `cache: false` et que rien ne
 * conservait les outils épinglés.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POURQUOI CES CACHES NE CHANGENT RIEN AU BINAIRE
 * ═══════════════════════════════════════════════════════════════════════════
 * Un cache est dangereux quand il peut faire produire autre chose. Ici :
 *
 *   - Les outils Kotlin et JSON sont figés par VERSION et vérifiés par
 *     EMPREINTE. Un fichier restauré subit le même contrôle qu'un fichier
 *     téléchargé ; un contenu altéré est refusé de la même façon.
 *   - Le cache de Go ne conserve que des résultats de compilation identifiés
 *     par leurs entrées : à entrées identiques, sortie identique.
 *
 * Ces contrôles empêchent qu'on les désactive par inadvertance, et qu'on
 * relâche la vérification d'empreinte qui les rend sûrs.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = readFileSync(path.join(RACINE, '.github/workflows/build-android.yml'), 'utf8');
const SCRIPT = readFileSync(path.join(RACINE, 'scripts/run-android-policy-gates.sh'), 'utf8');

describe('caches du build Android', () => {
  it('le cache de compilation Go est actif', () => {
    // `cache: false` recompilait sing-box entièrement à chaque build.
    assert.ok(
      !/cache:\s*false/.test(WORKFLOW),
      'aucune étape ne doit désactiver son cache',
    );
    assert.match(WORKFLOW, /cache-dependency-path:\s*scripts\/tests\/singbox-engine-check\/go\.mod/);
  });

  it('les outils épinglés sont conservés entre deux builds', () => {
    assert.match(WORKFLOW, /Cache des outils épinglés/);
    assert.match(WORKFLOW, /SXB_OUTILS_CACHE:/);
    // La clé nomme les versions : changer l'une d'elles invalide le cache.
    assert.match(WORKFLOW, /key:\s*sxb-outils-kotlin2\.1\.20-json20240303/);
  });
});

describe('ce qui rend ces caches sûrs', () => {
  it('le script vérifie l’empreinte AVANT de réutiliser un fichier', () => {
    assert.match(SCRIPT, /empreinte_ok\(\)/);
    assert.match(SCRIPT, /sha256sum --check --status/);
    // Un fichier tronqué par un build interrompu doit être retéléchargé.
    assert.match(SCRIPT, /if empreinte_ok "\$KOTLIN_ZIP" "\$KOTLIN_SHA"; then/);
    assert.match(SCRIPT, /if empreinte_ok "\$JSON_JAR" "\$JSON_SHA"; then/);
  });

  it('un téléchargement neuf reste vérifié strictement', () => {
    const strictes = SCRIPT.match(/sha256sum --check --strict/g) || [];
    assert.equal(strictes.length, 2, 'les deux téléchargements doivent rester vérifiés');
  });

  it('les versions et empreintes restent épinglées', () => {
    assert.match(SCRIPT, /kotlin-compiler-2\.1\.20\.zip/);
    assert.match(SCRIPT, /KOTLIN_SHA="a118197b0de55ffab2bc8d5cd03a5e39033cfb53383d6931bc761dec0784891a"/);
    assert.match(SCRIPT, /JSON_SHA="3cf6cd6892e32e2b4c1c39e0f52f5248a2f5b37646fdfbb79a66b46b618414ed"/);
  });

  it('sans cache désigné, le comportement d’origine est conservé', () => {
    // Hors intégration continue, le script doit continuer de télécharger dans
    // un dossier temporaire effacé à la sortie.
    assert.match(SCRIPT, /CACHE="\$\{SXB_OUTILS_CACHE:-\$HARNESS\}"/);
    assert.match(SCRIPT, /trap 'rm -rf "\$HARNESS"' EXIT/);
  });
});
