# Audit de production du 19 août 2026

Le dashboard `https://vpnsxb.afrihall.com/` est accessible. Après chargement, il affiche l’écran de connexion SXB VPN avec les modes « Email / Mot de passe » et « Token Admin ». Aucun indicateur métier n’est visible avant authentification, ce qui est cohérent avec un dashboard protégé. L’écran s’est chargé après une première vue blanche transitoire ; la seconde vérification a confirmé le formulaire et l’interface v2.1.

La vérification fonctionnelle complète du dashboard nécessite une session authentifiée. Les tests locaux des flux API et des composants restent nécessaires avant de publier une alerte quota.

## Vérification authentifiée

La connexion administrateur avec `superadmin@sxbvpn.com` a réussi. Le dashboard affiche 75 clients, 74 connexions actives, 75 appareils et 79 sessions actives. Les cartes quota sont présentes : quota provisionné `0.00 GB`, quota consommé `0.12 GB`, quota restant `0.00 GB`. Le dashboard reçoit donc bien des données de production, mais le total provisionné/restant est incohérent avec le trafic consommé affiché et doit être investigué dans l’API/base avant de considérer le flux quota comme pleinement sain.

L’activité récente confirme des provisions de configurations V2RAY et MTN pour des appareils réels, ainsi que la connexion administrateur. Aucun avertissement quota inférieur à 10 % n’était visible au moment de cette vérification ; l’alerte ajoutée dépend de la liste réelle `/api/devices` et s’affichera lorsqu’un appareil actif aura un quota total positif et moins de 10 % restant.

## Contrôle des endpoints depuis la session

Les appels directs sans en-tête `Authorization` vers `/api/dashboard/stats`, `/api/devices` et `/api/dashboard/traffic` retournent `401 Authorization token required`. La session authentifiée conserve `sxb_access_token` et `sxb_refresh_token` dans `localStorage` ; le rendu visible du dashboard provient donc d’appels API porteurs du jeton, et non de données statiques dans la page.

## Résultat corrigé sur les endpoints réellement utilisés

Le dashboard utilise `/xapi`, et non `/api`. Avec le jeton administrateur, `/xapi/dashboard/stats`, `/xapi/devices` et `/xapi/dashboard/traffic` répondent tous HTTP 200. Cependant, `/xapi/devices` renvoie actuellement uniquement les clés `id`, `deviceId`, `token`, `status`, `expireAt`, `activatedAt`, `createdAt`, `label`, `quotaTotal` et `quotaUsed`; `quotaRemaining`, `trafficDownload`, `trafficUpload`, `trafficTotal` et `lastTrafficAt` sont absents en production. Le calcul côté dashboard voit donc artificiellement zéro restant et ne peut pas afficher correctement l’alerte ou le trafic par appareil.

Les totaux production observés sur 75 appareils sont : quota total `70 111 566 234` octets, quota utilisé `131 468 581` octets, mais quota restant calculé à zéro faute de champ API. Le correctif doit être appliqué au backend effectivement servi par `/xapi/devices`, puis redéployé et retesté dans cette même session.
