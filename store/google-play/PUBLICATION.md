# SXB VPN - dossier Google Play

**Brouillon de publication, non autorisé à la soumission.** Préparé le 9 septembre 2026 depuis `5d2fd8adb4542ae012d65f63194df9e64f305d7f`. Les changements mobiles de consentement, de transport et du build doivent être rapprochés du binaire final ; ce dossier ne les certifie pas. Aucun compte, paiement, acceptation juridique, dépôt Play, push, déploiement ni PR n'est effectué par ce dossier.

## Fichiers à remettre à l'exploitant

| Fichier | Usage |
|---|---|
| `listing.fr.json`, `listing.en.json` | Titre, description courte, description complète à saisir dans Play Console après approbation. Limites : 30 / 80 / 4 000 caractères. |
| `declarations.json` | Réponses proposées Data safety, VpnService, service premier plan `specialUse`, accès examinateur et distribution. Format éditorial SXB, pas un import officiel Google. |
| `readiness.json` | Confirmations humaines bloquantes et emplacement d'une preuve non secrète pour chacune. Aucun drapeau n'est validé par défaut. |
| `assets/icon-512.png`, `assets/feature-1024x500.png` | Branding dérivé de `public/logo-512.png`, pas des captures d'écran. |
| `CAPTURE.md` | Captures réelles et vidéos restant à réaliser sur la version publiée. |
| `DELETION-OPERATIONS.md` | Réception et traitement manuel des demandes, périmètre de suppression et garde-fous comptes revendeurs. |
| `PUBLIC-ROUTES.md` | Intégration backend, configuration et contrat du formulaire public. |

`node store\google-play\validate.mjs` contrôle le format, les limites, les références de preuves et les PNG. **`node store\google-play\validate.mjs --submission` doit échouer tant que les confirmations et la configuration publique sont incomplètes.** Il ne crée ni ne publie rien. Le parent peut le raccorder à sa préparation de release ; ce dossier ne modifie pas les workflows. Ce garde-fou vérifie les attestations enregistrées, pas l'authenticité d'un compte Console ni la conformité du service déployé.

## Conditions préalables non confirmées

L'exploitant doit fournir son identité légale, une adresse e-mail publique réellement surveillée, les informations d'organisation et les éléments D-U-N-S. Google indique qu'une app approuvée pour `VpnService` doit choisir un **compte organisation** ; un type de compte personnel ne doit pas être choisi par défaut pour contourner ce prérequis. La Console, l'organisation, les droits de publication et le D-U-N-S ne sont pas vérifiés ici. Ne recopier aucune adresse de démonstration du code.

Avant soumission, l'exploitant doit approuver les bases et finalités de traitement applicables, l'identité de chaque prestataire, les lieux/transferts, les périodes de conservation, les exceptions légales et le traitement réel des demandes. Le formulaire est un canal d'entrée et ne remplace ni le contact e-mail obligatoire de la fiche Play ni un support effectivement opérationnel.

La page publique affiche un avertissement de prépublication tant que sa configuration n'est pas revue. Son HTTP 200 rend l'information lisible, **pas juridiquement complète**. Ne fournir cette URL comme politique finalisée dans Console qu'après relecture du texte, mise à jour des mentions encore incertaines, configuration des coordonnées et constats d'accès public FR/EN. Un HTTP 503 sur le POST signale un échec de réception, jamais une demande acceptée.

## Réponses à rapprocher de la version finale

Le fonctionnement proposé est **consumption-only** : accès à des forfaits existants par codes, sans flux d'achat mobile identifié. Cela ne signifie pas que le service est gratuit. L'exploitant choisit prix de téléchargement, pays, audience, classification de contenu, catégories et modèle commercial. Aucun lien de paiement ne doit être ajouté aux ressources de confidentialité pour contourner les règles de facturation.

Les chemins de consentement du binaire final doivent être démontrés : information VPN dédiée dans le parcours normal, refus réel, retour possible au consentement, action affirmative, puis autorisation Android. Les permissions Android ne remplacent pas l'information et le consentement requis. Les diagnostics optionnels et FCM ne peuvent être déclarés facultatifs que si tous les chemins, notamment l'initialisation Firebase native et l'arrière-plan, respectent les choix, sur **tous** les artefacts Play actifs.

L'API collecte IP, identifiants, volumes et sessions. Les diagnostics pseudonymisés sont une collecte ; les configurations exclusivement locales ne le sont pas par ce seul stockage. Les résolveurs DNS (notamment Cloudflare selon le chemin), les endpoints VPN, l'hébergeur et Google FCM doivent être inventoriés. Une exemption de « partage » Data safety pour un prestataire n'autorise pas à prétendre « aucun tiers ». Le schéma technique health n'accepte pas de logs bruts, mais des journaux d'audit historiques peuvent contenir des codes de compte.

Le parent corrige l'ancienne route d'enregistrement publique exposant des détails par téléphone/appareil. Les références de `declarations.json` décrivent le commit source ci-dessus : après intégration, mettre à jour les preuves et ne pas attribuer l'ancien comportement corrigé à la nouvelle version. Ne jamais utiliser un téléphone ou identifiant publiquement fourni comme preuve d'identité.

## Accès de l'examinateur

Dans Play Console **App content > App access**, un opérateur autorisé doit fournir un compte/code **dédié à la revue**, non administrateur, stable et utilisable pour toutes les fonctionnalités verrouillées. Définir un forfait suffisant, sans expiration ni verrouillage au premier appareil qui bloque la revue. Un code valide, une procédure d'import/déverrouillage et des instructions en anglais doivent permettre activation, vraie connexion, déconnexion, consultation de quota et accès aux pages publiques. Vérifier les éventuelles restrictions régionales et réseau.

Conserver les véritables codes dans Console ou un coffre autorisé, jamais dans Git, le texte de cette fiche, une capture, un log CI ou une vidéo publique. Ne fournir aucun accès OWNER/ADMIN, dashboard privilégié ou SSH root. Ne pas inventer d'identifiant examinateur. La classification « accès restreint » et les instructions restent `reviewed=false` jusqu'à l'essai réel.

## Artefact et signature

Le parent/build doit fournir l'AAB final, le nom de package stable, un `versionCode` supérieur et la preuve du niveau cible API **36** (règle applicable à compter du 31 août 2026 selon la source cible). Vérifier également les règles de compatibilité natives applicables, dont les pages mémoire 16 Ko, sur les bibliothèques réellement embarquées. Ne pas déduire ces résultats d'un manifeste source.

Pour préserver la mise à jour des APK existants, l'opérateur doit prendre la décision Play App Signing en conservant la clé de signature existante lorsque nécessaire ; choisir une nouvelle clé sans migration planifiée peut rompre les mises à jour. Une clé d'upload n'est pas la clé de signature de l'application. Aucune clé ni mot de passe ne figure dans ce dossier. La session build/parent possède cette intégration.

## Sources officielles

Références consultées le 9 septembre 2026, directement ou vérifiées par le parent. Reconsulter avant soumission, les règles et les formulaires peuvent changer.

| Sujet | Source |
|---|---|
| VpnService, chiffrement jusqu'à l'endpoint, consentement, vidéos ≤ 90 secondes | https://support.google.com/googleplay/android-developer/answer/12564964?hl=en |
| User Data, transparence et consentement | https://support.google.com/googleplay/android-developer/answer/10144311?hl=en |
| Data safety, pseudonymes, tiers, IP et tous les artefacts actifs | https://support.google.com/googleplay/android-developer/answer/10787469?hl=en |
| Définition du compte, parcours web et suppression associée | https://support.google.com/googleplay/android-developer/answer/13327111?hl=en |
| Déclarations foreground service | https://support.google.com/googleplay/android-developer/answer/13392821?hl=en |
| Type de compte organisation pour VpnService et D-U-N-S | https://support.google.com/googleplay/android-developer/answer/13634885?hl=en |
| Identité et coordonnées développeur | https://support.google.com/googleplay/android-developer/answer/13628312?hl=en |
| Création de fiche, métadonnées et e-mail de support obligatoire | https://support.google.com/googleplay/android-developer/answer/9859152?hl=en |
| PNG, dimensions, captures et vidéos de fiche | https://support.google.com/googleplay/android-developer/answer/9866151?hl=en |
| Icône Play | https://developer.android.com/distribute/google-play/resources/icon-design-specifications |
| Niveau API cible | https://support.google.com/googleplay/android-developer/answer/11926878?hl=en |
| Play App Signing et clé existante | https://developer.android.com/studio/publish/app-signing |
| Compatibilité pages 16 Ko | https://developer.android.com/guide/practices/page-sizes |
| Apps consumption-only et facturation | https://support.google.com/googleplay/android-developer/answer/10281818?hl=en |
| Firebase Messaging, Installations et données SDK Android | https://firebase.google.com/docs/android/play-data-disclosure |
| Confidentialité et sous-traitants Firebase | https://firebase.google.com/support/privacy |
| DNS public Cloudflare, à rapprocher du transport retenu | https://developers.cloudflare.com/1.1.1.1/privacy/public-dns-resolver/ |
