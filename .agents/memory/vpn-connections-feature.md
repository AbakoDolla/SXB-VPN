---
name: VPN Connections Feature
description: Architecture du système displayProtocol/technicalProtocol et comment déployer les connexions VPN côté mobile
---

## Règle principale
VpnProfile.displayProtocol = nom commercial affiché sur mobile ("MTN Protocol", "Orange Protocol")
VpnProfile.protocol = protocole technique ("ssh", "vless", "trojan"...) — ne jamais exposer au client mobile directement

## Points clés
- GET /api/mobile/connections retourne les Subscriptions avec les deux protocoles séparés
- connectedProtocol persisté dans AsyncStorage @sxb_connected_protocol
- Colonne displayProtocol ajoutée à vpn_profiles (TEXT, nullable)

**Why:** L'opérateur veut afficher "MTN Protocol" au lieu de "SSH" pour éviter que les utilisateurs sachent quel protocole technique est utilisé.

**How to apply:** Lors de la création d'un VpnProfile dans le dashboard, remplir "Nom affiché sur mobile". L'app mobile lit connections[].displayProtocol pour les cards, et connectedProtocol pour l'affichage lors d'une connexion active.
