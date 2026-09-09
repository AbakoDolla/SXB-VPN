# Branding, captures et vidéos SXB VPN

## Branding livré

`assets/icon-512.png` : 512 × 512, PNG RGBA 32 bits, dérivé directement de `public/logo-512.png`. `assets/feature-1024x500.png` : 1 024 × 500, PNG RGB 24 bits sans alpha, logo existant sur fond bleu et motif de liaison. **La bannière n'est pas une capture de l'app ni une preuve de connexion.**

Reproduction locale Windows avec les outils déjà présents : `powershell -File store\google-play\build-branding.ps1`. Aucun générateur d'image externe, photo tierce ou badge Google n'est utilisé. L'exploitant doit confirmer les droits du logo existant ; sa présence dans Git ne prouve pas sa licence.

Textes alternatifs : icône FR « Emblème bleu SXB VPN », EN « Blue SXB VPN emblem » ; bannière FR « SXB VPN sur fond bleu avec motif de liaison », EN « SXB VPN on a blue background with a connection motif ».

## Captures restant à produire

SDK Android et émulateur non disponibles dans cette session : **aucune capture Play n'est fournie**. Les anciens fichiers de `attached_assets` ne sont pas utilisés comme preuves du binaire actuel. Ne pas remplacer les captures par une maquette.

Prendre au moins deux captures réelles, idéalement quatre par langue FR/EN, dans une résolution native recommandée de 1 080 × 1 920. Contraintes de la fiche mobile : JPEG ou PNG RGB 24 bits sans alpha, dimensions entre 320 et 3 840 pixels, côté long au plus deux fois le petit côté, jusqu'à huit captures par type d'appareil. Les autres appareils ont leurs exigences propres ; ne pas activer tablette/TV/Wear/XR sans les vérifier.

| Scène réelle | Préparation | Texte alternatif proposé |
|---|---|---|
| Accueil avant connexion | Installation propre, langue correcte, compte dédié sans informations privées visibles | FR : Écran principal SXB VPN avant connexion. EN: SXB VPN home before connection. |
| VPN connecté | Vraie connexion au endpoint approuvé, état réellement confirmé, durée/volumes issus de la session | FR : État de la connexion VPN active. EN: Active VPN connection status. |
| Profils et quota | Données du seul compte de démonstration, pas de code ni hostname secret exposé | FR : Profils disponibles et quota du compte de démonstration. EN: Available profiles and demo account quota. |
| Confidentialité et contrôles | Version finale du consentement et des liens, diagnostics/notifications selon état réellement choisi | FR : Contrôles de confidentialité de SXB VPN. EN: SXB VPN privacy controls. |

La session build pourra installer l'AAB converti en APK de test ou l'APK release approprié sur un appareil autorisé, choisir un format 9:16, capturer via les outils Android existants et vérifier dimensions, couleurs, pixels réels et langue. Préférer des données de démonstration non sensibles à la retouche. Ne jamais modifier un indicateur « déconnecté » en « connecté », ajouter un débit inventé ou superposer une fausse interface. Un masquage de secret nécessaire ne doit pas altérer les fonctionnalités présentées ; si possible refaire la capture sans secret.

## Vidéos réglementaires, non produites ici

La déclaration VpnService demande une vidéo de connexion **90 secondes maximum** et une vidéo montrant l'information/consentement **90 secondes maximum** ; elles peuvent être communes seulement si tous les parcours sont lisibles et complets. La vidéo foreground service doit montrer le déclenchement et l'utilité du service. Une vidéo promotionnelle de fiche n'est pas un substitut à ces preuves.

Pour la connexion : partir de l'ouverture réelle de SXB VPN, sélectionner l'accès dédié, accepter l'information nécessaire et l'autorisation Android, établir réellement le tunnel, montrer la notification persistante et la possibilité de déconnexion. Démontrer le résultat avec un trafic de test autorisé, sans révélations de données personnelles.

Pour l'information : ouverture de l'app, affichage normal (pas uniquement Paramètres), texte complet et défilement lisible, refus, absence réelle de démarrage/collecte conditionnée, retour au parcours, action affirmative et autorisation Android. Montrer les choix facultatifs non présélectionnés dans la version finale si proposés. Toute narration doit expliquer ce qui a lieu, sans promettre anonymat absolu, « zéro logs », « zéro tiers », meilleure vitesse ou Internet gratuit.

Ne pas inclure codes VPN utilisables, identifiants Console, clé de signature, mot de passe ou compte réel. Après validation et **autorisation séparée d'upload**, un humain pourra héberger les vidéos à des URL accessibles à l'examinateur (YouTube ou fichier MP4/cloud pour VpnService). Les URL restent `null` dans le dossier. Aucune vidéo simulée, aucun upload ni compte créé par cette tâche.
