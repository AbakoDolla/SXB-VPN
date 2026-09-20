-- Cloisonnement de l'unicité des appareils VPN par gestionnaire.
--
-- Aucune ligne métier n'est supprimée ni réécrite. La migration retire
-- l'ancienne unicité globale de "deviceId" puis pose l'unicité du couple
-- ("managedById", "deviceId"), qui est le compartiment visible des ADMIN.
--
-- PostgreSQL considère deux NULL comme distincts : les clients historiques
-- sans gestionnaire ne sont donc pas rendus globalement uniques par ce nouvel
-- index. C'est volontaire : leur laisser une unicité globale recréerait le
-- blocage invisible que cette migration corrige pour les tableaux de bord
-- cloisonnés.
--
-- Pré-vérification production (doit rendre zéro ligne avant déploiement) :
-- SELECT "managedById", "deviceId", count(*) AS doublons, array_agg("id") AS clients
-- FROM "vpn_clients"
-- WHERE "managedById" IS NOT NULL AND "deviceId" IS NOT NULL
-- GROUP BY "managedById", "deviceId"
-- HAVING count(*) > 1;
--
-- Retour arrière manuel possible, si et seulement si aucune duplication
-- globale de "deviceId" n'existe : supprimer la contrainte composite puis
-- recréer "vpn_clients_deviceId_key" UNIQUE ("deviceId").

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "vpn_clients"
    WHERE "managedById" IS NOT NULL
      AND "deviceId" IS NOT NULL
    GROUP BY "managedById", "deviceId"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'vpn_clients contient des doublons (managedById, deviceId) ; migration interrompue';
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'vpn_clients_deviceId_key'
      AND conrelid = 'vpn_clients'::regclass
  ) THEN
    ALTER TABLE "vpn_clients" DROP CONSTRAINT "vpn_clients_deviceId_key";
  ELSIF to_regclass('public."vpn_clients_deviceId_key"') IS NOT NULL THEN
    DROP INDEX "vpn_clients_deviceId_key";
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'vpn_clients_managedById_deviceId_key'
      AND conrelid = 'vpn_clients'::regclass
  ) THEN
    ALTER TABLE "vpn_clients"
      ADD CONSTRAINT "vpn_clients_managedById_deviceId_key"
      UNIQUE ("managedById", "deviceId");
  END IF;
END
$$;

COMMIT;
