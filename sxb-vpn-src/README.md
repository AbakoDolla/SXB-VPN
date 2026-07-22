# SXB VPN - Plateforme SaaS de Gestion VPN

![SXB VPN Banner](https://via.placeholder.com/1200x475/0077FF/FFFFFF?text=SXB+VPN+Platform)

## 🚀 Vue d'ensemble

SXB VPN est une plateforme SaaS complète de gestion VPN comprenant :
- **Dashboard Admin** - Interface de gestion complète
- **Backend API** - API REST pour la gestion des clients et tokens
- **Base de données** - PostgreSQL avec Prisma ORM
- **Cache** - Redis pour les sessions
- **Intégration XPanel** - Gestion des serveurs VPN

## 🏗️ Architecture

```
SXB MOBILE APP
      │
      │
SXB BACKEND API (Node.js + Express)
      │
     ┌─┼─────────────┐
     │ │             │
PostgreSQL       Redis
     │             │
     │        XPanel
     │             │
     │    SSH + Sing-box
     │
Dashboard Web (React + Vite)
```

## 🌐 URLs de Production

| Service | URL |
|---------|-----|
| Dashboard | https://vpnsxb.afrihall.com |
| API | https://vpnsxb.afrihall.com/api |

## 🔐 Comptes par défaut

| Role | Email | Mot de passe |
|------|-------|--------------|
| Admin | admin@sxbvpn.com | admin123 |

## 🚀 Installation Locale

### Prérequis
- Node.js 22+
- PostgreSQL 16
- Redis 7
- Docker & Docker Compose (optionnel)

### Étapes

```bash
# 1. Cloner le repository
git clone https://github.com/AbakoDolla/SXB-VPN.git
cd SXB-VPN

# 2. Installer les dépendances
npm install

# 3. Configurer l'environnement
cp .env.example .env
# Éditer .env avec vos paramètres

# 4. Initialiser la base de données
npx prisma generate
npx prisma db push
npx tsx prisma/seed.ts

# 5. Démarrer l'application
npm run dev
```

## 🐳 Déploiement Docker

```bash
# Démarrer tous les services
docker-compose up -d

# Vérifier les logs
docker-compose logs -f
```

## 📁 Structure du projet

```
SXB-VPN/
├── docker-compose.yml      # Configuration Docker
├── Dockerfile.backend       # Image backend
├── Dockerfile.dashboard    # Image dashboard
├── prisma/                 # Schéma de base de données
│   └── schema.prisma
├── server/                 # Routes et services backend
│   ├── routes/
│   └── services/
├── src/                    # Frontend React
│   ├── components/
│   ├── contexts/
│   └── api/
├── scripts/                # Scripts de déploiement
│   ├── install.sh
│   ├── deploy.sh
│   ├── backup.sh
│   └── restore.sh
└── infrastructure/        # Configurations serveur
    └── nginx/
```

## 🔧 Configuration

Variables d'environnement principales :

```env
NODE_ENV=production
PORT=4000
DATABASE_URL=postgresql://user:pass@host:5432/sxb_vpn
REDIS_URL=redis://host:6379
JWT_SECRET=your-secret-key
XPANEL_URL=http://localhost:2080
```

## 🌐 API Endpoints

### Authentification
- `POST /api/auth/login` - Connexion
- `POST /api/auth/refresh` - Rafraîchir le token
- `POST /api/auth/logout` - Déconnexion

### Utilisateurs
- `GET /api/users` - Liste des utilisateurs
- `POST /api/users` - Créer un utilisateur
- `GET /api/users/:id` - Détails utilisateur
- `PATCH /api/users/:id` - Modifier utilisateur
- `DELETE /api/users/:id` - Supprimer utilisateur

### Clients VPN
- `GET /api/clients` - Liste des clients
- `POST /api/clients` - Créer un client
- `GET /api/clients/:id` - Détails client
- `PATCH /api/clients/:id` - Modifier client

### Serveurs
- `GET /api/servers` - Liste des serveurs
- `POST /api/servers` - Ajouter serveur
- `GET /api/servers/:id` - Détails serveur

### Tokens
- `GET /api/tokens` - Liste des tokens
- `POST /api/tokens` - Générer token
- `DELETE /api/tokens/:id` - Révoquer token

## 🔒 Sécurité

- ✅ Authentification JWT
- ✅ Mots de passe hashés avec bcrypt
- ✅ Rate limiting sur les endpoints API
- ✅ Headers de sécurité Helmet
- ✅ RBAC (Role-Based Access Control)
- ✅ Audit logs

## 📊 Technologies

- **Frontend**: React 19, Vite, TailwindCSS, Recharts
- **Backend**: Node.js, Express, TypeScript
- **Base de données**: PostgreSQL 16, Prisma ORM
- **Cache**: Redis 7
- **Containerisation**: Docker, Docker Compose
- **Serveur web**: Nginx
- **Process Manager**: PM2

## 📝 Licence

MIT License - Voir [LICENSE](LICENSE) pour plus de détails.

---

**Développé avec ❤️ pour le Continent Africain** 🇿🇦
