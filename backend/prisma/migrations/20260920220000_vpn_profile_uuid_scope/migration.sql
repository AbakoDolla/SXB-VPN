-- Cloisonnement de l'unicité de l'identifiant technique des configurations VPN.
--
-- "uuid" portait une unicité GLOBALE. Deux administrateurs qui importaient la
-- même configuration fournisseur — le cas normal quand un revendeur diffuse
-- un accès à plusieurs exploitants — se bloquaient donc mutuellement, sans
-- rien pouvoir observer l'un de l'autre. Mesuré en production : le second
-- recevait « HTTP 500 Failed to create VPN profile », sans indication.
--
-- C'est le défaut corrigé pour les appareils clients, transposé aux
-- configurations : la portée d'unicité suit la portée de visibilité, ici
-- l'auteur de la configuration ("createdBy"), sur lequel s'exprime déjà
-- `porteeProfils`.
--
-- AUCUNE PRÉ-VÉRIFICATION N'EST NÉCESSAIRE. L'unicité globale en vigueur
-- interdit déjà tout doublon d'"uuid" : elle implique l'unicité du couple
-- ("createdBy", "uuid"). Le resserrement est strictement plus permissif et ne
-- peut donc pas échouer sur des données existantes.
--
-- PostgreSQL considère deux NULL comme distincts. Les configurations
-- importées écrivent "uuid" à NULL — les identifiants techniques vivent dans
-- le canonique chiffré — et restent donc libres, comme aujourd'hui.
--
-- Retour arrière manuel : supprimer la contrainte composite puis recréer
-- "vpn_profiles_uuid_key" UNIQUE ("uuid"), à condition qu'aucun doublon
-- global d'"uuid" n'ait été créé entre-temps.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'vpn_profiles_uuid_key'
      AND conrelid = 'vpn_profiles'::regclass
  ) THEN
    ALTER TABLE "vpn_profiles" DROP CONSTRAINT "vpn_profiles_uuid_key";
  ELSIF to_regclass('public."vpn_profiles_uuid_key"') IS NOT NULL THEN
    DROP INDEX "vpn_profiles_uuid_key";
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'vpn_profiles_createdBy_uuid_key'
      AND conrelid = 'vpn_profiles'::regclass
  ) THEN
    ALTER TABLE "vpn_profiles"
      ADD CONSTRAINT "vpn_profiles_createdBy_uuid_key"
      UNIQUE ("createdBy", "uuid");
  END IF;
END
$$;

COMMIT;
