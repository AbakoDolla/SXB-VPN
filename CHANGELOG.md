# Changelog — SXB VPN Dashboard

Toutes les modifications notables sont documentées ici.
Format : [version] — AAAA-MM-JJ

---

## [2.4.0] — 2026-07-16

### Correctifs Critiques — Suppression de toutes les données simulées

#### Backend
- **analytics.ts** — Supprimé `Math.random()` pour CPU%, RAM%, bande passante et utilisateurs connectés. Données désormais issues de `prisma.vpnClient.count({ where: { status: 'active' } })`. Métriques matérielles (CPU/RAM) retournées comme `null` car elles nécessitent un agent de monitoring.
- **analytics.ts** — Supprimé `simulatedDailyUsage` avec `Math.random()`. Historique du trafic calculé depuis les données `updatedAt` réelles des `VpnClient`.
- **dashboard.ts** — Graphique trafic 7 jours : plus de distribution linéaire fake. Regroupement réel par `updatedAt` des `VpnClient`.
- **dashboard.ts** — Graphique utilisateurs 7 jours : count cumulatif réel par `createdAt`.
- **vouchers.ts** — Génération de code côté serveur avec `crypto.randomBytes` (plus côté client avec `Math.random()`). Endpoint accepte `{quotaGb, durationDays, count}` et retourne `{vouchers: []}`.

#### Base de données
- **Prisma schema** — Ajout du modèle `AdminToken` (tokens SXB-ADMIN-XXXX-XXXX).
- **Prisma schema** — Ajout du modèle `SupportTicket` (tickets persistés en DB, plus localStorage).
- **Migration** — `prisma db push` exécuté, tables `admin_tokens` et `support_tickets` créées.

#### Nouvelles routes
- `GET/POST/PATCH/DELETE /api/support` — Tickets d'assistance (PostgreSQL).
- `GET /api/audit-logs` — Journaux d'activité depuis la base réelle.
- `POST /api/auth/token-login` — Connexion par token admin (SXB-ADMIN-XXXX-XXXX).

### Nouvelles Fonctionnalités

#### Frontend
- **LoginForm** — Ajout d'un onglet "Token Admin" pour la connexion par token SXB-ADMIN-XXXX-XXXX.
- **SupportView.tsx** — Entièrement réécrit : tickets persistés via API `/api/support` (PostgreSQL), plus localStorage.
- **src/api/support.ts** — Nouveau module API pour les tickets.
- **src/api/vouchers.ts** — `generateVoucherCode()` utilise `crypto.getRandomValues()` au lieu de `Math.random()`.

### Documentation
- Ajout de `SXB_SYSTEM_AUDIT.md` — Rapport d'audit complet du système.
- Mise à jour de `CHANGELOG.md`.

---

## [2.3.0] — 2026-07-15

### Nouvelles Fonctionnalités

#### Backend
- **users.ts** — Création de compte : `password` optionnel, auto-généré si absent (hex `crypto.randomBytes`).
- **resellers.ts** — Création revendeur : retourne `generatedPassword` dans la réponse.

#### Frontend
- **ResellersView.tsx** — `CredentialsModal` : affiche email + mot de passe après création, avec bouton copier. Avertissement "montré une seule fois".
- **SettingsView.tsx** — Section "Gestion de l'équipe" : formulaire de création de comptes ADMIN/SUPPORT avec `CredentialsModal`.
- **src/api/permissions.ts** — `fetchRoles()` gère le retour tableau direct et `{roles: []}`.

---

## [2.2.0] — 2026-07-14

### Nouvelles Fonctionnalités
- Système de tokens admin (SXB-ADMIN-XXXX-XXXX) — route `admin-tokens.ts`.
- Vue AccountsView pour la gestion des comptes dashboard.
- Intégration XPanel (3x-ui) via service HTTP.
- Support RBAC complet avec permissions granulaires.
- Multilingue i18n (fr/en).

---

*SXB VPN — Plateforme SaaS de gestion VPN*  
*GitHub : AbakoDolla/SXB-VPN*
