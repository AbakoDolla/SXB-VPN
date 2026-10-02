# Rapport A-T : couche de securite additive SXB VPN

**Politique root demandee le 1er octobre 2026 :** une installation Android
detectee comme rootee est refusee avant montage de l'identite, de la navigation
ou du fournisseur VPN. Une exception est decidee uniquement dans
Administration > Centre de securite > Appareils rootes, derriere le verrou
existant. OWNER voit tout et les demandes non rattachees ; SUPER_ADMIN ne voit
et ne modifie que les demandes rattachees a son perimetre non-OWNER.
ADMIN, SUPPORT, RESELLER et CLIENT n'ont aucune voie d'approbation.
L'approbation ne cree ni session metier, ni forfait, ni quota.

La decision par cle d'installation est signee par une autorite dediee dont
le secret aleatoire reste serveur. Sa cle publique de verification, obtenue
par operation controlee, est compilee dans l'APK ; une reponse auto-signee
ou un changement de cache local ne peut pas creer une exception. Ce n'est
pas un pin de certificat TLS. Aucune cle ENCRYPTION_KEY/JWT par defaut ne sert
de secret de signature. La migration est additive, sans approbation automatique.

L'exception signee expire apres 24 h maximum. Une exception deja valide permet
le demarrage local sans appel Internet pre-tunnel ; un appareil non approuve
ne voit aucun ecran protege et son activite est fermee immediatement.
La demande d'exception part en arriere-plan, avec preuve de possession de cle.
Un premier contact API est necessaire pour rendre visible puis recuperer une
approbation. Les retraits atteignent l'appareil lors du prochain contact API
(surveillance toutes les minutes quand le processus est vivant), pas a travers
un lien hors ligne inexistant. L'echec de stockage d'une decision echoue ferme
en memoire, et une ancienne revision ne peut ecraser une decision plus recente.

Les applications/chemins su et root sont des observations locales contournables
sur un processus compromis ; les seules build tags test-keys ne sont plus
considerees comme preuve de root. Aucun bannissement d'emulateur, aucune
suspension de compte et aucun effacement du ledger ne sont ajoutes.
La politique ne promet pas une detection inviolable du root masque.
Android conserve un seul VPN par utilisateur/profil : le remplacement par
un autre service ferme immediatement TUN et sockets SSH et annule les reprises.
Cela ne detecte pas une capture root sans remplacement du VPN. Aucun ADB.

**Etat courant, retrait demande le 30 septembre 2026 :** le pinning client,
la generation locale de permission et la passerelle SSH imposee sont retires.
Les profils SSH retrouvent leur serveur et identite fournisseur par le
provisionnement chiffre lie a l'appareil, puis utilisent le cache local
sans appel Internet avant le tunnel. Aucun TLS n'est ajoute au SSH simple ;
les transports explicitement importes et HTTPS API restent inchanges.
Les secrets SSH directs sont donc presents dans le coffre chiffre de chaque
appareil autorise, pas seulement sur le serveur. Les anciens profils a ticket
necessitent une synchronisation unique ; une reponse tardive ne peut ecraser
un profil remplace ou recreer un profil supprime.
Le retrait de permission par Android coupe toujours
immediatement le TUN et le socket SSH direct, desarme la reconnexion et
annule les anciennes tentatives ; il ne cree plus de blocage de permission
persistant distinct. Un nouveau depart suit l'autorisation Android normale.
Les droits, quotas, preuve appareil et correctifs
de demarrage sans Internet prealable restent en place.
PCAPdroid en mode VPN remplace le VPN actif ; sa capture root sans remplacement
ne peut pas etre assimilee a ce signal. Les sections ci-dessous constituent le
rapport historique, pas une revendication de pinning dans le client simplifie.

Base conservee : `5ba8f701eff6d560c6a95aff1e07cb0119ee582d`, branche
`princeevanceabah-pixel-compatibilite-du-paquet-protocoles` (PR #89), incluant
la stabilite de PR #88. Implementation initiale revue :
`2b83e4a89848073baa1d01f81bb46c9e59eb434d`, premier candidat documente
`a29e0cd65276181cedd07605c1db179eb0e7fdb3`. Les corrections bornees apres
la premiere execution CI sont detaillees en O. Ce rapport ne constitue pas
une autorisation de publication.

**Code effectivement construit et verifie en CI :
`4a17c218c65dbd2f83c931f612ced593df54bc5c`.** Le commit documentaire
`1911ab6c0adf79266326c9dcf2a6ce4a29df0d92` a consigne cette preuve sans changer
le code. La preparation backend ulterieure decrite ci-dessous modifie les
gates de migration, pas l'identite ni le contenu de cet APK historique.
Le candidat est disponible en artefact GitHub, mais n'est ni publie en release
ni installe. Un backend compatible est obligatoire avant son usage.

## A. Resume

La couche conserve le service/TUN unique, libbox, JSch, DNSTT, les formats de
protocoles, le coffre chiffre, le ledger, les generations de connexion, les
essais, quotas, facturation et portees revendeur/RBAC. Elle etend les routes,
modeles et consoles existants au lieu de creer un second systeme de securite.

Les changements principaux sont la preuve de possession d'une cle Android,
les generations d'authentification et rotations de refresh persistantes,
l'association immuable des rapports de consommation, les evenements de
revocation Android differes et une politique de risque graduee non punitive.
Les ecritures locales d'identite et leurs nettoyages imbriques sont serialises :
un refresh ou une suppression A ne peut finir apres la persistance de B.
Une requete A en attente conserve son autorite et ne repart pas avec les jetons B.

Le constat d'audit sur `reportMode: unlinked` est corrige pour une association
de connexion geree deja autorisee par le serveur. Il ne s'agit **pas d'une
mesure independante du trafic** : un client completement hostile peut encore
mentir sur les octets ou ne pas les rapporter. Les identifiants fournisseur
peuvent rester persistants ; aucune rotation distante inexistante n'est promise.

### Extension du Centre : investigation et confidentialite OWNER

Cette evolution dashboard/backend n'exige ni migration SQL ni nouvelle APK.
La preuve de livraison historique ci-dessus ne constitue pas une preuve de
publication de cette evolution.

- OWNER dispose de la vue complete. SUPER_ADMIN ouvre le Centre avec sa propre
  preuve courte, mais ne recoit ni le compte OWNER, ni ses clients prives, ni les
  revendeurs crees par OWNER et leur parc dans les listes de gestion.
  ADMIN conserve son compartiment ; SUPPORT, RESELLER et CLIENT n'accedent pas
  au Centre. Les revendeurs conservent leurs propres clients et leur acces
  metier, meme lorsque leur agrement a ete cree par OWNER.
- Le filtrage serveur precede recherche, pagination, compteurs, derniere date
  d'alerte et acquittement. Les evenements lies uniquement par appareil ou
  session sont egalement exclus. Les actions OWNER sur une session publique
  restent privees grace au role enregistre dans les metadonnees.
- Les anciens audits non marques mais rattaches a OWNER sont exclus des
  lectures non-OWNER. Les audits et mouvements de quota sans auteur
  attribuable sont reserves a OWNER par precaution. Un echec de resolution
  d'appartenance retourne une erreur, pas une portee globale. Les journaux
  sont conserves, jamais effaces pour masquer une action.
- L'inventaire affiche et filtre les sessions, generations, appareils,
  empreintes publiques, dates et IP observees, sans tokens, cles privees ni
  etat de refresh. Il permet de consulter les alertes, de preparer une
  autorisation de cle et de revoquer la generation courante apres confirmation.
  La portee est recontrolee dans la mise a jour atomique de revocation.
- Le journal et le flux d'alertes disposent de recherche, filtres et pagination.
  L'export JSON contient uniquement la page affichee, pas l'ensemble du parc.
  Les alertes peuvent etre acquittees puis rouvertes ; les identifiants
  hors perimetre ne sont pas modifies.
- Seul OWNER modifie la politique globale (seuils, poids, certificats).
  SUPER_ADMIN la consulte en lecture seule. Root seul reste autorise,
  Play reste facultatif, et les signaux locaux ne suspendent pas les comptes.
- Le verrouillage manuel, l'expiration et le changement d'identite invalident
  les reponses asynchrones de la console. Un refus du constructeur Notification
  sur Android ne fait plus tomber la section : un message indique que les
  notifications systeme sont indisponibles, et les alertes restent consultables.

**Migration des appareils existants.** Un compte jamais active enregistre sa
cle lors de sa premiere activation. Une activation avec la meme cle ne demande
pas une nouvelle autorisation. Un compte deja active, sans cle ou presentant
une cle differente, exige une autorisation de dix minutes liee a l'empreinte
publique exacte. Dans le Centre, utiliser l'identifiant interne du client VPN,
pas son token. Le remplacement d'une cle existante doit etre explicitement
confirme apres verification de l'identite. Arreter le VPN et synchroniser
la consommation avant le premier enrolement ; ne pas effacer les donnees.
Cette evolution ne retire pas cette protection ni n'autorise automatiquement
tous les anciens comptes.

**Limites de confidentialite.** Les effets metier necessaires restent visibles
aux interesses (quota courant, abonnement, fermeture de leur session), sans
exposer le journal prive de l'auteur. Le support conserve sa file de demandes
anonymes pour OWNER, SUPER_ADMIN et SUPPORT ; les tickets rattaches au compte
ou au parc prive OWNER restent exclus des lectures et mutations des autres roles.
Les comptes ADMIN n'ont pas de colonne
d'auteur : on n'invente pas un rattachement OWNER absent du schema. Les anciens
evenements orphelins sans aucune attribution fiable ne permettent pas de
reconstituer retrospectivement leur proprietaire. Les comptes de role OWNER
partagent la vue racine existante ; il ne s'agit pas d'un cloisonnement entre
plusieurs OWNER. Cette protection applicative ne masque pas les traces aux
operateurs disposant d'un acces direct a la base ou au serveur.

Validation ciblee : routes HTTP reelles sur fixtures isolees, tests
`owner-security-http.test.mjs`, `security-center.test.mjs`, contrats de portee,
de quota et FR/EN ; runner PostgreSQL `security-layer-postgres.integration.mjs`
sur une base dediee loopback ; preview locale `security-dashboard-preview.mjs`
avec `?notification=android` pour reproduire le refus de l'API desktop.
La preview ne contacte aucune API de production.

## B. Fichiers existants modifies

Inventaire relatif a la base ci-dessus, hors caches d'outils et preuves temporaires.

```text
.github\workflows\build-android.yml
.github\workflows\deploy-vps.yml
.github\workflows\verification-pr.yml
.github\workflows\vps-audit.yml
README.md
app-mobile\app\activate.tsx
app-mobile\contexts\AuthContext.tsx
app-mobile\contexts\VpnContext.tsx
app-mobile\localization\en.ts
app-mobile\localization\fr.ts
app-mobile\modules\android-native\SecurityModule.kt
app-mobile\modules\android-native\SxbAccessControl.kt
app-mobile\modules\android-native\SxbAccessObserver.kt
app-mobile\modules\android-native\SxbVpnModule.kt
app-mobile\modules\android-native\SxbVpnPackage.kt
app-mobile\modules\android-native\SxbVpnService.kt
app-mobile\plugins\withSxbVpn.js
app-mobile\services\activationError.ts
app-mobile\services\apiClient.ts
app-mobile\services\configStore.ts
app-mobile\services\identitySession.ts
app-mobile\services\offlineStorage.ts
app-mobile\services\securityReport.ts
app-mobile\services\usageLedger.ts
app-mobile\tests\mobile-access.test.ts
app-mobile\tests\regression-critical-flows.test.ts
app-mobile\tests\usage-accounting.test.ts
artifacts\sxb-dashboard\src\api\security.ts
artifacts\sxb-dashboard\src\api\sessions.ts
artifacts\sxb-dashboard\src\api\reset.ts
artifacts\sxb-dashboard\src\components\OwnerResetSection.tsx
artifacts\sxb-dashboard\src\components\SecurityCenterView.tsx
artifacts\sxb-dashboard\src\components\SessionsView.tsx
artifacts\sxb-dashboard\src\locales\en\operations.json
artifacts\sxb-dashboard\src\locales\fr\operations.json
backend\prisma\schema.prisma
prisma\schema.prisma
scripts\deploy.sh
scripts\post-merge.sh
scripts\run-android-policy-gates.sh
scripts\tests\application-reset.test.mjs
scripts\tests\build-caches.test.mjs
scripts\tests\configuration-delivery.test.mjs
scripts\tests\dashboard-profile-lock.test.mjs
scripts\tests\durcissement-mobile.test.mjs
scripts\tests\engine-data.test.mjs
scripts\tests\parite-schemas-prisma.test.mjs
scripts\tests\provision-e2e.test.mjs
scripts\tests\public-privacy-http.test.mjs
scripts\tests\reset-dashboard-api.test.mjs
scripts\tests\reset-dashboard-ui.test.mjs
scripts\tests\security-center.test.mjs
scripts\update.sh
server.ts
server\middleware\auth.ts
server\routes\mobile-access.ts
server\routes\mobile-security.ts
server\routes\mobile.ts
server\routes\provision.ts
server\routes\security.ts
server\routes\sessions.ts
server\services\access-lifecycle.ts
server\services\access-ticket.ts
server\services\application-reset.ts
server\services\device-activation.ts
server\services\mobile-access-state.ts
server\services\mobile-principal.ts
server\services\mobile-risk.ts
server\services\mobile-session-refresh.ts
server\services\play-integrity.ts
server\services\reset-backup.ts
server\services\security-events.ts
server\tests\reseller-lifecycle.test.ts
```

## C. Nouveaux fichiers

```text
app-mobile\modules\android-native\SxbBackendTls.kt
app-mobile\modules\android-native\SxbDeviceProof.kt
app-mobile\modules\android-native\SxbSecurityMonitor.kt
app-mobile\services\deviceSecurity.ts
app-mobile\services\identityPersistence.ts
app-mobile\tests\DeviceSecurityTest.kt
app-mobile\tests\run-device-security.cjs
backend\prisma\security-layer.sql
backend\prisma\backend-rollout-compat.sql
docs\SECURITY-LAYER-REPORT.md
prisma\security-layer.sql
scripts\backend-migrate.cjs
scripts\backend-preflight.cjs
scripts\check-backend-cron.cjs
scripts\tests\backend-migration.test.mjs
scripts\tests\backend-migration-postgres.integration.mjs
scripts\tests\backend-preflight.test.mjs
scripts\tests\security-dashboard-preview.mjs
scripts\tests\security-ci-harness.test.mjs
scripts\tests\security-layer-postgres.integration.mjs
server\services\mobile-connections.ts
server\services\backend-migration.ts
server\services\mobile-proof.ts
server\services\mobile-session-security.ts
server\services\security-policy.ts
```

Le runner PostgreSQL a ete renomme de `.test.mjs` en `.integration.mjs`
pendant ce lot. Il ne doit pas entrer dans les globs sans base de donnees du
deploiement. Ses donnees sont des fixtures explicitement synthetiques ; son
stockage et ses transactions sont du vrai PostgreSQL.
Le runner de migration backend utilise egalement `.integration.mjs` et une
base dediee explicite ; les globs ordinaires n'ouvrent aucune connexion DB.

## D. Schema Prisma et migration

Les deux schemas Prisma et les deux fichiers SQL sont identiques entre racine
et `backend\prisma`. `security-layer.sql` est un script additif transactionnel,
pas une migration automatiquement decouverte par `prisma migrate deploy`.
Ne pas utiliser `db push` pour mettre a jour la production.

### Empreintes de configuration et compatibilite historique

Le controle CodeQL de l'integration a signale l'empreinte SHA-256 non secrete
du canonique, qui peut contenir des identifiants fournisseur. Les nouveaux
imports utilisent `hmac-sha256-v1:<hex>`, avec une sous-cle derivee et separee
de la cle AES-GCM existante ENCRYPTION_KEY. Une empreinte seule ne permet donc
plus de verifier hors ligne une supposition sur les identifiants sans cette cle.
Les mots de passe de connexion et de verrouillage restent geres par bcrypt.

Les blobs GCM, les empreintes SHA-256 deja stockees, les versions et les
identifiants de profils ne sont pas reecrits. Le provisionnement reconnait
explicitement les deux formats apres dechiffrement GCM authentifie et refuse
les formats inconnus ou contenus modifies. Les doublons d'anciens imports
restent detectes par comparaison de leur contenu dechiffre avec la nouvelle
empreinte, par pages, sans migration ni nouveau digest non secret. Le mobile
traite ces valeurs comme des identifiants opaques ; aucune reimportation de
profil existant n'est provoquee par le seul deploiement.

### Gate backend ajoute apres le candidat APK

Le workflow deploy-vps utilisait encore `db push` et omettait security-layer.sql.
Il appelle maintenant `scripts\backend-migrate.cjs prepare` : sauvegarde custom
verifiee, SQL explicites dans l'ordre ci-dessous, comparaison readonly du
schema reel, puis verification des protections du ledger. Toute erreur bloque
la generation explicite des clients, le seed OWNER, le remplacement des bundles
et le restart. La generation automatique postinstall est desactivee.

L'ordre est : `backend-rollout-compat.sql`, `migrations_manual.sql`, scopes
device puis profil, propriete/validite revendeur, permission tokens.revoke,
vouchers, verrouillage des profils, ledger append-only, `security-layer.sql`,
`20261002043000_data_allocation_ownership/migration.sql`.
Chaque fichier est transactionnel : sa propre transaction lorsqu'il en declare
une, sinon `psql --single-transaction`, toujours avec ON_ERROR_STOP=1 et sans
chargement de psqlrc. Il ne s'agit pas d'une transaction globale de tous les
fichiers : un fichier deja termine peut rester applique si le suivant echoue.
Aucun rollback de donnees automatique n'est tente.

Le retrait de db push a revele trois divergences historiques, reproduites sur
la baseline 5ba peuplee. Aucun fichier de migration historique ni le SQL de
securite initial n'a ete reecrit :

- Les scopes cherchaient des contraintes, alors que Prisma avait cree des
  indexes uniques homonymes : erreur 42P07. Le nouveau SQL prealable adopte
  les deux indexes via UNIQUE USING INDEX, sans changer leur OID ni recreer
  leurs donnees. Il verifie table, colonnes/ordre, btree, unicite, validite,
  disponibilite, NULLS DISTINCT, absence de predicat/expression/colonnes
  incluses, tri, collation et classe d'operateur par defaut. Un homonyme
  incompatible est refuse. Si l'index est absent, l'ancien SQL le cree.
- Le SQL manuel conserve `vpn_profiles.json_config`. Cette colonne distincte
  est representee par `legacyJsonConfig String? @map("json_config") @ignore`
  dans les deux schemas. Elle reste nullable et preserve ses valeurs, sans
  copie, renommage, suppression ni repli vers jsonConfig. Le client genere
  n'expose pas ce champ ni son contenu ; canonicalConfig reste inchange.
- Les indexes existants `xray_accounts_createdBy_idx` et
  `singbox_accounts_createdBy_idx` sont representes par @@index([createdBy])
  dans les deux modeles, sans suppression des indexes du SQL historique.

Le gate exige le datasource PostgreSQL DATABASE_URL des deux schemas coherents,
le schema public et tous les fichiers DDL attendus. Il utilise
`prisma migrate diff --from-schema-datasource ... --to-schema-datamodel ...
--exit-code` : code 2 signifie BACKEND_SCHEMA_DRIFT, toute erreur reste bloquante.
Aucun URL ni parametre d'authentification PG ne passe dans les arguments/logs.
Les options TLS libpq reconnues sont preservees ; parametres inconnus, doubles,
schema different, overrides host/hostaddr ou options de session ambigues sont
refuses, pas supprimes : la sauvegarde et le diff doivent cibler la meme autorite.
Les diagnostics bruts Prisma/psql ne sont pas publies. Les codes d'erreur et
l'etape identifient le controle a diagnostiquer dans un environnement prive.

Le provider de sauvegarde existant est reutilise : archive compressee custom
PGDMP, taille minimale, pg_restore --list, SHA256 et creation exclusive, droits
700/600 sous POSIX et hors repertoire applicatif. Le nom `reset-<uuid>.dump`
est historique ; aucune operation de reset applicatif n'a lieu. Le recu
id/taille/hash est egalement conserve dans l'erreur si une etape ulterieure
echoue. Les archives ne sont ni ecrasees ni purgees automatiquement. Le delai
borne est de 120 secondes par outil, y compris la sauvegarde ; un volume plus
important demande une politique de sauvegarde revue, jamais un contournement.

Avant remplacement du checkout, le futur workflow execute le helper cron
autonome depuis FETCH_HEAD verifie, via `git show ... | node` sous pipefail.
La lecture `sudo -n crontab -u root -l` est bloquante si impossible ou si le
cron legacy connu git pull/docker-compose up est trouve. Aucune ligne de cron
ni aucun secret n'est imprime ; aucune suppression automatique n'a lieu.
Ce controle cible le job connu, pas tous les ordonnanceurs possibles.
La presence d'un tel cron sur le VPS n'a PAS ete inspectee pendant ce lot.

Les anciens scripts Docker deploy.sh/update.sh echouent explicitement avant
toute action, et post-merge.sh ne pousse plus le schema Drizzle. Le packaging
Docker n'est pas refondu. Une recette isolee reussie n'autorise toujours ni
fusion, deploiement, activation des clients enroles ou publication.

| Modele/table | Ajout |
| --- | --- |
| `VpnClient` / `vpn_clients` | Cle publique SPKI, empreinte, date d'enrolement, autorisation temporaire d'enrolement/remplacement |
| `ActivationSession` / `activation_sessions` | Generation, dates d'emission/expiration/revocation, ID de retry d'activation, generation/JTI refresh courant et precedent, limite de retry |
| `MobileProofNonce` / `mobile_proof_nonces` | Unicite `(keyId, nonce)`, expiration indexee |
| `MobileConnection` / `mobile_connections` | Connexion, autorite d'origine, device, session comptable, forfait/configuration immuables, cloture |
| `SecurityEvent` / `security_events` | Correlations nullable session/generation/connexion, cle d'idempotence, version de politique, niveau de risque |

`ActivationSession` conserve sa cardinalite `(clientId, deviceId)` : ce n'est
pas une ligne par reconnexion VPN. La generation historique vaut 0. Aucune
cle n'est attribuee ni aucun appareil automatiquement enrole par la migration.
`MobileConnection`, unique par `(clientId, usageSessionId)`, est une association
comptable par connexion, pas une autre session d'authentification. La relation
d'autorite et sa mutation sont controlees dans les transactions applicatives.

Ordre de deploiement : controle hote readonly, sauvegarde, SQL explicites
avec compatibilites additives et verification du schema reel,
generation du client Prisma, mise a niveau de **tous** les noeuds backend,
puis activation des nouveaux clients/enrolements. Les anciens clients restent
dans la cohorte explicitement non enrolee. Un ancien backend ignorant les
nouvelles colonnes/claims ne protege pas un client enrole : le routage mixte
ou un rollback vers cet ancien code doit etre bloque operationnellement.
Il n'y a ni date-butoir implicite ni bascule globale destructive.

La migration a ete verifiee sur une base locale peuplee, avec preservation et
reexecution idempotente, par le parent. Le nouveau job CI initialise uniquement
son PostgreSQL jetable a partir du schema courant puis execute le SQL additif ;
ce bootstrap CI n'est pas, a lui seul, une preuve de migration d'un parc ancien.

Le reset global OWNER inclut les deux nouvelles tables sans FK dans ses
verrous, inventaire, purge transactionnelle et compteurs apres purge.
Les changements de cle/generation rendent un ancien apercu caduc ; connexions,
nonces et refresh ordinaires restent des deltas transitoires couverts par
le verrou. Les anciens recus ne sont pas reecrits : les deux compteurs absents
restent absents et s'affichent « Non mesure / Not measured », jamais comme zero.
Un nouvel apercu exige les 26 compteurs et refuse une reponse incomplete.

### Isolation financiere des allocations

Chaque `Subscription` reste l'allocation et l'autorite de son quota : elle
enregistre des instantanes `allocationUserId`, `allocationOwnerId`,
`allocationOwnerName`, `allocationResellerId`, `allocationType` (`sold` ou
`free_trial`) et `allocationOrigin`. Les octets attribues, consommes et restants,
la date de creation et la configuration sont exposes depuis cette meme ligne.
Un trigger PostgreSQL interdit la reecriture du proprietaire, de l'utilisateur,
du type ou du compte porteur apres attribution. Un changement de gestionnaire
du compte ne deplace donc pas les ventes.

Un revendeur peut vendre a un compte deja active avec son code `SXB-USER`,
depuis **Forfaits Data > Compte existant, avec son code**. Cette operation cree
son allocation, debite seulement son enveloppe et ne change ni le compte
porteur, ni sa cle d'activation. Elle ne donne aucun annuaire des clients
d'autrui et ne lui renvoie pas leurs codes d'activation ou leurs autres plans.
Ne pas creer un deuxieme compte pour cumuler des ventes : le code identifie le
compte authentifie existant, sans fusionner des identites appareil distinctes.

Les scopes, compteurs, graphiques, historique commercial et mutations de
forfaits suivent leur proprietaire financier, pas `VpnClient.resellerId`.
Les essais et leurs recharges restent finances par le systeme, y compris
apres une conversion administrative de leur demande. Une nouvelle vente est
une allocation distincte, jamais une reecriture du financement d'un essai.
Un revendeur ne peut pas suspendre, supprimer ou faire tourner le code global
d'un compte partage et ainsi retirer les allocations d'autrui : il gere ses
propres forfaits, les actions globales restant a l'administration.

L'affichage financier reste dans le dashboard : chaque groupe de client
presente le total attribue, consomme et restant des seules allocations
visibles du filtre et du compartiment courant. Les essais gardent leur
section dediee et aucun total concurrent n'est expose a un revendeur.
Le mobile conserve son affichage habituel par forfait, sans bloc agrege
ni etiquette de vendeur. Le moteur et le ledger debitent toujours le
`subscriptionId` effectivement selectionne. Expiration, etat,
configuration et liaison appareil restent applicables. Un vendeur expire
bloque ses allocations, pas les allocations independantes des autres vendeurs
ou du systeme ; les revocations du compte/appareil lui-meme restent globales.

La migration est additive et repetable. Les essais historiques sont retrouves
par leur demande ou leur historique de creation ; le vendeur historique est
fige depuis le createur revendeur lorsqu'il existait deja a la creation.
Sinon `legacy_account_snapshot` designe explicitement l'instantane de
facturation anterieur a la migration, pas une reconstruction certaine du
vendeur original. Aucune vente ni consommation anterieure n'est inventee.
Apres sauvegarde, SQL et generation des deux clients Prisma, le deploiement
execute `scripts/reconcile-allocation-ledger.cjs`. Les reservations stockees
sont recalculees par proprietaire sous transaction serializable et verrou,
avec un mouvement de correction immuable ; les plafonds attribues ne changent
pas. La reexecution ne cree aucun ajustement lorsque le compteur est deja juste.
Le gate readonly exige aussi le trigger et la contrainte d'identite
d'allocation. Un echec de migration ou de reconciliation bloque la publication.

### Chemin de donnees SSH : couts internes et debit

Les sockets SSH proteges (direct, TLS declare et payload) activent
`TCP_NODELAY`. Le flux entrant est tamponne a 32 KiB pour ne pas effectuer
une lecture reseau par octet d'en-tete HTTP/WebSocket ou de banniere.
Les relais SOCKS utilisent 32 KiB au lieu de 8 KiB. Le tampon de canal
JSch commence toujours a 32 KiB et peut grandir a la demande jusqu'a
256 KiB, sans reservation arbitraire par connexion et sans modifier
les fenetres SSH ou le chiffrement negocies.

L'emetteur WebSocket conserve un tampon borne pour les paquets usuels,
masque chaque trame avec un nouveau masque cryptographique et serialise
la trame complete sur le meme verrou que les controles ping/pong. Les
trames de donnees ne provoquent que deux diagnostics par direction :
les journaux de controle, les refus et les erreurs restent explicites.
Les grands appels conservent les longueurs RFC 6455 et leurs octets exacts.
Les fermetures de socket, demi-fermetures TCP et compteurs ne changent pas.

`run-ssh-frame-throughput.cjs` mesure les declarations Kotlin reellement
extraites, et les tests SSH/JSch/SOCKS exercent le vrai chemin. Le resultat
de ce banc JVM est un cout de tramage et d'allocation, pas une promesse
de debit operateur. Le banc VLESS/WS/TLS/HTTP utilise aussi le vrai moteur
sur boucle locale et verifie des transferts de plusieurs Mio. Aucun
parametre explicite de profil, TLS, DNS, MTU, route, UDP ou multiplexage
n'est modifie pour afficher une vitesse flatteuse. La capacite du serveur,
les politiques operateur et les conditions du telephone restent exterieures
a cette validation.

## E. API

| Surface | Contrat |
| --- | --- |
| `POST /api/mobile/auth/activate` | Existant etendu : cle publique et `activationRequestId`, autorite d'enrolement, retour `security` |
| `POST /api/mobile/auth/refresh` | Existant etendu : rotation persistante, preuve, retries bornes |
| `POST /api/auth/refresh` | Chemin historique controle aussi pour une autorite mobile ; aucune elevation vers le role operateur |
| `POST /api/mobile/vpn/session` | Existant etendu : autorisation/idempotence de l'association connexion-comptabilite |
| `POST /api/mobile/vpn/traffic` | Existant etendu : association immuable, retries et rapport manuel explicite conserves |
| `POST /api/mobile-security/report` | Existant etendu : integrite locale, politique versionnee, jamais de suspension heuristique automatique |
| `POST /api/mobile-security/events` | Nouveau : lot de 1 a 25 evenements durables, acquittement apres commit |
| `GET`, `PUT /api/security/policy` | Nouveaux : lecture et CAS de version ; owner/super-admin et console deverrouillee |
| `POST /api/security/devices/:id/authorize-key` | Nouveau : autorisation explicite de cle publique, duree 10 minutes |
| `POST /api/security/sessions/:id/revoke` | Nouveau : revocation de generation precise, console protegee |
| `GET /api/sessions/:id/security-events` | Nouveau : projection bornee selon permissions et portee existantes |
| `POST /api/sessions/:id/security-revoke` | Nouveau : action de generation avec `clients.manage`, interdite au SUPPORT |
| Provisionnement, principal mobile, access-ticket et observation | Existants renforces par cle/generation/revocation |

Le champ `generation` des revocations est obligatoire. Une generation obsolete
ne revoque pas la suivante. Le vieux `/api/sessions/:id/revoke`, action metier
suspendant le client, reste distinct et n'est jamais utilise pour `VPN_REVOKED`.
Les enveloppes d'erreur compatibles utilisent notamment `SESSION_INVALID`
avec une `reason` precise (`DEVICE_MISMATCH`, `SESSION_REPLAY`, etc.) ;
un nonce reutilise est refuse en 409. Ces refus ne livrent aucune configuration.

## F. Evenements et console

Vocabulaire ajoute : `VPN_STARTED`, `VPN_STOPPED`, `VPN_REVOKED`, `VPN_CONFLICT`,
`ROOT_DETECTED`, `DEBUG_DETECTED`, `HOOKING_RISK`, `INSTRUMENTATION_RISK`,
`APP_INTEGRITY_FAILED`, `TOKEN_REPLAY`, `DEVICE_MISMATCH`, `SESSION_REPLAY`,
`CAPTURE_RISK_DETECTED`, `CONTROL_RISK_DETECTED`, `SECURITY_POLICY_BLOCK`.
L'inscription d'un nom au vocabulaire ne prouve pas l'existence d'un detecteur
capable de confirmer toutes les captures ou tous les conflits.

Les producteurs effectifs comprennent les transitions VPN natives, les
observations root/debug/hooks/signature et les refus d'autorite/replay serveur.
Les observations client sont etiquetees comme telles. Les nouvelles donnees
de cycle de vie ne contiennent ni paquet, payload VPN, jeton, mot de passe ni
cle privee. Les metadonnees sont allowlistees et bornees. Les anciens champs
`ip` et `clientName` de la console owner existent toujours : ne pas presenter
l'ensemble de l'historique comme ne contenant que des IP hachees.

Les acquittements durables utilisent l'ecrivain strict dans la transaction ;
un echec de stockage donne un echec explicite, pas un faux acquittement. Les
observations facultatives restent non fatales et leurs echecs sont journalises.

La console existante conserve son verrou court et ses passkeys. Filtres :
utilisateur, appareil, session, gravite, type, dates et etat d'acquittement ;
la vue Sessions garde le filtre d'etat metier. ADMIN/SUPPORT ne recoivent
qu'une projection autorisee, sans configuration privee ni metadonnees owner.
SUPPORT n'a pas le nouveau bouton de revocation. Aucune console owner n'est
ouverte au CLIENT ; les routes d'identite existantes suffisent pour son compte.

Le polling conserve les brouillons et les erreurs de mutation. Les erreurs
de chargement sont separees et disparaissent a la recuperation du chargement.
Le rechargement volontaire d'une politique modifiee demande confirmation.
Les actions de session passent a la ligne sur mobile sans fragmenter les mots ;
la fixture utilise le vrai `installResponsiveTables`, comme le layout.

## G. Politique de risque

Stockage : `Setting.key = mobile.security.policy.v1`. Version initiale 1 ;
mise a jour stricte avec `version courante + 1`, creation initiale et CAS
serialises en PostgreSQL, y compris lorsque la ligne Setting n'existe pas.

| Niveau | Politique par defaut |
| --- | --- |
| NORMAL | Score 0, aucune action |
| LOW | Sous MEDIUM, aucune action ; root seul reste LOW/autorise |
| MEDIUM | A partir de 30, surveillance |
| HIGH | A partir de 65, revalidation, sans suspension du compte |
| CRITICAL | Branche reservee a une violation confirmee cote serveur, jamais construite en additionnant des declarations client |

Poids initiaux : signature invalide 75, leurre touche 40, hooked 50, Frida 50,
Xposed 40, attestation refusee 40, debugger 30, root 10, emulateur 10.
Le score des observations est leur **maximum**, borne a 89, pas leur somme.
Les seuils configurables sont MEDIUM 11-64 et HIGH 65-89 ; les poids doivent
tous etre presents. Une erreur de lecture de politique est explicite (503).

Un bearer vole accompagne d'une mauvaise preuve ne doit pas offrir un moyen
de revoquer la victime. Les refus de requetes sont donc journalises/refuses,
sans assimiler automatiquement leur emetteur au detenteur legitime de la cle.
La revocation persistante de session est une action autorisee et generationnelle.
Aucune suppression, interdiction de compte ou suspension de forfait n'est ajoutee.

## H. Root

Root seul : ALLOW, sans condition Play ni blocage local automatique.
Root avec plusieurs detecteurs de hooks n'est pas une preuve independante
de compromission. Root avec une signature declaree invalide atteint HIGH
par le signal de signature, pas CRITICAL par addition. Les declarations locales
et leurs detecteurs peuvent etre neutralises sur un appareil compromis.

## I. Conflits VPN et `onRevoke`

Trois identites sont distinctes :

| Identite | Usage |
| --- | --- |
| `ActivationSession.id + authGeneration` | Autorite de connexion au backend, famille de refresh |
| Tentative/start natif et `MobileConnection.id` | Tentative et connexion VPN d'origine |
| `usageSessionId + seq` | Rejeu comptable, jamais credential d'authentification |

`onRevoke` capture l'autorite originale avant le travail asynchrone, interdit
la reconnexion, arrete descripteurs/workers et fige la consommation finale.
L'evenement est persiste pour livraison ulterieure, avec l'autorite de cette
connexion. Une callback ancienne ne coupe pas une tentative/service plus recent.

La perte de permission peut etre une decision normale d'Android. Elle ferme
la connexion originale, pas le login, l'activation, les profils chiffres ou
le ledger. L'application ne lutte pas pour reprendre automatiquement la
permission VPN. Un evenement ancien ne revoque ni nouveau login ni nouvelle
connexion ; le serveur verifie l'association avant de clore la connexion.
Les files sont bornees et privilegient les pertes de permission. Une panne
de stockage reste signalee : aucune durabilite impossible n'est promise.

## J. Integrite APK et HTTPS

Package attendu : `com.sxbvpn.mobile`. Empreinte publique du signataire release
verifie avant ce lot :

```text
0140c97e6ba6e9bab0d0ce86935562fbdedd80a026de49642764c49dce56f726
```

La liste autorise 1 a 8 certificats officiels pour preparer une rotation.
Package, certificat, version/build et canal sont observes localement.
Un APK officiel sideloade reste admis. Play est facultatif ; absence,
indisponibilite, non-reconnaissance, `UNLICENSED`, `UNEVALUATED` et canal inconnu
ne prouvent pas une attaque. L'adaptateur Play existant est reutilise.
Un digest auto-declare n'est pas une attestation serveur authentique.

Le plumbing TLS natif couvre la pile React Native utilisee par JS ainsi que
les appels HTTP natifs de fond. Il valide la chaine avec le trust manager
systeme puis applique l'allowlist SPKI a la chaine validee. Pas de trust-all,
TOFU, faux pin de secours ni fallback sur un mismatch configure.

Configuration publique :
`EXPO_PUBLIC_BACKEND_SPKI_PINS` est un tableau JSON de pins `sha256/...` revus ;
`EXPO_PUBLIC_APK_SIGNERS` est une liste de digests separee par virgules.
L'origine HTTPS configuree reste selectionnable. Les controles natifs ne
promettent pas un nouveau support de backend Android HTTP en clair.

**Aucun pin TLS reel de production n'a ete fourni ou recolte.** La valeur
non configuree `[]` n'active pas le pinning. Avant activation il faut obtenir
hors de cette intervention les SPKI publics approuves et le materiel public
de rotation, puis verifier un vrai handshake. L'enforcement production du
pinning n'est donc pas demontre par ce lot.

## K. Device binding

Cle EC P-256 non exportable dans Android Keystore, sans obligation StrongBox,
root ou Google Play. Le serveur conserve la cle publique SPKI et son empreinte.
L'enrolement est rattache a l'activation et au principal existants. Sur un
appareil deja active, un upgrade/remplacement exige une autorisation explicite
liee a l'empreinte publique verifiee, valable 10 minutes. Un bearer et un
en-tete `deviceId` falsifie ne permettent pas d'ecraser une cle existante.

Avant premier enrolement, VPN arrete et ledger synchronise : pas d'abandon
de consommation historique non liee. Le marqueur local d'enrolement est
persistant ; une reponse security manquante ou un bridge indisponible ne
declenchent pas un downgrade silencieux. Les retries d'activation conservent
leur ID ; seul l'ID effectivement acquitte est nettoye.

La preuve couvre, dans cet ordre et separe par des sauts de ligne :

```text
SXB-PROOF-1
METHODE
chemin et query exacts
SHA256(octets exacts du corps)
sessionId ou -
generation ou 0
SHA256(credential utilise)
timestamp
nonce
```

Signature `SHA256withECDSA`, identite de cle associee au principal. Le credential
est celui de l'operation (activation, refresh, bearer ou ticket observeur).
JS signe les octets qu'Axios envoie effectivement, y compris une string JSON
avec blancs. Les chemins bridge/natifs de fond ne passent pas sans preuve ;
le reporter headless conserve son chemin JS signe.

## L. Replay et persistance d'identite

Fenetre de preuve : 90 secondes, nonce aleatoire, unicite PostgreSQL par cle.
Consommation, revalidation de session et mutation protegee partagent la
transaction ; un rollback ne consomme pas artificiellement la preuve.
Il n'y a pas de dependance Redis inventee.

Access JWT : au plus 15 minutes. Famille de refresh : sept jours fixes apres
activation, sans glissement indefini. Rotation par JTI/generation persistants ;
le precedent JTI a une fenetre de retry de 120 secondes et rend le meme
successeur. Huit refresh paralleles legitimes produisent un seul successeur.
Un ancien retry hors fenetre est refuse sans revoquer le successeur legitime.
Access, refresh, provisioning et observer appliquent la generation revoquee.
Les tickets d'observation restent limites a leur audience, sans droit de provisionner.

La barriere locale commune couvre activation, refresh, restauration legacy,
validation, mise a jour d'etat et nettoyage. Les suppressions internes du coffre
et des quotas attendent aussi **toutes** leurs promesses avant de propager
un echec. L'arret natif reste immediat au clear. Les tests retardent vraiment
les ecritures, changent l'identite, puis liberent A ; ils ne remplacent pas
ce controle par un simple check avant `await`.

## M. Configurations privees et consommation

Le principal serveur, l'appartenance, la validite du forfait, le quota,
l'appareil et les droits de profil precedents restent controles. Le contenu
canonique reste enveloppe en AES-GCM. Aucune cle fournisseur n'est ajoutee
au dashboard ou aux evenements.

Tests effectifs : user B ne peut provisionner A ; bearer A + cle B + header A
ne donne aucune configuration ; un corps `deviceId=B` signe par A est refuse.
Ni le client ni le forfait ne changent de device et aucun device B n'est inscrit.

La resolution de forfait partagee est : `subscriptionId` explicite, sinon
`configId` seulement pour une source backend, sinon `null`. Un alias manuel
explicitement lie conserve son forfait ; une configuration manuelle non liee
homonyme d'un forfait ne lui est jamais imputee. Connexion serveur, options
natives et ledger utilisent cette meme lecture, sans reecriture des IDs/meta.
Retries, chunks, redemarrages et rapports retardes gardent l'association originale.
Cette garantie d'attribution ne transforme pas un compteur client en compteur reseau fiable.

## N. Tests effectues et matrice des 24 scenarios

Les suites utilisent les vraies fonctions/routes et, pour l'integration, un
vrai PostgreSQL local. Les frontieres Android, materiel, stockage mobile et
donnees de console sont explicitement synthetiques lorsqu'un harness les remplace.
Elles ne sont pas presentees comme un test sur telephone.

| Scenario | Preuve automatique obtenue | Preuve physique |
| --- | --- | --- |
| 01 Telephone normal | Activation/provision/usage et moteurs de politique | Non effectuee |
| 02 Telephone roote | Politique root autorisee | Non effectuee |
| 03 Root + APK officiel | Absence de suspension pour root seul | Non effectuee |
| 04 Autre VpnService | Contrats source/JVM d'autorite de revoke | Non effectuee |
| 05 `onRevoke` | Arret/generation/evenement ancien/file durable, source et JVM | Non effectuee |
| 06 APK modifie | Signal `APP_INTEGRITY_FAILED`, revalidation et politique | APK repacke non execute |
| 07 Sideload officiel | Semantique certificats/direct et Play neutre | Installation non effectuee |
| 08 Play absent | Adapter absent/non configure neutre | Non effectuee |
| 09 Integrity indisponible | Adapter indisponible neutre | Non effectuee |
| 10 Token mauvais appareil | Principal, preuve et vrais handlers refuses | Non necessaire pour la decision serveur ; Keystore reel non teste |
| 11 Ancienne session | Ancienne generation/refresh refuses ; nouvelle autorite preservee | Non effectuee sur telephone |
| 12 Nonce reutilise | Concurrence PostgreSQL, une consommation, rollback et replay provisioning | Serveur reel uniquement, pas de telephone |
| 13 JWT expire | Access JWT reellement expire + PoP fraiche : 401 ; token courant : 200 | Serveur reel uniquement, pas de telephone |
| 14 Config privee user A/B | Provisionnement croise refuse | Serveur reel uniquement, pas de telephone |
| 15 Config privee device A/B | Cle B/bearer A/header A et corps B signe A refuses, aucune config/reassociation | Serveur reel uniquement, pas de telephone |
| 16 Root seul ALLOW | Decision et route de rapport, compte conserve | Non effectuee |
| 17 Root + APK modifie | HIGH par defaut, pas CRITICAL fabrique par correlation | Non effectuee |
| 18 Root + anomalie token | Refus cryptographique et politique separes des heuristiques | Non effectuee |
| 19 Backend indisponible | 503 explicite, autorite preservee, retries/ledger durables | Coupure physique non effectuee |
| 20 Wi-Fi vers mobile | Politiques de recuperation/stabilite sur JVM | Transition radio non effectuee |
| 21 Mobile vers Wi-Fi | Memes invariants de generation/recuperation | Transition radio non effectuee |
| 22 Mode avion | Attente/retry/offline simules aux frontieres | Non effectuee |
| 23 Reboot | Restauration du ledger/autorite et snapshots dans les harnesses | Reboot non effectue |
| 24 Arret puis relance | Rejeu persistant, ancienne generation et stockage retarde | Mort/reprise Android reelle non effectuee |

PCAPdroid sans root : conflit de VpnService et revoke couverts par les
contrats, mais aucun lancement de PCAPdroid ni test Android reel n'a eu lieu.
PCAPdroid avec root : politique root seule autorisee et controles serveur
maintenus ; aucune capture root executee. Aucune detection exhaustive ou
promesse d'invisibilite/anti-capture a 100 %.

## O. Resultats

| Controle | Resultat observe |
| --- | --- |
| Regression mobile complete, incluant les contrats CI | 813 tests, 108 suites, aucun echec/skip |
| Courses d'identite et drainage pilote | 19 tests, vrais modules, frontieres I/O synthetiques |
| Usage/attribution | 58 tests dont les trois resolutions connexion/native/ledger |
| HTTP + PostgreSQL isole | 149 checks, dont JWT expire et provisioning par mauvais appareil |
| Backend cible historique | 130 tests reussis avant les derniers ajouts documentaires/CI |
| Dashboard securite/langues | 27 tests reussis |
| TypeScript mobile et dashboard | Reussite |
| Build Vite dashboard | Reussite ; avertissement de gros chunk existant |
| Securite source/JVM | 18 contrats de cycle de vie/file + 18 signatures Kotlin-vers-Node et alterations |
| Autres gates JVM | Access 20 ; stabilite 61, recuperation/protocoles, usage natif 9 ; SSH avec JSch et fixtures localhost |
| Graphes derives du builder Kotlin | 14 graphes acceptes par sing-box desktop 1.12.9 |
| Revue navigateur locale | FR/EN, 390/1440 px, conflits/CAS, brouillons, polling, permissions ; vrais tableaux responsives, mots non fragmentes |
| Typecheck strict global backend | Non vert : erreurs preexistantes hors nouveau code ; bundle/syntaxe du vrai serveur verifies par le parent |
| Premiere verification GitHub | Execution parent 36362254165 sur a29 : builds serveur/dashboard verts, suite generique 1177 tests / 6 echecs, etape PG non atteinte |
| Premier Android GitHub | Execution parent 36362254183 sur a29 : mobile 813 + types, access 20 et lifecycle JVM 18 verts ; echec de resolution esbuild, avant prebuild/APK/libbox final |
| Regressions ciblees apres corrections CI | 132 tests verts, dont reset avec donnees non vides/rollback, recus historiques FR/EN et generation Prisma exacte sans DB |
| Suite generique complete apres corrections CI | 1183 tests, 32 suites, zero echec/skip ; glob complet, quatre workers, aucune connexion DB |
| Mobile apres corrections CI | 813 tests, 108 suites, zero echec/skip |
| Harness natif apres correction CI | 18 contrats JVM + 18 signatures, copie isolee ne disposant que de app-mobile/node_modules, aucun backend |
| PostgreSQL apres corrections CI | 149 checks a nouveau verts sur la base isolee reelle |
| Types/build apres corrections CI | Types dashboard et graphe strict du service reset (vrais types Prisma) verts ; bundles dashboard et vrai server.ts construits |
| Verification GitHub corrigee | Run 36365634711 SUCCESS au 4a17 : builds serveur/dashboard, suite generique 1183 et etape PostgreSQL dediee executee, REAL_POSTGRES_SECURITY_CHECKS=149 |
| Android GitHub corrige | Run 36365634614 SUCCESS au 4a17 : mobile 813, JVM, prebuild, DNSTT, compileDebugKotlin/assembleDebug et compileReleaseKotlin/assembleRelease, signature et upload |
| Verificateur libbox exact en CI | 15 succes reels de libbox.CheckConfig : 14 graphes du bundle et le graphe synthetique de base |
| APK release telecharge | Empreinte, certificat officiel, 38 librairies natives et geodata verifies independamment par le parent |
| Manifeste release reel | Decode depuis l'APK telecharge avec la librairie Android SDK preexistante ; assertions package/version/SDK/service/signer passees |
| R8 / publication / installation | Aucune tache minifyReleaseWithR8 ; mergeDexRelease observe. Etapes de publication Release/SCP/installVPS/purge ignorees ; aucune installation sur appareil |

### Preparation backend ulterieure : preuve locale, pas un nouvel APK

Les controles suivants concernent uniquement le lot backend posterieur au
candidat 477 et au commit documentaire 1911. Ils ne remplacent pas les
identifiants de source, de CI et d'APK historiques ci-dessus.

| Controle du lot backend | Resultat observe |
| --- | --- |
| Suite generique complete, sans DB | 1194 tests, 32 suites, aucun echec/skip apres restauration des dependances de test |
| Contrats directement concernes | 197 tests mobile depuis app-mobile et 69 tests backend depuis la racine ; 266 succes, 20 suites |
| Ancien schema peuple, vrai PostgreSQL isole | 19 checks ; baseline 5ba8f701, huit enregistrements synthetiques dans huit tables, preparation complete deux fois |
| Sauvegarde/restauration reelle | Deux archives PGDMP independantes, empreintes verifiees ; premiere archive effectivement restauree avant les scenarios suivants |
| Compatibilite additive | OID des index adoptes conserve, donnees et metadonnees RBAC stables, SQL securite rejoue deux fois sans enrollment legacy |
| Refus verifies sur vraie DB | Neuf variantes d'index incompatibles, absence du DDL, drift inconnu, unicite nonce manquante et trigger ledger desactive ; erreur backup sans DDL ni travail aval |
| Ancien champ plaintext | Client Prisma 5.22 genere dans un repertoire isole : valeur absente du resultat reel et champ ignore refuse dans VpnProfileSelect |
| Types et bundles | Graphe strict migration/backup avec vrais types Prisma vert ; bundles du vrai server.ts et du gate construits |
| Guard cron et scripts | Pipeline exact git show vers node sous pipefail teste avec depot synthetique : cron dangereux, absent, lecture refusee et fichier absent ; bash -n sur script SSH extrait, jamais execute |
| Actions exclues | Aucun workflow dispatch, acces production, SSH, deploiement, redemarrage VPS, nouvelle construction APK ou installation sur appareil |

Les recus, les deux dumps synthetiques, le client genere et sa fixture de types
ont ete copies du temporaire vers les fichiers persistants prives de la session ;
les empreintes des copies ont ete reverifiees. Premiere archive : 83151 octets,
SHA256 `3c59152cb65c89e99d801543ceef85a70c0588aead75096956ce81eade5a0541`.
Deuxieme archive : 91497 octets,
SHA256 `8de3df15d877932762a2058c3d661ffa4860d33b65912fed9c316c785e0a5d21`.
Ces archives ne sont ni des sauvegardes de production ni des fichiers du depot.

Limite de reproductibilite de l'environnement : des dependances partagees ont
disparu pendant la recette, sans cause etablie. Apres echecs explicites de
resolution, le parent a restaure une capsule backend isolee, sans modifier les
manifestes ni locks du depot. Le catalogue/lock historique ne permettait pas
une installation frozen : la capsule a son propre lock resolu, SHA256
`1046e94b8b2eef999953518f475b89d41a4c35acff84cbefd8590ab55c1ee454`.
Versions verifiees : Prisma/client/engines 5.22.0, TypeScript 5.8.3,
@types/node 22.20.1, esbuild 0.27.3, tsx 4.23.1 et dotenv 17.4.2.
Le complement yaml 2.9.0, deja declare dans app-mobile, a ete restaure
separement apres son propre echec de resolution, avec pnpm 10.34.5,
minimumReleaseAge 1440, scripts desactives et store prive. Son lock persistant
a pour SHA256 `8ddbc373050ecdad2345acc6e9b0146782bba264c39901771c8386865bf0d5b0`.
Les derniers runs complets sont verts ; ce n'est pas une reproduction frozen
du lock original ni une execution GitHub au nouveau SHA backend.

Les lignes se recouvrent : ne pas additionner leurs nombres comme des tests
independants. Le gate desktop local des 14 graphes a utilise
`ENABLE_DEPRECATED_TUN_ADDRESS_X=true`. Le parent les a aussi acceptes sur
son banc avec substitution explicite de la frontiere TUN, sans ce flag.
Ces deux anciens resultats desktop n'etaient pas des appels directs a
`libbox.CheckConfig`. La preuve exacte est desormais fournie separement par
les 15 succes du gate CI au SHA 4a17 ; elle n'est pas une preuve sur telephone.

Les erreurs intermediaires detectees (CAS initial, ecritures d'identite,
drainage imbrique, attribution legacy, polling et boutons mobiles) ont leurs
corrections et regressions correspondantes. Une tentative de revue native
distante a echoue par reseau/modele ; ce n'est pas une revue reussie.

### Corrections des premieres executions CI

Les six assertions generiques echouees ont ete reproduites avant correction.
L'omission du reset etait une regression metier : les deux tables sans FK
n'etaient ni verrouillees ni purgees. Les fixtures contiennent maintenant des
lignes non vides, controlent comptage/purge atomiques, conservation au rollback,
relecture/retry des anciens recus et absence de compteurs inventes.

Le 503 de confidentialite venait du fixture CLIENT sans `vpnClient.findUnique`,
requis par la verification de session. Le delegate manquant est implemente
dans ce fixture ; aucun middleware ou droit metier n'est assoupli. Le test
exige encore 200/liste vide pour les clients legitimes, 404 pour le ticket
public inaccessible, 503 lors d'une vraie panne simulee et 401 pour une
identite enrolee sans preuve.

Les autres contrats obsoletes visent maintenant les trois telechargements
epingles Kotlin/JSON/JSch, le message SSH distinguant formulaire et export
Settings reconnu, la compilation puis execution du verificateur libbox pour
chaque graphe, et l'ordre public-privacy avant `express.json({ verify })`.
Aucune assertion n'est supprimee ni remplacee par une tolerance d'echec.

Le runner Kotlin-vers-Node charge les vraies sources serveur avec
`tsx/cjs/api`, dependance declaree de l'application, au lieu d'esbuild
resolu depuis un backend absent du job Android. La verification a utilise une
copie source sans dossier backend ni node_modules racine.

Un bloqueur CI supplementaire a ete reproduit par le parent avant relance :
Prisma ne resolvait pas `@prisma/client` depuis le schema dans RUNNER_TEMP.
Le schema de travail est maintenant un fichier temporaire sous backend,
nettoye par trap, et le client genere reste dans RUNNER_TEMP. Le nouveau
test execute exactement PREPARE puis le vrai generateur, autoinstall
desactive et URL synthetique loopback port 1, sans connexion DB.

### Identite et preuves du candidat APK 477

[Artefact candidat GitHub, non publie : sxb-vpn-android-apk-477](https://github.com/AbakoDolla/SXB-VPN/actions/runs/36365634614/artifacts/10946688898).
Ce lien designe une archive d'artefact CI, pas le lien de distribution officiel.
Son acces peut exiger une connexion GitHub ; il reste soumis a la retention
des artefacts. Aucune installation sur la production actuelle n'est recommandee.

| Propriete | Valeur verifiee |
| --- | --- |
| SHA du code construit | `4a17c218c65dbd2f83c931f612ced593df54bc5c` |
| Run Android / artefact | `36365634614` / `10946688898` |
| versionName / versionCode | `1.2.1` / `212721743` (precedent publie : `212679036`) |
| Taille de l'APK extrait | 65 283 421 octets |
| SHA256 de l'APK extrait | `2b0be5e4436a8b820cdb92a6ae147a45b59da71b2476cbb72ef9c20bcf23a46b` |
| SHA256 du certificat officiel | `0140c97e6ba6e9bab0d0ce86935562fbdedd80a026de49642764c49dce56f726` |
| Taille de l'archive GitHub | 61 757 336 octets |
| SHA256 de l'archive GitHub | `b412588d184d67a9a0f00bf793f8de50a810d549a50057ccbbb0a1179da00f93` |
| ABI / librairies natives | `arm64-v8a`, `armeabi-v7a` ; 38 librairies controlees |
| Geodata embarquee | Version `20260908094002`, SHA256 `03cbdc0ceab1aa8f0620af77d32e990a3850acb653ffdced8efac137277930b2` |
| Package / minSdk / targetSdk | `com.sxbvpn.mobile` / `24` / `36` |
| Release debuggable | `false` par absence de l'attribut dans le manifeste |
| Service VPN | Unique, non exporte, permission `android.permission.BIND_VPN_SERVICE`, foreground type `specialUse` |
| Certificat embarque | Correspond au signataire officiel attendu |
| BACKEND_SPKI_PINS | `[]` : pinning INACTIF |
| allowBackup | `true`, valeur heritee ; ne pas annoncer une sauvegarde desactivee |
| usesCleartextTraffic / networkSecurityConfig | Attributs absents ; aucun booleen explicite invente |

La signature V1 a ete verifiee localement avec jarsigner et le certificat avec
keytool. La CI a aussi verifie V1 explicitement avec `--min-sdk-version 23`,
puis V2/V3 pour la plateforme du candidat. Le rapport apksigner final indique
V1=false sur ce dernier chemin minSdk 24 : ce resultat ne doit pas etre
confondu avec la verification V1 distincte. Les empreintes de l'archive et
de l'APK extrait sont differentes et ne sont pas interchangeables.

Les recus independants du parent sont `local-verification.json` et
`local-manifest-verification.json`, rapproches de `report\validation.json`,
des rapports de signature et des journaux CI. Le manifeste a ete decode
directement depuis le binaire AndroidManifest.xml de l'APK, sans installation
de SDK supplementaire ; le CLI aapt local etait absent.

## P. Limites et prerequis restants

Les compilations APK, signatures, contenu et manifeste sont maintenant attestes
pour le candidat 477 au SHA 4a17. Aucun ADB, emulateur, telephone ou installation
APK n'a ete utilise. Keystore, handshake TLS/pinning, revoke, radio, reboot et
PCAP restent sans preuve physique. Les outils lourds Go/SDK n'ont pas ete
installes sur le poste enfant ; le gate exact a tourne dans la CI autorisee.

R8 n'a pas ete execute : aucune obfuscation renforcee n'est revendiquee.
Le manifeste conserve allowBackup=true et confirme des pins vides.
Les SPKI publics approuves et leur rotation restent a fournir puis verifier.
Ces limites ne sont pas masquees par le succes de compilation.

L'etape PostgreSQL ignoree au premier essai a ete effectivement executee et
reussie lors du run 36365634711. La migration locale peuplee/idempotente reste
une preuve distincte du bootstrap CI. Tous les dispatchs ont ete effectues par
le parent ; la session enfant n'a effectue aucun dispatch manuel GitHub.

Le candidat n'est pas une publication : aucun deploiement backend, fusion,
release officielle ou installation VPS/appareil n'a eu lieu. La migration
additive, le backend compatible sur tous les noeuds et l'autorisation
d'enrolement sont requis avant usage de la nouvelle securite. Ne pas installer
ce candidat contre la production actuelle sans cette preparation.

La securite suppose que serveur, secrets serveur et Keystore ne sont pas
compromis. Une application compromise peut tenter d'utiliser la cle sur place,
falsifier ses observations/compteurs ou omettre des rapports. Aucun secret
embarque ne rend magiquement l'application inviolable.

## Q. Commandes locales

PowerShell, depuis la racine du checkout. Utiliser des dependances deja
installees et possedees par ce checkout. Ne jamais installer/generer a travers
une junction `node_modules` appartenant a un autre worktree. Le desaccord
preexistant du catalogue pnpm n'a pas ete corrige en regenerant le lockfile.

Preparation backend (uniquement apres autorisation explicite de l'operateur ;
ces commandes de deploiement n'ont pas ete executees contre la production) :

Preflight MANUEL : `gh workflow run vps-audit.yml --ref <SHA-approuve> -f mode=backend-preflight`.
Lecture seule, sans audit historique/DB/installation : SHA checkout (pas preuve du bundle actif), outils, espace, permissions du repertoire existant et daemon PM2 (pas sante backend), puis guard cron exact ; observations uniquement, readiness non evaluee, aucune sauvegarde creee.

```powershell
# Lecture seule ; DATABASE_URL vient de l'environnement ou du .env du checkout.
node scripts\backend-migrate.cjs check
# Ecritures DB : sauvegarde obligatoire hors du checkout, DDL et gate readonly.
$env:SXB_MIGRATION_BACKUP_DIR='<repertoire prive absolu hors checkout>'
node scripts\backend-migrate.cjs prepare
```

Le workflow utilise `$HOME/sxb-backups`. Node et les dependances backend
declarees (tsx, dotenv, Prisma 5.22) ainsi que psql, pg_dump et pg_restore
compatibles doivent deja etre disponibles. PSQL_BIN, PG_DUMP_BIN et
PG_RESTORE_BIN permettent des chemins explicites. Une erreur d'outil,
permission, archive, migration, drift ou protection ledger arrete le gate.
La restauration reste une decision operateur : arreter les ecritures,
verifier le recu et les donnees depuis le dump, evaluer les ecritures survenues
depuis la sauvegarde et la compatibilite des sessions avant tout retour arriere.

Contrats de migration et regressions directement concernees, sans DB :

```powershell
node --test scripts\tests\backend-migration.test.mjs scripts\tests\reset-backup.test.mjs scripts\tests\parite-schemas-prisma.test.mjs scripts\tests\configuration-delivery.test.mjs
Push-Location app-mobile
node ..\backend\node_modules\tsx\dist\cli.mjs --test tests\regression-critical-flows.test.ts
Pop-Location
node backend\node_modules\tsx\dist\cli.mjs --test server\tests\reseller-lifecycle.test.ts
```

Le contrat mobile lit ses fichiers relativement a app-mobile : ne pas combiner
ces deux commandes en un lancement depuis la racine. Si les dependances de
test sont isolees, NODE_PATH doit inclure leurs repertoires node_modules
(backend et complement YAML dans cette recette), sans installation dans
les junctions partagees.

Recette PG REELLE, avec outils deja presents et base synthetique dediee :

```powershell
$env:SXB_ROLLOUT_TEST_RESET='1'
$env:SXB_ROLLOUT_TEST_CONNECTION_FILE='<JSON prive contenant url, cible 127.0.0.1 et base sxb_rollout_child_<hex> ou sxb_rollout_parent_<hex>>'
$env:SXB_ROLLOUT_BASELINE_SQL='<baseline SQL historique 5ba8f701>'
$env:SXB_ROLLOUT_PG_BIN='<repertoire des outils PostgreSQL existants>'
node scripts\tests\backend-migration-postgres.integration.mjs
```

Ce runner reinitialise UNIQUEMENT le schema de cette base explicitement
autorisee ; il ne charge aucun .env de production. Les sauvegardes et le recu
sont gardes dans le repertoire temporaire indique ; copier les preuves utiles
vers les artefacts persistants prives avant nettoyage de ce temporaire, puis
reverifier les empreintes des archives. Il genere son client dans ce repertoire
et supprime son schema temporaire sous backend, sans installer ni generer dans
les dependances partagees. Ne jamais employer une base metier.

Verification mobile :

```powershell
Push-Location app-mobile
node node_modules\typescript\bin\tsc --noEmit --pretty false
npm run test:regression
Pop-Location
node --test scripts\tests\security-center.test.mjs scripts\tests\dashboard-i18n.test.mjs
```

La suite complete importe aussi le backend et exige un client Prisma genere.
Sur ce poste, un preload prive de session redirige vers le client genere
isole ; aucun changement dans les dependances du parent n'est necessaire.

PostgreSQL : fournir dans l'environnement, sans les afficher, une URL de
test dediee `SXB_SECURITY_TEST_DATABASE_URL` et le chemin absolu du client
genere `SXB_SECURITY_PRISMA_CLIENT`. Le runner refuse une cible non loopback
ou dont le nom ne contient pas `security_impl`/`security_upgrade`, ainsi que
l'absence de configuration. Il ne transforme jamais cette absence en skip.

```powershell
node scripts\tests\security-layer-postgres.integration.mjs
```

Pour appliquer le SQL sur une base locale prealablement preparee avec le
schema historique, configurer `DATABASE_URL` uniquement vers cette base :

```powershell
if (-not $env:DATABASE_URL -or ([Uri]$env:DATABASE_URL).Host -notin @('127.0.0.1', 'localhost')) {
  throw 'Base locale isolee obligatoire'
}
node backend\node_modules\prisma\build\index.js db execute --schema prisma\schema.prisma --file prisma\security-layer.sql
```

Sur un checkout a dependances propres, la regeneration normale est :

```powershell
node backend\node_modules\prisma\build\index.js generate --schema prisma\schema.prisma
node backend\node_modules\prisma\build\index.js generate --schema backend\prisma\schema.prisma
node scripts\verify-prisma-runtime.cjs
```

Avec des dependances partagees, copier le schema dans un repertoire temporaire
situe sous backend pour resoudre le generateur installe, et lui donner un
`generator.output` absolu isole hors node_modules, comme l'etape CI ; ne pas
executer ces generations normales sur les junctions de cette session.

Rejouer les regressions generiques, sans DB (le test de preparation Prisma
genere seulement un client temporaire et interdit l'autoinstall) :

```powershell
$env:SXB_SECURITY_TEST_DATABASE_URL=''
$env:SXB_SECURITY_PRISMA_CLIENT=''
$env:PRISMA_SKIP_POSTINSTALL_GENERATE='true'
$env:PRISMA_GENERATE_SKIP_AUTOINSTALL='1'
$env:CHECKPOINT_DISABLE='1'
node --experimental-strip-types --test --test-concurrency=4 'scripts/tests/*.test.mjs'
```

Dans cette recette a dependances restaurees, NODE_PATH fournit la capsule
backend et le complement YAML ; NODE_OPTIONS charge le preload Prisma prive
avec `--require="<chemin absolu du preload>"`. Ce preload ne simule pas Prisma :
il redirige la resolution vers le vrai client 5.22 genere hors des dependances
partagees. Un checkout avec son propre client genere n'en a pas besoin.

Build et preview de console sans proxy production :

```powershell
$Artifacts = Join-Path $env:TEMP ('sxb-security-ui-' + [guid]::NewGuid().ToString('N'))
$env:SXB_API_PROXY_TARGET = 'http://127.0.0.1:65529'
Push-Location artifacts\sxb-dashboard
node node_modules\typescript\bin\tsc --noEmit --pretty false
node node_modules\vite\bin\vite.js build --configLoader runner --outDir $Artifacts
Pop-Location
$env:SXB_SECURITY_DASHBOARD_BUILD = $Artifacts
node scripts\tests\security-dashboard-preview.mjs
```

URL de cette fixture : `http://127.0.0.1:4189`, mot de passe de fixture
`synthetic-fixture`. Elle affiche son statut synthetique, ne contacte aucune
base et ne simule pas une preuve PostgreSQL. Le proxy Vite historique vise
la production par defaut : ne pas demarrer le dashboard sans override local.

Demarrage du vrai backend pour une recette deja configuree localement :

```powershell
$Repo = (Get-Location).Path
$env:NODE_PATH = Join-Path $Repo 'backend\node_modules'
$env:NODE_ENV = 'development'
$env:PORT = '3000'
# DATABASE_URL, JWT_SECRET, REFRESH_SECRET, ENCRYPTION_KEY et services annexes
# doivent deja designer uniquement des ressources/secrets de recette locale.
if (-not $env:DATABASE_URL -or ([Uri]$env:DATABASE_URL).Host -notin @('127.0.0.1', 'localhost')) {
  throw 'Base locale isolee obligatoire'
}
foreach ($Name in @('JWT_SECRET', 'REFRESH_SECRET', 'ENCRYPTION_KEY')) {
  if (-not [Environment]::GetEnvironmentVariable($Name)) { throw "Configuration locale manquante : $Name" }
}
node app-mobile\node_modules\tsx\dist\cli.mjs server.ts
```

L'entree renforcee est **`server.ts` a la racine**. Le `backend\server.ts`
historique n'est pas un simple alias : `cd backend; npm run dev` ne doit pas
etre presente comme demarrant automatiquement cette implementation.
Pour Metro, depuis `app-mobile`, apres configuration d'une origine API HTTPS
de recette avec certificat systeme valide :
`node node_modules\expo\bin\cli start --offline`.
Ces recettes de demarrage ne constituent pas un test de connexion en production.

Gate JVM de securite, avec chemins vers les outils deja disponibles :

```powershell
# KOTLINC : chemin absolu de kotlinc.bat ; SXB_JSON_JAR : org.json 20240303.
# JAVA : chemin absolu de java.exe si java n'est pas dans PATH.
Push-Location app-mobile
node tests\run-device-security.cjs
Pop-Location
```

## R. Commandes APK et gate de livraison

Prerequis pour reproduire localement (non installes sur le poste enfant) :
JDK 17, SDK Android 36/build-tools 36.0.0,
NDK 27.1.12297006, moteurs/ressources natifs approuves de la chaine existante,
et configuration de signature release securisee. Ne pas utiliser les binaires
ou scripts de `protocols.zip`.

Dans un checkout de recette possedant son dossier Android et ses dependances :

```powershell
Push-Location app-mobile
node node_modules\expo\bin\cli prebuild --platform android --no-install
.\android\gradlew.bat -p .\android :app:assembleDebug :app:assembleRelease --no-daemon
& "$env:ANDROID_HOME\build-tools\36.0.0\apksigner.bat" verify --verbose --print-certs .\android\app\build\outputs\apk\release\app-release.apk
& "$env:ANDROID_HOME\build-tools\36.0.0\aapt.exe" dump xmltree .\android\app\build\outputs\apk\release\app-release.apk AndroidManifest.xml
Pop-Location
```

Un succes Gradle seul ne prouve ni le bon signataire release, ni l'execution
de R8. Verifier les sorties/manifeste, les ABI/librairies, le certificat attendu,
le versionCode et la configuration effective de minification/mapping.
Le workflow existant reste la recette complete de signature, packaging et
validation ; les commandes courtes ci-dessus n'en remplacent pas les prerequis.

Le job Android ajoute `assembleDebug`, verification de signature et rapport
de manifeste **uniquement hors `main`**. `assembleRelease` et ses controles
existants restent en place. Les conditions de publication/deploiement `main`
ne sont pas modifiees. La proposition empilee cible PR #89 ; le workflow
`verification-pr` filtre toujours les PR vers `main`, donc son execution sur
cette branche reste a coordonner manuellement avec le parent.
Les executions effectuees et leur SHA source sont consignes en O ; le commit
ulterieur de preparation backend ne pretend pas etre un nouveau build APK.

## S. Android / Expo

Le plugin installe les nouveaux helpers natifs, les metadonnees publiques de
certificats/pins/origine, le constructeur HTTP React Native et les regles R8
necessaires. Le bridge expose l'identite publique, la signature des requetes
et les evenements durables. Le service existant et son ordonnancement restent
les seuls responsables du tunnel. Aucun nouveau VpnService, package blacklist,
permission de capture, obligation Play ou contournement TLS n'est introduit.

Un debug APK a son propre certificat : sa construction reussie ne prouve pas
qu'il est signe par la cle officielle release. Le certificat du candidat
release 477 a, lui, ete verifie. La presence de regles R8 dans le plugin ne
signifie pas que R8 a tourne : le build observe utilise mergeDexRelease.
Un test physique de Keystore,
pinning, revoke, reboot et reseau reste necessaire avant revendication device.

## T. Backend / exploitation

`server.ts` capture les octets bruts du JSON pour la verification de signature.
Le middleware/principal ne confond pas un token mobile avec le role operateur
du titulaire en base. Les routes montees sont celles reellement testees :
notamment `server\routes\users.ts`, pas l'ancien repertoire `users\index.ts`.

Nonce, generation, enrolement, refresh, connexion et mutation protegee utilisent
les transactions PostgreSQL existantes avec ordre de verrouillage coherent.
La console reutilise Setting, SecurityEvent, AuditLog et ses protections.
Le nettoyage des nonces expires est borne/indexe ; aucune infrastructure Redis
ni nouveau service externe n'est impose.

Le nouveau service PostgreSQL de `verification-pr` est jetable, loopback, avec
identifiants synthetiques sans autorite de production. Son etape genere un
client dans `runner.temp` et execute le runner d'integration explicitement.
Les globs de tests ordinaires et `deploy-vps.yml` restent sans ce besoin de DB.
Aucune migration ni ecriture en production/VPS, fusion, publication ou
installation sur appareil n'a ete effectuee pendant cette intervention.
