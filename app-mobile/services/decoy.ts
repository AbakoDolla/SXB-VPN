/**
 * Leurres anti-rétro-ingénierie.
 *
 * Objectif : quiconque extrait puis tente de déchiffrer les données de
 * l'application pour y lire le serveur réel doit obtenir des valeurs
 * plausibles — mais fausses. Un échec franc (« payload invalide ») renseigne
 * l'attaquant : il lui confirme qu'il tient bien le bon fichier et qu'il lui
 * manque seulement la clé. Une configuration crédible, elle, l'envoie
 * travailler sur une infrastructure qui n'existe pas.
 *
 * Deux surfaces sont couvertes :
 *   1. le déchiffrement d'un payload avec une mauvaise clé, ou d'un payload
 *      altéré, retourne un leurre au lieu de lever une exception ;
 *   2. des entrées appâts sont semées dans le stockage sous les noms qu'un
 *      analyste cherche en premier (`vpn_config`, `sxb_server`, …), alors que
 *      les vraies données vivent sous des clés opaques et chiffrées.
 *
 * Garde-fou indispensable : l'application ne doit JAMAIS se connecter avec un
 * leurre. Le marquage passe par un WeakSet en mémoire — invisible dans les
 * données stockées, donc non repérable par un attaquant qui inspecterait le
 * disque, contrairement à un drapeau booléen écrit dans l'objet, qu'il
 * suffirait de rechercher pour trier le vrai du faux.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const leurres = new WeakSet<object>();

/** Domaines crédibles : la forme imite celle d'un vrai parc d'hébergement. */
const DOMAINES = [
  'edge-fra1.cdn-relay.net',
  'gw-ams3.netlink-core.com',
  'sg2.tunnelbridge.io',
  'node07.fastpath-eu.net',
  'relay-lon4.streamgate.org',
  'ix-par2.transitpoint.net',
  'de3.secure-hop.io',
  'us-east1.linkforward.net',
];
const PORTS = [443, 8443, 2083, 2087, 22, 2222, 8080, 993];
const SNI = ['www.cloudflare.com', 'www.bing.com', 'cdn.jsdelivr.net', 'www.microsoft.com'];
const PROTOCOLES = ['vless', 'trojan', 'ssh', 'vmess'];

/** Générateur déterministe : la même graine rend toujours le même leurre. */
function melange(graine: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < graine.length; i++) {
    h ^= graine.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h ^= h << 13; h >>>= 0;
    h ^= h >> 17;
    h ^= h << 5; h >>>= 0;
    return h / 4294967296;
  };
}

function chaine(rnd: () => number, longueur: number, alphabet: string): string {
  let out = '';
  for (let i = 0; i < longueur; i++) out += alphabet[Math.floor(rnd() * alphabet.length)];
  return out;
}

/**
 * Fabrique une configuration factice complète et vraisemblable.
 *
 * Elle porte tous les champs d'une vraie configuration afin qu'aucune absence
 * ne trahisse la supercherie : un outil qui compare les clés d'objet ne voit
 * aucune différence de structure.
 */
export function genererLeurre(graine: string = String(Date.now())): Record<string, any> {
  const rnd = melange(graine);
  const hex = '0123456789abcdef';
  const alnum = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const uuid = [8, 4, 4, 4, 12].map(n => chaine(rnd, n, hex)).join('-');
  const protocole = PROTOCOLES[Math.floor(rnd() * PROTOCOLES.length)];
  const leurre: Record<string, any> = {
    host: DOMAINES[Math.floor(rnd() * DOMAINES.length)],
    port: PORTS[Math.floor(rnd() * PORTS.length)],
    protocol: protocole,
    uuid,
    id: uuid,
    username: `u${chaine(rnd, 8, alnum)}`,
    password: chaine(rnd, 16, alnum),
    sni: SNI[Math.floor(rnd() * SNI.length)],
    host_header: SNI[Math.floor(rnd() * SNI.length)],
    path: `/${chaine(rnd, 10, alnum)}`,
    security: rnd() > 0.5 ? 'tls' : 'none',
    network: 'ws',
    tls: rnd() > 0.4,
    flow: '',
    payload: `GET / HTTP/1.1[crlf]Host: ${SNI[Math.floor(rnd() * SNI.length)]}[crlf][crlf]`,
    method: 'aes-256-gcm',
    alterId: 0,
    configId: chaine(rnd, 24, hex),
  };
  leurres.add(leurre);
  return leurre;
}

/** Marque un objet déjà construit comme leurre. */
export function marquerLeurre<T extends object>(valeur: T): T {
  leurres.add(valeur);
  return valeur;
}

/**
 * Un leurre ne doit jamais servir à ouvrir un tunnel.
 *
 * Le test porte sur l'identité de l'objet, pas sur son contenu : rien dans les
 * données écrites sur disque ne permet de distinguer un leurre d'une vraie
 * configuration.
 */
export function estLeurre(valeur: unknown): boolean {
  return typeof valeur === 'object' && valeur !== null && leurres.has(valeur as object);
}

/**
 * Noms de clés qu'un analyste inspecte en premier après avoir extrait les
 * données de l'application. Aucune n'est lue par le code : elles n'existent que
 * pour être trouvées. Les clés réellement utilisées (`sxb_cfg_payload_*`) sont
 * chiffrées et ne figurent pas dans cette liste.
 */
export const CLES_APPATS = [
  'vpn_config',
  'sxb_server',
  'server_config',
  'vpn_credentials',
  'sxb_host_config',
  'tunnel_settings',
];

/**
 * Sème les appâts. Idempotent : une entrée déjà présente n'est pas réécrite,
 * pour qu'un observateur ne voie pas ces valeurs changer à chaque démarrage —
 * ce qui les désignerait immédiatement comme artificielles.
 */
export async function semerAppats(): Promise<void> {
  try {
    const existantes = await AsyncStorage.multiGet(CLES_APPATS);
    const aEcrire: [string, string][] = [];
    for (const [cle, valeur] of existantes) {
      if (valeur) continue;
      aEcrire.push([cle, JSON.stringify(genererLeurre(cle))]);
    }
    if (aEcrire.length) await AsyncStorage.multiSet(aEcrire);
  } catch {
    // Le semis est un bonus défensif : son échec ne doit jamais empêcher
    // l'application de démarrer.
  }
}
