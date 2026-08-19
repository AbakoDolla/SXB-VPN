# Notes de compatibilité sing-box utilisées pour SXB VPN

## Sources officielles

1. DNS général : https://sing-box.sagernet.org/configuration/dns/
   - La structure DNS supporte `servers`, `rules`, `final` et `strategy`.
   - `strategy` accepte notamment `prefer_ipv4`, `prefer_ipv6`, `ipv4_only`, `ipv6_only`.

2. Règles DNS : https://sing-box.sagernet.org/configuration/dns/rule/
   - Les règles DNS disposent de champs `domain`, `server` et `action`.
   - Les règles DNS diffèrent d’une simple table Xray `dns.hosts`.

3. Serveur DNS Hosts : https://sing-box.sagernet.org/configuration/dns/server/hosts/
   - Le serveur `type: hosts` avec `predefined` est indiqué comme disponible depuis sing-box 1.12.0.
   - Le moteur mobile SXB actuellement embarqué est sing-box 1.11.15 ; le traducteur ne doit donc pas injecter ce bloc dans une configuration destinée à ce moteur. Il conserve un avertissement explicite et laisse le DNS du moteur traiter la résolution.

4. TLS partagé : https://sing-box.sagernet.org/configuration/shared/tls/
   - En outbound, `tls.utls` accepte `enabled` et `fingerprint`, notamment `chrome`.
   - `server_name`, `insecure` et `alpn` sont des champs TLS valides.

5. Dial fields : https://sing-box.sagernet.org/configuration/shared/dial/
   - `domain_strategy` est le champ de résolution d’un outbound dans les versions utilisées.
   - `fallback_delay` est le champ de délai de fallback/résolution documenté ; le traducteur mappe `sockopt.happyEyeballs.tryDelayMs` vers ce champ et signale les paramètres Xray sans équivalent stable.

## Conséquence pour la configuration jointe

La configuration VLESS + WS + TLS avec `serverName: hsnylstroom.co.za`, `Host: live.faibakenya.app`, chemin `/lee`, fingerprint Chrome et `sockopt.happyEyeballs` est traduisible vers sing-box. Les `dns.hosts` sont signalés comme non appliqués par sing-box 1.11.15 au lieu d’être silencieusement perdus ou d’invalider le JSON. Les inbounds SOCKS sont ignorés car l’application fournit son propre TUN, conformément au moteur mobile.
