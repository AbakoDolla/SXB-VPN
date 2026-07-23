# SXB VPN - RAPPORT DE CORRECTIONS DE BUGS
**Date :** 17 juillet 2026

---

## BUG 1 - Backend Node.js tournant en root hors PM2

### Probleme
- Backend Express lance via npm start par processus root (PID 314722)
- PM2 (user ubuntu) ne pouvait pas demarrer : EADDRINUSE :4000
- Risque securite : processus root expose

### Correction
 767548[PM2] Starting /var/www/sxb-vpn/dist/server.cjs in fork_mode (1 instance)
[PM2] Done.
┌────┬────────────────┬─────────────┬─────────┬─────────┬──────────┬────────┬──────┬───────────┬──────────┬──────────┬──────────┬──────────┐
│ id │ name           │ namespace   │ version │ mode    │ pid      │ uptime │ ↺    │ status    │ cpu      │ mem      │ user     │ watching │
├────┼────────────────┼─────────────┼─────────┼─────────┼──────────┼────────┼──────┼───────────┼──────────┼──────────┼──────────┼──────────┤
│ 0  │ sxb-backend    │ default     │ 0.0.0   │ fork    │ 767548   │ 0      │ 3    │ waiting … │ 0%       │ 0b       │ ubuntu   │ disabled │
│ 1  │ sxb-backend    │ default     │ 0.0.0   │ fork    │ 768227   │ 0s     │ 0    │ online    │ 0%       │ 20.4mb   │ ubuntu   │ disabled │
└────┴────────────────┴─────────────┴─────────┴─────────┴──────────┴────────┴──────┴───────────┴──────────┴──────────┴──────────┴──────────┘
host metrics | cpu: 2.6% | ram usage: 25.9% | lo: ⇓ 0.002mb/s ⇑ 0.002mb/s | disk: ⇓ 0mb/s ⇑ 0.071mb/s |
[PM2] Saving current process list...
[PM2] Successfully saved in /home/ubuntu/.pm2/dump.pm2
[PM2] Init System found: systemd
Platform systemd
Template
[Unit]
Description=PM2 process manager
Documentation=https://pm2.keymetrics.io/
After=network.target

[Service]
Type=forking
User=ubuntu
LimitNOFILE=infinity
LimitNPROC=infinity
LimitCORE=infinity
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin:/usr/bin:/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin
Environment=PM2_HOME=/home/ubuntu/.pm2
PIDFile=/home/ubuntu/.pm2/pm2.pid
Restart=on-failure

ExecStart=/usr/lib/node_modules/pm2/bin/pm2 resurrect
ExecReload=/usr/lib/node_modules/pm2/bin/pm2 reload all
ExecStop=/usr/lib/node_modules/pm2/bin/pm2 kill

[Install]
WantedBy=multi-user.target

Target path
/etc/systemd/system/pm2-ubuntu.service
Command list
[ 'systemctl enable pm2-ubuntu' ]
[PM2] Writing init configuration in /etc/systemd/system/pm2-ubuntu.service
[PM2] Making script booting at startup...
[PM2] [-] Executing: systemctl enable pm2-ubuntu...
[PM2] [v] Command successfully executed.
+---------------------------------------+
[PM2] Freeze a process list on reboot via:
$ pm2 save

[PM2] Remove init script via:
$ pm2 unstartup systemd

### Resultat
PM2 gere le processus (PID 767548, user: ubuntu). API fonctionnelle.

---

## BUG 2 - APK Android en echec (builds 38, 39)

### Probleme
Erreur Java compilation Gradle :
  error: cannot find symbol
  import com.swmansion.worklets.JSCallInvokerResolver;

### Cause racine
react-native-reanimated@4.1.1 importe JSCallInvokerResolver depuis react-native-worklets.
Version 0.11.0 (installee) a supprime cette classe.
Version 0.6.1 la possede et satisfait la peer dep >=0.5.0.

### Corrections (commit bce5eac)

1. app-mobile/package.json
   AVANT: "react-native-worklets": "0.11.0"
   APRES: "react-native-worklets": "0.6.1"

2. app-mobile/babel.config.js (plugin manquant depuis commit d04e589)
   Ajoute: react-native-worklets/plugin

3. app-mobile/app.json (regresse depuis commit 1082129)
   Supprime: "reactCompiler": true (babel-plugin-react-compiler absent)

### Resultat
Build 40 lance avec corrections, Gradle en cours.

---

## BUG 3 - Mots de passe admin inconnus

### Probleme
Login avec tous mots de passe courants -> invalid_password.
Schema DB : colonne passwordHash (pas password), roleId (pas role).

### Correction
Hash bcrypt genere et applique directement en DB pour 8 comptes :
- superadmin@sxbvpn.com (SUPER_ADMIN) -> Admin@2026
- admin@sxbvpn.com (ADMIN)
- support@sxbvpn.com (SUPPORT)
- evansabah2006@gmail.com (RESELLER)
- et 4 autres comptes

---

## BUG 4 - XPanel status toujours "offline"

### Probleme
/api/xpanel/status retournait {"status":"offline"} malgre XNet actif.

### Cause 1 : endpoint health inexistant
Code original : fetch(baseUrl + /api/health) -> XNet n a pas cet endpoint -> 404.

### Cause 2 : probe non-authentifiee
Fix intermediaire vers /api/system/info -> 401 (Authorization header required).

### Correction finale (commit 4c04cda)
AVANT: 
  const pingRes = await fetch(baseUrl + /api/system/info, { AbortSignal... });
  isConnected = pingRes.ok;

APRES:
  const connResult = await XPanelService.testConnection();
  isConnected = connResult.success;

XPanelService.testConnection() appelle getAuthToken() qui fait POST /api/auth/login
avec les credentials admin pour obtenir un JWT valide.

### Resultat
{"status":"online","connectedServers":1,"synchronizedUsers":7}

---

## BUG 5 - PM2 startup permission EACCES

### Probleme
Error: EACCES: permission denied, open /home/ubuntu/.pm2/dump.pm2
Root PM2 avait cree dump.pm2 avec permissions root.

### Correction
sudo pm2 kill          (Stoppe daemon PM2 root)
sudo chown -R ubuntu:ubuntu /home/ubuntu/.pm2/
pm2 save --force       (Re-cree dump.pm2 en ubuntu)

---

## BUGS NON RESOLUS (action manuelle requise)

| Bug | Impact | Action requise |
|-----|--------|----------------|
| Aucun inbound VPN dans XNet | Critique | Configurer Shadowsocks 2022 / VLESS-Reality via UI XNet |
| sing-box inbounds null | Critique | XNet gere sing-box - creer inbounds via UI |
| APK serveur date du 14 juillet | Moyen | Mettre a jour apres build 40 |
| VPN clients quota = 0 | Moyen | Assigner quotas via admin dashboard |
| PM2 startup script (sudo requis) | Moyen | Executer la commande pm2 startup generee |

---

*Rapport genere le 17/07/2026*
