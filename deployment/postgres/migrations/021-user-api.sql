-- The users API of slice S1 (design card K8).
-- It adds the read gate of the user routes, the user sync state read, the abandon of a user sync,
-- the category read of document B section 9, and the credential of that read.
-- Every gate accepts users:read, where the device gate accepts devices:read (document A section 8).

-- The read gate of the users routes. It mirrors 016 cc.device_reader with users:read.
CREATE FUNCTION cc.user_reader(p_actor uuid,p_version integer) RETURNS cc.google_connection
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection;
BEGIN
  SELECT * INTO connection FROM cc.google_connection WHERE singleton;
  IF NOT EXISTS(SELECT 1 FROM cc.application_principals p
      WHERE p.id=p_actor AND p.enabled AND p.permission_version=p_version) OR
    NOT EXISTS(SELECT 1 FROM cc.application_grants g WHERE g.principal_id=p_actor AND g.action='users:read' AND (
      g.scope='{"kind":"platform"}'::jsonb OR
      (g.scope->>'kind'='district' AND g.scope->>'customerId'=connection.customer_id))) THEN
    RAISE EXCEPTION 'User read authority is required.' USING ERRCODE='42501';
  END IF;
  RETURN connection;
END;
$$;

-- The user sync state as its requester, or as a person who reads jobs, may see it.
-- It repeats 017 cc.visible_device_sync without the telemetry part of the device state.
CREATE FUNCTION cc.visible_user_sync(p_actor uuid,p_version integer,p_customer text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE call jsonb; state cc.user_sync_state; now_at timestamptz:=clock_timestamp(); requester uuid;
BEGIN
  SELECT * INTO state FROM cc.user_sync_state s WHERE s.customer_id=p_customer;
  call:=cc.user_sync_projection(p_customer);
  requester:=CASE WHEN state.sync_id IS NULL THEN state.failure_requested_by
    WHEN state.sync_expires_at>now_at THEN NULL ELSE state.sync_actor END;
  IF NOT cc.job_visible(p_actor,p_version,p_customer,requester) THEN
    call:=jsonb_set(call,'{failure}','null'::jsonb);
  END IF;
  RETURN call;
END;
$$;

-- The user sync state, as GET /api/users/sync reads it. It mirrors 016 cc.read_device_sync.
CREATE FUNCTION cc.read_user_sync(p_actor uuid,p_version integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection;
BEGIN
  connection:=cc.user_reader(p_actor,p_version);
  IF connection.customer_id IS NULL THEN RETURN NULL; END IF;
  RETURN cc.visible_user_sync(p_actor,p_version,connection.customer_id);
END;
$$;

-- The abandon of a user sync whose flow did not start. It repeats 016 cc.abandon_device_sync with
-- the user gate and the user state row (design card K8, route POST /api/users/sync).
CREATE FUNCTION cc.abandon_user_sync(p_actor uuid,p_version integer,p_customer text,p_id uuid,p_failure text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE pending cc.user_sync_state; header record; now_at timestamptz;
BEGIN
  PERFORM cc.user_reader(p_actor,p_version);
  IF p_failure IS DISTINCT FROM 'orchestration-unavailable' THEN
    RAISE EXCEPTION 'Only an undispatched sync can be abandoned.' USING ERRCODE='22023';
  END IF;
  -- A null identifier never matches a state row or a header.
  IF p_customer IS NULL OR p_id IS NULL THEN
    RAISE EXCEPTION 'The sync identifier is required.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO pending FROM cc.user_sync_state WHERE customer_id=p_customer FOR UPDATE;
  -- The state row locks first, the scoped header second, and the clock third.
  SELECT * INTO header FROM cc.jobs j WHERE j.job_id=p_id AND j.customer_id=p_customer FOR UPDATE;
  -- A superseded call changes nothing. A missing scoped header returns at once.
  IF NOT FOUND THEN
    RETURN cc.visible_user_sync(p_actor,p_version,p_customer);
  END IF;
  now_at:=clock_timestamp();
  IF pending.sync_id IS DISTINCT FROM p_id OR pending.sync_attempt IS NOT NULL OR
    header.status<>'running' OR header.finished_at IS NOT NULL THEN
    RETURN cc.visible_user_sync(p_actor,p_version,p_customer);
  END IF;
  PERFORM 1 FROM cc.application_principals p WHERE p.id=pending.sync_actor FOR KEY SHARE;
  PERFORM 1 FROM cc.google_connection c WHERE c.customer_id=p_customer FOR KEY SHARE;
  now_at:=clock_timestamp();
  UPDATE cc.user_sync_state SET failure=p_failure,failure_requested_by=sync_actor,checked_at=now_at,
    sync_id=NULL,sync_actor=NULL,sync_generation=NULL,sync_attempt=NULL,sync_expires_at=NULL
  WHERE customer_id=p_customer;
  PERFORM cc.close_refresh_job(p_id,'orchestration-unavailable');
  RETURN cc.visible_user_sync(p_actor,p_version,p_customer);
END;
$$;

-- The text values of one attribute value: the single value, or one entry for each item of a list.
-- A multi-value entry holds `{ value }`, so its `value` key answers (B section 8.2).
CREATE FUNCTION cc.user_attribute_values(p_value jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,cc AS $$
  SELECT COALESCE(array_agg(CASE WHEN jsonb_typeof(e)='object' THEN e->>'value' ELSE e#>>'{}' END),'{}'::text[])
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_value)='array' THEN p_value
    ELSE jsonb_build_array(p_value) END) e
  WHERE jsonb_typeof(e)<>'null' AND (jsonb_typeof(e)<>'object' OR e ? 'value')
$$;

-- The numeric values of one attribute value. A JSON number and a numeric string both count
-- (B section 8.1). Every other text is left out, so no cast fails.
CREATE FUNCTION cc.user_attribute_numbers(p_value jsonb) RETURNS numeric[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,cc AS $$
  SELECT COALESCE(array_agg(t::numeric),'{}'::numeric[])
  FROM unnest(cc.user_attribute_values(p_value)) t
  WHERE t ~ '^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$'
$$;

-- Whether one attribute value holds a value. A No answer is a value. An empty list is none
-- (B section 12).
CREATE FUNCTION cc.user_attribute_has_value(p_value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,cc AS $$
  SELECT p_value IS NOT NULL AND jsonb_typeof(p_value)<>'null' AND
    (CASE WHEN jsonb_typeof(p_value)='array' THEN jsonb_array_length(p_value)>0 ELSE true END)
$$;

-- The category read of B section 10 row 1: the cached categories with their holder counts, the
-- account limits, and the cache time. A holder is a cached user with a value (B section 3).
CREATE FUNCTION cc.user_attribute_categories_projection(p_customer text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  WITH category AS (
    SELECT c.schema_id,c.schema_name,c.display_name,c.etag,c.fields,c.read_at,
      (SELECT count(*) FROM cc.users u WHERE u.customer_id=c.customer_id AND u.removed_at IS NULL AND
        EXISTS(SELECT 1 FROM jsonb_array_elements(c.fields) f WHERE
          cc.user_attribute_has_value(u.custom_schemas->c.schema_name->(f->>'fieldName')))) AS holders
    FROM cc.user_attribute_categories c WHERE c.customer_id=p_customer
  )
  SELECT jsonb_build_object(
    'categories',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'schemaId',x.schema_id,'schemaName',x.schema_name,'displayName',x.display_name,'etag',x.etag,
      'fields',(SELECT jsonb_agg(f.field||jsonb_build_object('holders',
          (SELECT count(*) FROM cc.users u WHERE u.customer_id=p_customer AND u.removed_at IS NULL AND
            cc.user_attribute_has_value(u.custom_schemas->x.schema_name->(f.field->>'fieldName'))))
        ORDER BY f.ord)
        FROM jsonb_array_elements(x.fields) WITH ORDINALITY AS f(field,ord)),
      'holders',x.holders,'readAt',x.read_at) ORDER BY x.display_name,x.schema_name)
      FROM category x),'[]'::jsonb),
    'limits',jsonb_build_object('categories',(SELECT count(*) FROM category),
      'categoryLimit',100,
      'attributes',COALESCE((SELECT sum(jsonb_array_length(x.fields)) FROM category x),0),
      'attributeLimit',100),
    'observedAt',(SELECT max(x.read_at) FROM category x));
$$;

-- The category read, gated by users:read. A customer without a connection reads null.
CREATE FUNCTION cc.read_user_attribute_categories(p_actor uuid,p_version integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection;
BEGIN
  connection:=cc.user_reader(p_actor,p_version);
  IF connection.customer_id IS NULL THEN RETURN NULL; END IF;
  RETURN cc.user_attribute_categories_projection(connection.customer_id);
END;
$$;

-- One schemas.list read replaces the whole cached set (B section 9). A category that Google no
-- longer lists leaves the cache. The read time comes from the caller, so the cache rule of B
-- section 9 measures the Google read, not the store.
CREATE FUNCTION cc.replace_user_attribute_categories(p_actor uuid,p_version integer,p_customer text,
  p_categories jsonb,p_read_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection; item jsonb;
BEGIN
  connection:=cc.user_reader(p_actor,p_version);
  IF connection.customer_id IS DISTINCT FROM p_customer THEN
    RAISE EXCEPTION 'The Google connection changed.' USING DETAIL='connection-changed';
  END IF;
  IF p_read_at IS NULL OR jsonb_typeof(p_categories) IS DISTINCT FROM 'array' OR
    jsonb_array_length(p_categories)>100 THEN
    RAISE EXCEPTION 'The category set is invalid.' USING ERRCODE='22023';
  END IF;
  FOR item IN SELECT e.value FROM jsonb_array_elements(p_categories) e LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR
      jsonb_typeof(item->'schemaId') IS DISTINCT FROM 'string' OR
      jsonb_typeof(item->'schemaName') IS DISTINCT FROM 'string' OR
      jsonb_typeof(item->'displayName') IS DISTINCT FROM 'string' OR
      jsonb_typeof(item->'fields') IS DISTINCT FROM 'array' OR
      jsonb_array_length(item->'fields') NOT BETWEEN 1 AND 100 OR
      (item ? 'etag' AND jsonb_typeof(item->'etag') NOT IN ('string','null')) THEN
      RAISE EXCEPTION 'The category set is invalid.' USING ERRCODE='22023';
    END IF;
  END LOOP;
  DELETE FROM cc.user_attribute_categories WHERE customer_id=p_customer;
  INSERT INTO cc.user_attribute_categories(customer_id,schema_id,schema_name,display_name,etag,fields,read_at)
  SELECT p_customer,e.value->>'schemaId',e.value->>'schemaName',e.value->>'displayName',
    CASE WHEN jsonb_typeof(e.value->'etag')='string' THEN e.value->>'etag' END,
    e.value->'fields',p_read_at
  FROM jsonb_array_elements(p_categories) e;
  RETURN cc.read_user_attribute_categories(p_actor,p_version);
END;
$$;

-- The active credential of one generation for the category read. It mirrors 018
-- cc.device_write_credential with users:read. The envelope stays encrypted, and the route opens it.
CREATE FUNCTION cc.user_read_credential(p_actor uuid,p_version integer,p_customer text,p_generation integer)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection; encrypted jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(7240173008);
  IF NOT EXISTS(SELECT 1 FROM cc.application_principals p
      WHERE p.id=p_actor AND p.enabled AND p.permission_version=p_version) OR
    NOT EXISTS(SELECT 1 FROM cc.application_grants g
      WHERE g.principal_id=p_actor AND g.action='users:read' AND
      (g.scope='{"kind":"platform"}'::jsonb OR
      (g.scope->>'kind'='district' AND g.scope->>'customerId'=p_customer))) THEN
    RAISE EXCEPTION 'User read authority is required.' USING ERRCODE='42501';
  END IF;
  connection:=cc.google_current_generation(p_customer,p_generation);
  SELECT envelope INTO encrypted FROM cc.google_credentials WHERE id=connection.credential_id;
  RETURN jsonb_build_object('customerId',p_customer,'generation',p_generation,
    'credentialId',connection.credential_id,'envelope',encrypted);
END;
$$;

REVOKE ALL ON FUNCTION cc.user_reader(uuid,integer),cc.visible_user_sync(uuid,integer,text),
  cc.read_user_sync(uuid,integer),cc.abandon_user_sync(uuid,integer,text,uuid,text),
  cc.user_attribute_categories_projection(text),cc.read_user_attribute_categories(uuid,integer),
  cc.replace_user_attribute_categories(uuid,integer,text,jsonb,timestamptz),
  cc.user_read_credential(uuid,integer,text,integer) FROM PUBLIC;