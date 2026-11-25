-- J4: the facts that the category and value jobs report. Document B sections 7.1 to 7.3 and 10,
-- CA state 07, and UM states 09 and 10.
--
-- 1. A category plan keeps the label that an edit moved from, and the info type of each change. A
--    removed attribute leaves the Google body, so the plan stored no type for it before (K16).
-- 2. The preview rows carry the user name of the cache, for the review table of UM state 09 (K23).
-- The plan route stays creator-only, and the job reads follow the job visibility of the list.

-- 1. The two facts that a plan lacked. `previous_display_name` is the cached label of an edit whose
-- label moves, and it stays null for a create, a delete, and an edit that keeps its label.
-- `change_field_types` holds one entry for each plan change, in the order of `changes`: the info
-- type of that change (B section 8.1). A same-name replacement keeps the cached type of its Removed
-- row and the body type of its Added row, so the entry follows the change and not the field name.
ALTER TABLE cc.user_category_plans
  ADD COLUMN previous_display_name text
    CHECK(previous_display_name IS NULL OR length(previous_display_name) BETWEEN 1 AND 200),
  ADD COLUMN change_field_types jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK(jsonb_typeof(change_field_types)='array');

CREATE OR REPLACE FUNCTION cc.create_user_category_plan(p_actor uuid,p_version integer,p_customer text,
  p_generation integer,p_kind text,p_schema_id text,p_base_etag text,p_schema_name text,
  p_display_name text,p_body jsonb,p_changes jsonb,p_phrase text,p_digest text,
  p_expires_minutes integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection; category cc.user_attribute_categories; plan cc.user_category_plans;
  categories integer; attributes integer; added integer; removed integer; bad integer;
  now_at timestamptz; category_limit integer:=100; attribute_limit integer:=100;
  -- The facts that CA state 07 needs and the plan lacked: the label that an edit moved from, and the
  -- info type of each change, which a removed attribute loses with the body (card J4).
  previous_name text; change_types jsonb;
BEGIN
  -- S2: every input holds a value of its domain, or the call rejects before any lock or write.
  IF p_actor IS NULL OR p_version IS NULL OR p_customer IS NULL OR p_generation IS NULL OR
    p_kind IS NULL OR p_kind NOT IN ('create-category','edit-category','delete-category') OR
    p_schema_name IS NULL OR p_schema_name !~ '^[A-Za-z0-9_-]{1,200}$' OR
    p_display_name IS NULL OR char_length(p_display_name) NOT BETWEEN 1 AND 200 OR
    p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$' OR
    p_expires_minutes IS NULL OR p_expires_minutes NOT BETWEEN 1 AND 1440 OR
    (p_phrase IS NOT NULL AND char_length(p_phrase) NOT BETWEEN 1 AND 200) OR
    jsonb_typeof(p_changes) IS DISTINCT FROM 'array' OR jsonb_array_length(p_changes)>200 THEN
    RAISE EXCEPTION 'The category plan request is invalid.' USING ERRCODE='22023';
  END IF;
  -- A create names no cached category and no etag. Only a delete sends no body.
  IF (p_kind='create-category')<>(p_schema_id IS NULL) OR
    (p_kind='create-category')<>(p_base_etag IS NULL) OR
    (p_kind='delete-category')<>(p_body IS NULL) THEN
    RAISE EXCEPTION 'The category plan request is invalid.' USING ERRCODE='22023';
  END IF;
  -- The body is the complete schema that the worker sends (B section 6.1).
  IF p_body IS NOT NULL AND (jsonb_typeof(p_body)<>'object' OR
      p_body->>'schemaName' IS DISTINCT FROM p_schema_name OR
      p_body->>'displayName' IS DISTINCT FROM p_display_name OR
      jsonb_typeof(p_body->'fields') IS DISTINCT FROM 'array' OR
      jsonb_array_length(p_body->'fields') NOT BETWEEN 1 AND 100) THEN
    RAISE EXCEPTION 'The category plan body is invalid.' USING ERRCODE='22023';
  END IF;
  IF p_body IS NOT NULL THEN
    SELECT count(*) INTO bad FROM jsonb_array_elements(p_body->'fields') f
      WHERE jsonb_typeof(f) IS DISTINCT FROM 'object' OR
        COALESCE(f->>'fieldName','') !~ '^[A-Za-z0-9_-]{1,200}$' OR
        jsonb_typeof(f->'displayName') IS DISTINCT FROM 'string' OR
        char_length(f->>'displayName') NOT BETWEEN 1 AND 200 OR btrim(f->>'displayName')='' OR
        COALESCE(f->>'fieldType','') NOT IN ('STRING','INT64','DOUBLE','BOOL','DATE','EMAIL','PHONE') OR
        jsonb_typeof(f->'multiValued') IS DISTINCT FROM 'boolean' OR
        jsonb_typeof(f->'indexed') IS DISTINCT FROM 'boolean' OR
        COALESCE(f->>'readAccessType','') NOT IN ('ADMINS_AND_SELF','ALL_DOMAIN_USERS') OR
        (f->'fieldId' IS NOT NULL AND f->'fieldId'<>'null'::jsonb AND
          (jsonb_typeof(f->'fieldId')<>'string' OR char_length(f->>'fieldId') NOT BETWEEN 1 AND 200)) OR
        (f->'numericIndexingSpec' IS NOT NULL AND f->'numericIndexingSpec'<>'null'::jsonb AND
          (jsonb_typeof(f->'numericIndexingSpec')<>'object' OR
          (f->'numericIndexingSpec'->'minValue' IS NOT NULL AND f->'numericIndexingSpec'->'minValue'<>'null'::jsonb AND
            jsonb_typeof(f->'numericIndexingSpec'->'minValue')<>'number') OR
          (f->'numericIndexingSpec'->'maxValue' IS NOT NULL AND f->'numericIndexingSpec'->'maxValue'<>'null'::jsonb AND
            jsonb_typeof(f->'numericIndexingSpec'->'maxValue')<>'number') OR
          f->>'fieldType' NOT IN ('INT64','DOUBLE')));
    IF bad>0 THEN
      RAISE EXCEPTION 'The category plan body is invalid.' USING ERRCODE='22023';
    END IF;
    -- A create lets Google assign every field ID.
    IF p_kind='create-category' AND EXISTS(SELECT 1 FROM jsonb_array_elements(p_body->'fields') f
        WHERE f->'fieldId' IS NOT NULL AND f->'fieldId'<>'null'::jsonb) THEN
      RAISE EXCEPTION 'A new attribute carries no field ID.' USING ERRCODE='22023';
    END IF;
  END IF;
  -- Each change names its attribute, its property list, and the holder count of a removal.
  SELECT count(*) INTO bad FROM jsonb_array_elements(p_changes) c
    WHERE jsonb_typeof(c) IS DISTINCT FROM 'object' OR
      COALESCE(c->>'change','') NOT IN ('added','changed','removed') OR
      (c->'fieldId' IS NOT NULL AND c->'fieldId'<>'null'::jsonb AND
        (jsonb_typeof(c->'fieldId')<>'string' OR char_length(c->>'fieldId') NOT BETWEEN 1 AND 200)) OR
      COALESCE(c->>'fieldName','') !~ '^[A-Za-z0-9_-]{1,200}$' OR
      jsonb_typeof(c->'displayName') IS DISTINCT FROM 'string' OR
      char_length(c->>'displayName') NOT BETWEEN 1 AND 200 OR
      jsonb_typeof(c->'properties') IS DISTINCT FROM 'array' OR
      (c->'holders' IS NOT NULL AND jsonb_typeof(c->'holders') NOT IN ('number','null')) OR
      ((c->>'change'='added') IS DISTINCT FROM (c->'fieldId' IS NULL OR c->'fieldId'='null'::jsonb)) OR
      ((c->>'change'='changed') IS DISTINCT FROM (jsonb_array_length(c->'properties')>0)) OR
      ((c->>'change'='removed') IS DISTINCT FROM (jsonb_typeof(c->'holders')='number')) OR
      ((c->>'change'='removed') AND jsonb_array_length(c->'properties')>0) OR
      EXISTS(SELECT 1 FROM jsonb_array_elements_text(c->'properties') p
        WHERE p NOT IN ('displayName','multiValued','indexed','readAccessType','numericIndexingSpec'));
  IF bad>0 THEN
    RAISE EXCEPTION 'The category plan changes are invalid.' USING ERRCODE='22023';
  END IF;
  -- Rule G: the global access lock comes first, before any row lock or write, as device previews do.
  PERFORM pg_advisory_xact_lock(7240173008);
  -- The person check of the route. A caller without the action receives no plan.
  IF NOT EXISTS(SELECT 1 FROM cc.application_principals p
      WHERE p.id=p_actor AND p.enabled AND p.permission_version=p_version) OR
    NOT EXISTS(SELECT 1 FROM cc.application_grants g WHERE g.principal_id=p_actor AND
      g.action='users:schema-manage' AND (g.scope='{"kind":"platform"}'::jsonb OR
      (g.scope->>'kind'='district' AND g.scope->>'customerId'=p_customer))) THEN
    RETURN jsonb_build_object('outcome','forbidden');
  END IF;
  -- The connection row locks after the access lock and before the first clock read.
  SELECT * INTO connection FROM cc.google_connection c WHERE c.singleton FOR KEY SHARE;
  IF connection.customer_id IS DISTINCT FROM p_customer OR
    connection.generation<>p_generation THEN
    RETURN jsonb_build_object('outcome','connection-changed');
  END IF;
  SELECT count(*),COALESCE(sum(jsonb_array_length(c.fields)),0) INTO categories,attributes
  FROM cc.user_attribute_categories c WHERE c.customer_id=p_customer;
  IF p_kind='create-category' THEN
    -- Google holds a category name unique in the customer, without letter case (B section 5).
    IF EXISTS(SELECT 1 FROM cc.user_attribute_categories c WHERE c.customer_id=p_customer AND
        lower(c.schema_name)=lower(p_schema_name)) THEN
      RETURN jsonb_build_object('outcome','name-in-use');
    END IF;
    categories:=categories+1;
    attributes:=attributes+jsonb_array_length(p_body->'fields');
    added:=jsonb_array_length(p_body->'fields');
    IF (SELECT count(*) FROM jsonb_array_elements(p_changes) c WHERE c->>'change'<>'added')>0 OR
      jsonb_array_length(p_changes)<>added THEN
      RAISE EXCEPTION 'The category plan changes are invalid.' USING ERRCODE='22023';
    END IF;
  ELSE
    -- The category cache re-reads right before the store. A different etag means another change
    -- reached the category after the plan base, so the plan never stores (C7).
    SELECT * INTO category FROM cc.user_attribute_categories c
      WHERE c.customer_id=p_customer AND c.schema_id=p_schema_id FOR SHARE;
    IF category.schema_id IS NULL OR category.etag IS DISTINCT FROM p_base_etag OR
      category.schema_name IS DISTINCT FROM p_schema_name OR
      (p_kind='delete-category' AND category.display_name IS DISTINCT FROM p_display_name) THEN
      RETURN jsonb_build_object('outcome','category-changed');
    END IF;
    IF p_kind='delete-category' THEN
      -- A delete removes the category and every attribute in it, and adds nothing. The two limit
      -- counts that the plan answers must stay numeric.
      categories:=categories-1;
      added:=0;
      removed:=jsonb_array_length(category.fields);
      IF jsonb_array_length(p_changes)<>removed OR
        EXISTS(SELECT 1 FROM jsonb_array_elements(p_changes) c WHERE c->>'change'<>'removed' OR
          NOT EXISTS(SELECT 1 FROM jsonb_array_elements(category.fields) f
            WHERE f->>'fieldId'=c->>'fieldId' AND f->>'fieldName'=c->>'fieldName')) THEN
        RAISE EXCEPTION 'The category plan changes are invalid.' USING ERRCODE='22023';
      END IF;
    ELSE
      -- A kept attribute keeps its cached name and info type, and a multi-value attribute never
      -- returns to one value (B section 5).
      SELECT count(*) INTO bad FROM jsonb_array_elements(p_body->'fields') f
        WHERE f->'fieldId' IS NOT NULL AND f->'fieldId'<>'null'::jsonb AND NOT EXISTS(
          SELECT 1 FROM jsonb_array_elements(category.fields) cf
          WHERE cf->>'fieldId'=f->>'fieldId' AND cf->>'fieldName'=f->>'fieldName' AND
            cf->>'fieldType'=f->>'fieldType' AND
            NOT (cf->>'multiValued'='true' AND f->>'multiValued'='false'));
      IF bad>0 THEN
        RAISE EXCEPTION 'The category plan changes a locked property.' USING ERRCODE='22023';
      END IF;
      SELECT count(*) INTO added FROM jsonb_array_elements(p_body->'fields') f
        WHERE f->'fieldId' IS NULL OR f->'fieldId'='null'::jsonb;
      removed:=jsonb_array_length(category.fields)-(jsonb_array_length(p_body->'fields')-added);
      IF added<0 OR removed<0 OR
        (SELECT count(*) FROM jsonb_array_elements(p_changes) c WHERE c->>'change'='added')<>added OR
        (SELECT count(*) FROM jsonb_array_elements(p_changes) c WHERE c->>'change'='removed')<>removed THEN
        RAISE EXCEPTION 'The category plan changes are invalid.' USING ERRCODE='22023';
      END IF;
    END IF;
    attributes:=attributes-removed+added;
  END IF;
  -- The two account limits of B section 5, with the unsaved attributes counted.
  IF categories>category_limit THEN
    RETURN jsonb_build_object('outcome','category-limit','limit',category_limit);
  END IF;
  IF attributes>attribute_limit THEN
    RETURN jsonb_build_object('outcome','attribute-limit','limit',attribute_limit);
  END IF;
  -- A create adds attributes and a delete removes them. Another plan carries no change.
  IF (p_kind='create-category' AND p_phrase IS NOT NULL) OR
    (p_kind='delete-category' AND p_phrase IS NULL) THEN
    RAISE EXCEPTION 'The category plan phrase is invalid.' USING ERRCODE='22023';
  END IF;
  -- The label that an edit moves from. A create has no earlier label, and a delete keeps the
  -- cached label that the scope line shows, so only an edit whose label moves stores one.
  IF p_kind='edit-category' AND category.display_name IS DISTINCT FROM p_display_name THEN
    previous_name:=category.display_name;
  END IF;
  -- The info type of each change, in the order of the changes. A Removed row reads the cached
  -- category, because a removal leaves the body, and an Added or Changed row reads the frozen body.
  -- A same-name replacement therefore keeps two different types (CA state 07).
  change_types:=COALESCE((SELECT jsonb_agg(jsonb_build_object('fieldName',c->>'fieldName',
      'fieldType',CASE WHEN c->>'change'='removed' THEN
        (SELECT f->>'fieldType' FROM jsonb_array_elements(COALESCE(category.fields,'[]'::jsonb)) f
          WHERE f->>'fieldName'=c->>'fieldName' LIMIT 1)
      ELSE
        (SELECT f->>'fieldType' FROM jsonb_array_elements(COALESCE(p_body->'fields','[]'::jsonb)) f
          WHERE f->>'fieldName'=c->>'fieldName' LIMIT 1)
      END) ORDER BY o)
    FROM jsonb_array_elements(p_changes) WITH ORDINALITY AS x(c,o)),'[]'::jsonb);
  now_at:=clock_timestamp();
  INSERT INTO cc.user_category_plans(plan_id,customer_id,created_by,permission_version,generation,
    action,schema_id,schema_name,base_etag,body,changes,limits,phrase,digest,prepared_at,expires_at,
    previous_display_name,change_field_types)
  VALUES(gen_random_uuid(),p_customer,p_actor,p_version,p_generation,p_kind,p_schema_id,p_schema_name,
    p_base_etag,p_body,p_changes,
    jsonb_build_object('categories',categories,'categoryLimit',category_limit,
      'attributes',attributes,'attributeLimit',attribute_limit),
    p_phrase,p_digest,now_at,now_at+make_interval(mins=>p_expires_minutes),
    previous_name,change_types)
  RETURNING * INTO plan;
  RETURN jsonb_build_object('outcome','created','plan',cc.user_category_plan_projection(plan));
END;
$$;

-- 2. One page of the frozen rows of a preview, with the user name of the cache (card J4 item 5).
-- The row order, the cursor, and the refusal rules of 028 are unchanged.
CREATE OR REPLACE FUNCTION cc.read_user_attribute_preview_targets(p_actor uuid,p_version integer,p_preview_id uuid,
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
  -- The review table of UM state 09 shows the user name of the cache (card J4 item 5). A user
  -- that the cache no longer holds answers null.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('ordinal',v.ordinal,'schemaName',v.schema_name,
      'fieldName',v.field_name,'currentValue',v.current_value,'newValue',v.requested_value,
      'disposition',v.disposition,'userId',t.user_id,'userName',u.full_name,
      'primaryEmail',t.primary_email,'observedAt',t.observed_at)
      ORDER BY v.ordinal,v.schema_name,v.field_name),'[]'::jsonb)
    INTO rows
    FROM (SELECT * FROM cc.user_attribute_target_values v WHERE v.preview_id=p_preview_id AND
        (p_disposition IS NULL OR v.disposition=p_disposition) AND
        (p_cursor_ordinal IS NULL OR (v.ordinal,v.schema_name,v.field_name)>
          (p_cursor_ordinal,p_cursor_schema,p_cursor_field))
      ORDER BY v.ordinal,v.schema_name,v.field_name LIMIT p_limit) v
    JOIN cc.user_attribute_preview_targets t
      ON t.preview_id=v.preview_id AND t.ordinal=v.ordinal
    LEFT JOIN cc.users u ON u.customer_id=preview.customer_id AND u.user_id=t.user_id;
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


REVOKE ALL ON FUNCTION
  cc.create_user_category_plan(uuid,integer,text,integer,text,text,text,text,text,jsonb,jsonb,text,text,integer),
  cc.read_user_attribute_preview_targets(uuid,integer,uuid,text,integer,text,text,integer) FROM PUBLIC;
