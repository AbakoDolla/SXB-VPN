/**
 * journalTechnique — transformer les traces du moteur en faits lisibles et sûrs.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE CE MODULE RÉSOUT
 * ══════════════════════════════════════════════════════════════════════════
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
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI UNE LISTE BLANCHE, ET JAMAIS UN MASQUAGE
 * ══════════════════════════════════════════════════════════════════════════
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

/**
 * Code d'erreur symbolique du moteur — `SSH_TIMEOUT`, `CONFIG_UNSUPPORTED`.
 *
 * La forme est close des deux côtés : capitales, chiffres et soulignés, trente
 * caractères au plus. Un hôte, une adresse ou une clé ne peuvent pas la
 * satisfaire, car tous portent un caractère qu'elle refuse — point, deux-points
 * ou minuscule.
 */
const codeSymbolique = (v: string): string | null =>
  (/^[A-Z][A-Z0-9_]{2,31}$/.test(v) ? v : null);

/**
 * Nom de classe d'exception Java — `SocketTimeoutException`.
 *
 * Le moteur n'émet que `e.javaClass.simpleName` : jamais le message, qui lui
 * porterait l'hôte. Le motif exige le suffixe pour que seule cette grandeur-là
 * puisse passer.
 */
const nomException = (v: string): string | null =>
  (/^[A-Za-z][A-Za-z0-9]{2,48}Exception$/.test(v) ? v : null);

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
// visite), MODE_CLASSIFIED (porte une ligne de statut libre), PAYLOAD_NORMALIZED
// et POST_HEADER_PEEK (portent le contenu de la charge utile). Les omettre
// suffit à les écarter : rien n'a besoin de les interdire.

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
      mode: parmi('WEBSOCKET_RFC6455', 'SSH_RAW', 'CONNECT_RAW', 'RAW_FALLBACK'),
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

  // ── Cycle de vie de la connexion ──────────────────────────────────────────
  //
  // Ces étapes viennent du raccourci `trace()` du moteur. Elles étaient émises
  // depuis toujours, et jetées par un motif trop strict (voir MOTIF_ETAPE).
  // Ce sont elles qui disent OÙ une connexion s'arrête : quelle tentative,
  // quel transport, quelle poignée de main, quelle interface.

  SSH_TUNNEL_START: {
    cle: 'tech_ssh_tunnel_start',
    niveau: 'info',
    champs: {},
  },
  SSH_ATTEMPT_START: {
    cle: 'tech_ssh_attempt',
    niveau: 'info',
    // `transport` est la stratégie retenue : raw, tls_raw, tls_ws, ws.
    champs: { n: entier, transport: parmi('RAW', 'TLS_RAW', 'TLS_WS', 'WS') },
  },
  SSH_HANDSHAKE_START: {
    cle: 'tech_ssh_handshake',
    niveau: 'info',
    champs: { transport: parmi('RAW', 'TLS_RAW', 'TLS_WS', 'WS'), timeout_ms: duree },
  },
  SSH_OVER_TLS_START: {
    cle: 'tech_ssh_over_tls',
    niveau: 'info',
    // `sni_set` est un booléen : il dit qu'un SNI est posé, jamais lequel.
    champs: { sni_set: siVrai('SNI') },
  },
  SSH_HANDSHAKE_SUCCESS: {
    cle: 'tech_ssh_ok',
    niveau: 'ok',
    champs: {},
  },
  SOCKS5_READY: {
    cle: 'tech_socks_ready',
    niveau: 'ok',
    // Le port est celui du relais LOCAL, en boucle locale : il ne désigne
    // aucun serveur distant.
    champs: { port: entier },
  },
  TUN_CREATE_START: {
    cle: 'tech_tun_start',
    niveau: 'info',
    champs: { mtu: entier },
  },
  TUN_CREATED: {
    cle: 'tech_tun_ready',
    niveau: 'ok',
    // `interface_name` est volontairement omis : il n'apprend rien à
    // l'utilisateur et n'a pas de forme close.
    champs: { fd_ready: siVrai('FD') },
  },
  VPN_FAILED: {
    cle: 'tech_vpn_failed',
    niveau: 'echec',
    champs: { code: codeSymbolique },
  },
  CLEANUP_START: {
    cle: 'tech_cleanup_start',
    niveau: 'info',
    champs: {},
  },
  CLEANUP_COMPLETE: {
    cle: 'tech_cleanup_done',
    niveau: 'info',
    champs: {},
  },

  // ── Diagnostics d'échec ───────────────────────────────────────────────────
  //
  // Émises par le moteur, et jusqu'ici invisibles alors qu'elles nomment la
  // panne. Ce sont les seules traces qui distinguent « le tunnel n'a jamais
  // répondu » de « le tunnel a été fermé par l'autre bout ».

  SOCKS5_ERROR: {
    cle: 'tech_socks_error',
    niveau: 'echec',
    champs: { type: nomException },
  },
  WS_FRAME_TIMEOUT: {
    cle: 'tech_ws_timeout',
    niveau: 'attention',
    champs: {},
  },
  WS_CLOSE: {
    cle: 'tech_ws_close',
    niveau: 'attention',
    champs: { code: entier },
  },
  SOCKET_PROTECT: {
    cle: 'tech_socket_protect',
    niveau: 'info',
    // Dit que le socket échappe au tunnel — sans quoi la connexion se
    // mordrait la queue. Booléen seul.
    champs: { result: siVrai('OK') },
  },
};

/**
 * `stage=NAME` dans une trace du moteur.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI LE MOTIF NE COLLE PAS `stage=` AU MARQUEUR
 * ══════════════════════════════════════════════════════════════════════════
 * Le moteur émet ses traces sous DEUX formes, et elles ne se ressemblent pas :
 *
 *   directe   [SXB_TRACE] stage=TCP_CONNECTED elapsed_ms=412
 *   par aide  [SXB_TRACE] seq=7 elapsed_ms=3400 stage=TUN_CREATED fd_ready=true
 *
 * La seconde vient du raccourci `trace(stage, detail)` de SxbVpnService.kt,
 * qui préfixe un numéro d'ordre et l'horloge de l'appareil. Un motif exigeant
 * `stage=` juste après le marqueur ne reconnaissait donc QUE la première :
 * les treize étapes du cycle de vie — démarrage du moteur, poignée de main
 * SSH, création de l'interface, échec, arrêt — étaient émises, masquées,
 * transmises… puis jetées ici en silence. `LIBBOX_STARTED` figurait même dans
 * la table ci-dessus sans avoir jamais pu s'afficher une seule fois.
 *
 * Le préfixe admis est volontairement étroit : des paires `clé=valeur` à clé
 * MINUSCULE uniquement. Un nom d'étape reste donc le seul jeton en capitales,
 * et rien d'autre ne peut se glisser à sa place.
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

  /**
   * Les champs ne sont cherchés QU'APRÈS le nom d'étape.
   *
   * Le préfixe du raccourci porte lui aussi un `elapsed_ms` — mais c'est
   * l'horloge de l'appareil depuis son démarrage, pas la durée de l'étape.
   * Le lire produirait « 3.4 s » là où l'étape a pris 12 ms, c'est-à-dire un
   * chiffre faux présenté comme une mesure. Borner la recherche à l'aval du
   * nom d'étape écarte cette confusion par construction, sans avoir à
   * reconnaître le cas.
   */
  const reste = ligne.slice(tete.index! + tete[0].length);

  const valeurs: string[] = [];
  for (const [champ, valider] of Object.entries(etape.champs)) {
    // La valeur court jusqu'à la clé suivante : un statut HTTP contient des
    // espaces, et s'arrêter au premier le tronquerait.
    const m = reste.match(new RegExp(`\\b${champ}=(.*?)(?=\\s+[a-z_]+=|$)`));
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
