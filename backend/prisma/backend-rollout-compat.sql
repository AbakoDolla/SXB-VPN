-- Preserve known legacy structures without rewriting historical migrations.
BEGIN;
SET LOCAL search_path = public;

DO $$
DECLARE
  target RECORD;
  definition RECORD;
  table_oid OID;
  index_oid OID;
  column_names TEXT[];
BEGIN
  FOR target IN SELECT * FROM (VALUES
    ('vpn_clients', 'vpn_clients_managedById_deviceId_key', 'managedById', 'deviceId'),
    ('vpn_profiles', 'vpn_profiles_createdBy_uuid_key', 'createdBy', 'uuid')
  ) AS targets(table_name, index_name, first_column, second_column)
  LOOP
    table_oid := to_regclass(format('public.%I', target.table_name));
    IF table_oid IS NULL THEN
      RAISE EXCEPTION 'BACKEND_SCOPE_TABLE_MISSING';
    END IF;
    index_oid := to_regclass(format('public.%I', target.index_name));
    IF index_oid IS NULL THEN
      -- The historical SQL creates the constraint when no index exists.
      IF EXISTS (SELECT 1 FROM pg_constraint
          WHERE conrelid=table_oid AND conname=target.index_name) THEN
        RAISE EXCEPTION 'BACKEND_SCOPE_CONSTRAINT_INCOMPATIBLE';
      END IF;
      CONTINUE;
    END IF;

    SELECT i.*, c.relkind, a.amname INTO definition
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    JOIN pg_am a ON a.oid=c.relam WHERE i.indexrelid=index_oid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'BACKEND_SCOPE_INDEX_INCOMPATIBLE';
    END IF;
    SELECT array_agg(a.attname::text ORDER BY k.position) INTO column_names
    FROM unnest(definition.indkey::smallint[]) WITH ORDINALITY AS k(attnum, position)
    JOIN pg_attribute a ON a.attrelid=table_oid AND a.attnum=k.attnum;

    IF definition.indrelid <> table_oid OR definition.relkind <> 'i' OR definition.amname <> 'btree'
      OR NOT definition.indisunique OR NOT definition.indisvalid OR NOT definition.indisready
      OR NOT definition.indislive OR NOT definition.indimmediate OR definition.indisprimary
      OR definition.indisexclusion OR definition.indnatts <> 2 OR definition.indnkeyatts <> 2
      OR definition.indpred IS NOT NULL OR definition.indexprs IS NOT NULL
      OR NOT (0 = ALL(definition.indoption::smallint[]))
      OR coalesce((to_jsonb(definition)->>'indnullsnotdistinct')::boolean, false)
      OR column_names IS DISTINCT FROM ARRAY[target.first_column, target.second_column]
      OR EXISTS (
        SELECT 1 FROM unnest(definition.indkey::smallint[], definition.indclass::oid[],
          definition.indcollation::oid[]) AS k(attnum, opclass_oid, collation_oid)
        JOIN pg_attribute a ON a.attrelid=table_oid AND a.attnum=k.attnum
        JOIN pg_opclass op ON op.oid=k.opclass_oid
        WHERE NOT op.opcdefault OR op.opcintype <> a.atttypid OR k.collation_oid <> a.attcollation
      ) THEN
      RAISE EXCEPTION 'BACKEND_SCOPE_INDEX_INCOMPATIBLE';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=table_oid AND conname=target.index_name) THEN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=table_oid AND conname=target.index_name
        AND contype='u' AND conindid=index_oid AND NOT condeferrable AND NOT condeferred) THEN
        RAISE EXCEPTION 'BACKEND_SCOPE_CONSTRAINT_INCOMPATIBLE';
      END IF;
    ELSE
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I UNIQUE USING INDEX %I',
        target.table_name, target.index_name, target.index_name);
    END IF;
  END LOOP;
END
$$;

-- Preserve this historical plaintext column without using it as config input.
ALTER TABLE public.vpn_profiles ADD COLUMN IF NOT EXISTS json_config TEXT;
COMMIT;
