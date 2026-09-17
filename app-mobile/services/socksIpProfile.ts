/**
 * socksIpProfile.ts — Lecture d'un profil SSH exporté par SocksIP.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE MODULE EXISTE
 * ═══════════════════════════════════════════════════════════════════════════
 * Ces profils circulent entre exploitants sous la forme exportée par SocksIP.
 * Le tableau de bord sait désormais les lire (voir
 * `server/services/canonical-config.ts`), mais l'application, elle, les
 * refusait encore : « Protocole non reconnu ». Le même fichier était donc
 * accepté d'un côté et rejeté de l'autre — une incohérence que rien n'explique
 * du point de vue de l'utilisateur, qui colle simplement ce qu'on lui a donné.
 *
 * Les deux côtés produisent volontairement le MÊME canonique, champ pour champ.
 * Un test de parité compare les deux lectures : si l'une dérive, il échoue.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CE QUI SE DÉDUIT, ET CE QUI NE SE DEVINE PAS
 * ═══════════════════════════════════════════════════════════════════════════
 * Le format porte des énumérations opaques — `TypeTunnel`, `TypeSSHTransport`,
 * `DNSTType` — dont la signification n'est documentée nulle part. Les
 * interpréter au jugé produirait un profil silencieusement faux, bien pire
 * qu'un refus. Elles sont donc ignorées : le mode se déduit de ce qui est
 * VÉRIFIABLE — une charge utile présente signifie un tunnel à charge utile, un
 * proxy distinct du serveur signifie un CONNECT vers ce proxy.
 */

/** Clés normalisées comme côté serveur : majuscules, sans séparateurs. */
function champs(obj: Record<string, any>): Map<string, any> {
  const table = new Map<string, any>();
  for (const [cle, valeur] of Object.entries(obj)) {
    table.set(cle.toUpperCase().replace(/[^A-Z0-9]/g, ''), valeur);
  }
  return table;
}

function valeur(table: Map<string, any>, ...noms: string[]): any {
  for (const nom of noms) {
    const v = table.get(nom.toUpperCase().replace(/[^A-Z0-9]/g, ''));
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/** `hote:port` ou `hote:port@utilisateur:motdepasse` → ses quatre parties. */
export function decomposerPointSocksIp(
  brut: string,
): { host: string; port: number; username: string; password: string } | null {
  const texte = String(brut ?? '').trim();
  if (!texte) return null;
  const arobase = texte.indexOf('@');
  const point = arobase >= 0 ? texte.slice(0, arobase) : texte;
  const identifiants = arobase >= 0 ? texte.slice(arobase + 1) : '';
  const colon = point.lastIndexOf(':');
  if (colon <= 0) return null;
  const host = point.slice(0, colon).trim();
  const port = Number(point.slice(colon + 1).trim());
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const separateur = identifiants.indexOf(':');
  return {
    host,
    port,
    username: separateur >= 0 ? identifiants.slice(0, separateur) : identifiants,
    password: separateur >= 0 ? identifiants.slice(separateur + 1) : '',
  };
}

/**
 * Charge utile SocksIP → charge utile SXB.
 *
 * LE PIÈGE : l'export intercale des séquences `\n` de DEUX CARACTÈRES — une
 * barre oblique inverse suivie d'un « n » — entre ses lignes, en plus des
 * jetons `[crlf]` qui portent déjà la vraie fin de ligne. Transmises telles
 * quelles, ces deux lettres partent SUR LE FIL au milieu des en-têtes HTTP :
 * la requête devient malformée et le frontal la rejette, sans que rien
 * n'explique pourquoi une charge utile « identique » échoue chez nous.
 *
 * Quand les jetons `[crlf]` sont présents, ces séquences ne sont donc que du
 * décor d'affichage : on les retire. En leur absence, elles portent réellement
 * la fin de ligne, et deviennent alors le jeton correspondant.
 */
export function normaliserChargeUtileSocksIp(brut: string): string {
  const texte = String(brut ?? '').trim();
  if (!texte) return '';
  const porteDesJetons = /\[(?:crlf|lfcr|lf|cr)\]/i.test(texte);
  return porteDesJetons
    ? texte.replace(/\\r\\n|\\n|\\r/g, '')
    : texte.replace(/\\r\\n|\\n|\\r/g, '[crlf]');
}

/** L'objet ressemble-t-il à un export SocksIP ? */
export function estProfilSocksIp(obj: any): boolean {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (typeof obj.protocol === 'string') return false;
  const table = champs(obj);
  return valeur(table, 'SSHSERVER', 'PROXYHOSTPORT', 'SSHSERVERRESOLUTION') !== undefined;
}

/**
 * Rend le canonique SXB correspondant, ou `null` si l'objet n'est pas un
 * export SocksIP exploitable.
 */
export function lireProfilSocksIp(obj: any): Record<string, any> | null {
  if (!estProfilSocksIp(obj)) return null;
  const table = champs(obj);

  const serveur = String(valeur(table, 'SSHSERVER') ?? '').trim();
  const proxyBrut = String(valeur(table, 'PROXYHOSTPORT') ?? '').trim();
  const resolution = String(valeur(table, 'SSHSERVERRESOLUTION') ?? '').trim();

  const principal = decomposerPointSocksIp(serveur)
    ?? decomposerPointSocksIp(proxyBrut)
    ?? decomposerPointSocksIp(resolution);
  if (!principal) return null;

  // Les identifiants ne sont pas toujours dans les champs qui leur sont
  // dédiés : SocksIP les accroche aussi aux points d'accès, sous la forme
  // `hote:port@utilisateur:motdepasse`.
  const porteurs = [
    principal,
    decomposerPointSocksIp(proxyBrut),
    decomposerPointSocksIp(String(valeur(table, 'SSHPROXYSERVERRESOLUTION') ?? '')),
    decomposerPointSocksIp(resolution),
  ].filter((p): p is NonNullable<typeof p> => p !== null);
  const username = String(valeur(table, 'SSHUSERNAME') ?? '').trim()
    || (porteurs.find(p => p.username !== '')?.username ?? '');
  const password = String(valeur(table, 'SSHPASSWORD') ?? '')
    || (porteurs.find(p => p.password !== '')?.password ?? '');
  if (!username) return null;

  const charge = normaliserChargeUtileSocksIp(String(valeur(table, 'SSHPAYLOAD') ?? ''));
  const usePayload = charge !== '';

  // Le proxy n'est retenu que s'il DIFFÈRE du serveur : SocksIP y recopie
  // souvent le serveur lui-même, et le déclarer comme proxy distinct ferait
  // basculer le moteur sur un CONNECT en deux temps qui n'a pas lieu d'être.
  const proxy = decomposerPointSocksIp(proxyBrut);
  const proxyDistinct = proxy !== null
    && (proxy.host !== principal.host || proxy.port !== principal.port);

  const cfg: Record<string, any> = {
    protocol: usePayload ? 'ssh+payload' : 'ssh',
    sshTransport: usePayload ? (proxyDistinct ? 'http-connect' : 'payload') : 'direct',
    host: principal.host,
    port: principal.port,
    username,
    password,
    tls: false,
    usePayload,
    proxyEnabled: proxyDistinct,
    localPort: 1080,
    timeoutMs: 30_000,
    compressionLevel: 0,
  };
  if (usePayload) cfg.payload = charge;
  if (proxyDistinct && proxy) {
    cfg.proxyHost = proxy.host;
    cfg.proxyPort = proxy.port;
  }
  return cfg;
}
