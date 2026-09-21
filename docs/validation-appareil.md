# Validation sur appareil réel — grille de relevé (§17.5)

> **Ce document ne prouve rien à lui seul.** Il sert à mener la validation que
> personne n'a encore pu mener : aucun tunnel réel n'a été établi pour ce
> moteur — ni appareil, ni SDK Android, ni serveur de test n'étaient
> disponibles. La suite de tests passe, et ce vert ne dit rien du comportement
> sur un téléphone. Voir §17.4 du rapport d'audit.

---

## 1. Pourquoi une grille plutôt qu'un simple « vérifier que ça marche »

La procédure §17.5 demandait de regarder un écran et de juger. Un œil humain
qui voit « Connecté » ne peut pas dire si l'application **avait le droit** de
l'afficher : c'est justement ce que cette mission corrigeait. L'écran est
convaincant, et c'est le problème.

La grille confronte donc deux sources indépendantes :

| Source | Ce qu'elle établit |
|---|---|
| La trace du service natif, capturée par `adb logcat` | Ce que le moteur a **réellement fait** |
| Ce que vous avez vu à l'écran, déclaré ci-dessous | Ce que l'application a **annoncé** |

**C'est leur désaccord qui est intéressant.** Une application qui affiche
« Connecté » alors que le service n'a émis aucune preuve d'acheminement, c'est
le faux `connected` revenu. Sans confrontation, il est invisible.

### Ce que le journal ne peut pas prouver

Le journal établit qu'un **mécanisme** a été appliqué. Jamais son **effet sur
le réseau**. « Kill Switch actif — trafic bloqué » prouve que l'interface de
blocage a été posée ; cela ne prouve pas qu'aucun octet ne sort.

Ces critères-là sont marqués `À MESURER HORS JOURNAL` : ils exigent une mesure
faite hors de l'application (navigateur, `ping`) et **ne passent jamais au vert
tout seuls**.

### Trois verdicts

| Verdict | Sens |
|---|---|
| `ÉTABLI` | La preuve attendue est présente. |
| `CONTREDIT` | La capture dit le contraire de ce qui est attendu. |
| `NON OBSERVÉ` | La preuve manque. **Ce n'est pas une réussite** — c'est l'aveu qu'on ne sait pas. |

---

## 2. Avant de commencer

**Sur un appareil de test, jamais sur des données de production.**

| Prérequis | Vérification |
|---|---|
| Outils de plateforme Android (`adb`) | `adb version` |
| Débogage USB autorisé sur le téléphone | `adb devices` → une seule ligne `device` |
| Une APK construite | `app-mobile/build/sxb-vpn.apk`, ou `--apk <chemin>` |
| Go ≥ 1.23 et NDK, **si** `libbox.aar` doit être reconstruit | `npx expo prebuild --platform android` (~10 min) |

### Les profils de test — à fournir par vous

**Aucun serveur de test n'est fourni dans ce dépôt, et c'est délibéré.** Livrer
des profils tout faits reviendrait à inventer des serveurs qui n'existent pas :
la validation semblerait menée alors qu'elle ne le serait pas.

Préparez donc, depuis vos propres serveurs :

| # | Profil | À quoi il sert |
|---|---|---|
| A | SSH avec des identifiants **valides** | Points 4, 5, 6, 7, 8 |
| B | SSH sur le **même hôte**, identifiants **faux** | Point 5b — le cas le plus parlant |
| C | VLESS ou VMess valide | Rejouer les points 4 et 5 sur l'autre moteur |

Le profil B doit viser un serveur **joignable**. Un hôte injoignable échouerait
plus tôt, et ne testerait pas ce qui nous intéresse : l'application annonce-t-elle
une réussite quand le transport monte mais que la session ne s'ouvre pas ?

---

## 3. Dérouler un point

Trois commandes, depuis `app-mobile/` :

```bash
# une fois, au début
node scripts/valider-sur-appareil.mjs preparer

# avant chaque scénario — laisser tourner, Ctrl-C à la fin
node scripts/valider-sur-appareil.mjs capturer --sortie point4.log

# après le scénario
node scripts/valider-sur-appareil.mjs analyser --capture point4.log --point 4 --tunnel-affiche oui
```

Le code de sortie vaut `0` seulement si **tous** les critères sont `ÉTABLI`.

---

## 4. Les points, un par un

### Point 4 — « Tunnel établi » apparaît

C'est la trace qui était muette. Connecter le profil A, ouvrir le journal.

```bash
node scripts/valider-sur-appareil.mjs analyser --capture point4.log --point 4 \
  --tunnel-affiche <oui|non>
```

### Point 5 — aucun « connected » avant un octet reçu

Connecter le profil A. Déclarer ce que l'écran a affiché.

```bash
node scripts/valider-sur-appareil.mjs analyser --capture point5.log --point 5 \
  --affiche-connecte <oui|non>
```

> Si l'analyse rend `CONTREDIT` avec la mention *régression du faux connected*,
> **arrêtez-vous et signalez-le** : l'application annonce une réussite que le
> moteur n'a pas prouvée.

### Point 5b — identifiants faux : échec, jamais réussite

Connecter le profil B. L'application doit signaler un échec.

```bash
node scripts/valider-sur-appareil.mjs analyser --capture point5b.log --point 5b \
  --affiche-connecte <oui|non>
```

### Point 6 — réseau coupé en session → `TUNNEL_STALLED`

Connecter le profil A, attendre l'état connecté, puis couper le réseau de
l'appareil (mode avion). Attendre l'échéance.

```bash
node scripts/valider-sur-appareil.mjs analyser --capture point6.log --point 6 \
  --etat-quitte <oui|non>
```

### Point 7 — Kill Switch activé en session → aucun trafic

Connecter le profil A. **Pendant la session**, activer le Kill Switch. Couper le
VPN. Puis, **hors de l'application**, tenter d'ouvrir une page web.

```bash
node scripts/valider-sur-appareil.mjs analyser --capture point7.log --point 7 \
  --trafic-passe <oui|non>
```

> `--trafic-passe oui` rend `CONTREDIT` : l'application afficherait une garantie
> de sécurité qu'elle n'applique pas. C'est exactement le défaut corrigé (§13.3).

### Point 8 — Kill Switch désactivé → l'internet revient

Depuis l'état bloqué du point 7, désactiver le Kill Switch. Retenter une page web.

```bash
node scripts/valider-sur-appareil.mjs analyser --capture point8.log --point 8 \
  --internet-revenu <oui|non>
```

### Point 9 — le journal partagé ne laisse rien fuir

Filtrer le journal sur « Problèmes », partager, coller le texte dans un fichier.

```bash
node scripts/valider-sur-appareil.mjs analyser --capture partage.txt --point 9 \
  --relecture-ok <oui|non>
```

L'analyse cherche des **formes** — adresse IPv4, nom d'hôte, identifiants dans
une URL, clé privée, jeton long — et non des valeurs connues : vous n'avez donc
pas à écrire l'adresse de votre serveur dans une ligne de commande.

---

## 5. Grille à remplir

| Point | Scénario | Capture | Verdict rendu | Écart observé, le cas échéant |
|---|---|---|---|---|
| 4 | « Tunnel établi » apparaît | `point4.log` | | |
| 5 | Pas de `connected` sans preuve (profil A) | `point5.log` | | |
| 5 | Idem sur profil C (VLESS/VMess) | `point5c.log` | | |
| 5b | Identifiants faux → échec (profil B) | `point5b.log` | | |
| 6 | Réseau coupé → `TUNNEL_STALLED` | `point6.log` | | |
| 7 | Kill Switch actif → aucun trafic | `point7.log` | | |
| 8 | Kill Switch levé → internet revenu | `point8.log` | | |
| 9 | Journal partagé sans fuite | `partage.txt` | | |

**Appareil :** ………………  **Android :** ………  **Version de l'APK :** ………
**Date :** ………………  **Opérateur :** ………………

---

## 6. Ce qu'il faut renvoyer

1. La grille ci-dessus remplie.
2. Les fichiers de capture — ils sont déjà expurgés par le service avant
   d'atteindre `logcat` (`SecurityModule.maskSensitive`), mais **relisez-les**
   avant de les transmettre.
3. Pour tout verdict `CONTREDIT`, la ligne de preuve citée par l'analyse.

Un point resté `NON OBSERVÉ` n'est pas un échec de la livraison : c'est un point
qui n'a pas été mesuré, et qui doit le rester tant qu'il ne l'a pas été.
