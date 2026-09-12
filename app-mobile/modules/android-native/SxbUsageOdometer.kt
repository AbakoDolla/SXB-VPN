package com.sxbvpn.vpnmodule

/**
 * SxbUsageOdometer — arithmétique du comptage de consommation.
 *
 * POURQUOI CE FICHIER EXISTE
 * ──────────────────────────
 * Les compteurs que lit le service (compteurs noyau de l'interface TUN,
 * compteurs UID d'Android) sont des compteurs de SESSION : ils repartent de
 * zéro à chaque reconnexion du tunnel, à chaque recréation de l'interface, et
 * à chaque redémarrage du téléphone. Le code qui remontait la consommation
 * calculait pourtant un simple `courant - précédent` borné à zéro. Une remise
 * à zéro produisait donc un delta NUL, et tout le trafic déjà mesuré mais pas
 * encore remonté disparaissait — définitivement, puisque le compteur devait
 * d'abord repasser au-dessus de son ancienne valeur avant de reproduire un
 * delta positif.
 *
 * La règle est donc explicite et unique, partagée entre le natif et le fil
 * JavaScript (`app-mobile/services/usageLedger.ts`) :
 *
 *   une lecture INFÉRIEURE à la précédente signifie une remise à zéro,
 *   donc le delta vaut la nouvelle valeur ENTIÈRE, jamais zéro.
 *
 * Ce fichier ne contient que de l'arithmétique : aucune dépendance Android,
 * aucun état. Il se compile et s'exécute sur une JVM ordinaire, ce qui permet
 * de prouver la règle en intégration continue (`tests/StabilityPolicyTest.kt`)
 * sans appareil ni émulateur.
 */
object SxbUsageOdometer {

    /** Écriture durable au plus toutes les 10 s : le poll tourne à 1 Hz. */
    const val PERSIST_INTERVAL_MS = 10_000L

    /** Écriture immédiate dès qu'un mégaoctet non sauvegardé s'est accumulé. */
    const val PERSIST_THRESHOLD_BYTES = 1L * 1024 * 1024

    /**
     * Delta entre deux lectures successives d'un compteur cumulatif.
     *
     * @param previous lecture précédente (négatif traité comme zéro)
     * @param current  lecture courante
     * @return les octets neufs mesurés entre les deux lectures
     */
    fun step(previous: Long, current: Long): Long {
        if (current <= 0L) return 0L
        val floor = if (previous < 0L) 0L else previous
        // Compteur qui RECULE ⇒ remise à zéro : tout ce qu'il affiche est neuf.
        return if (current < floor) current else current - floor
    }

    /**
     * Nouveau total durable après une lecture.
     *
     * Le total ne décroît JAMAIS : c'est le compteur kilométrique de l'appareil,
     * il survit à la reconnexion, à l'arrêt du service et à la mort de
     * l'application, et c'est lui qui garantit qu'aucun octet déjà mesuré ne
     * peut être perdu entre deux remontées.
     */
    fun total(previousTotal: Long, previous: Long, current: Long): Long {
        val base = if (previousTotal < 0L) 0L else previousTotal
        val sum = base + step(previous, current)
        // Débordement inatteignable en pratique (9,2 Eo) mais jamais un recul.
        return if (sum < base) Long.MAX_VALUE else sum
    }

    /**
     * Faut-il écrire le total durable maintenant ?
     *
     * Écrire à chaque poll userait la mémoire flash pour rien ; ne jamais
     * écrire perdrait la fin de session sur une mort brutale du processus. Le
     * compromis retenu : au plus une écriture toutes les 10 s, et une écriture
     * immédiate dès qu'un mégaoctet non sauvegardé est en jeu.
     *
     * Une horloge qui recule (changement d'heure, synchronisation réseau)
     * déclenche une écriture au lieu de figer la sauvegarde pour toujours.
     */
    fun shouldPersist(
        lastWriteMs: Long,
        nowMs: Long,
        unsavedBytes: Long,
        intervalMs: Long = PERSIST_INTERVAL_MS,
        thresholdBytes: Long = PERSIST_THRESHOLD_BYTES,
    ): Boolean {
        if (unsavedBytes <= 0L) return false
        if (unsavedBytes >= thresholdBytes) return true
        if (nowMs < lastWriteMs) return true
        return nowMs - lastWriteMs >= intervalMs
    }
}
