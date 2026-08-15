# Audit dashboard en ligne — 2026-08-15

Le dashboard `https://vpnsxb.afrihall.com` est accessible avec la session superadmin persistante. La section « VPN Configurations » affiche actuellement l'ancienne interface et les profils existants.

Constats observés :

- Le dashboard montre 38 profils, dont des profils importés canoniques et des profils legacy.
- Le bouton actuel est « Importer une configuration ».
- Les filtres visibles couvrent SSH, SSH+Payload, VLESS, VMess, Trojan, Shadowsocks, Singbox et WireGuard, mais pas encore Hysteria2/TUIC dans l'interface déployée.
- Les profils importés affichent `Importé v1 · ssh+payload-json` et un badge de validation lorsqu'il existe.
- Plusieurs profils SSH+Payload affichent `Network —`, ce qui confirme que l'ancien dashboard ne rend pas toujours le transport/path de façon complète.
- Le dashboard contient déjà des profils `ssh+payload` basés sur `51.222.247.178:443`, `fr1.wssht.to:443`, `at1.vpnjantit.com:80` et `node05.mikosi.fr.eu.org:443`.
- Des activités récentes montrent que le provisioning mobile est appelé pour des abonnements et des Device IDs.
- Le dashboard en ligne n'inclut pas encore les modifications locales du formulaire unifié ni le nouveau statut `transport_ok`; aucune modification live n'a été faite.

Les modifications locales ne doivent pas être annoncées comme déployées tant qu'elles n'ont pas été poussées et déployées. Le build local du dashboard et son typecheck devront être validés avant publication.

## Vérification post-déploiement

Après le workflow VPS réussi sur le commit `6f3d4df`, puis le correctif APK `7ec0c52`, le dashboard `https://vpnsxb.afrihall.com` reste accessible et charge correctement la page d'accueil avec la session superadmin persistante. La section « VPN Configurations » devra être ouverte après invalidation du cache navigateur pour vérifier le nouveau bundle; la page d'accueil elle-même répond et affiche les données du backend, les abonnements et les activités de provisioning.

Le workflow Android du commit `7ec0c52` a ensuite terminé avec succès; le workflow VPS du commit parent `6f3d4df` était déjà en succès. Le nouveau commit Android contient uniquement la correction de l'échappement Kotlin qui bloquait le premier build.

## Contrôle de la section VPN Configurations après déploiement

La section est accessible et les profils sont chargés, mais le bundle actuellement servi affiche encore les filtres `Tous`, `ssh`, `ssh+payload`, `vless`, `vmess`, `trojan`, `shadowsocks`, `singbox`, `wireguard`. Les nouveaux filtres `hysteria2` et `tuic` ne sont pas visibles. Le nouveau message de saisie manuelle et le champ payload brut n'ont pas encore été vérifiés dans le modal. Cela suggère que le workflow VPS a déployé le backend, mais pas le bundle dashboard local correspondant, ou qu'un cache static est encore servi. Ne pas annoncer le dashboard comme entièrement mis à jour sans contrôle du modal/bundle.

## Contrôle du modal live

Le modal « Importer une configuration VPN » est bien déployé. Il affiche les formats `hysteria2://` et `tuic://` dans l'aide, le préflight « Tester la configuration importée », et le bouton live est encore libellé « Importer (chiffré) » sur le chemin JSON. Le modal affiche aussi l'onglet « Saisie manuelle (legacy) »; il faut maintenant l'ouvrir pour vérifier que le nouveau texte indique bien l'utilisation du même flux canonique chiffré et que le textarea payload brut est présent.

## Modal manuel live

Le modal JSON live est accessible après le déploiement. Les éléments textuels confirment le préflight et l'import chiffré. Le clic automatisé sur l'onglet manuel n'a pas changé l'onglet visible; aucune configuration n'a été soumise. Le contrôle live confirme donc l'accès au parcours JSON, mais pas encore l'exécution d'un enregistrement manuel sur la base distante.

## Confirmation finale

Après rechargement, le dashboard en ligne répond correctement, conserve la session superadmin et affiche les compteurs clients, appareils, sessions, quotas ainsi que les événements de provisioning. La section VPN Configurations et le modal JSON sont accessibles. Aucun test de sauvegarde réel n'a été soumis afin de ne pas créer un profil de test dans la base de production.

## Nouvelle vérification live demandée

La connexion au dashboard en ligne fonctionne avec la session `superadmin@sxbvpn.com`. La page d'accueil affiche 73 clients, 72 connectés, 73 appareils et 77 sessions; les activités de provisioning sont visibles.

Dans « Profils VPN », 38 profils sont chargés, avec les cartes canoniques AES-256-GCM, les serveurs, la validité offline et les abonnements. Le rendu visible des filtres reste `Tous`, `ssh`, `ssh+payload`, `vless`, `vmess`, `trojan`, `shadowsocks`, `singbox`, `wireguard`; les éléments Hysteria2/TUIC ne sont pas visibles dans cette ligne à l'écran, même si le modal JSON indique leurs formats acceptés. Aucun profil n'a été créé ou modifié pendant cette vérification.

## Modal et saisie manuelle — vérification complémentaire

Le modal JSON live est bien accessible et affiche les formats `hysteria2://` et `tuic://`, le stockage AES-256-GCM, le préflight de transport et le bouton d'import chiffré. Les interactions coordonnées avec l'onglet « Saisie manuelle (legacy) » n'ont pas changé l'onglet visible dans le navigateur automatisé; aucune configuration n'a été soumise. Le contenu du modal JSON est donc confirmé en ligne, tandis que la présence visuelle du textarea manuel doit être validée par une interaction utilisateur ou par un contrôle DOM plus ciblé.
