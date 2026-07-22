---
name: SXB VPN RBAC Permissions
description: Comment fonctionne le système de permissions RBAC et ses quirks
---

## requirePermission bypass

```typescript
const hasPermission = 
  req.user.permissions.includes(permissionName) || 
  req.user.role === "ADMIN" || 
  req.user.role === "SUPER_ADMIN";
```

ADMIN et SUPER_ADMIN **ignorent toujours** les vérifications de permission. Donc un bug de nom de permission (`analytics.view` vs `analytics.read`) n'affecte que les rôles inférieurs.

## Noms de permissions dans la DB

Les deux existent : `analytics.read` ET `analytics.view`. Les routes analytics.ts utilisaient `analytics.read`, dashboard.ts utilisait `analytics.view`. 

**Fix appliqué** : harmoniser `dashboard.ts` vers `analytics.read`.

## Seed par défaut

- `superadmin@sxbvpn.com` / `SuperAdmin2026!` (SUPER_ADMIN)
- `admin@sxbvpn.com` / `Admin2026!` (ADMIN)
- `support@sxbvpn.com` / `Support2026!` (SUPPORT)

**Why:** Les routes de dashboard et analytics furent écrites par deux personnes différentes avec des noms de permission différents. Le bypass ADMIN masquait le bug en production pour les super-admins.

**How to apply:** Toujours vérifier la cohérence des noms de permission entre les routes. Les noms canoniques sont dans la table `permissions` (snake_case : `resource.action`).
