# Patch CI — OPTIONNEL (optimisation)

> **Le build fonctionne sans ce patch.** Le plugin Expo construit `libbox.aar`
> automatiquement pendant le prebuild si l'AAR est absent. Ce patch sert
> uniquement à **mettre le résultat en cache** entre les exécutions CI, ce qui
> économise ~10 min par build.

Le workflow n'a pas pu être modifié directement : l'App GitHub utilisée par
cette session n'a pas la permission `workflows` (push rejeté par GitHub). La
modification a donc été extraite ici.

## Appliquer

```bash
git apply app-mobile/ci-patches/0001-build-android-libbox.patch
git add .github/workflows/build-android.yml
git commit -m "ci(android): construire libbox.aar (moteur sing-box in-process)"
```

## Ce que le patch fait

1. Ajoute `env.SING_BOX_VERSION: v1.11.15`.
2. Ajoute `actions/setup-go@v5` (Go 1.23).
3. Ajoute la construction de `libbox.aar` via `scripts/build-libbox.sh`,
   mise en cache sur la version de sing-box (~10 min au premier build).
4. Remplace l'étape « Copier sing-box vers Android assets natifs » (les
   binaires ont été supprimés : inexécutables sur Android 10+) par une
   vérification de la présence de `android/app/libs/libbox.aar`.
5. Ajoute les règles ProGuard `io.nekohasekai.libbox.**` et `go.**` — sans
   elles, R8 supprime les classes appelées par réflexion depuis Go et le
   moteur plante au démarrage du tunnel.

## Sans le patch

Le build reste fonctionnel : le plugin Expo détecte l'absence de
`libs/libbox.aar` et lance `scripts/build-libbox.sh` pendant le prebuild.
Go et le NDK sont préinstallés sur les runners `ubuntu-latest`. Seul coût :
le moteur est recompilé à chaque exécution (~10 min).

L'étape « Copier sing-box vers Android assets natifs » du workflow actuel
n'échoue pas malgré la suppression des binaires : elle se contente d'un
avertissement.

Voir `app-mobile/VPN_ENGINE_FIX.md` pour le diagnostic complet.
