# SXB VPN

Plateforme VPN complète : une application Android à moteur `sing-box` embarqué,
un tableau de bord d'administration multi-rôles avec réseau de revendeurs, et
une API de provisionnement.

**Production :** <https://vpnsxb.afrihall.com>

---

## Ce que fait la plateforme

Un administrateur importe une configuration VPN **une seule fois**. Il la
distribue ensuite à des revendeurs, qui la vendent à leurs propres clients sous
forme de forfaits data. Chaque client active l'application mobile avec un jeton,
consomme son quota, et voit son forfait expirer automatiquement à l'échéance.

Les paramètres techniques ne sont pas affichés aux revendeurs ni aux clients.
L'application reçoit les paramètres nécessaires par le provisionnement chiffré,
uniquement pour l'appareil et le forfait autorisés.

```mermaid
flowchart LR
    A[Administrateur] -->|importe une config| B[(Configuration VPN)]
    A -->|attribue| C[Revendeur]
    B -.->|nom commercial seul| C
    C -->|crée un forfait| D[Client]
    D -->|jeton d'activation| E[Application Android]
    E -->|moteur sing-box| F((Internet))
    E -->|trafic consommé| G[API]
    G --> A
```

---

## Organisation du dépôt

Monorepo **pnpm**. Les paquets sont déclarés dans `pnpm-workspace.yaml`.

| Chemin | Rôle |
| --- | --- |
| `app-mobile/` | Application Android — Expo / React Native 0.81, moteur natif Kotlin |
| `artifacts/sxb-dashboard/` | Tableau de bord d'administration — React 19, Vite, Tailwind |
| `server/` | API Express — routes, middlewares RBAC, services |
| `prisma/` | Schéma PostgreSQL et scripts d'amorçage |
| `backend/prisma/` | **Copie déployée** du schéma — doit rester identique à `prisma/` |
| `lib/` | Bibliothèques partagées (`db`, `api-zod`, `api-client-react`) |
| `.github/workflows/` | Construction Android, déploiement VPS, audit |

> **Attention :** le déploiement pousse `backend/prisma/schema.prisma`, **pas**
> celui de la racine. Une modification faite uniquement à la racine n'atteint
> jamais la base. Un test de régression vérifie que les deux fichiers sont
> identiques.

---

## Application mobile

Le moteur `sing-box` est compilé en bibliothèque native (`libbox.aar`) et
s'exécute **dans le processus de l'application** — il n'y a pas de binaire
externe. Le script `app-mobile/scripts/build-libbox.sh` produit cette
bibliothèque.

**Protocoles pris en charge :** VLESS, VMess, Trojan, Shadowsocks, WireGuard,
Hysteria2, TUIC, et SSH (avec payload).

Points notables du moteur :

- **Résolution DNS d'amorçage** — joindre le serveur exige de résoudre son nom,
  ce qui exigerait le tunnel. Les résolveurs du réseau sont lus via
  `ConnectivityManager` : `address: "local"` échoue sous Android, faute de
  `/etc/resolv.conf`.
- **Empreinte uTLS** — sans elle, le ClientHello émis est celui de Go,
  reconnaissable par les inspections de paquets opérateur.
- **Configurations chiffrées** — la charge est chiffrée en AES avant stockage, la
  clé maître vivant dans le Keystore Android.
- **Compteur de session** — détenu par le service natif, il survit à la mise en
  arrière-plan de l'application.

Les réponses d'activation mobile n'ont pas besoin de contenir une adresse e-mail.
L'identité et le nom renvoyés par l'API suffisent ; un échec local de finalisation
ou une réponse invalide ne doit pas être présenté comme une panne réseau.

Les imports Xray compatibles conservent les tags, routes, plages de ports,
options WebSocket/TLS et références aux proxys HTTP. Les références inconnues
ou ambiguës sont refusées, plutôt que remplacées par une route inventée. Définir
plusieurs proxys dans le fichier ne les active pas tous : les routes et `detour`
déterminent lesquels sont effectivement utilisés. Aucun débit ou basculement
automatique n'est garanti par le seul import.

La base de domaines SagerNet/v2fly `20260908094002` est embarquée pour les règles
`geosite`, avec empreinte vérifiée et notice de licence dans
`app-mobile/assets/engine/`. Le démarrage ne dépend pas d'un téléchargement
de cette base. Les gates Android exécutent le vrai générateur Kotlin et le
constructeur libbox `1.11.15` sur un graphe fictif équivalent, sans connexion VPN.
Une configuration fournisseur avec `allowInsecure: true` reste explicitement
non admissible au canal Play ; l'import ne contourne pas cette protection.

### Activation de l'appareil et droits des configurations

L'activation de l'application et les droits de chaque configuration sont deux
niveaux distincts. Une erreur sur un forfait ne justifie pas de supprimer la
session de l'appareil, ses autres profils ou son identité persistante.

| Action du dashboard | Effet attendu dans le mobile |
| --- | --- |
| Révoquer ou supprimer une configuration attribuée | Retirer uniquement le fichier concerné, avec un message ciblé. Arrêter le VPN s'il utilise ce fichier ; conserver l'activation et les autres fichiers. |
| Suspendre une configuration | Conserver le fichier mais bloquer son utilisation temporairement. Ne pas suspendre l'appareil ou un autre tunnel. |
| Prolonger un forfait ou ajouter du quota | Actualiser ses métadonnées sans effacer la consommation, la session ou le code d'activation de l'appareil. |
| Suspendre ou désactiver un appareil | Arrêter son VPN dès réception du changement et afficher le blocage correspondant, sans effacer les configurations ni exiger une nouvelle activation d'un appareil déjà lié. |
| Reprendre un appareil | Lever le blocage si sa durée d'accès reste valide, sans modifier le code ou l'échéance. Ne pas reconnecter automatiquement un VPN. |
| Renouveler un appareil | Prolonger sa propre échéance, générer un nouveau code `SXB-USER` visible dans le dashboard et conserver sa liaison et ses sessions existantes. Ne pas modifier les forfaits associés. |

Les configurations locales indépendantes ne sont pas des fichiers orphelins du
dashboard. Seule une réponse distante complète et authentifiée permet de
réconcilier les configurations gérées par le serveur. Un échec réseau, une
limitation `429` ou un `403`/`404` sans motif de session explicite ne constitue
pas une preuve de révocation de l'application.

Les changements sont suivis par une attente HTTP bornée sur
`/api/mobile/access-state`, avec une révision du contenu et une reprise après
interruption. Pendant un VPN Android actif, un observateur natif maintient ce
suivi même si le JavaScript est en arrière-plan. Son ticket est lié à l'appareil,
limité à la lecture des droits et ne permet ni provisionnement ni accès au
dashboard. Ce contrôle nécessaire au VPN ne dépend pas du consentement aux
notifications FCM ; le consentement VPN Play reste requis.

**Limite réseau :** aucun serveur ne peut transmettre une nouvelle révocation
à un appareil entièrement hors ligne. Un blocage déjà reçu est conservé et
la reconnexion au serveur réconcilie les droits. La déconnexion est déclenchée
à réception du changement, pas à partir d'une promesse de délai hors ligne.
Le ticket de contrôle expire au plus tard après sept jours : son expiration
ne supprime ni l'identité ni les fichiers, et l'ouverture de l'application
renouvelle le suivi authentifié. Si l'application reste exclusivement en
arrière-plan au-delà de cette échéance, le tunnel conserve ses derniers droits
connus sans surveillance distante jusqu'au retour au premier plan.

---

## Tableau de bord et rôles

| Rôle | Portée |
| --- | --- |
| `OWNER` | Administration racine. Contourne les permissions RBAC, mais pas le verrou par mot de passe des configurations ; peut mettre le service en pause. |
| `SUPER_ADMIN` | Administration complète de la plateforme. |
| `ADMIN` | Gestion courante : clients, forfaits, configurations, serveurs. |
| `SUPPORT` | Consultation et assistance. |
| `RESELLER` | **Strictement cloisonné** : ses clients, ses forfaits, son quota, sa propre activité. |

Le revendeur ne voit que les configurations que l'administrateur lui a
explicitement attribuées, et sous leur seul nom commercial. La restriction est
appliquée par l'API, pas seulement par l'affichage : un appel direct avec une
configuration non attribuée reçoit un `403`.

### Remise à zéro des données applicatives

La zone de réinitialisation des paramètres est réservée au **propriétaire
`OWNER`**, y compris côté API. Un administrateur ou super-administrateur ne
peut pas lancer cette opération. Un aperçu des données concernées précède
la confirmation exacte **`RESET SXB VPN`** et la saisie du mot de passe courant
du propriétaire.

La remise à zéro supprime les comptes non administratifs, les revendeurs,
les licences/appareils et activations, les forfaits, jetons et vouchers,
les configurations VPN et comptes techniques du dashboard, les tickets de
support, les enregistrements push, les diagnostics et données de trafic.
Les licences VPN rattachées à un administrateur sont également retirées,
mais son compte de connexion est conservé.

**Restent conservés :** les utilisateurs `OWNER`, `ADMIN` et `SUPER_ADMIN`
(identifiants, mots de passe et accès), les rôles et permissions, les serveurs
et paramètres d'infrastructure, la publication APK, les journaux d'audit et
le grand livre immuable des quotas. Les références d'audit vers un utilisateur
supprimé deviennent nulles selon la clé étrangère existante ; les événements
eux-mêmes restent conservés. Aucun fichier du projet, clé de signature,
certificat TLS ou compte SSH du système n'est supprimé.

Une sauvegarde PostgreSQL privée est obligatoire **avant** les suppressions.
Un échec de sauvegarde interdit l'effacement. Les suppressions sont
transactionnelles, avec verrouillage des écritures concurrentes, et le mode
maintenance précédent est restauré après l'opération. Un rejeu du même
challenge récupère le reçu existant au lieu d'effacer de nouvelles données.
La restauration d'une sauvegarde reste une opération d'exploitation manuelle,
à essayer d'abord sur une base isolée ; elle n'est jamais déclenchée
automatiquement par le dashboard.

Cette remise à zéro complète est une exception destructive explicite :
elle retire aussi les configurations protégées, sans en révéler les secrets.
Elle ne donne **aucun** déverrouillage réutilisable. Les suppressions
sélectives, individuelles ou multiples, continuent à respecter les permissions,
les liens aux forfaits et les mots de passe de configuration, même pour `OWNER`.
La sélection de suppression porte sur les éléments filtrés ; ses limites et
les éventuels échecs sont affichés, sans annoncer la suppression d'un élément
que l'API a refusé.

Le workflow manuel `production-reset.yml` utilise le même endpoint protégé,
avec les identifiants `OWNER` du coffre existant. Son mode par défaut,
`inventory`, ne supprime rien. Il refuse une version déployée différente de
celle attendue et ne téléverse aucune sauvegarde de production vers GitHub.
La vérification `verify-production-reset.yml` utilise exclusivement une base
PostgreSQL jetable et des données fictives.

**Espace disque :** supprimer des lignes peut rendre les pages PostgreSQL
réutilisables sans réduire immédiatement la taille des fichiers sur le VPS.
Les sauvegardes conservées occupent aussi de l'espace. Cette opération ne
promet donc pas de libérer plusieurs gigaoctets et ne nettoie pas le code,
les dépendances ou les fichiers du projet.

### Verrouillage des configurations

À la création ou à l'import, un mot de passe de protection **distinct des
identifiants du tunnel VPN** est demandé. La configuration est verrouillée dès
son enregistrement, y compris pour son créateur. Son nom commercial reste
disponible afin de pouvoir l'attribuer, mais ses paramètres techniques et ses
modifications exigent un déverrouillage.

Le verrou s'ajoute aux permissions existantes : connaître le mot de passe ne
donne ni un nouveau rôle ni l'accès aux clients d'un autre revendeur. Aucun
rôle, même `OWNER` ou `SUPER_ADMIN`, ne dispense du déverrouillage. Celui-ci
est temporaire et lié au compte connecté et à la configuration concernée.
Changer le mot de passe invalide les autorisations de déverrouillage précédentes.

Le mot de passe est conservé sous forme de **hash**, jamais en clair. La preuve
temporaire de déverrouillage ne doit être placée ni dans une URL, ni dans les
journaux, ni dans le stockage persistant du navigateur.

L'attribution d'un profil à un client ou à un appareil, puis son provisionnement
dans le mobile, **ne nécessitent pas de déverrouillage**. Les permissions,
la propriété du client, la validité du forfait et les contrôles de quota
continuent de s'appliquer.

Les configurations historiques restent compatibles : la migration ne leur
invente aucun mot de passe et ne coupe pas les appareils déjà provisionnés.
Leur protection peut être activée explicitement depuis le tableau de bord.
Les comptes SSH, Xray et Sing-box liés à un profil doivent respecter le même
verrou ; ils ne constituent pas un accès de remplacement à ses secrets.

### Langues du tableau de bord

Le sélecteur **Français / English** change la langue des écrans, formulaires,
confirmations, états et messages applicatifs. La préférence est conservée dans
le navigateur sous `sxb_vpn_lang`. La langue choisie s'applique aussi aux dates,
nombres et volumes affichés.

Les données saisies par les utilisateurs — noms de clients, noms de profils,
annonces, descriptions, paramètres VPN — ne sont pas traduites ou réécrites.
Les événements historiques des journaux conservent leur contenu d'origine.
Les nouvelles chaînes applicatives doivent avoir une clé dans les deux
dictionnaires, avec les mêmes paramètres d'interpolation `{{parametre}}`.

---

## Développement

Prérequis : **Node 22+**, **pnpm**, PostgreSQL.

```bash
pnpm install          # pnpm est obligatoire (un garde-fou refuse npm et yarn)
pnpm run typecheck    # bibliothèques + artifacts
pnpm run build        # typecheck puis construction de chaque paquet
```

Tableau de bord :

```bash
cd artifacts/sxb-dashboard
pnpm run build        # sortie dans dist/public
```

Application mobile :

```bash
cd app-mobile
npx tsc --noEmit                                   # typecheck
npx tsx --test tests/regression-critical-flows.test.ts   # garde-fous
```

Les tests de régression combinent des assertions sur le code source, des tests
de services et des appels aux véritables routes Express avec une base isolée.
Ils couvrent notamment la parité des schémas Prisma, le cloisonnement des rôles,
les mutations concurrentes et les parcours du dashboard. Les tests de langue
contrôlent les clés et interpolations FR/EN ainsi que les formats affichés.
Ne pas remplacer un test de comportement par la seule présence d'une chaîne
dans le code, ni exécuter les scénarios de mutation sur la base de production.

---

## Déploiement

Workflows GitHub Actions :

| Workflow | Déclencheur | Effet |
| --- | --- | --- |
| `deploy-vps.yml` | push sur `main` (chemins surveillés) | Construit puis déploie l'API et le tableau de bord |
| `build-android.yml` | push sur `main` | Construit l'APK signé et publie une release |
| `build-google-play.yml` | manuel | Construit un candidat AAB signé, sans publication sur Google Play |
| `vps-audit.yml` | manuel | Contrôle l'état du serveur |

Le déploiement ne se déclenche que sur certains chemins : un changement dans
`pnpm-workspace.yaml` ou dans les tests demande un lancement manuel
(`gh workflow run deploy-vps.yml --ref main`).

Le numéro de publication de l'APK est **distinct** du `versionCode` Android : ce
dernier doit rester strictement croissant, sans quoi Android refuse d'installer
la mise à jour sur les appareils déjà équipés. Les canaux direct et Google Play
utilisent la même horloge UTC de versionnement et le même groupe de construction
sérialisée. Le code exact figure dans les rapports de release ; ne pas utiliser
le numéro `apk-*` à sa place dans le dashboard.

Un lancement manuel de `build-android.yml` avec `distribution=direct` sur une
branche autre que `main` produit seulement l'APK signée et ses rapports :
il ne crée pas de release publique, ne remplace pas l'APK du VPS et ne purge
pas les anciennes publications. Le candidat conserve le certificat de l'APK
publique actuelle. Les mentions d'auteur visibles `AbakoDollar$` ne changent
ni cette clé cryptographique ni l'identifiant Android.

### Préparation Google Play

Le canal **direct** reste la valeur par défaut. Le canal **play** est choisi à la
construction avec `EXPO_PUBLIC_DISTRIBUTION=play`, sans changement du package
`com.sxbvpn.mobile`. Il ne doit pas installer de mises à jour APK externes.

Le workflow manuel `build-google-play.yml` produit un **candidat AAB signé** et
un rapport de validation ; il ne publie rien sur Google Play. Le paramètre
`previous_play_version_code` correspond au plus grand code déjà envoyé à Play.
Une valeur `0` avec `play_history_verified=false` permet de construire un candidat
quand cet historique est encore inconnu ; elle ne déclare pas qu'une première
publication a été confirmée. L'éditeur doit vérifier l'historique avant tout
envoi à Google. La signature,
l'identité du package, l'API cible 36, les permissions et l'alignement des
bibliothèques natives sont contrôlés avant de fournir le candidat.

Pour valider une branche avant toute mise en production, le workflow existant
`build-android.yml` accepte aussi un déclenchement manuel avec
`distribution=play` : il appelle le workflow AAB sans lancer son job de
publication APK. Garder `play_history_verified=false` tant que le propriétaire
du compte Play Console n'a pas confirmé l'historique.

Le dossier [`store/google-play/`](store/google-play/) contient les textes FR/EN,
les visuels de marque, les déclarations préparatoires et les opérations à
effectuer dans Play Console. Sa validation simple vérifie les fichiers ; son
mode `--submission` doit aussi valider les confirmations de l'éditeur. Un
dossier techniquement correct n'est **pas** une publication approuvée.

Avant toute soumission, l'éditeur doit notamment confirmer son compte développeur
et son identité, l'historique de signature/version, les pratiques de traitement
des données, les coordonnées publiques et les informations d'accès pour l'équipe
de vérification. Les captures et vidéos doivent montrer la véritable application,
pas une connexion VPN simulée. Google reste responsable de l'examen et de
l'acceptation de la publication.

Les ressources publiques prévues sont :

- `https://vpnsxb.afrihall.com/api/public/privacy`
- `https://vpnsxb.afrihall.com/api/public/data-deletion`

Elles passent par le proxy API existant, restent accessibles sans session et
pendant une maintenance. Le formulaire crée une demande privée pour l'équipe
d'assistance ; il ne supprime aucun compte sur la seule déclaration d'un visiteur.
L'identité du demandeur doit être vérifiée avant suppression, en particulier
pour les comptes historiques partagés avec un revendeur.

Les informations juridiques et les pratiques effectives sont à renseigner via
les variables `SXB_PRIVACY_*` décrites dans
[`PUBLIC-ROUTES.md`](store/google-play/PUBLIC-ROUTES.md). Tant que l'éditeur ne les
a pas validées, les pages sont explicitement signalées comme **prépublication**
et la soumission doit rester bloquée. `SXB_PRIVACY_REVIEWED=true` n'est pas une
valeur à activer pour contourner cette étape : elle exige toutes les informations
obligatoires. Le déploiement les contrôle avant de remplacer le serveur en cours.

### Compte propriétaire

`POST /api/users` refuse de créer un compte `OWNER` si le demandeur n'en est pas
un — le premier ne peut donc naître que hors API :

```bash
OWNER_EMAIL=... OWNER_PASSWORD=... npx tsx prisma/seed-owner.ts
```

Le script est idempotent : le relancer réinitialise le mot de passe, ce qui en
fait aussi la procédure de récupération. Le mot de passe est lu dans
l'environnement, jamais écrit dans le dépôt ni journalisé. Le déploiement
l'exécute automatiquement si les secrets `OWNER_EMAIL` et `OWNER_PASSWORD` sont
définis.

---

## Sécurité

- Les configurations sont chiffrées au repos sur l'appareil, clé maître en
  Keystore Android.
- Les journaux masquent hôtes, identifiants, jetons et UUID.
- L'adresse de sortie n'est ni affichée ni demandée par l'application.
- `minimumReleaseAge` impose un délai d'un jour avant l'installation d'une
  version npm, comme défense contre les compromissions de chaîne
  d'approvisionnement. **Ne pas désactiver.**
