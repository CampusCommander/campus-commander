-- K23: the value preview routes of document B section 10.
-- A preview freezes the final value of each user and attribute, the category `etag` that the route
-- read, and one digest over the frozen rows. A confirm re-reads each frozen category and answers
-- 409 `category-changed` when its `etag` moved (B section 6.2, B section 13). A first confirm
-- creates one `user-attribute-update` job and a repeated confirm answers the same `UAT-` receipt.
-- The value worker (K24) runs the frozen rows of that job.

-- The write gate of the value routes. It mirrors 025 cc.user_schema_manager with `users:write`, so
-- a person without the action reads no preview base and creates no preview. User Write implies no
-- other action; a selection preview checks `users:bulk-actions` beside this gate.
CREATE FUNCTION cc.user_attribute_writer(p_actor uuid,p_version integer) RETURNS cc.google_connection
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection;
BEGIN
  SELECT * INTO connection FROM cc.google_connection WHERE singleton;
  IF NOT EXISTS(SELECT 1 FROM cc.application_principals p
      WHERE p.id=p_actor AND p.enabled AND p.permission_version=p_version) OR
    NOT EXISTS(SELECT 1 FROM cc.application_grants g WHERE g.principal_id=p_actor AND g.action='users:write' AND (
      g.scope='{"kind":"platform"}'::jsonb OR
      (g.scope->>'kind'='district' AND g.scope->>'customerId'=connection.customer_id))) THEN
    RAISE EXCEPTION 'User write authority is required.' USING ERRCODE='42501';
  END IF;
  RETURN connection;
END;
$$;

-- The preview base of B section 10: the cached set under the write gate, with the customer and the
-- generation that the preview freezes. A customer without a connection reads null.
CREATE FUNCTION cc.read_user_attribute_preview_base(p_actor uuid,p_version integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection;
BEGIN
  connection:=cc.user_attribute_writer(p_actor,p_version);
  IF connection.customer_id IS NULL THEN RETURN NULL; END IF;
  RETURN cc.user_attribute_categories_projection(connection.customer_id)||
    jsonb_build_object('customerId',connection.customer_id,'generation',connection.generation);
END;
$$;

-- The read credential of an edit-list preview. The edit list reads each user from Google before it
-- freezes a row (B section 8.4), and that read needs `users:write`, not `users:read`: the route
-- gates on the action that the person uses. The read scope stays the read-only user scope of
-- document A, so no write token leaves this function.
CREATE FUNCTION cc.user_value_credential(p_actor uuid,p_version integer,p_customer text,
  p_generation integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection; encrypted jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(7240173008);
  IF NOT EXISTS(SELECT 1 FROM cc.application_principals p
      WHERE p.id=p_actor AND p.enabled AND p.permission_version=p_version) OR
    NOT EXISTS(SELECT 1 FROM cc.application_grants g
      WHERE g.principal_id=p_actor AND g.action='users:write' AND
      (g.scope='{"kind":"platform"}'::jsonb OR
      (g.scope->>'kind'='district' AND g.scope->>'customerId'=p_customer))) THEN
    RAISE EXCEPTION 'User write authority is required.' USING ERRCODE='42501';
  END IF;
  connection:=cc.google_current_generation(p_customer,p_generation);
  SELECT envelope INTO encrypted FROM cc.google_credentials WHERE id=connection.credential_id;
  RETURN jsonb_build_object('customerId',p_customer,'generation',p_generation,
    'credentialId',connection.credential_id,'envelope',encrypted);
END;
$$;

-- The category `etag` of each attribute that a preview freezes. A confirm re-reads these rows, so
-- a category that changed after the preview answers `category-changed` (K22 review, B section 6.2).
CREATE TABLE cc.user_attribute_preview_categories (
  preview_id uuid NOT NULL REFERENCES cc.user_attribute_previews(preview_id) ON DELETE CASCADE,
  schema_name text NOT NULL CHECK(schema_name ~ '^[A-Za-z0-9_-]{1,200}$'),
  etag text NOT NULL CHECK(char_length(etag) BETWEEN 1 AND 200),
  PRIMARY KEY(preview_id,schema_name)
);
REVOKE ALL ON cc.user_attribute_preview_categories FROM PUBLIC;

-- The preview answer of B section 10. An edit list answers no frozen change list, because each of
-- its rows carries its own request.
CREATE FUNCTION cc.user_attribute_preview_projection(p cc.user_attribute_previews) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT jsonb_build_object('previewId',p.preview_id,'source',p.source,
    'changes',CASE WHEN p.source='selection' THEN COALESCE((
      SELECT jsonb_agg(jsonb_build_object('schemaName',c.schema_name,'fieldName',c.field_name,
        'mode',c.mode,'values',c.values) ORDER BY c.ordinal)
      FROM cc.user_attribute_preview_changes c WHERE c.preview_id=p.preview_id),'[]'::jsonb)
      ELSE NULL END,
    'attributeChanges',p.attribute_changes,'selected',p.selected,'eligible',p.eligible,
    'unchanged',p.unchanged,'conflicts',p.conflicts,'oldestObservedAt',p.oldest_observed_at,
    'preparedAt',p.prepared_at,'expiresAt',p.expires_at,'manifestDigest',p.manifest_digest);
$$;

-- One prepared value preview header (B section 10). The caller computes the digest over the
-- frozen rows and stores it with the seal. This function validates the changes and the category
-- etags, takes the global access lock, checks the person and the connection, and stores the
-- preview row with no target. It stores no complete document, so a selection of 100,000 users
-- never reaches one JSON argument. A selection needs `users:bulk-actions` beside `users:write`
-- (B section 11).
CREATE FUNCTION cc.create_user_attribute_preview(p_actor uuid,p_version integer,p_customer text,
  p_generation integer,p_source text,p_selection jsonb,p_changes jsonb,p_etags jsonb,
  p_expires_minutes integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection; preview cc.user_attribute_previews; bad integer;
  now_at timestamptz;
BEGIN
  -- S2: every input holds a value of its domain, or the call rejects before any lock or write.
  IF p_actor IS NULL OR p_version IS NULL OR p_customer IS NULL OR p_generation IS NULL OR
    p_source IS NULL OR p_source NOT IN ('selection','edit-list') OR
    p_expires_minutes IS NULL OR p_expires_minutes NOT BETWEEN 1 AND 1440 OR
    p_changes IS NULL OR p_etags IS NULL OR
    jsonb_typeof(p_changes) IS DISTINCT FROM 'array' OR
    jsonb_typeof(p_etags) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'The value preview request is invalid.' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(p_changes)>100 OR jsonb_array_length(p_etags) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'The value preview request is invalid.' USING ERRCODE='22023';
  END IF;
  -- A selection names its grid and tab. An edit list names neither, and it freezes no change list.
  IF (p_source='selection')<>(p_selection IS NOT NULL) OR
    (p_source='selection')<>(jsonb_array_length(p_changes)>0) OR
    (p_selection IS NOT NULL AND (jsonb_typeof(p_selection)<>'object' OR
      COALESCE(p_selection->>'gridId','') !~ '^[A-Za-z0-9_-]{1,100}$' OR
      COALESCE(p_selection->>'tabId','') !~ '^[A-Za-z0-9_-]{1,100}$')) THEN
    RAISE EXCEPTION 'The value preview request is invalid.' USING ERRCODE='22023';
  END IF;
  -- Each frozen change names its attribute and its values (B section 8.3).
  SELECT count(*) INTO bad FROM jsonb_array_elements(p_changes) c
    WHERE jsonb_typeof(c) IS DISTINCT FROM 'object' OR
      COALESCE(c->>'schemaName','') !~ '^[A-Za-z0-9_-]{1,200}$' OR
      COALESCE(c->>'fieldName','') !~ '^[A-Za-z0-9_-]{1,200}$' OR
      COALESCE(c->>'mode','') NOT IN ('set','clear','add','remove','replace') OR
      jsonb_typeof(c->'values') IS DISTINCT FROM 'array' OR
      jsonb_array_length(c->'values')>150 OR
      ((c->>'mode'='clear')<>(jsonb_array_length(c->'values')=0)) OR
      ((c->>'mode'='set') AND jsonb_array_length(c->'values')<>1);
  IF bad>0 THEN
    RAISE EXCEPTION 'The value preview changes are invalid.' USING ERRCODE='22023';
  END IF;
  -- Each frozen category carries the etag that the route read, once.
  SELECT count(*) INTO bad FROM jsonb_array_elements(p_etags) e
    WHERE jsonb_typeof(e) IS DISTINCT FROM 'object' OR
      COALESCE(e->>'schemaName','') !~ '^[A-Za-z0-9_-]{1,200}$' OR
      COALESCE(e->>'etag','')='' OR char_length(e->>'etag')>200;
  IF bad>0 OR
    (SELECT count(DISTINCT e->>'schemaName') FROM jsonb_array_elements(p_etags) e)<>jsonb_array_length(p_etags) THEN
    RAISE EXCEPTION 'The value preview categories are invalid.' USING ERRCODE='22023';
  END IF;
  -- Rule G: the global access lock comes first, before any row lock or write, as device previews do.
  PERFORM pg_advisory_xact_lock(7240173008);
  -- The person check of the route. A caller without the actions receives no preview.
  IF NOT EXISTS(SELECT 1 FROM cc.application_principals p
      WHERE p.id=p_actor AND p.enabled AND p.permission_version=p_version) OR
    NOT EXISTS(SELECT 1 FROM cc.application_grants g WHERE g.principal_id=p_actor AND
      g.action='users:write' AND (g.scope='{"kind":"platform"}'::jsonb OR
      (g.scope->>'kind'='district' AND g.scope->>'customerId'=p_customer))) OR
    (p_source='selection' AND NOT EXISTS(SELECT 1 FROM cc.application_grants g
      WHERE g.principal_id=p_actor AND g.action='users:bulk-actions' AND
      (g.scope='{"kind":"platform"}'::jsonb OR
      (g.scope->>'kind'='district' AND g.scope->>'customerId'=p_customer)))) THEN
    RETURN jsonb_build_object('outcome','forbidden');
  END IF;
  -- The connection row locks after the access lock and before the first clock read.
  SELECT * INTO connection FROM cc.google_connection c WHERE c.singleton FOR KEY SHARE;
  IF connection.customer_id IS DISTINCT FROM p_customer OR connection.generation<>p_generation THEN
    RETURN jsonb_build_object('outcome','connection-changed');
  END IF;
  now_at:=clock_timestamp();
  INSERT INTO cc.user_attribute_previews(preview_id,customer_id,created_by,permission_version,generation,
    source,selection,selected,eligible,unchanged,conflicts,attribute_changes,oldest_observed_at,
    manifest_digest,prepared_at,expires_at)
  VALUES(gen_random_uuid(),p_customer,p_actor,p_version,p_generation,p_source,p_selection,0,0,0,0,0,
    NULL,NULL,now_at,now_at+make_interval(mins=>p_expires_minutes))
  RETURNING * INTO preview;
  INSERT INTO cc.user_attribute_preview_changes(preview_id,ordinal,schema_name,field_name,mode,values)
  SELECT preview.preview_id,(c.ord-1)::integer,c.value->>'schemaName',c.value->>'fieldName',
    c.value->>'mode',c.value->'values'
  FROM jsonb_array_elements(p_changes) WITH ORDINALITY c(value,ord);
  INSERT INTO cc.user_attribute_preview_categories(preview_id,schema_name,etag)
  SELECT preview.preview_id,e->>'schemaName',e->>'etag' FROM jsonb_array_elements(p_etags) e;
  RETURN jsonb_build_object('outcome','created','previewId',preview.preview_id,
    'preview',cc.user_attribute_preview_projection(preview));
END;
$$;

-- One bounded batch of frozen targets. The route stores a selection in batches, so no single
-- JSON argument holds the complete selection. The ordinals continue from the stored rows, and the
-- preview stays unconfirmable until the seal writes the digest.
CREATE FUNCTION cc.append_user_attribute_preview_targets(p_actor uuid,p_version integer,
  p_preview_id uuid,p_targets jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection; preview cc.user_attribute_previews; bad integer;
  ordinal integer; target jsonb; row_value jsonb;
BEGIN
  IF p_actor IS NULL OR p_version IS NULL OR p_preview_id IS NULL OR p_targets IS NULL OR
    jsonb_typeof(p_targets) IS DISTINCT FROM 'array' OR
    jsonb_array_length(p_targets) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'The value preview targets are invalid.' USING ERRCODE='22023';
  END IF;
  -- Each target names its user and at least one attribute row. The API sorts the targets by user
  -- ID and the rows by attribute, so the digest and the page cursor stay stable.
  SELECT count(*) INTO bad FROM jsonb_array_elements(p_targets) WITH ORDINALITY t(value,ord)
    WHERE jsonb_typeof(t.value) IS DISTINCT FROM 'object' OR
      jsonb_typeof(t.value->'ordinal') IS DISTINCT FROM 'number' OR
      COALESCE(t.value->>'userId','') !~ '^[A-Za-z0-9_-]{1,128}$' OR
      COALESCE(t.value->>'primaryEmail','') !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' OR
      char_length(t.value->>'primaryEmail') NOT BETWEEN 3 AND 254 OR
      COALESCE(t.value->>'disposition','') NOT IN ('eligible','unchanged','conflict') OR
      (t.value->'observedAt' IS NOT NULL AND t.value->'observedAt'<>'null'::jsonb AND
        jsonb_typeof(t.value->'observedAt')<>'string') OR
      jsonb_typeof(t.value->'rows') IS DISTINCT FROM 'array' OR
      jsonb_array_length(t.value->'rows') NOT BETWEEN 1 AND 100;
  IF bad>0 OR (SELECT count(DISTINCT t.value->>'userId') FROM jsonb_array_elements(p_targets) t)<>jsonb_array_length(p_targets) THEN
    RAISE EXCEPTION 'The value preview targets are invalid.' USING ERRCODE='22023';
  END IF;
  SELECT count(*) INTO bad FROM jsonb_array_elements(p_targets) t,
    jsonb_array_elements(t->'rows') r
    WHERE jsonb_typeof(r) IS DISTINCT FROM 'object' OR
      COALESCE(r->>'schemaName','') !~ '^[A-Za-z0-9_-]{1,200}$' OR
      COALESCE(r->>'fieldName','') !~ '^[A-Za-z0-9_-]{1,200}$' OR
      COALESCE(r->>'disposition','') NOT IN ('eligible','unchanged','conflict') OR
      (r->'currentValue' IS NOT NULL AND r->'currentValue'<>'null'::jsonb AND
        jsonb_typeof(r->'currentValue') NOT IN ('string','number','boolean','array')) OR
      (r->'newValue' IS NOT NULL AND r->'newValue'<>'null'::jsonb AND
        jsonb_typeof(r->'newValue') NOT IN ('string','number','boolean','array')) OR
      (jsonb_typeof(r->'currentValue')='array' AND EXISTS(
        SELECT 1 FROM jsonb_array_elements(r->'currentValue') v
        WHERE jsonb_typeof(v) NOT IN ('string','number','boolean','object'))) OR
      (jsonb_typeof(r->'newValue')='array' AND EXISTS(
        SELECT 1 FROM jsonb_array_elements(r->'newValue') v
        WHERE jsonb_typeof(v) NOT IN ('string','number','boolean','object')));
  IF bad>0 OR (SELECT count(*) FROM jsonb_array_elements(p_targets) t,
      jsonb_array_elements(t->'rows') r) <> (SELECT count(DISTINCT (t->>'ordinal',r->>'schemaName',r->>'fieldName'))
      FROM jsonb_array_elements(p_targets) t, jsonb_array_elements(t->'rows') r) THEN
    RAISE EXCEPTION 'The value preview rows are invalid.' USING ERRCODE='22023';
  END IF;
  -- The target column repeats the row rule of B section 8.4: one conflict makes a conflict target,
  -- one eligible row makes an eligible target, and the rest stay unchanged.
  SELECT count(*) INTO bad FROM jsonb_array_elements(p_targets) t
    WHERE (t->>'disposition') IS DISTINCT FROM (CASE
      WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(t->'rows') r WHERE r->>'disposition'='conflict') THEN 'conflict'
      WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(t->'rows') r WHERE r->>'disposition'='eligible') THEN 'eligible'
      ELSE 'unchanged' END);
  IF bad>0 THEN
    RAISE EXCEPTION 'The value preview dispositions are invalid.' USING ERRCODE='22023';
  END IF;
  -- The write gate revalidates the person and the action on every batch.
  connection:=cc.user_attribute_writer(p_actor,p_version);
  SELECT * INTO preview FROM cc.user_attribute_previews p WHERE p.preview_id=p_preview_id FOR UPDATE;
  IF preview.preview_id IS NULL OR preview.created_by<>p_actor OR
    preview.customer_id IS DISTINCT FROM connection.customer_id OR preview.manifest_digest IS NOT NULL THEN
    RETURN jsonb_build_object('outcome','not-found');
  END IF;
  -- A selection preview freezes no conflict row (B section 8.4).
  IF preview.source='selection' AND EXISTS(SELECT 1 FROM jsonb_array_elements(p_targets) t
      WHERE t->>'disposition'='conflict' OR EXISTS(SELECT 1 FROM jsonb_array_elements(t->'rows') r
      WHERE r->>'disposition'='conflict')) THEN
    RAISE EXCEPTION 'The value preview rows are invalid.' USING ERRCODE='22023';
  END IF;
  -- Every row names a category that the preview froze, and the ordinals continue without a gap.
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_targets) t, jsonb_array_elements(t->'rows') r
      WHERE r->>'schemaName' NOT IN (SELECT c.schema_name FROM cc.user_attribute_preview_categories c
        WHERE c.preview_id=p_preview_id)) THEN
    RAISE EXCEPTION 'The value preview categories are invalid.' USING ERRCODE='22023';
  END IF;
  SELECT COALESCE(max(t.ordinal)+1,0) INTO ordinal FROM cc.user_attribute_preview_targets t
    WHERE t.preview_id=p_preview_id;
  SELECT count(*) INTO bad FROM jsonb_array_elements(p_targets) WITH ORDINALITY t(value,ord)
    WHERE (t.value->>'ordinal')::integer<>ordinal+(t.ord-1)::integer;
  IF bad>0 THEN
    RAISE EXCEPTION 'The value preview target order is invalid.' USING ERRCODE='22023';
  END IF;
  FOR target IN SELECT value FROM jsonb_array_elements(p_targets) LOOP
    INSERT INTO cc.user_attribute_preview_targets(preview_id,ordinal,user_id,primary_email,
      disposition,observed_at)
    VALUES(preview.preview_id,(target->>'ordinal')::integer,target->>'userId',target->>'primaryEmail',
      target->>'disposition',NULLIF(target->>'observedAt','null')::timestamptz);
    FOR row_value IN SELECT value FROM jsonb_array_elements(target->'rows') LOOP
      INSERT INTO cc.user_attribute_target_values(preview_id,ordinal,schema_name,field_name,
        current_value,requested_value,disposition)
      VALUES(preview.preview_id,(target->>'ordinal')::integer,row_value->>'schemaName',
        row_value->>'fieldName',NULLIF(row_value->'currentValue','null'::jsonb),
        NULLIF(row_value->'newValue','null'::jsonb),row_value->>'disposition');
    END LOOP;
  END LOOP;
  RETURN jsonb_build_object('outcome','stored','stored',jsonb_array_length(p_targets));
END;
$$;

-- The seal of one value preview. It recomputes the counts and the oldest eligible observation
-- from the stored rows and writes the digest. A preview without its seal stays unreadable and
-- unconfirmable, so a failed store never becomes a job.
CREATE FUNCTION cc.complete_user_attribute_preview(p_actor uuid,p_version integer,p_preview_id uuid,
  p_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection; preview cc.user_attribute_previews; bad integer; total integer;
  eligible_total integer; unchanged_total integer; conflict_total integer; changes integer;
  oldest timestamptz;
BEGIN
  IF p_actor IS NULL OR p_version IS NULL OR p_preview_id IS NULL OR p_digest IS NULL OR
    p_digest !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'The value preview seal is invalid.' USING ERRCODE='22023';
  END IF;
  connection:=cc.user_attribute_writer(p_actor,p_version);
  SELECT * INTO preview FROM cc.user_attribute_previews p WHERE p.preview_id=p_preview_id FOR UPDATE;
  IF preview.preview_id IS NULL OR preview.created_by<>p_actor OR
    preview.customer_id IS DISTINCT FROM connection.customer_id OR preview.manifest_digest IS NOT NULL THEN
    RETURN jsonb_build_object('outcome','not-found');
  END IF;
  SELECT count(*)::integer, count(*) FILTER(WHERE t.disposition='eligible')::integer,
      count(*) FILTER(WHERE t.disposition='unchanged')::integer,
      count(*) FILTER(WHERE t.disposition='conflict')::integer
    INTO total,eligible_total,unchanged_total,conflict_total
    FROM cc.user_attribute_preview_targets t WHERE t.preview_id=p_preview_id;
  IF total NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'The value preview target count is invalid.' USING ERRCODE='22023';
  END IF;
  -- Every target keeps the target rule of B section 8.4 and holds at least one row.
  SELECT count(*) INTO bad FROM cc.user_attribute_preview_targets t
    WHERE t.disposition IS DISTINCT FROM (CASE
      WHEN EXISTS(SELECT 1 FROM cc.user_attribute_target_values v WHERE v.preview_id=t.preview_id
        AND v.ordinal=t.ordinal AND v.disposition='conflict') THEN 'conflict'
      WHEN EXISTS(SELECT 1 FROM cc.user_attribute_target_values v WHERE v.preview_id=t.preview_id
        AND v.ordinal=t.ordinal AND v.disposition='eligible') THEN 'eligible'
      ELSE 'unchanged' END) OR
      NOT EXISTS(SELECT 1 FROM cc.user_attribute_target_values v WHERE v.preview_id=t.preview_id
        AND v.ordinal=t.ordinal);
  IF bad>0 THEN
    RAISE EXCEPTION 'The value preview targets are invalid.' USING ERRCODE='22023';
  END IF;
  SELECT count(*)::integer INTO changes FROM cc.user_attribute_target_values v
    WHERE v.preview_id=p_preview_id AND v.disposition='eligible';
  SELECT min(t.observed_at) INTO oldest FROM cc.user_attribute_preview_targets t
    WHERE t.preview_id=p_preview_id AND t.disposition='eligible';
  UPDATE cc.user_attribute_previews p SET selected=total,eligible=eligible_total,
    unchanged=unchanged_total,conflicts=conflict_total,attribute_changes=changes,
    oldest_observed_at=oldest,manifest_digest=p_digest
    WHERE p.preview_id=p_preview_id RETURNING * INTO preview;
  RETURN jsonb_build_object('outcome','created','preview',cc.user_attribute_preview_projection(preview));
END;
$$;

-- One value preview, to its creator only (B section 10). A preview lapses 15 minutes after it was
-- prepared. A confirmed preview keeps its answer for its receipt.
CREATE FUNCTION cc.read_user_attribute_preview(p_actor uuid,p_version integer,p_preview_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection; preview cc.user_attribute_previews;
BEGIN
  IF p_actor IS NULL OR p_version IS NULL OR p_preview_id IS NULL THEN
    RAISE EXCEPTION 'The value preview request is invalid.' USING ERRCODE='22023';
  END IF;
  connection:=cc.user_attribute_writer(p_actor,p_version);
  IF connection.customer_id IS NULL THEN
    RETURN jsonb_build_object('outcome','not-found');
  END IF;
  SELECT * INTO preview FROM cc.user_attribute_previews p
    WHERE p.preview_id=p_preview_id AND p.customer_id=connection.customer_id AND p.created_by=p_actor
      AND p.manifest_digest IS NOT NULL;
  IF preview.preview_id IS NULL THEN
    RETURN jsonb_build_object('outcome','not-found');
  END IF;
  IF preview.expires_at<=clock_timestamp() AND NOT EXISTS(
      SELECT 1 FROM cc.user_attribute_update_jobs d WHERE d.preview_id=p_preview_id) THEN
    RETURN jsonb_build_object('outcome','preview-expired','expiresAt',preview.expires_at);
  END IF;
  RETURN jsonb_build_object('outcome','preview','customerId',preview.customer_id,
    'preview',cc.user_attribute_preview_projection(preview));
END;
$$;

-- One page of the frozen rows of a preview, in the order of the primary key: user ordinal, then
-- attribute name. The cursor names the last row that a page answered (B section 10).
CREATE FUNCTION cc.read_user_attribute_preview_targets(p_actor uuid,p_version integer,p_preview_id uuid,
  p_disposition text,p_cursor_ordinal integer,p_cursor_schema text,p_cursor_field text,p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection; preview cc.user_attribute_previews; rows jsonb; more boolean;
  cursor text;
BEGIN
  IF p_actor IS NULL OR p_version IS NULL OR p_preview_id IS NULL OR p_limit IS NULL OR
    p_limit NOT BETWEEN 1 AND 1000 OR
    (p_disposition IS NOT NULL AND p_disposition NOT IN ('eligible','unchanged','conflict')) OR
    ((p_cursor_ordinal IS NULL)<>(p_cursor_schema IS NULL)) OR
    ((p_cursor_ordinal IS NULL)<>(p_cursor_field IS NULL)) OR
    (p_cursor_schema IS NOT NULL AND p_cursor_schema !~ '^[A-Za-z0-9_-]{1,200}$') OR
    (p_cursor_field IS NOT NULL AND p_cursor_field !~ '^[A-Za-z0-9_-]{1,200}$') THEN
    RAISE EXCEPTION 'The value preview page request is invalid.' USING ERRCODE='22023';
  END IF;
  connection:=cc.user_attribute_writer(p_actor,p_version);
  IF connection.customer_id IS NULL THEN
    RETURN jsonb_build_object('outcome','not-found');
  END IF;
  SELECT * INTO preview FROM cc.user_attribute_previews p
    WHERE p.preview_id=p_preview_id AND p.customer_id=connection.customer_id AND p.created_by=p_actor
      AND p.manifest_digest IS NOT NULL;
  IF preview.preview_id IS NULL THEN
    RETURN jsonb_build_object('outcome','not-found');
  END IF;
  IF preview.expires_at<=clock_timestamp() AND NOT EXISTS(
      SELECT 1 FROM cc.user_attribute_update_jobs d WHERE d.preview_id=p_preview_id) THEN
    RETURN jsonb_build_object('outcome','preview-expired','expiresAt',preview.expires_at);
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('ordinal',v.ordinal,'schemaName',v.schema_name,
      'fieldName',v.field_name,'currentValue',v.current_value,'newValue',v.requested_value,
      'disposition',v.disposition,'userId',t.user_id,'primaryEmail',t.primary_email,
      'observedAt',t.observed_at) ORDER BY v.ordinal,v.schema_name,v.field_name),'[]'::jsonb)
    INTO rows
    FROM (SELECT * FROM cc.user_attribute_target_values v WHERE v.preview_id=p_preview_id AND
        (p_disposition IS NULL OR v.disposition=p_disposition) AND
        (p_cursor_ordinal IS NULL OR (v.ordinal,v.schema_name,v.field_name)>
          (p_cursor_ordinal,p_cursor_schema,p_cursor_field))
      ORDER BY v.ordinal,v.schema_name,v.field_name LIMIT p_limit) v
    JOIN cc.user_attribute_preview_targets t
      ON t.preview_id=v.preview_id AND t.ordinal=v.ordinal;
  SELECT EXISTS(SELECT 1 FROM (SELECT v.ordinal FROM cc.user_attribute_target_values v
      WHERE v.preview_id=p_preview_id AND
        (p_disposition IS NULL OR v.disposition=p_disposition) AND
        (p_cursor_ordinal IS NULL OR (v.ordinal,v.schema_name,v.field_name)>
          (p_cursor_ordinal,p_cursor_schema,p_cursor_field))
      ORDER BY v.ordinal,v.schema_name,v.field_name OFFSET p_limit LIMIT 1) x) INTO more;
  IF more THEN
    SELECT v.ordinal||':'||v.schema_name||'.'||v.field_name INTO cursor
      FROM cc.user_attribute_target_values v
      WHERE v.preview_id=p_preview_id AND
        (p_disposition IS NULL OR v.disposition=p_disposition) AND
        (p_cursor_ordinal IS NULL OR (v.ordinal,v.schema_name,v.field_name)>
          (p_cursor_ordinal,p_cursor_schema,p_cursor_field))
      ORDER BY v.ordinal,v.schema_name,v.field_name OFFSET p_limit-1 LIMIT 1;
  ELSE
    cursor:=NULL;
  END IF;
  RETURN jsonb_build_object('outcome','page','customerId',preview.customer_id,'targets',rows,
    'nextCursor',cursor);
END;
$$;

-- The receipt of one accepted value job. A repeated confirm answers it.
CREATE FUNCTION cc.user_attribute_job_receipt(p_job uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT jsonb_build_object('jobId',j.job_id,'displayId',j.display_id,'status','accepted',
    'userCount',j.target_count,
    'changeCount',(SELECT count(*)::integer FROM (SELECT DISTINCT v.schema_name,v.field_name
      FROM cc.user_attribute_target_values v WHERE v.preview_id=d.preview_id AND
        v.disposition='eligible') a))
  FROM cc.jobs j JOIN cc.user_attribute_update_jobs d ON d.job_id=j.job_id
  WHERE j.job_id=p_job AND j.kind='user-attribute-update';
$$;

-- The confirmation of B section 10. It revalidates the person, the two grants, the frozen
-- permission version, the connection generation, the expiry, the digest, the conflicts, and the
-- frozen category etags, then creates one `user-attribute-update` job. The preview row locks first,
-- so a second confirmation reads the committed job and answers the same receipt.
CREATE FUNCTION cc.confirm_user_attribute_preview(p_actor uuid,p_version integer,p_preview_id uuid,
  p_digest text,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE preview cc.user_attribute_previews; connection cc.google_connection; job cc.jobs;
  category cc.user_attribute_categories; etag_row record; number bigint;
BEGIN
  IF p_actor IS NULL OR p_version IS NULL OR p_preview_id IS NULL OR p_digest IS NULL OR
    p_digest !~ '^[a-f0-9]{64}$' OR p_correlation IS NULL THEN
    RAISE EXCEPTION 'The value preview confirmation is invalid.' USING ERRCODE='22023';
  END IF;
  -- Rule G: the global access lock comes first, before any row lock. The preview row locks after it.
  PERFORM pg_advisory_xact_lock(7240173008);
  SELECT * INTO preview FROM cc.user_attribute_previews p WHERE p.preview_id=p_preview_id FOR UPDATE;
  IF preview.preview_id IS NULL OR preview.manifest_digest IS NULL OR preview.created_by<>p_actor THEN
    RETURN jsonb_build_object('outcome','not-found');
  END IF;
  -- Current authority and the frozen permission version come before the existing receipt, so a
  -- revoked grant never receives the receipt of a job it no longer may see.
  IF NOT EXISTS(SELECT 1 FROM cc.application_principals p
      WHERE p.id=p_actor AND p.enabled AND p.permission_version=p_version) OR
    NOT EXISTS(SELECT 1 FROM cc.application_grants g WHERE g.principal_id=p_actor AND
      g.action='users:write' AND (g.scope='{"kind":"platform"}'::jsonb OR
      (g.scope->>'kind'='district' AND g.scope->>'customerId'=preview.customer_id))) OR
    (preview.source='selection' AND NOT EXISTS(SELECT 1 FROM cc.application_grants g
      WHERE g.principal_id=p_actor AND g.action='users:bulk-actions' AND
      (g.scope='{"kind":"platform"}'::jsonb OR
      (g.scope->>'kind'='district' AND g.scope->>'customerId'=preview.customer_id)))) THEN
    RETURN jsonb_build_object('outcome','forbidden');
  END IF;
  IF preview.permission_version<>p_version THEN
    RETURN jsonb_build_object('outcome','forbidden');
  END IF;
  -- A preview that holds a job never creates another one (B section 10).
  IF EXISTS(SELECT 1 FROM cc.user_attribute_update_jobs d WHERE d.preview_id=p_preview_id) THEN
    RETURN jsonb_build_object('outcome','existing','receipt',cc.user_attribute_job_receipt(
      (SELECT d.job_id FROM cc.user_attribute_update_jobs d WHERE d.preview_id=p_preview_id)));
  END IF;
  IF preview.expires_at<=clock_timestamp() THEN
    RETURN jsonb_build_object('outcome','preview-expired','expiresAt',preview.expires_at);
  END IF;
  IF p_digest IS DISTINCT FROM preview.manifest_digest THEN
    RETURN jsonb_build_object('outcome','preview-changed');
  END IF;
  -- A preview that froze a conflict row never confirms, and it creates no job (B section 8.4).
  IF preview.conflicts>0 THEN
    RETURN jsonb_build_object('outcome','preview-conflict');
  END IF;
  -- A preview with no eligible row has nothing to write, so it creates no job (B section 13).
  IF preview.eligible=0 THEN
    RETURN jsonb_build_object('outcome','nothing-to-update');
  END IF;
  -- B section 6.2: the preview froze each category etag, and the confirm compares the cache again.
  -- The customer category-set lock serializes this reread with the whole-set replacement (021,
  -- 026). Without it, a waiting lookup skips a tuple that the replacement deleted instead of
  -- observing its replacement. The global access lock came first, as rule G requires.
  PERFORM pg_advisory_xact_lock(hashtext('cc:user_attribute_categories'),hashtext(preview.customer_id));
  -- The connection row locks after the preview row and before the job rows.
  SELECT * INTO connection FROM cc.google_connection c WHERE c.singleton FOR KEY SHARE;
  -- Every blocking wait is behind us. A preview that reached its deadline during one of those
  -- waits refuses here, before any job exists.
  IF preview.expires_at<=clock_timestamp() THEN
    RETURN jsonb_build_object('outcome','preview-expired','expiresAt',preview.expires_at);
  END IF;
  -- A category that changed or vanished answers category-changed before any job exists.
  FOR etag_row IN SELECT * FROM cc.user_attribute_preview_categories c WHERE c.preview_id=p_preview_id LOOP
    SELECT * INTO category FROM cc.user_attribute_categories c
      WHERE c.customer_id=preview.customer_id AND c.schema_name=etag_row.schema_name;
    IF category.schema_id IS NULL OR category.etag IS DISTINCT FROM etag_row.etag THEN
      RETURN jsonb_build_object('outcome','category-changed');
    END IF;
  END LOOP;
  IF connection.customer_id IS DISTINCT FROM preview.customer_id OR
    connection.generation<>preview.generation THEN
    RETURN jsonb_build_object('outcome','connection-changed');
  END IF;
  number:=nextval('cc.job_number_uat');
  -- The value job takes the `devices` scope with the eligible user count, the `user` entity type,
  -- and the write slot that 027 gives the kind (E8).
  INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,entity_type,status,requested_by,
    generation,target_count,correlation_id)
  VALUES(gen_random_uuid(),cc.job_display_id('UAT',number),preview.customer_id,
    'user-attribute-update','devices','user','accepted',p_actor,preview.generation,preview.eligible,
    p_correlation)
  RETURNING * INTO job;
  INSERT INTO cc.user_attribute_update_jobs(job_id,preview_id,confirmed_by,confirmer_permission_version)
  VALUES(job.job_id,p_preview_id,p_actor,p_version);
  PERFORM cc.record_job_change(job.job_id,true);
  RETURN jsonb_build_object('outcome','created','receipt',cc.user_attribute_job_receipt(job.job_id));
END;
$$;

REVOKE ALL ON FUNCTION cc.user_attribute_writer(uuid,integer),
  cc.read_user_attribute_preview_base(uuid,integer),
  cc.user_value_credential(uuid,integer,text,integer),
  cc.user_attribute_preview_projection(cc.user_attribute_previews),
  cc.create_user_attribute_preview(uuid,integer,text,integer,text,jsonb,jsonb,jsonb,integer),
  cc.append_user_attribute_preview_targets(uuid,integer,uuid,jsonb),
  cc.complete_user_attribute_preview(uuid,integer,uuid,text),
  cc.read_user_attribute_preview(uuid,integer,uuid),
  cc.read_user_attribute_preview_targets(uuid,integer,uuid,text,integer,text,text,integer),
  cc.user_attribute_job_receipt(uuid),
  cc.confirm_user_attribute_preview(uuid,integer,uuid,text,uuid) FROM PUBLIC;