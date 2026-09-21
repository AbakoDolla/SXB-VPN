/**
 * journalTechnique — transformer les traces du moteur en faits lisibles et sûrs.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CE QUE CE MODULE RÉSOUT
 * ═══════════════════════════════════════════════════════════════════════════
 * Le journal ne montrait que des phrases vagues : « Préparation… ». Quand une
 * connexion échoue ou traîne, cela n'apprend rien — ni à l'utilisateur, ni à
 * celui qui doit la réparer. Les autres applications de ce marché (HTTP
 * Injector, HTTP Custom) affichent au contraire le détail réel : « HTTP/1.1
 * 200 », « tunnel établi », « TLS 1.3 ». C'est ce détail qui permet de dire
 * OÙ ça casse.
 *
 * Le moteur produit déjà exactement ces faits, sous la forme :
 *
 *     [SXB_TRACE] stage=TCP_CONNECTED elapsed_ms=412 local_bound=true
 *     [SXB_TRACE] stage=HTTP_RESPONSE status=HTTP/1.1 200 OK header_count=6
 *
 * Ils n'étaient simplement jamais montrés.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POURQUOI UNE LISTE BLANCHE, ET JAMAIS UN MASQUAGE
 * ═══════════════════════════════════════════════════════════════════════════
 * Ces mêmes traces portent aussi ce qu'il ne faut JAMAIS montrer :
 *
 *     [SXB_TRACE] stage=ENDPOINT_RESOLVED remote=crash…googleapis.com id=…
 *
 * Effacer les passages sensibles d'une ligne serait une course perdue : il
 * suffit qu'une trace évolue, ou qu'un cas échappe au filtre, pour que la
 * fuite revienne — en silence. On fait donc l'inverse, à DEUX verrous :
 *
 *   1. Seules les étapes CITÉES ici sont lues. `ENDPOINT_RESOLVED` n'y est
 *      pas : il disparaît, sans qu'on ait eu à le reconnaître comme dangereux.
 *
 *   2. Pour chaque étape, seules les CLÉS citées sont lues, et chaque valeur
 *      doit satisfaire un type strict — un nombre, un booléen, ou un mot d'une
 *      liste fermée. Une valeur libre est rejetée même si sa clé est admise.
 *
 * Un nom d'hôte ne peut donc pas passer : ni son étape, ni sa clé, ni sa forme
 * ne sont admises. La sûreté ne dépend d'aucune vigilance future.
 */

export type NiveauTechnique = 'ok' | 'info' | 'attention' | 'echec';

export interface FaitTechnique {
  /** Clé de traduction du libellé — jamais du texte venu du moteur. */
  cle: string;
  /** Valeurs sûres, déjà mises en forme, à accoler au libellé. */
  valeurs: string[];
  niveau: NiveauTechnique;
  /** Identifiant d'étape, pour ne pas empiler deux fois la même. */
  etape: string;
}

// ── Validateurs de valeur ───────────────────────────────────────────────────
//
// Une clé admise ne suffit pas : la VALEUR doit aussi avoir la forme attendue.
// C'est le second verrou, celui qui tient même si une trace change de contenu.

/** Entier simple. Rejette tout ce qui n'est pas entièrement numérique. */
const entier = (v: string): string | null => (/^\d{1,12}$/.test(v) ? v : null);

/** Durée en millisecondes, rendue lisible. */
const duree = (v: string): string | null => {
  if (!/^\d{1,12}$/.test(v)) return null;
  const ms = Number(v);
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
};

/** Volume en octets, rendu lisible. */
const octets = (v: string): string | null => {
  if (!/^\d{1,15}$/.test(v)) return null;
  const n = Number(v);
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`;
  return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
};

/**
 * Ligne de statut HTTP, réduite à sa version et son code.
 *
 * « HTTP/1.1 200 OK » devient « HTTP/1.1 200 ». Le motif est ancré des deux
 * côtés de ce qu'on garde : un hôte glissé dans la ligne ne pourrait pas en
 * ressortir, puisque seuls les deux premiers jetons sont conservés.
 */
const statutHttp = (v: string): string | null => {
  const m = v.match(/^(HTTP\/\d(?:\.\d)?)\s+(\d{3})\b/i);
  return m ? `${m[1].toUpperCase()} ${m[2]}` : null;
};

/** Version du protocole TLS. Liste fermée : aucune chaîne libre n'entre. */
const versionTls = (v: string): string | null =>
  (/^(TLSv1(\.[0-3])?|SSLv3|TLS_?1[._]?[0-3])$/i.test(v) ? v.replace(/_/g, '.') : null);

/** Un mot d'une liste fermée, rendu tel qu'il y figure. */
const parmi = (...admis: string[]) => (v: string): string | null => {
  const t = v.toUpperCase();
  return admis.includes(t) ? t : null;
};

/** Un booléen, qui ne produit une valeur que lorsqu'il est vrai. */
const siVrai = (rendu: string) => (v: string): string | null =>
  (v.toLowerCase() === 'true' ? rendu : null);

/** Un identifiant en capitales, d'une liste fermée de formes. Aucune chaîne libre. */
const identifiantMajuscule = (v: string): string | null =>
  (/^[A-Z][A-Z0-9_]{1,39}$/.test(v) ? v : null);

/** Nom court de classe d'exception Java. Jamais son message, qui est libre. */
const nomException = (v: string): string | null =>
  (/^[A-Za-z][A-Za-z0-9]{0,39}(Exception|Error|Throwable)$/.test(v) ? v : null);

type Validateur = (v: string) => string | null;

interface Etape {
  cle: string;
  niveau: NiveauTechnique;
  /** Clés admises pour CETTE étape, et la forme exigée de chaque valeur. */
  champs: Record<string, Validateur>;
}

// ── Les étapes montrées, et elles seules ────────────────────────────────────
//
// Absentes volontairement : ENDPOINT_RESOLVED (porte l'hôte), HTTP_HEADERS
// (porte des noms d'en-tête choisis par l'exploitant), WS_FRAME_IN/OUT (trop
// bavardes pour un journal), SOCKS5_TARGET_RESOLVED (porte ce que l'utilisateur
// visite). Les omettre suffit à les écarter : rien n'a besoin de les interdire.

const ETAPES: Record<string, Etape> = {
  SOCKET_CREATED: {
    cle: 'tech_socket_created',
    niveau: 'info',
    champs: { tls: siVrai('TLS'), timeout_ms: duree },
  },
  DNS_RESOLVE: {
    cle: 'tech_dns',
    niveau: 'info',
    champs: { elapsed_ms: duree },
  },
  TCP_CONNECTED: {
    cle: 'tech_tcp',
    niveau: 'ok',
    champs: { elapsed_ms: duree },
  },
  TLS_HANDSHAKE_SUCCESS: {
    cle: 'tech_tls_ok',
    niveau: 'ok',
    champs: { protocol: versionTls, elapsed_ms: duree },
  },
  PAYLOAD_SENT: {
    cle: 'tech_payload_sent',
    niveau: 'info',
    champs: { bytes: octets },
  },
  HTTP_RESPONSE: {
    cle: 'tech_http_response',
    niveau: 'ok',
    champs: { status: statutHttp },
  },
  TRANSPORT_SELECTED: {
    cle: 'tech_transport',
    niveau: 'ok',
    champs: {
      // Deux vocabulaires coexistent selon le point d'émission : celui de la
      // classification HTTP, et celui des stratégies SSH. Les deux sont clos.
      mode: parmi(
        'WEBSOCKET_RFC6455', 'SSH_RAW', 'CONNECT_RAW', 'RAW_FALLBACK',
        'TLS_RAW', 'TLS_WS', 'WS', 'RAW',
      ),
      // Pourquoi ce mode a été retenu. Liste fermée : c'est ce qui distingue
      // un 101 cosmétique d'un vrai WebSocket, et cette nuance est
      // précisément ce qu'un exploitant cherche dans un journal.
      reason: parmi(
        'HTTP_101_UPGRADE', '101_THEN_SSH_BANNER', 'HTTP_200', 'HTTP_2XX_TUNNEL',
        'CONNECT_PAYLOAD', 'SSH_BANNER', 'UNKNOWN_RESPONSE',
      ),
    },
  },
  SOCKET_PROTECT: {
    cle: 'tech_socket_protect',
    niveau: 'info',
    champs: { result: siVrai('hors tunnel'), fd_ready: siVrai('fd prêt') },
  },
  MODE_CLASSIFIED: {
    // `status` porte une ligne HTTP libre : volontairement non admis ici.
    cle: 'tech_mode_classified',
    niveau: 'info',
    champs: {
      ws: siVrai('WebSocket'),
      connect200: siVrai('CONNECT 200'),
      ssh_banner: siVrai('bannière SSH'),
    },
  },
  SSH_ATTEMPT_START: {
    cle: 'tech_ssh_attempt',
    niveau: 'info',
    champs: { n: entier, tls: siVrai('TLS') },
  },
  SSH_OVER_TLS_START: {
    cle: 'tech_ssh_over_tls',
    niveau: 'info',
    champs: { sni_set: siVrai('SNI') },
  },
  SSH_HANDSHAKE_START: {
    cle: 'tech_ssh_handshake_start',
    niveau: 'info',
    champs: { n: entier, timeout_ms: duree },
  },
  SSH_HANDSHAKE_SUCCESS: {
    cle: 'tech_ssh_handshake_ok',
    niveau: 'ok',
    champs: { session_connected: siVrai('session ouverte') },
  },
  SOCKS5_READY: {
    // `port` est le port local du relais, pas une destination : sans valeur
    // pour qui observerait le journal, et sans rapport avec la navigation.
    cle: 'tech_socks_ready',
    niveau: 'ok',
    champs: { listen_loopback: siVrai('boucle locale'), port: entier },
  },
  TUN_CREATE_START: {
    cle: 'tech_tun_start',
    niveau: 'info',
    champs: { mtu: entier, auto_route: siVrai('routage auto'), strict_route: siVrai('routage strict') },
  },
  TUN_CREATED: {
    // `interface_name` est écarté : il n'apporte rien à l'utilisateur et
    // reste un détail d'appareil.
    cle: 'tech_tun_created',
    niveau: 'ok',
    champs: { fd_ready: siVrai('interface prête'), tun_counters: siVrai('compteurs lisibles') },
  },
  TUNNEL_TRAFFIC_CONFIRMED: {
    // LE fait que l'utilisateur attend : la preuve que des données circulent.
    cle: 'tech_traffic_confirmed',
    niveau: 'ok',
    champs: {
      proof: parmi('TUN_RX', 'SSH_RELAY_RX', 'ENGINE_LOG', 'PRESUMED_UNMEASURABLE'),
      bytes: octets,
    },
  },
  TUNNEL_PROOF_UNMEASURABLE: {
    cle: 'tech_proof_unmeasurable',
    niveau: 'attention',
    champs: { timeout_ms: duree },
  },
  TUNNEL_NO_TRAFFIC_PROOF: {
    cle: 'tech_no_traffic',
    niveau: 'echec',
    champs: { measurable: siVrai('mesure possible'), timeout_ms: duree },
  },
  WS_CLOSE: {
    cle: 'tech_ws_close',
    niveau: 'attention',
    champs: { code: entier, payload_bytes: octets },
  },
  WS_FRAME_TIMEOUT: {
    cle: 'tech_ws_timeout',
    niveau: 'attention',
    champs: { timeout_propagated: siVrai('délai propagé') },
  },
  SOCKS5_ERROR: {
    // Le NOM de la classe d'exception, jamais son message : celui-ci peut
    // contenir l'hôte que l'utilisateur tentait de joindre.
    cle: 'tech_socks_error',
    niveau: 'attention',
    champs: { type: nomException },
  },
  VPN_FAILED: {
    cle: 'tech_vpn_failed',
    niveau: 'echec',
    champs: {
      code: identifiantMajuscule,
      state: parmi('CONNECTING', 'HANDSHAKING', 'CONNECTED', 'DISCONNECTED', 'ERROR'),
    },
  },
  SSH_BANNER_WAIT: {
    cle: 'tech_ssh_banner',
    niveau: 'info',
    champs: { timeout_ms: duree },
  },
  LIBBOX_STARTED: {
    cle: 'tech_engine_started',
    niveau: 'ok',
    champs: {},
  },
  SOCKS5_RELAY_CLOSED: {
    cle: 'tech_relay_closed',
    niveau: 'info',
    champs: { upload_bytes: octets, download_bytes: octets },
  },
};

/**
 * `stage=NAME` dans une trace du moteur.
 *
 * Le moteur émet deux formes : `[SXB_TRACE] stage=X` en direct, et
 * `[SXB_TRACE] seq=12 elapsed_ms=8400 stage=X` via son aide `trace()`. Un
 * motif qui exigeait `stage=` collé au marqueur ne voyait que la première —
 * « Tunnel établi » n'a donc jamais pu s'afficher. Les paires intercalées
 * sont admises, mais seulement sous forme `clé=valeur` bien formée : rien
 * d'autre ne peut se glisser avant l'étape.
 */
const MOTIF_ETAPE = /\[SXB_TRACE\]\s+(?:[a-z][a-z0-9_]*=\S*\s+)*stage=([A-Z0-9_]+)/;

/**
 * Lit une ligne du moteur et rend le fait technique qu'elle porte.
 *
 * Rend `null` pour tout ce qui n'est pas une trace reconnue — ce qui inclut,
 * volontairement, les traces dont l'étape n'est pas citée plus haut.
 */
export function analyserTrace(ligne: string): FaitTechnique | null {
  if (typeof ligne !== 'string') return null;
  const tete = ligne.match(MOTIF_ETAPE);
  if (!tete) return null;

  const etape = ETAPES[tete[1]];
  if (!etape) return null;

  // Les champs se lisent APRÈS le nom d'étape, jamais avant. Le préfixe de
  // l'aide `trace()` porte son propre `elapsed_ms` — la durée d'allumage de
  // l'appareil, pas celle de l'étape. Le lire à la place du bon champ
  // afficherait un chiffre faux.
  const corps = ligne.slice((tete.index ?? 0) + tete[0].length);

  const valeurs: string[] = [];
  for (const [champ, valider] of Object.entries(etape.champs)) {
    // La valeur court jusqu'à la clé suivante : un statut HTTP contient des
    // espaces, et s'arrêter au premier le tronquerait. La clé suivante peut
    // contenir des chiffres (« connect200 ») : l'ignorer ferait déborder la
    // valeur précédente sur elle, et le validateur la rejetterait à tort.
    const m = corps.match(new RegExp(`\\b${champ}=(.*?)(?=\\s+[a-z][a-z0-9_]*=|$)`));
    if (!m) continue;
    const sure = valider(m[1].trim());
    if (sure) valeurs.push(sure);
  }

  return { cle: etape.cle, valeurs, niveau: etape.niveau, etape: tete[1] };
}

/**
 * Met un fait technique en une ligne lisible.
 *
 * @param fait    Ce que `analyserTrace` a reconnu.
 * @param libelle Le libellé déjà traduit — l'appelant tient `t()`.
 */
export function formaterFait(fait: FaitTechnique, libelle: string): string {
  return fait.valeurs.length ? `${libelle} · ${fait.valeurs.join(' · ')}` : libelle;
}
