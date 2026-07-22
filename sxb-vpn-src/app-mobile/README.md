# SXB VPN — Application Mobile

Application mobile React Native (Expo 54) pour SXB VPN.

## Stack
- Expo 54 + Expo Router 6
- React Native 0.81
- TypeScript
- Palette : `#080B14` (fond), `#5B8DEF` (primary), `#00E5A0` (connecté)
- Localisation : Français & Anglais

## Prérequis
```bash
npm install -g expo-cli eas-cli
```

## Installation
```bash
cd app-mobile
npm install
```

## Lancement
```bash
# Démarrage local (scan QR avec Expo Go)
npm start

# Android
npm run android

# iOS
npm run ios
```

## Build APK/IPA (EAS)
```bash
# Android
npm run build:android

# iOS
npm run build:ios
```

## Configuration API
Le fichier `services/apiClient.ts` pointe vers :
```
https://vpnsxb.afrihall.com/api
```

## Structure
```
app/
  (tabs)/         — Onglets principaux (Home, Historique, Notifs, Profil)
  activate.tsx    — Activation de compte (code SXB-USER-XXXX)
  onboarding.tsx  — Écran de bienvenue
  plan.tsx        — Activation forfait (SXB-DATA-XXXX)
  settings.tsx    — Paramètres
  support.tsx     — Support

components/       — Composants réutilisables
contexts/         — Auth, VPN, Langue, Thème
services/         — Client API
localization/     — Traductions fr/en
```

## Backend
- API : `https://vpnsxb.afrihall.com/api`
- Auth mobile : `POST /api/mobile/auth/activate` (code SXB-USER-XXXX → JWT)
- Forfaits : `POST /api/mobile/plans/activate` (code SXB-DATA-XXXX)
