/**
 * Teinte associée à un protocole VPN.
 *
 * POURQUOI : la liste des connexions se lit en cherchant « celle en VLESS » ou
 * « la Trojan ». Avec une seule teinte pour toutes, il fallait lire chaque
 * étiquette. Une couleur par famille rend le repérage immédiat.
 *
 * ATTENTION : la couleur ne remplace JAMAIS l'étiquette. La pastille du
 * protocole porte toujours son nom écrit — un utilisateur qui ne distingue pas
 * le violet de l'indigo doit pouvoir s'y retrouver exactement aussi bien.
 */
import type { ThemeColors } from '@/constants/colors';

export function protocolTone(
  colors: ThemeColors,
  protocol: string | null | undefined,
): string {
  const clef = (protocol ?? '').trim().toUpperCase();
  // La correspondance se fait sur la FAMILLE, pas sur la chaîne exacte :
  // « ssh+payload », « ssh+tls » et « ssh » désignent le même transport et
  // doivent porter la même couleur.
  if (clef.startsWith('VLESS')) return colors.accents.violet;
  if (clef.startsWith('VMESS')) return colors.accents.indigo;
  if (clef.startsWith('TROJAN')) return colors.accents.rose;
  if (clef.startsWith('SSH') || clef.startsWith('SLOWDNS')) return colors.accents.turquoise;
  if (clef.startsWith('SHADOWSOCKS') || clef === 'SS') return colors.accents.ambre;
  if (clef.startsWith('WIREGUARD') || clef === 'WG') return colors.accents.emeraude;
  if (clef.startsWith('HYSTERIA') || clef.startsWith('TUIC')) return colors.accents.corail;
  return colors.accents.cyan;
}
