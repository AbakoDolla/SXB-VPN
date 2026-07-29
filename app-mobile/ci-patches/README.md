# Patch CI — à appliquer manuellement

Le workflow `.github/workflows/build-android.yml` doit être mis à jour pour
construire le moteur VPN (`libbox.aar`), mais l'App GitHub utilisée par cette
session n'a pas la permission `workflows` : la modification a donc été extraite
ici au lieu d'être poussée.

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

**Sans ce patch, le build Android échouera** : `libbox.aar` ne sera pas généré
et le plugin Expo avertira `libs/libbox.aar introuvable`.

Voir `app-mobile/VPN_ENGINE_FIX.md` pour le diagnostic complet.
