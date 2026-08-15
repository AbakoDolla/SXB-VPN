# Audit transport SXB-VPN — 2026-08-15

## Constat terrain

Une sonde TCP vers `51.222.247.178:443` ouvre la connexion mais le payload CONNECT vers `yamo.mtn.cm` ne reçoit aucune réponse dans la fenêtre de test. Une sonde TLS avec SNI `yamo.mtn.cm` et un handshake WebSocket RFC 6455 reçoit une réponse HTTP `302 Found` avec une location explicite vers `https://yamo.mtn.cm/nxt-lvl`. Cette réponse est une preuve de redirection HTTP, pas une bannière SSH et pas une réussite WebSocket.

Conclusion : l'adresse testée répond au niveau HTTP/HTTPS mais ne démontre pas qu'elle expose un relais SSH-over-WS autorisé pour ce Host. La ladder peut classer ces résultats et essayer les modes suivants, mais elle ne peut pas fabriquer une bannière SSH lorsqu'aucun endpoint SSH/WebSocket ne la fournit.

## Recherche publique

SocksIP décrit plusieurs transports séparés (SSH direct, proxy HTTP/TLS, WebSocket, DNS et UDP) et indique que la disponibilité dépend du serveur et de sa charge : https://play.google.com/store/apps/details?id=com.newtoolsworks.sockstunnel&hl=en_US

HA Tunnel Plus décrit SSH2.0, une injection HTTP personnalisée et un SNI pour le handshake ; ces éléments sont des paramètres de négociation distincts, pas une preuve que n'importe quel domaine HTTP fournit un tunnel SSH : https://play.google.com/store/apps/details?id=com.hatunnel.plus&hl=en_US

NPV Tunnel annonce le support de VLESS, VMess, Shadowsocks, Trojan, SOCKS, SSH et payload ; cela correspond à plusieurs moteurs et formats de configuration, pas à une compatibilité automatique avec un serveur arbitraire : https://play.google.com/store/apps/details?id=com.napsternetlabs.napsternetv&hl=en_US

Le projet public Custom-Internet illustre trois stratégies de transport (direct, payload HTTP, SNI fronted) et transmet ensuite le socket établi à Paramiko. Il confirme que la stratégie doit correspondre au gateway réel : https://github.com/tavgar/Custom-Internet

## Règle de livraison

Ne pas publier une APK en affirmant que T-E1 est réussi tant qu'un serveur de test autorisé ne renvoie pas une bannière SSH après l'un des handshakes. Les logs doivent distinguer `banner_ok`, `timeout`, `closed`, `tls_error` et les codes HTTP, sans transformer une réponse HTTP 302 en preuve de connexion VPN.
