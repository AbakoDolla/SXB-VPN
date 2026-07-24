---
name: VPS SSH Servers State
description: Architecture SSH/VPN du VPS 141.95.112.93 après audit juillet 2026
---

## Serveurs SSH actifs

| Service | Port | Type | Statut |
|---------|------|------|--------|
| OpenSSH (admin) | 22 | SSH standard | ✅ actif |
| Dropbear VPN | 444 | SSH direct mobile | ✅ actif (systemd: dropbear-vpn) |
| sshd-vpntunnel | 2223 (localhost) | SSH pour stunnel | ✅ actif (systemd: sshd-vpntunnel) |
| websockify-ssh | 2082 | WebSocket → Dropbear:444 | ✅ actif (systemd: websockify-ssh) |
| SSH-WS Nginx | /ssh-ws (443 HTTPS) | Proxy WS → websockify:2082 | ✅ configuré |

## Config mobile recommandée

### SSH direct (sans payload)
- host: 141.95.112.93, port: 444, protocol: ssh

### SSH+WebSocket payload
- host: vpnsxb.afrihall.com, port: 443
- payload: `GET /ssh-ws HTTP/1.1\r\nHost: vpnsxb.afrihall.com\r\nUpgrade: websocket\r\n\r\n`
- protocol: ssh+payload (le SxbPayloadProxy détecte HTTP 101 → mode WS)

## Stunnel
- Config: accept 443 → 127.0.0.1:2223
- Problème: port 443 pris par Nginx → stunnel ne peut pas démarrer sur 443
- Solution utilisée: websockify + Nginx proxy à la place de stunnel

**Why:** stunnel et Nginx ne peuvent pas partager le port 443. On utilise Nginx comme frontend TLS et websockify comme bridge WS→SSH.
