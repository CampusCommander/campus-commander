-- K15: the category plan and confirm routes of document B section 10.
-- A plan freezes one Google category call. Its route builds the call and this migration stores it
-- under the schema-manage gate. The store re-reads the category cache first, so a changed `etag`
-- answers `category-changed` (C7). A confirm creates one `user-schema-change` job of the `CAT-`
-- display rule and answers its receipt. The category job worker (K16) runs the stored call.

-- The schema-manage gate of the plan routes. It mirrors 021 cc.user_reader with
-- `users:schema-manage`, so a person without the action reads no category base and plans nothing.
CREATE FUNCTION cc.user_schema_manager(p_actor uuid,p_version integer) RETURNS cc.google_connection
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection;
BEGIN
  SELECT * INTO connection FROM cc.google_connection WHERE singleton;
  IF NOT EXISTS(SELECT 1 FROM cc.application_principals p
      WHERE p.id=p_actor AND p.enabled AND p.permission_version=p_version) OR
    NOT EXISTS(SELECT 1 FROM cc.application_grants g WHERE g.principal_id=p_actor AND g.action='users:schema-manage' AND (
      g.scope='{"kind":"platform"}'::jsonb OR
      (g.scope->>'kind'='district' AND g.scope->>'customerId'=connection.customer_id))) THEN
    RAISE EXCEPTION 'User schema manage authority is required.' USING ERRCODE='42501';
  END IF;
  RETURN connection;
END;
$$;

-- The plan base of B section 10: the cached set under the schema-manage gate, with the customer and
-- the generation that the plan freezes. A customer without a connection reads null. The category
-- read route of K8 keeps `users:read`, because User Schema Manage does not imply User Read.
CREATE FUNCTION cc.read_user_category_plan_base(p_actor uuid,p_version integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection;
BEGIN
  connection:=cc.user_schema_manager(p_actor,p_version);
  IF connection.customer_id IS NULL THEN RETURN NULL; END IF;
  RETURN cc.user_attribute_categories_projection(connection.customer_id)||
    jsonb_build_object('customerId',connection.customer_id,'generation',connection.generation);
END;
$$;

-- The plan answer of B section 10. A create and an edit carry their label in the frozen body. A
-- delete sends no body, and its typed phrase is the cached category label, so the answer reads it
-- there.
CREATE FUNCTION cc.user_category_plan_projection(p cc.user_category_plans) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT jsonb_build_object('planId',p.plan_id,
    'kind',p.action,
    'method',CASE p.action WHEN 'create-category' THEN 'insert'
      WHEN 'edit-category' THEN 'update' ELSE 'delete' END,
    'schemaId',p.schema_id,
    'schemaName',p.schema_name,
    'displayName',CASE WHEN p.body IS NOT NULL THEN p.body->>'displayName' ELSE p.phrase END,
    'baseEtag',p.base_etag,
    'changes',p.changes,
    'phrase',p.phrase,
    'limits',p.limits,
    'preparedAt',p.prepared_at,
    'expiresAt',p.expires_at,
    'digest',p.digest);
$$;

-- One prepared category plan. The caller builds the Google call, its attribute changes, its typed
-- phrase, and its digest. This function re-reads the category cache right before the store: an
-- `etag` that differs from the plan base answers `category-changed` (C7), a category name that the
-- cache now holds answers `name-in-use`, and the two account limits answer `category-limit` and
-- `attribute-limit`. The stored limits count the set after the save.
CREATE FUNCTION cc.create_user_category_plan(p_actor uuid,p_version integer,p_customer text,
  p_generation integer,p_kind text,p_schema_id text,p_base_etag text,p_schema_name text,
  p_display_name text,p_body jsonb,p_changes jsonb,p_phrase text,p_digest text,
  p_expires_minutes integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection; category cc.user_attribute_categories; plan cc.user_category_plans;
  categories integer; attributes integer; added integer; removed integer; bad integer;
  now_at timestamptz; category_limit integer:=100; attribute_limit integer:=100;
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
  now_at:=clock_timestamp();
  INSERT INTO cc.user_category_plans(plan_id,customer_id,created_by,permission_version,generation,
    action,schema_id,schema_name,base_etag,body,changes,limits,phrase,digest,prepared_at,expires_at)
  VALUES(gen_random_uuid(),p_customer,p_actor,p_version,p_generation,p_kind,p_schema_id,p_schema_name,
    p_base_etag,p_body,p_changes,
    jsonb_build_object('categories',categories,'categoryLimit',category_limit,
      'attributes',attributes,'attributeLimit',attribute_limit),
    p_phrase,p_digest,now_at,now_at+make_interval(mins=>p_expires_minutes))
  RETURNING * INTO plan;
  RETURN jsonb_build_object('outcome','created','plan',cc.user_category_plan_projection(plan));
END;
$$;

-- One category plan, to its creator only (B section 10). A plan that no confirm reached lapses 15
-- minutes after it was prepared. A confirmed plan keeps its answer for its receipt.
CREATE FUNCTION cc.read_user_category_plan(p_actor uuid,p_version integer,p_plan_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection; plan cc.user_category_plans;
BEGIN
  IF p_actor IS NULL OR p_version IS NULL OR p_plan_id IS NULL THEN
    RAISE EXCEPTION 'The category plan request is invalid.' USING ERRCODE='22023';
  END IF;
  connection:=cc.user_schema_manager(p_actor,p_version);
  IF connection.customer_id IS NULL THEN
    RETURN jsonb_build_object('outcome','not-found');
  END IF;
  SELECT * INTO plan FROM cc.user_category_plans p
    WHERE p.plan_id=p_plan_id AND p.customer_id=connection.customer_id AND p.created_by=p_actor;
  IF plan.plan_id IS NULL THEN
    RETURN jsonb_build_object('outcome','not-found');
  END IF;
  IF plan.confirmed_at IS NULL AND plan.expires_at<=clock_timestamp() THEN
    RETURN jsonb_build_object('outcome','plan-expired','expiresAt',plan.expires_at);
  END IF;
  RETURN jsonb_build_object('outcome','plan','customerId',plan.customer_id,
    'plan',cc.user_category_plan_projection(plan));
END;
$$;

-- The receipt of one accepted category job. A repeated confirm answers it.
CREATE FUNCTION cc.user_category_job_receipt(p_job uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT jsonb_build_object('jobId',j.job_id,'displayId',j.display_id,'status','accepted',
    'action',p.action,'changeCount',COALESCE(jsonb_array_length(p.changes),0))
  FROM cc.jobs j JOIN cc.user_schema_change_jobs d ON d.job_id=j.job_id
  JOIN cc.user_category_plans p ON p.plan_id=d.plan_id
  WHERE j.job_id=p_job AND j.kind='user-schema-change';
$$;

-- The confirmation of B section 10. It revalidates the person, the grant, the connection
-- generation, the expiry, the digest, the typed phrase, and the cached etag of an edit or delete,
-- then creates one `user-schema-change` job. The plan row locks first, so a second confirmation
-- reads the committed job and answers the same receipt. The job keeps the confirmer that the
-- worker revalidates (B section 6.2 step 1).
CREATE FUNCTION cc.confirm_user_category_plan(p_actor uuid,p_version integer,p_plan_id uuid,
  p_digest text,p_phrase text,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE plan cc.user_category_plans; connection cc.google_connection; job cc.jobs;
  category cc.user_attribute_categories; number bigint; now_at timestamptz;
  -- The ECMAScript WhiteSpace and LineTerminator set that String.prototype.trim removes. The
  -- caller trims the entered phrase with trim(), so the frozen phrase must trim the same set.
  phrase_whitespace constant text := E' \t\n\r\f\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
BEGIN
  IF p_actor IS NULL OR p_version IS NULL OR p_plan_id IS NULL OR p_digest IS NULL OR
    p_digest !~ '^[a-f0-9]{64}$' OR p_correlation IS NULL OR
    (p_phrase IS NOT NULL AND char_length(p_phrase)>200) THEN
    RAISE EXCEPTION 'The category plan confirmation is invalid.' USING ERRCODE='22023';
  END IF;
  -- Rule G: the global access lock comes first, before any row lock. The plan row locks after it.
  PERFORM pg_advisory_xact_lock(7240173008);
  SELECT * INTO plan FROM cc.user_category_plans p WHERE p.plan_id=p_plan_id FOR UPDATE;
  IF plan.plan_id IS NULL OR plan.created_by<>p_actor THEN
    RETURN jsonb_build_object('outcome','not-found');
  END IF;
  -- Current authority and the frozen permission version come before the existing receipt, so a
  -- revoked grant never receives the receipt of a job it no longer may see.
  IF NOT EXISTS(SELECT 1 FROM cc.application_principals p
      WHERE p.id=p_actor AND p.enabled AND p.permission_version=p_version) OR
    NOT EXISTS(SELECT 1 FROM cc.application_grants g WHERE g.principal_id=p_actor AND
      g.action='users:schema-manage' AND (g.scope='{"kind":"platform"}'::jsonb OR
      (g.scope->>'kind'='district' AND g.scope->>'customerId'=plan.customer_id))) THEN
    RETURN jsonb_build_object('outcome','forbidden');
  END IF;
  IF plan.permission_version<>p_version THEN
    RETURN jsonb_build_object('outcome','forbidden');
  END IF;
  -- A plan that holds a job never creates another one (B section 10).
  IF EXISTS(SELECT 1 FROM cc.user_schema_change_jobs d WHERE d.plan_id=p_plan_id) THEN
    RETURN jsonb_build_object('outcome','existing','receipt',cc.user_category_job_receipt(
      (SELECT d.job_id FROM cc.user_schema_change_jobs d WHERE d.plan_id=p_plan_id)));
  END IF;
  IF plan.expires_at<=clock_timestamp() THEN
    RETURN jsonb_build_object('outcome','plan-expired','expiresAt',plan.expires_at);
  END IF;
  IF p_digest IS DISTINCT FROM plan.digest THEN
    RETURN jsonb_build_object('outcome','plan-changed');
  END IF;
  -- B section 5 trims the typed phrase. The caller trims the entered phrase with ECMAScript
  -- String.prototype.trim, and `phrase_whitespace` names the same characters, so the frozen phrase
  -- trims the same way; a category label keeps its surrounding whitespace in the plan answer. A
  -- plan without a removal or a delete expects no phrase.
  IF btrim(p_phrase,phrase_whitespace) IS DISTINCT FROM btrim(plan.phrase,phrase_whitespace) THEN
    RETURN jsonb_build_object('outcome','phrase-mismatch');
  END IF;
  -- B section 6.2: the plan froze a cached etag, and the confirm compares the cache again. A
  -- category that changed or vanished answers category-changed before any job exists.
  IF plan.action<>'create-category' THEN
    SELECT * INTO category FROM cc.user_attribute_categories c
      WHERE c.customer_id=plan.customer_id AND c.schema_id=plan.schema_id FOR SHARE;
    IF category.schema_id IS NULL OR category.etag IS DISTINCT FROM plan.base_etag THEN
      RETURN jsonb_build_object('outcome','category-changed');
    END IF;
  END IF;
  -- The connection row locks after the plan row and before the job rows. The subject stays inside
  -- the worker's claim, so this function keeps no credential.
  SELECT * INTO connection FROM cc.google_connection c WHERE c.singleton FOR KEY SHARE;
  IF connection.customer_id IS DISTINCT FROM plan.customer_id OR
    connection.generation<>plan.generation THEN
    RETURN jsonb_build_object('outcome','connection-changed');
  END IF;
  now_at:=clock_timestamp();
  number:=nextval('cc.job_number_cat');
  -- The category job takes the `devices` scope with one operation, the `user` entity type, and the
  -- write slot that 024 gives the kind (E8).
  INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,entity_type,status,requested_by,
    generation,target_count,correlation_id)
  VALUES(gen_random_uuid(),cc.job_display_id('CAT',number),plan.customer_id,'user-schema-change',
    'devices','user','accepted',p_actor,plan.generation,1,p_correlation)
  RETURNING * INTO job;
  INSERT INTO cc.user_schema_change_jobs(job_id,plan_id,confirmed_by,confirmer_permission_version)
  VALUES(job.job_id,p_plan_id,p_actor,p_version);
  UPDATE cc.user_category_plans SET confirmed_at=now_at WHERE plan_id=p_plan_id;
  PERFORM cc.record_job_change(job.job_id,true);
  RETURN jsonb_build_object('outcome','created','receipt',cc.user_category_job_receipt(job.job_id));
END;
$$;

REVOKE ALL ON FUNCTION cc.user_schema_manager(uuid,integer),
  cc.read_user_category_plan_base(uuid,integer),
  cc.create_user_category_plan(uuid,integer,text,integer,text,text,text,text,text,jsonb,jsonb,text,text,integer),
  cc.read_user_category_plan(uuid,integer,uuid),
  cc.user_category_job_receipt(uuid),
  cc.confirm_user_category_plan(uuid,integer,uuid,text,text,uuid),
  cc.user_category_plan_projection(cc.user_category_plans) FROM PUBLIC;