import { Platform } from 'react-native';
import * as Application from 'expo-application';

/**
 * deviceFingerprint.ts — Empreinte d'appareil pour l'essai gratuit.
 *
 * LE PROBLÈME QUE CE FICHIER RÉSOUT : l'identifiant d'appareil habituel
 * (`@sxb_device_id`) est un aléa écrit dans AsyncStorage. Désinstaller
 * l'application efface ce stockage ; la réinstallation repart avec un
 * identifiant neuf, et un second essai gratuit devenait possible à l'infini.
 *
 * CE QUI N'EST PAS TOUCHÉ : `getOrCreateDeviceId()` et la clé `@sxb_device_id`
 * restent inchangés. Des appareils sont activés en production avec cette
 * valeur ; la modifier casserait leur accès. L'empreinte est une information
 * SUPPLÉMENTAIRE, envoyée uniquement à l'inscription à l'essai gratuit.
 *
 * CE QUI EST ENVOYÉ : la valeur brute part une seule fois, vers `/free-trial/
 * enroll`, en HTTPS. Le serveur n'en conserve qu'un condensat salé et ne la
 * journalise jamais. Elle n'est ni stockée localement, ni jointe aux autres
 * requêtes, ni utilisée pour du suivi publicitaire.
 *
 * PORTÉE : Android d'abord, parce que c'est la plateforme de distribution du
 * produit et que `Settings.Secure.ANDROID_ID` a exactement la propriété
 * recherchée — stable par (appareil, signature d'application), remis à zéro
 * seulement par une réinitialisation d'usine.
 */

/** Longueur minimale d'une empreinte considérée comme exploitable. */
const LONGUEUR_MIN = 8;

/**
 * Valeurs qu'Android a historiquement renvoyées quand il n'avait rien de
 * fiable. Les accepter donnerait la MÊME empreinte à des milliers d'appareils,
 * donc refuserait l'essai à tous après le premier.
 */
const VALEURS_INEXPLOITABLES = new Set(['null', 'undefined', 'unknown', '0', '9774d56d682e549c']);

/**
 * Empreinte indisponible.
 *
 * On préfère une erreur explicite à un repli silencieux : un essai accordé sans
 * empreinte serait un essai que rien ne rattache à un appareil, donc
 * renouvelable indéfiniment. C'est précisément ce que le propriétaire refuse.
 */
export class EmpreinteIndisponible extends Error {
  constructor() {
    super('DEVICE_FINGERPRINT_UNAVAILABLE');
    this.name = 'EmpreinteIndisponible';
  }
}

function exploitable(valeur: unknown): valeur is string {
  if (typeof valeur !== 'string') return false;
  const propre = valeur.trim().toLowerCase();
  if (propre.length < LONGUEUR_MIN || propre.length > 255) return false;
  if (VALEURS_INEXPLOITABLES.has(propre)) return false;
  // « 0000000000 » est un remplissage, pas une identité.
  return !/^(.)\1*$/.test(propre);
}

/**
 * Lit l'empreinte de l'appareil, ou lève `EmpreinteIndisponible`.
 *
 * Android : `Settings.Secure.ANDROID_ID`, la seule valeur du système qui
 * survive à une désinstallation sans exiger de permission.
 *
 * iOS : `identifierForVendor`, la meilleure approximation disponible. Elle
 * survit à une réinstallation TANT QU'une autre application du même éditeur
 * reste installée ; sinon elle est régénérée. Apple n'expose rien de plus
 * stable sans compte utilisateur, et nous n'en demandons pas.
 */
export async function lireEmpreinteAppareil(): Promise<string> {
  try {
    if (Platform.OS === 'android') {
      const androidId = Application.getAndroidId();
      if (exploitable(androidId)) return androidId.trim();
      throw new EmpreinteIndisponible();
    }
    if (Platform.OS === 'ios') {
      const vendorId = await Application.getIosIdForVendorAsync();
      if (exploitable(vendorId)) return String(vendorId).trim();
      throw new EmpreinteIndisponible();
    }
  } catch (erreur) {
    if (erreur instanceof EmpreinteIndisponible) throw erreur;
    throw new EmpreinteIndisponible();
  }
  // Web et plateformes non prévues : aucune identité d'appareil digne de ce
  // nom, donc aucun essai. Mieux vaut refuser que d'accorder un essai
  // reproductible à volonté depuis un navigateur.
  throw new EmpreinteIndisponible();
}
