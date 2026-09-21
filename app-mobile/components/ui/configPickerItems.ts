type NamedConfig = { id: string; name: string };

/** Un accès tel que le serveur l'annonce — la forme que l'accueil affiche déjà. */
type AssignmentOrigin = {
  label: string;
  tone: 'superadmin' | 'admin' | 'reseller' | 'support' | 'default';
  role: string | null;
};

type AccesDistant = {
  id: string;
  name: string;
  status?: string;
  displayProtocol?: string;
  technicalProtocol?: string;
  assignmentOrigin?: AssignmentOrigin | null;
  assignedByRole?: string | null;
};

/**
 * États qu'un profil peut porter.
 *
 * Réécrits ici plutôt qu'importés : ce module ne dépend d'aucun service, et
 * c'est ce qui permet de le tester sans monter la moitié de l'application. Le
 * test de parité ci-contre vérifie que la liste reste celle d'`accessPolicy`.
 */
const ETATS_PROFIL = ['active', 'suspended', 'revoked', 'deleted', 'expired', 'exhausted'] as const;
export type EtatProfil = (typeof ETATS_PROFIL)[number];

/** Une entrée que le serveur annonce mais dont l'appareil n'a pas la configuration. */
export type AccesEnAttente = {
  id: string;
  name: string;
  protocol: string;
  isActive: false;
  status?: EtatProfil;
  assignmentOrigin?: AssignmentOrigin | null;
  /** L'appareil ne détient pas encore la configuration de cet accès. */
  enAttente: true;
};

/**
 * Accès annoncés par le serveur dont le coffre local n'a rien.
 *
 * ── POURQUOI CETTE FONCTION EXISTE ────────────────────────────────────────
 *
 * L'accueil et ce sélecteur ne lisaient pas la même source : l'accueil liste
 * `/mobile/connections` (ce que le SERVEUR accorde), le sélecteur listait le
 * coffre local (ce que l'appareil a RÉUSSI à provisionner). Quand un
 * provisionnement échouait — il n'est journalisé qu'en console —, l'accès
 * continuait d'apparaître avec sa barre de quota sur l'accueil et
 * DISPARAISSAIT purement et simplement du sélecteur.
 *
 * L'utilisateur voyait donc son forfait, sans pouvoir le choisir, et sans
 * qu'aucun message n'explique l'écart.
 *
 * Or `switchConfig` sait déjà provisionner à la demande : la capacité
 * existait, seul son ACCÈS manquait. Remettre ces entrées dans la liste suffit
 * donc à réparer le symptôme, sans dupliquer la moindre logique de
 * provisionnement.
 *
 * Les accès non actifs sont conservés eux aussi, avec leur état : le
 * sélecteur sait déjà les présenter comme inutilisables. Les écarter ici
 * recréerait exactement le trou que cette fonction comble.
 *
 * L'état est RÉTRÉCI, jamais affirmé : `VpnConnection.status` est un `string`
 * nu, et un état inconnu doit rester sans pastille plutôt que d'en porter une
 * fausse.
 */
export function accesSansConfigLocale(
  configs: readonly NamedConfig[],
  connections: readonly AccesDistant[],
): AccesEnAttente[] {
  const detenus = new Set(configs.map(config => config.id));
  return connections
    .filter(acces => !detenus.has(acces.id))
    .map(acces => {
      const etat = ETATS_PROFIL.find(connu => connu === acces.status);
      return {
        id: acces.id,
        name: acces.name,
        protocol: acces.displayProtocol || acces.technicalProtocol || '',
        isActive: false as const,
        ...(etat ? { status: etat } : {}),
        ...(acces.assignmentOrigin ? { assignmentOrigin: acces.assignmentOrigin } : {}),
        enAttente: true as const,
      };
    });
}

function searchKey(value: string) {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase();
}

export function visibleConfigs<T extends NamedConfig>(
  configs: readonly T[],
  activeConfigId: string | null,
  query: string,
  language: 'fr' | 'en',
): T[] {
  const key = searchKey(query.trim());
  return configs
    .filter(config => searchKey(config.name).includes(key))
    .sort((a, b) =>
      Number(b.id === activeConfigId) - Number(a.id === activeConfigId)
      || a.name.localeCompare(b.name, language, { sensitivity: 'base', numeric: true }),
    );
}
