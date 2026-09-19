# Activer les notifications poussées (Firebase)

## Ce qui marche déjà, et ce qui manque

Le code est **entièrement en place** des deux côtés. Mesuré en production :

| Moitié | État | Symptôme |
| --- | --- | --- |
| Serveur | `FCM_NOT_CONFIGURED` | aucun envoi possible |
| Appareils | 0 jeton sur 38 | personne à qui envoyer |

Il ne manque que des **valeurs**, jamais du code. Le déploiement transmet déjà
les variables au serveur, et le build les injecte déjà dans l'APK.

## Ce que ça change concrètement

**Sans Firebase** — une annonce n'apparaît que lorsque l'utilisateur **ouvre**
l'application. C'est le fonctionnement actuel, et il est honnête : le tableau
de bord le dit désormais après chaque publication.

**Avec Firebase** — le bandeau s'affiche sur l'écran du téléphone
immédiatement, **application fermée**.

## La marche à suivre

### 1. Créer le projet Firebase

Sur <https://console.firebase.google.com> : créer un projet, puis y **ajouter
une application Android** avec le nom de paquet exact de l'application.

Le nom de paquet se lit dans `app-mobile/app.json`, champ `expo.android.package`.

### 2. Renseigner le SERVEUR — 1 secret GitHub

Dans le projet Firebase : **Paramètres → Comptes de service → Générer une
nouvelle clé privée**. Un fichier JSON est téléchargé.

Dans le dépôt GitHub, **Settings → Secrets and variables → Actions → Secrets** :

| Secret | Valeur |
| --- | --- |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | le **contenu entier** du fichier JSON |

> Ce fichier est un secret : il autorise l'envoi au nom du projet. Ne jamais le
> committer, ne jamais le coller dans une conversation.

*(Variante, si l'on préfère trois champs séparés : `FIREBASE_PROJECT_ID`,
`FIREBASE_CLIENT_EMAIL` et `FIREBASE_PRIVATE_KEY`. Le serveur accepte les deux
formes, mais exige les trois ensemble.)*

### 3. Renseigner l'APPLICATION — 4 variables GitHub

Dans Firebase : **Paramètres → Vos applications → l'application Android**.
Les quatre valeurs y figurent.

Dans **Settings → Secrets and variables → Actions → Variables** :

| Variable | Où la lire dans Firebase |
| --- | --- |
| `EXPO_PUBLIC_FIREBASE_API_KEY` | Clé d'API Web |
| `EXPO_PUBLIC_FIREBASE_PROJECT_ID` | ID du projet |
| `EXPO_PUBLIC_FIREBASE_APP_ID` | ID de l'application |
| `EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | Numéro de l'expéditeur |

Ces quatre-là ne sont **pas** des secrets : elles voyagent déjà dans l'APK, que
n'importe qui peut ouvrir. Les mettre en « Variables » plutôt qu'en « Secrets »
les rend relisibles, ce qui évite de les ressaisir à l'aveugle.

### 4. Reconstruire

Les valeurs n'entrent dans l'APK et sur le serveur qu'au prochain passage :

- **Build Android APK** → régénère l'APK avec la configuration Firebase
- **Deploy to VPS** → transmet le secret au serveur

Les deux se relancent depuis l'onglet **Actions**.

## Vérifier que ça marche

Publier une annonce depuis le tableau de bord. Après la correction, il répond
lui-même :

- « **Envoyée sur N appareil(s).** » — tout fonctionne.
- « **Publiée, mais pas envoyée sur les téléphones** » — il reste une moitié à
  renseigner.

Le second cas distingue les deux pannes :

- motif `FCM_NOT_CONFIGURED` → le **serveur** n'a pas le secret (étape 2).
- envoi accepté mais **0 destinataire** → les **APK** n'ont pas la configuration
  (étape 3), ou aucun appareil n'a encore rouvert l'application depuis la mise
  à jour.

> Un appareil n'enregistre son jeton qu'au premier lancement d'un APK
> configuré. Le compte de destinataires monte donc progressivement, à mesure
> que le parc se met à jour — un zéro le premier jour n'est pas un échec.

## Pourquoi le tableau de bord le dit maintenant

Le serveur renvoyait déjà ce compte rendu à chaque publication ; le tableau de
bord le **jetait**. On publiait, aucune erreur ne s'affichait, et on en
concluait que l'annonce était arrivée sur tous les téléphones. Elle n'avait
atteint personne, depuis toujours.

Un envoi qui échoue en silence est pire qu'un envoi qui refuse : on continue de
s'en servir en croyant qu'il porte.
