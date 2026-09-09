# Ressources publiques de confidentialité

## Intégration dans le backend actif

Le parent doit importer le routeur par défaut depuis `./server/routes/public-privacy` et ajouter `app.use(publicPrivacyRouter)` dans `server.ts`, **après Helmet mais avant les parseurs globaux `express.json()` / `express.urlencoded()`, les gardes de maintenance et le middleware SPA/static**. Le parseur du formulaire contrôle lui-même le type et la taille. Il ne faut pas monter ce routeur sous `/api` ni le protéger par `requireAuth`. Le parent est propriétaire de cette modification ; ce dossier ne touche pas `server.ts`.

Le logger HTTP peut être placé avant le routeur s'il ne journalise pas de corps/cookies/secrets. Le reverse proxy doit transmettre l'origine navigateur inchangée, appliquer HTTPS et une configuration `trust proxy` correspondant aux seuls proxys de confiance. Ne pas publier le port Express directement derrière un `trust proxy=1` si l'appelant peut fabriquer l'IP source.

| Méthode et chemin | Contrat |
|---|---|
| `GET /privacy?lang=fr` ou `en` | HTML autonome, sans auth ni DB requise, pas de script ni ressource tiers. Contenu, coordonnées si configurées, lien vers le formulaire. |
| `GET /data-deletion?lang=fr` ou `en` | HTML autonome avec étapes, périmètre et formulaire. Sans application installée. Cookie temporaire de protection CSRF. |
| `POST /data-deletion?lang=fr` ou `en` | Seulement `application/x-www-form-urlencoded`. Crée un `SupportTicket`, jamais une suppression automatique. |

Sans paramètre reconnu, `Accept-Language` négocie FR/EN, puis français par défaut. Les liens mobiles peuvent garder les URL canoniques sans paramètre ou fournir la langue. Les pages sont lisibles pendant la maintenance si l'ordre de montage ci-dessus est respecté. Le formulaire a toujours besoin de la base : une base hors service donne une erreur explicite, pas un fallback mémoire.

Champs POST : `lang` (`fr|en`), `csrf`, `kind` (`deletion|privacy`), `email` (max 254), `deviceId` facultatif (`SXB` puis 6 à 80 lettres majuscules/chiffres, max 83), `message` (10 à 2 000), `website` vide (piège antispam), `acknowledge=yes`. Les propriétés inconnues, clés dupliquées sous forme de tableaux, caractères de contrôle et formats évidents de code/clé/configuration sont refusés. Ne pas demander de mot de passe ou de justificatif sensible. Aucun filtre ne garantit que tout secret saisi en texte libre sera détecté : le support doit en limiter l'accès et le retirer au traitement.

La validation exige `Origin: https://vpnsxb.afrihall.com` et, si fourni, `Sec-Fetch-Site: same-origin`. Ce choix est intentionnel : un autre hostname ne peut pas poster sans adaptation explicite. La page d'essai locale peut être lue, mais un navigateur sur `localhost` n'est pas autorisé à soumettre au serveur canonique. Les tests HTTP fixture reproduisent les en-têtes canoniques sans contacter ce domaine.

CSRF signé HMAC-SHA256 à usage séparé via `config.JWT_SECRET`, lié au cookie et à un horodatage ; cookie `__Host-sxb-privacy-csrf`, `HttpOnly`, `Secure`, `SameSite=Strict`, chemin `/`, sans domaine, en production. En test/développement : nom sans préfixe `__Host`, pas de `Secure`. Durée 20 minutes, délai minimal de saisie 2 secondes. Le cookie est effacé au succès ; ce n'est pas un jeton transactionnel à usage unique (un replay manuel reste soumis aux limites).

Limites : 16 Kio décompressés maximum, corps compressés refusés, 10 paramètres maximum, **5 POST par IP/sous-réseau IPv6 et par heure**, y compris les tentatives invalides, en-tête `Retry-After` sur 429. Le mécanisme réutilise `express-rate-limit`. Les compteurs sont **en mémoire par processus**, donc réinitialisés au redémarrage et multipliés par les workers. Avant mise en ligne à plusieurs instances, appliquer aussi une limite commune au reverse proxy ou un store partagé existant ; le piège antispam et le délai ne remplacent pas une défense distribuée. Les GET ne sont pas bloqués par le quota de soumission. Pas de CAPTCHA tiers.

Réponses HTML : 202 uniquement après création persistée, 400 validation, 403 CSRF/origine, 413 taille/paramètres, 415 mauvais type, 429 débit, 503 persistance indisponible. Pas d'identifiant de ticket, d'e-mail, d'appareil ou d'existence de compte dans les réponses. Le formulaire ne conserve pas/réaffiche pas la saisie après erreur. Les erreurs DB ne journalisent pas l'exception Prisma susceptible de contenir le message.

## Configuration publique

Toutes ces valeurs sont à renseigner par l'exploitant, **pas à deviner** :

| Variable | Signification |
|---|---|
| `SXB_PRIVACY_OPERATOR_NAME` | Identité légale de l'exploitant, 200 caractères max. |
| `SXB_PRIVACY_CONTACT_EMAIL` | Contact public réellement exploité et valide, 254 max. |
| `SXB_PRIVACY_RETENTION_NOTE_FR` / `_EN` | Durées applicables, déclencheurs, sauvegardes et exceptions justifiées, 4 000 max chacune. |
| `SXB_PRIVACY_PROCESSORS_NOTE_FR` / `_EN` | Prestataires, lieux, rôles, transferts et garanties applicables, 4 000 max chacune. |
| `SXB_PRIVACY_REVIEWED` | `false` par défaut ; `true` uniquement après validation juridique et opérationnelle du contenu entier. |

Les chaînes sont affichées comme texte HTML échappé, jamais du HTML de configuration. Une configuration invalide est une erreur explicite au démarrage. `true` sans les six champs précédents est refusé. Un drapeau n'est pas une preuve : le contenu de `server/resources/privacy-content.json` doit lui aussi être relu et les mentions « à confirmer » résolues avant finalisation. Un champ ne doit pas contenir « no logs » pour contredire les pratiques constatées.

En configuration incomplète, les GET restent en HTTP 200 avec avertissement prépublication et identité non confirmée. Ce choix permet l'accès à l'information et au mécanisme réel de demande sans transformer un manque juridique en fausse URL conforme. Le gate `--submission` reste bloquant.

## Persistance et accès

Aucune migration ni modification de schéma. `SupportTicket` existant : `userId=null`, `status=open`, `priority=medium`, titre `[PRIVACY] Deletion request` ou `[PRIVACY] Data request`, `clientName=Public privacy request`. `description` est du JSON : source, version de texte, langue, objet, e-mail de réponse, appareil facultatif, message, accusé d'information, `identityVerified=false`. Les dates proviennent de Prisma. Ni le corps, ni l'IP, ni le cookie ne sont copiés dans un journal applicatif par ce routeur.

`/api/support` existant donne l'accès aux rôles `OWNER`, `SUPER_ADMIN`, `ADMIN`, `SUPPORT` ; les non-staff sont filtrés sur leur `userId` et ne voient pas les tickets publics. Ne jamais affecter un ticket public à un compte revendiqué avant vérification. Le support doit consulter la file et utiliser un canal de réponse confirmé : aucune notification e-mail n'est envoyée par le formulaire.

Commande ciblée : `node --test scripts\tests\public-privacy-http.test.mjs scripts\tests\rate-limit.test.mjs`. Le test compile les vrais routeurs et l'auth, utilise un store fixture isolé à forme Prisma et n'accède à aucune production. Il couvre accès public/maintenance, FR/EN, persistance, rôle staff/non-staff, XSS, CSRF/origine/expiration, limites, non-énumération et échec DB. Une simulation fixture n'est pas un essai de disponibilité de l'URL déployée.
