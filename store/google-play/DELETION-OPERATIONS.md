# Traitement des demandes SXB VPN

**Procédure à faire approuver et exploiter avant soumission.** Le formulaire livré reçoit des demandes dans `SupportTicket`. Il n'exécute aucune suppression. Aucun délai légal, période de sauvegarde ou exception commerciale n'est inventé ici. L'exploitant doit déterminer les obligations applicables, les publier, nommer un responsable et tester un traitement complet sur une fixture avant d'activer `deletionProcessOperational`.

## Réception et vérification

1. Un membre autorisé du support consulte `/api/support` et repère les titres `[PRIVACY]`. Il lit la description JSON en texte, jamais comme HTML. Il place le dossier en `in_progress` et note uniquement les étapes utiles.
2. Il répond à l'e-mail fourni depuis un canal confirmé. Ne révéler aucune existence de compte, autre client ni donnée de facture avant vérification. Une adresse de réponse non vérifiée ne prouve rien, pas plus qu'un `deviceId`, un téléphone, une IP ou un token trouvé dans les anciennes routes publiques.
3. Déterminer un mécanisme proportionné de vérification : contrôle du canal **déjà vérifié indépendamment** associé au client, ou confirmation confidentielle via l'opérateur/revendeur et preuve de relation de service adaptée. Si aucun canal fiable n'existe, escalader au responsable ; ne pas improviser un effacement sur simple déclaration. Ne jamais demander mot de passe, code VPN utilisable, clé privée, pièce d'identité dans le formulaire libre. Le contrôle d'une adresse nouvelle ne suffit pas à établir le titulaire d'un compte historique.
4. Confirmer si la demande vise un appareil, des données précises ou le compte individuel complet. Pour un compte individuel, couvrir tous ses appareils et données associées, pas seulement le dernier identifiant. Expliquer la fin de l'accès, les éventuelles démarches d'abonnement réellement nécessaires et les exceptions légales applicables ; ne pas inventer de condition de paiement pour supprimer.

## Distinguer client et propriétaire historique

Un `VpnClient` possède un `userId` et éventuellement un `resellerId`. Des clients historiques partagent le `User` d'un revendeur. **Ne jamais exécuter `User.delete` sur ce revendeur pour supprimer un client** : cascade destructrice sur les autres clients, rôles et données. Ne pas effacer globalement `SupportTicket`, `AuditLog` ou `PushToken` avec ce seul `userId`.

Construire et faire relire une sélection explicite des `clientId`, `subscriptionId`, `deviceId`, comptes moteurs et pseudonymes concernés. Contrôler `User.role`, l'existence d'une fiche `Reseller`, tous les autres `VpnClient` et droits reliés. Un User n'est supprimable qu'après preuve qu'il s'agit bien du compte individuel visé, non partagé et non privilégié. Si la demande porte sur un compte revendeur lui-même, elle relève d'un processus distinct.

## Matrice d'effacement à appliquer

| Données | Sélection et action après autorisation |
|---|---|
| Accès et sessions | Arrêter/révoquer les sessions et identifiants du client visé, y compris l'accès réel aux endpoints VPN et xPanel s'il existe. La suspension seule n'est pas l'effacement. Ne pas supprimer un profil de serveur partagé. |
| `VpnClient`, `TokenSXB`, `Subscription`, `SubscriptionDevice`, `ActivationSession` | Traiter les dépendances liées au client ; les cascades connues aident mais ne couvrent pas toutes les catégories. Confirmer la suppression des données, pas uniquement un changement `status`. |
| `AppRegistration` | Effacer les enregistrements liés par client et appareils confirmés, y compris historiques/pending attribuables. La FK `onDelete: SetNull` laisse sinon les informations personnelles en place. |
| `PushToken` et Firebase | Sélection par utilisateur **et appareils confirmés**, jamais tout un revendeur. Retirer les jetons du backend et traiter la suppression d'installation/token auprès du prestataire selon les mécanismes disponibles, avec attestation. L'app désinstallée n'est pas une excuse pour ne traiter que le stockage local. |
| `MobileHealthDevice` / `MobileHealthReport` | Calculer les pseudonymes avec `pseudonymizeMobileDevice(userId, deviceId, secret)` dans l'environnement autorisé, sans exporter secret ni identifiants ; traiter aussi les anciennes clés/pseudonymes si rotation. Effacer les fiches concernées ; rapports en cascade. Ce modèle n'a pas de FK vers le client : supprimer le client ne le supprime pas automatiquement. |
| `TrafficUsage`, `VpnLog` | Filtrer par client/appareils/comptes moteurs confirmés. Ces identifiants sont des chaînes sans FK : une cascade client ne suffit pas. Retirer les lignes ou les données identifiantes selon l'obligation approuvée, pas selon une hypothèse de conservation illimitée. |
| Comptes SSH/Xray/Sing-box/xPanel | Identifier le compte technique réellement lié, révoquer les credentials chez le moteur et retirer les données uniquement de ce client. Certaines relations sont restrictives/optionnelles ; traiter avant la suppression du parent. Prouver l'action au niveau VPN réel, pas seulement dans PostgreSQL. |
| Vouchers et grand livre revendeur | `redeemedClientId` peut être mis à null par cascade mais les autres références ou textes demeurent. Définir les références à supprimer/anonymiser et les enregistrements financiers légalement conservés avec durée et motif. Ne pas réécrire arbitrairement le grand livre partagé ou libérer du quota commercial au détriment des autres clients. Escalader les obligations contradictoires. |
| `AuditLog`, proxy/API/OS/VPN logs | Rechercher les liens fiables au sujet dans les champs et actions (certains codes historiques apparaissent en texte). Ne pas attribuer une IP partagée à une personne par défaut. Une FK `SetNull` ne garantit pas l'anonymat des messages. Traiter rotation/purge et exceptions documentées chez chaque opérateur. |
| Support et coordonnées | Retirer les données du sujet dans les tickets individuels/publics après traitement ; conserver seulement la preuve minimale légalement justifiée et sa durée. Ne pas supprimer les tickets d'autres clients d'un User partagé. |
| Sauvegardes et prestataires | Documenter période d'expiration, accès restreint, impossibilité éventuelle d'effacement granulaire et réapplication des suppressions après restauration. Envoyer les demandes aux prestataires et suivre leur résultat. Les périodes réelles restent un préalable humain. |
| Stockage mobile | Expliquer suppression locale des profils/données via les contrôles Android. Un effacement serveur ne garantit pas l'effacement de tout appareil hors ligne ou d'une copie exportée ; ne pas demander la réinstallation pour accepter la demande. |

L'API administrative de suppression d'un client n'est pas une preuve d'effacement complet de cette matrice. Le runbook ne fournit volontairement aucune commande SQL générique destructrice. Dans un environnement autorisé, l'opérateur doit préparer une transaction ciblée et revue, gérer les actions externes non transactionnelles avec reprise, puis contrôler qu'aucune donnée attribuable non justifiée ne demeure. Ne pas exporter l'ensemble de production pour une demande individuelle.

## Clôture

Confirmer au demandeur **après exécution** les catégories effacées, les exceptions conservées, leur justification et leur durée. En cas d'échec ou d'identité insuffisante, expliquer le blocage sans révéler les données recherchées ; ne jamais marquer « supprimé » sur un simple enregistrement, logout ou gel. Suivre le dossier jusqu'au résultat réel, puis réduire les données de suivi et celles de la demande selon la politique validée.

Avant mise en service, exercer au minimum : client individuel multi-appareils, client partageant le User d'un revendeur, demande sans app installée, appareil ancien sans activité, pseudonyme health, logs orphelins, panne d'un prestataire, sauvegarde/restauration et impossibilité de vérifier l'identité. Constater que les clients voisins et le compte revendeur restent intacts.
