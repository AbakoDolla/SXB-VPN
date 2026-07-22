# SXB VPN Mobile App

Expo app for SXB VPN.

## Build profiles (eas.json)
- **preview** — APK Android (CI par défaut)
- **production** — AAB Android / IPA iOS (store)
- **development** — debug APK + simulateur iOS

## API
`EXPO_PUBLIC_API_URL=https://vpnsxb.afrihall.com/api`

## GitHub Actions secrets requis
- `EXPO_TOKEN` — token EAS (obligatoire)
- `DEPLOY_SECRET` — webhook VPS (optionnel)

