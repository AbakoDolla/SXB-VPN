/**
 * v2rayNProfile.ts — Lecture d'un profil au format de partage v2rayN.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE MODULE EXISTE
 * ═══════════════════════════════════════════════════════════════════════════
 * Ce format circule partout : c'est celui que produit le bouton « exporter »
 * de v2rayN, et celui qu'on trouve dans la plupart des abonnements. Il ne
 * nomme pas toujours son protocole et emploie des clés abrégées — `add` pour
 * l'adresse, `id` pour l'UUID, `net` pour le transport, `ps` pour le nom.
 *
 * Le tableau de bord savait déjà le lire ; l'application le refusait avec
 * « Protocole non reconnu ». Le même fichier était donc accepté d'un côté et
 * rejeté de l'autre — une incohérence que rien n'explique du point de vue de
 * qui colle simplement ce qu'on lui a donné.
 *
 * Les deux côtés produisent volontairement le MÊME canonique, champ pour
 * champ, et un test de parité compare les deux lectures.
 */

function decoder(valeur: string): string {
  try {
    return decodeURIComponent(valeur);
  } catch {
    // Une valeur non encodée est fréquente dans ce format : la refuser
    // perdrait un profil parfaitement utilisable.
    return valeur;
  }
}

/** L'objet ressemble-t-il à un profil de partage v2rayN ? */
export function estProfilV2rayN(obj: any): boolean {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (Array.isArray(obj.outbounds) || Array.isArray(obj.configs)) return false;
  // Ce qui distingue ce format d'un canonique SXB, c'est OÙ vit l'adresse.
  // Ici elle est dans `add` (ou `address`/`server`) ; dans un canonique elle
  // est dans `host`, où ce format place au contraire l'EN-TÊTE Host. Se fier
  // à `host` confondrait les deux et écrirait le vrai service comme adresse.
  const adresse = obj.add ?? obj.address ?? obj.server;
  if (!adresse) return false;
  // Un canonique déjà normalisé porte `uuid` ; ce format porte `id`.
  if (obj.uuid !== undefined && obj.id === undefined) return false;
  return Boolean(obj.port ?? obj.serverPort);
}

/**
 * Rend le canonique SXB correspondant, ou `null` si ce n'est pas un profil de
 * partage exploitable.
 *
 * Seuls les protocoles que le moteur sait exécuter sont acceptés. Deviner
 * au-delà produirait une configuration qui s'importe puis échoue à l'ouverture
 * du tunnel, ce qui est pire qu'un refus net à l'import.
 */
export function lireProfilV2rayN(obj: any): Record<string, any> | null {
  if (!estProfilV2rayN(obj)) return null;

  const reseau = String(obj.net ?? obj.network ?? obj.type ?? 'tcp').toLowerCase();
  const adresse = obj.add ?? obj.address ?? obj.server;
  const port = Number(obj.port ?? obj.serverPort);
  if (!adresse || !Number.isFinite(port) || port <= 0) return null;

  const declare = String(obj.protocol ?? obj.configType ?? '').toLowerCase();
  // Sans protocole déclaré, un identifiant en forme d'UUID désigne VMess dans
  // ce format : c'est sa forme historique, et v2rayN l'écrit ainsi.
  const protocole = declare || ((obj.id || obj.uuid) ? 'vmess' : '');

  const cfg: Record<string, any> = { host: String(adresse), port };

  if (protocole === 'vless') {
    const uuid = obj.id ?? obj.uuid ?? obj.password;
    if (!uuid) return null;
    cfg.protocol = 'vless';
    cfg.uuid = String(uuid);
    if (obj.flow) cfg.flow = String(obj.flow);
  } else if (protocole === 'vmess') {
    const uuid = obj.id ?? obj.uuid;
    if (!uuid) return null;
    cfg.protocol = 'vmess';
    cfg.uuid = String(uuid);
    const alterId = obj.aid ?? obj.alterId;
    if (alterId !== undefined && alterId !== '') cfg.alterId = Number(alterId);
    const chiffrement = obj.scy ?? obj.security;
    // `security` porte deux sens dans ce format : le chiffrement VMess, ou la
    // couche TLS. Seul le premier est un chiffrement VMess valable.
    if (chiffrement && ['auto', 'aes-128-gcm', 'chacha20-poly1305', 'none', 'zero'].includes(String(chiffrement).toLowerCase())) {
      cfg.security = String(chiffrement);
    }
  } else if (protocole === 'trojan') {
    const motDePasse = obj.password ?? obj.id;
    if (!motDePasse) return null;
    cfg.protocol = 'trojan';
    cfg.password = String(motDePasse);
  } else if (protocole === 'shadowsocks' || protocole === 'ss') {
    const methode = obj.method ?? obj.security;
    const motDePasse = obj.password ?? obj.pass;
    if (!methode || !motDePasse) return null;
    cfg.protocol = 'shadowsocks';
    cfg.method = String(methode);
    cfg.password = String(motDePasse);
  } else {
    return null;
  }

  if (reseau) cfg.network = reseau;
  const valeurTls = obj.tls ?? obj.streamSecurity ?? obj.security;
  cfg.tls = valeurTls === true || String(valeurTls ?? '').toLowerCase() === 'tls';

  const chemin = obj.path ?? obj.requestPath;
  if (chemin) cfg.path = decoder(String(chemin));
  // `host` désigne l'EN-TÊTE Host, jamais l'adresse jointe : celle-ci est dans
  // `add`. Les confondre écrirait le vrai service en clair dans le premier
  // paquet, ce qui vide une configuration de façade de tout son sens.
  const enTeteHost = obj.requestHost ?? obj.wsHost ?? obj.host;
  if (enTeteHost) cfg.wsHost = decoder(String(enTeteHost));
  if (obj.sni) cfg.sni = decoder(String(obj.sni));

  const typeEnTete = obj.headerType ?? (obj.type && String(obj.type).toLowerCase() !== reseau ? obj.type : undefined);
  if (typeEnTete && String(typeEnTete).toLowerCase() !== 'none') cfg.headerType = String(typeEnTete);
  const empreinte = obj.fp ?? obj.fingerprint;
  if (empreinte) cfg.fingerprint = String(empreinte);
  if (obj.alpn) {
    cfg.alpn = Array.isArray(obj.alpn) ? obj.alpn.map((v: any) => String(v)).join(',') : String(obj.alpn);
  }
  return cfg;
}
