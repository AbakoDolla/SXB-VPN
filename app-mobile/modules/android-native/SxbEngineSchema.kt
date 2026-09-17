package com.sxbvpn.vpnmodule

import org.json.JSONArray
import org.json.JSONObject

/**
 * SxbEngineSchema — traduction PURE d'une configuration sing-box vers le
 * schéma du moteur embarqué.
 *
 * Ce fichier ne contient aucune dépendance Android : il est compilé et exécuté
 * tel quel par le harnais Kotlin des tests, comme `SxbTunnelPolicy` et
 * `SxbReconnectPolicy`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE MODULE EXISTE
 * ═══════════════════════════════════════════════════════════════════════════
 * Le moteur passe de sing-box 1.11 à 1.14. Entre les deux, sing-box n'a pas
 * seulement déprécié des options : il en a SUPPRIMÉ. Trois d'entre elles sont
 * écrites par SXB dans chaque configuration qu'il produit, et une quatrième se
 * trouve dans les configurations que les exploitants importent :
 *
 *  • l'outbound `{"type":"dns"}` — supprimé en 1.13, remplacé par l'action de
 *    route `hijack-dns` ;
 *  • les champs `sniff` / `sniff_override_destination` sur un inbound —
 *    supprimés en 1.13, remplacés par l'action de route `sniff` ;
 *  • le format de serveur DNS `{"address": …}` — supprimé en 1.14, remplacé
 *    par une forme typée `{"type": …, "server": …}` ;
 *  • le bloc `dns.fakeip` — supprimé en 1.14, fusionné dans le serveur.
 *
 * Une configuration qui en contient une seule est REFUSÉE EN BLOC par le
 * moteur. Sans ce module, la montée de version rendrait donc inutilisable
 * l'intégralité du parc : chaque profil déjà provisionné sur chaque téléphone,
 * et chaque profil stocké sur le tableau de bord.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POURQUOI LA TRADUCTION VIT ICI, ET NON DANS LES GÉNÉRATEURS
 * ═══════════════════════════════════════════════════════════════════════════
 * SXB produit ses configurations à six endroits, et en reçoit d'autres déjà
 * écrites — sing-box natif importé, Xray traduit, profils provisionnés il y a
 * des semaines sur des téléphones que personne ne peut mettre à jour. Corriger
 * les générateurs un par un laisserait ces dernières de côté, c'est-à-dire
 * précisément celles qu'on ne peut pas réparer après coup.
 *
 * La traduction est donc appliquée à la FRONTIÈRE : le point unique par lequel
 * toute configuration entre dans le moteur. Tout ce qui passe est traduit, quel
 * que soit son âge et son origine.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CE QUE CE MODULE NE FAIT JAMAIS
 * ═══════════════════════════════════════════════════════════════════════════
 * Il ne change ni l'adresse jointe, ni le nom présenté en TLS, ni l'en-tête
 * Host, ni les identifiants, ni le transport. Il ne traduit QUE la forme, et
 * une configuration déjà écrite au format courant en ressort inchangée.
 */
object SxbEngineSchema {

    /** Version du moteur embarqué, alignée sur `scripts/build-libbox.sh`. */
    const val ENGINE_VERSION = "1.12.9"

    /** Stratégies de résolution acceptées par le moteur. */
    private val STRATEGIES = setOf("prefer_ipv4", "prefer_ipv6", "ipv4_only", "ipv6_only")

    /**
     * Noms de code de réponse DNS, du format hérité vers celui du moteur.
     *
     * Le format hérité employait des noms lisibles (`rcode://success`) ; le
     * format courant attend les mnémoniques du protocole DNS lui-même. Les
     * deux vocabulaires ne se recouvrent PAS : « success » n'existe pas côté
     * DNS, où le code 0 s'appelle NOERROR. Traduire mot pour mot produit donc
     * une configuration que le moteur refuse — et il refuse l'ensemble, pas
     * seulement la règle fautive.
     */
    private val RCODES = mapOf(
        "success" to "NOERROR",
        "format_error" to "FORMERR",
        "server_failure" to "SERVFAIL",
        "name_error" to "NXDOMAIN",
        "not_implemented" to "NOTIMP",
        "refused" to "REFUSED",
    )

    /**
     * Clés d'une règle qui ne sont PAS des critères de correspondance.
     *
     * Sert à reconnaître une règle dont on vient de retirer le dernier critère :
     * laissée telle quelle, elle ne filtrerait plus rien et s'appliquerait donc
     * à TOUT le trafic — l'inverse de ce qu'elle exprimait.
     */
    private val CLES_NON_CRITERES = setOf(
        "outbound", "action", "invert", "server", "strategy", "client_subnet",
        "disable_cache", "rewrite_ttl", "override_address", "override_port",
        "sniffer", "timeout", "rcode", "answer", "ns", "extra",
    )

    /**
     * Champs d'inbound supprimés en 1.13 (`option.InboundOptions`).
     * Leur seule présence fait refuser la configuration entière.
     */
    private val CHAMPS_INBOUND_SUPPRIMES = listOf(
        "sniff", "sniff_override_destination", "sniff_timeout",
        "domain_strategy", "udp_disable_domain_unmapping",
    )

    /**
     * Rend une configuration acceptable par le moteur courant.
     *
     * L'objet reçu n'est jamais modifié : une configuration est une donnée
     * partagée — elle est relue à chaque reprise du tunnel — et la traduire en
     * place ferait dépendre le résultat du nombre de tentatives déjà faites.
     */
    fun moderniser(source: JSONObject): JSONObject {
        val config = JSONObject(source.toString())

        // L'ordre compte : les inbounds disent s'il faut une action `sniff`, les
        // outbounds disent quelles règles de route deviennent `hijack-dns` ou
        // `reject`, et le DNS fournit le résolveur d'amorçage que la route doit
        // désigner. Les trois sont donc lus AVANT de réécrire la route.
        val sniffDemande = moderniserInbounds(config)
        val speciaux = moderniserOutbounds(config)
        val dns = config.optJSONObject("dns")?.let { moderniserDns(it) }
        if (dns != null) config.put("dns", dns)
        moderniserRoute(config, sniffDemande, speciaux, resolveurDAmorcage(dns))
        return config
    }

    /**
     * Étiquette du serveur DNS joignable SANS le tunnel, ou `null`.
     *
     * C'est lui qui doit résoudre le nom du serveur de sortie : le résoudre par
     * le tunnel exigerait le tunnel, dont l'ouverture exige cette résolution.
     * Le moteur appelle cela `default_domain_resolver`, et depuis 1.12 il
     * avertit quand il manque — puis le refusera.
     */
    private fun resolveurDAmorcage(dns: JSONObject?): String? {
        val serveurs = dns?.optJSONArray("servers") ?: return null
        for (i in 0 until serveurs.length()) {
            val serveur = serveurs.optJSONObject(i) ?: continue
            if (serveur.optString("type") == "fakeip") continue
            val tag = serveur.optString("tag", "")
            if (tag.isNotEmpty() && serveur.optString("detour", "") == "direct") return tag
        }
        return null
    }

    // ── Inbounds ─────────────────────────────────────────────────────────────

    /**
     * Retire les champs d'inbound supprimés et rend `true` si l'un d'eux
     * demandait l'inspection du trafic.
     *
     * L'inspection n'est pas un détail : c'est elle qui lit le nom de domaine
     * dans la poignée de main TLS. Sans elle, les règles de route par domaine
     * ne voient plus que des adresses IP et cessent de s'appliquer. On ne se
     * contente donc pas de supprimer le champ — on reporte ce qu'il demandait.
     */
    private fun moderniserInbounds(config: JSONObject): Boolean {
        val inbounds = config.optJSONArray("inbounds") ?: return false
        var sniff = false
        for (i in 0 until inbounds.length()) {
            val inbound = inbounds.optJSONObject(i) ?: continue
            if (inbound.optBoolean("sniff", false)) sniff = true
            for (champ in CHAMPS_INBOUND_SUPPRIMES) inbound.remove(champ)
        }
        return sniff
    }

    // ── Outbounds ────────────────────────────────────────────────────────────

    /** Étiquettes des outbounds spéciaux retirés, par nature. */
    private data class Speciaux(val dns: MutableSet<String>, val block: MutableSet<String>)

    /**
     * Retire les outbounds spéciaux devenus des actions de route.
     *
     * `{"type":"dns"}` est un refus net du moteur depuis 1.13. `{"type":"block"}`
     * est encore accepté, mais il est retiré de la même façon : garder une
     * forme dépréciée par simple prudence, c'est se garantir la même panne à la
     * version suivante.
     */
    private fun moderniserOutbounds(config: JSONObject): Speciaux {
        val speciaux = Speciaux(mutableSetOf(), mutableSetOf())
        val outbounds = config.optJSONArray("outbounds") ?: return speciaux
        val conserves = JSONArray()
        for (i in 0 until outbounds.length()) {
            val outbound = outbounds.optJSONObject(i) ?: continue
            val tag = outbound.optString("tag", "")
            val type = outbound.optString("type", "")
            if (type == "dns" || type == "block") {
                if (tag.isNotEmpty()) {
                    if (type == "dns") speciaux.dns.add(tag) else speciaux.block.add(tag)
                }
                continue
            }
            // `domain_strategy` sur un outbound demande au moteur de résoudre le
            // saut suivant lui-même ; remplacé par `domain_resolver` en 1.12.
            outbound.remove("domain_strategy")
            conserves.put(outbound)
        }
        config.put("outbounds", conserves)
        return speciaux
    }

    // ── Route ────────────────────────────────────────────────────────────────

    /**
     * Retire un critère `geosite`, et dit si la règle garde un sens.
     *
     * ═══════════════════════════════════════════════════════════════════════
     * POURQUOI LE CRITÈRE DISPARAÎT
     * ═══════════════════════════════════════════════════════════════════════
     * `geosite` désignait une catégorie dans une base de domaines embarquée.
     * sing-box l'a remplacée par les jeux de règles et l'a SUPPRIMÉE en 1.12 :
     * une configuration qui en contient est refusée entière.
     *
     * On ne peut pas la traduire : il faudrait la liste des domaines de la
     * catégorie, et l'inventer produirait un routage qui ressemble à celui
     * demandé sans l'être — la pire des pannes, parce qu'elle a l'air de
     * fonctionner. Le critère est donc retiré, et le trafic qu'il détournait
     * suit la route par défaut, c'est-à-dire le tunnel. Pour un VPN, c'est le
     * repli sûr : on protège plus que demandé, jamais moins.
     *
     * Rend `false` quand la règle n'avait QUE ce critère. La garder la rendrait
     * universelle — elle s'appliquerait à tout le trafic, exactement l'inverse
     * de ce qu'elle exprimait.
     */
    private fun retirerGeosite(regle: JSONObject): Boolean {
        if (!regle.has("geosite")) return true
        regle.remove("geosite")
        return regle.keys().asSequence().any { it !in CLES_NON_CRITERES }
    }

    /**
     * Réécrit les règles qui visaient un outbound spécial, et rétablit
     * l'inspection du trafic sous forme d'action.
     */
    private fun moderniserRoute(
        config: JSONObject,
        sniffDemande: Boolean,
        speciaux: Speciaux,
        resolveurAmorcage: String?,
    ) {
        val routeExistante = config.optJSONObject("route")
        // Sans route ni inspection à rétablir, il n'y a rien à réécrire : en
        // fabriquer une vide ajouterait une section que le moteur n'attend pas.
        if (routeExistante == null && !sniffDemande) return
        val route = routeExistante ?: JSONObject()

        // Le moteur veut savoir QUI résout le nom d'un serveur de sortie. Sans
        // cette indication il avertit depuis 1.12, et refusera ensuite. La
        // réponse est le résolveur d'amorçage : le seul joignable sans le
        // tunnel que cette résolution doit précisément permettre d'ouvrir.
        if (resolveurAmorcage != null && !route.has("default_domain_resolver")) {
            route.put("default_domain_resolver", resolveurAmorcage)
        }

        val source = route.optJSONArray("rules") ?: JSONArray()
        val rules = JSONArray()

        // L'inspection doit précéder toute règle de routage : une règle par
        // domaine placée avant elle s'évaluerait sur une destination que le
        // moteur n'a pas encore lue.
        if (sniffDemande) rules.put(JSONObject().put("action", "sniff"))

        for (i in 0 until source.length()) {
            val regle = source.optJSONObject(i) ?: continue
            if (!retirerGeosite(regle)) continue
            if (regle.has("action")) { rules.put(regle); continue }
            val cible = regle.optString("outbound", "")
            when {
                cible.isNotEmpty() && speciaux.dns.contains(cible) -> {
                    regle.remove("outbound")
                    regle.put("action", "hijack-dns")
                }
                cible.isNotEmpty() && speciaux.block.contains(cible) -> {
                    regle.remove("outbound")
                    regle.put("action", "reject")
                }
            }
            rules.put(regle)
        }
        route.put("rules", rules)

        // Un `final` qui désignait un outbound retiré laisserait la route sans
        // sortie : le moteur refuserait la configuration pour une référence
        // pendante. On le laisse tomber, et le moteur reprend son défaut.
        val fin = route.optString("final", "")
        if (fin.isNotEmpty() && (speciaux.dns.contains(fin) || speciaux.block.contains(fin))) {
            route.remove("final")
        }
        config.put("route", route)
    }

    // ── DNS ──────────────────────────────────────────────────────────────────

    /**
     * Traduit le bloc `dns` vers la forme typée.
     *
     * Le format hérité décrivait un serveur par une URL (`tls://1.1.1.1`,
     * `https://dns.google/dns-query`). Le format courant sépare ce que cette
     * URL mélangeait : le TRANSPORT d'un côté (`type`), l'ADRESSE de l'autre
     * (`server`, `server_port`).
     */
    private fun moderniserDns(source: JSONObject): JSONObject {
        val dns = JSONObject(source.toString())
        // La mémoire est désormais indexée par transport : le champ ne veut
        // plus rien dire, et le moteur refuse ce qu'il ne connaît pas.
        dns.remove("independent_cache")

        val serveurs = dns.optJSONArray("servers") ?: return dns
        val fakeip = dns.optJSONObject("fakeip")
        dns.remove("fakeip")
        val fakeipActif = fakeip == null || fakeip.optBoolean("enabled", true)

        val traduits = JSONArray()
        /** Étiquettes disparues, et le code de réponse que chacune fabriquait. */
        val rcodes = mutableMapOf<String, String>()
        val abandonnes = mutableSetOf<String>()
        /** Stratégie de chaque serveur, pour la reporter sur ses règles. */
        val strategies = mutableMapOf<String, String>()
        /** Sous-réseau client de chaque serveur, à reporter de la même façon. */
        val sousReseaux = mutableMapOf<String, String>()

        for (i in 0 until serveurs.length()) {
            val serveur = serveurs.optJSONObject(i) ?: continue
            val tag = serveur.optString("tag", "")

            // Déjà au format courant : on n'y touche pas.
            if (serveur.has("type") && !serveur.has("address")) { traduits.put(serveur); continue }

            val adresse = serveur.optString("address", "").trim()
            val strategie = serveur.optString("strategy", "").trim().lowercase()
            if (tag.isNotEmpty() && strategie in STRATEGIES) strategies[tag] = strategie

            // `rcode://` ne désignait aucun serveur : la réponse était fabriquée
            // sur place. C'est devenu une action de règle, et le vocabulaire a
            // changé avec elle — voir RCODES.
            if (adresse.startsWith("rcode://", ignoreCase = true)) {
                val nom = adresse.substringAfter("://").trim().lowercase()
                // Un nom hors de la table est laissé tel quel, en majuscules :
                // le moteur rendra alors la même erreur qu'avant, plutôt que de
                // recevoir une valeur que nous aurions inventée.
                if (tag.isNotEmpty()) rcodes[tag] = RCODES[nom] ?: nom.uppercase()
                continue
            }
            if (adresse.equals("fakeip", ignoreCase = true) && !fakeipActif) {
                if (tag.isNotEmpty()) abandonnes.add(tag)
                continue
            }

            val traduit = JSONObject()
            if (tag.isNotEmpty()) traduit.put("tag", tag)
            appliquerAdresse(traduit, adresse, fakeip)

            // Un serveur `fakeip` n'accepte QUE ses plages : il ne joint rien,
            // il fabrique des adresses. Lui laisser un `detour` hérité — que le
            // format précédent tolérait — ferait refuser la configuration pour
            // un champ inconnu.
            if (traduit.optString("type") != "fakeip") {
                // `address_resolver` désignait le serveur chargé de résoudre le
                // NOM de celui-ci. Renommé, pour dire ce qu'il fait.
                val resolveur = serveur.optString("address_resolver", "").trim()
                if (resolveur.isNotEmpty()) traduit.put("domain_resolver", resolveur)
                if (serveur.has("detour")) traduit.put("detour", serveur.get("detour"))
            }
            // `client_subnet` n'est plus une propriété du serveur : il se pose
            // sur les règles qui le désignent, comme la stratégie. Lu sans
            // supposer son type : une valeur inattendue ne doit pas faire
            // échouer la traduction de TOUTE la configuration.
            val sousReseau = serveur.optString("client_subnet", "").trim()
            if (tag.isNotEmpty() && sousReseau.isNotEmpty()) sousReseaux[tag] = sousReseau
            traduits.put(traduit)
        }
        dns.put("servers", traduits)

        moderniserReglesDns(dns, rcodes, abandonnes, strategies, sousReseaux)

        // La stratégie par serveur n'existe plus. Celle du serveur de dernier
        // recours devient la stratégie globale ; les autres ont été reportées
        // sur les règles qui désignent leur serveur, juste au-dessus.
        val fin = dns.optString("final", "")
        val globale = strategies[fin] ?: strategies.values.firstOrNull()
        if (globale != null && !dns.has("strategy")) dns.put("strategy", globale)
        return dns
    }

    /**
     * Pose `type` et l'adresse d'après l'URL héritée.
     *
     * Une adresse sans schéma désignait un serveur DNS ordinaire, donc UDP —
     * c'est ce que faisait le moteur, et le supposer autrement changerait le
     * comportement de profils qui fonctionnent.
     */
    private fun appliquerAdresse(cible: JSONObject, adresse: String, fakeip: JSONObject?) {
        val valeur = adresse.trim()
        when {
            valeur.isEmpty() || valeur.equals("local", ignoreCase = true) ||
                valeur.startsWith("local://", ignoreCase = true) -> {
                cible.put("type", "local")
                return
            }
            valeur.equals("fakeip", ignoreCase = true) -> {
                cible.put("type", "fakeip")
                // Les plages vivaient dans `dns.fakeip` ; elles appartiennent
                // désormais au serveur lui-même.
                val v4 = fakeip?.optString("inet4_range", "")?.takeIf { it.isNotEmpty() } ?: "198.18.0.0/15"
                cible.put("inet4_range", v4)
                fakeip?.optString("inet6_range", "")?.takeIf { it.isNotEmpty() }
                    ?.let { cible.put("inet6_range", it) }
                return
            }
            valeur.startsWith("dhcp://", ignoreCase = true) -> {
                cible.put("type", "dhcp")
                val interfaceReseau = valeur.substringAfter("://")
                if (interfaceReseau.isNotEmpty() && !interfaceReseau.equals("auto", ignoreCase = true)) {
                    cible.put("interface", interfaceReseau)
                }
                return
            }
        }

        val schema = if (valeur.contains("://")) valeur.substringBefore("://").lowercase() else "udp"
        val reste = if (valeur.contains("://")) valeur.substringAfter("://") else valeur
        // Le chemin d'une URL DoH (`/dns-query`) est le défaut du moteur : le
        // recopier n'apporte rien et ferait échouer les serveurs qui n'en
        // servent qu'un seul.
        val hotePort = reste.substringBefore('/')

        cible.put("type", schema)
        if (hotePort.startsWith("[")) {
            // IPv6 entre crochets : `[2001:db8::1]:853`.
            cible.put("server", hotePort.substringAfter('[').substringBefore(']'))
            val apres = hotePort.substringAfter(']')
            if (apres.startsWith(":")) {
                apres.drop(1).toIntOrNull()?.let { cible.put("server_port", it) }
            }
        } else if (hotePort.count { it == ':' } == 1) {
            cible.put("server", hotePort.substringBefore(':'))
            hotePort.substringAfter(':').toIntOrNull()?.let { cible.put("server_port", it) }
        } else {
            cible.put("server", hotePort)
        }
    }

    /**
     * Reporte sur les règles DNS ce que les serveurs ne portent plus : la
     * stratégie, et les réponses fabriquées par les anciens `rcode://`.
     */
    private fun moderniserReglesDns(
        dns: JSONObject,
        rcodes: Map<String, String>,
        abandonnes: Set<String>,
        strategies: Map<String, String>,
        sousReseaux: Map<String, String>,
    ) {
        val source = dns.optJSONArray("rules") ?: return
        val rules = JSONArray()
        for (i in 0 until source.length()) {
            val regle = source.optJSONObject(i) ?: continue
            if (!retirerGeosite(regle)) continue
            val cible = regle.optString("server", "")
            // Une règle qui désigne un serveur disparu est une référence
            // pendante : le moteur refuse la configuration entière.
            if (abandonnes.contains(cible)) continue
            if (rcodes.containsKey(cible)) {
                regle.remove("server")
                regle.put("action", "predefined")
                regle.put("rcode", rcodes.getValue(cible))
            } else {
                val strategie = strategies[cible]
                if (strategie != null && !regle.has("strategy")) regle.put("strategy", strategie)
                val sousReseau = sousReseaux[cible]
                if (sousReseau != null && !regle.has("client_subnet")) {
                    regle.put("client_subnet", sousReseau)
                }
            }
            rules.put(regle)
        }
        dns.put("rules", rules)

        val fin = dns.optString("final", "")
        if (fin.isNotEmpty() && abandonnes.contains(fin)) dns.remove("final")
    }
}
