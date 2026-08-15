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
