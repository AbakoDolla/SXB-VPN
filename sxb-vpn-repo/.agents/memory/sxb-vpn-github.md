---
name: SXB VPN GitHub push auth
description: GitHub push requires a PAT; the remote uses HTTPS and password auth is rejected
---

# GitHub Auth pour SXB VPN

## Repo
`https://github.com/AbakoDolla/SXB-VPN`

## Problème
Le push HTTPS échoue: "Invalid username or token. Password authentication is not supported for Git operations."

## Solution
Utiliser un Personal Access Token (PAT) GitHub. Configurer le remote:
```bash
cd sxb-vpn-src
git remote set-url origin https://<TOKEN>@github.com/AbakoDolla/SXB-VPN.git
git push origin main
```

**How to apply:** Demander le PAT à l'utilisateur comme secret (`GITHUB_TOKEN`), ou utiliser le skill `git-remote` pour la procédure complète.
