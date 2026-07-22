---
name: VPS SSH quirks and .env recovery
description: Covers the trailing-space username bug and .env file recovery procedure for the SXB VPN VPS
---

## VPS SSH Username Trailing Space

**Rule:** `VPS_USERNAME` secret has a trailing space. Always trim before use.

**How to apply:** Every SSH command must use:
```bash
VPS_USER=$(echo "$VPS_USERNAME" | tr -d ' \t\n\r')
sshpass -p "$VPS_PASSWORD" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=20 \
  -o PreferredAuthentications=password -o PubkeyAuthentication=no \
  "${VPS_USER}@${VPS_HOST}" ...
```

**Why:** The secret was stored with a trailing space, which causes SSH to fail silently with "invalid username" errors.

---

## .env Recovery

If `/var/www/sxb-vpn/.env` is accidentally deleted (e.g., during bad git operations):

```bash
# Find the commit that had .env tracked (look for one that accidentally committed it)
git log --all --oneline | head -20

# Recover from that commit
git show <COMMIT_HASH>:.env > /var/www/sxb-vpn/.env
chmod 600 /var/www/sxb-vpn/.env

# Restart PM2 to pick up the restored file
pm2 restart sxb-backend --update-env
```

**Why:** The `.env` was accidentally staged and committed during a git stash/rebase operation, which also means it exists in git history and can be recovered.

**Important:** `.env` should be in `.gitignore` — add it if missing:
```bash
echo ".env" >> /var/www/sxb-vpn/.gitignore
```
