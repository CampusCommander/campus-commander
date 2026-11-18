-- K16: the category job worker (document B sections 6.2, 7.3, 7.4, and 9).
-- A confirmed category plan gives one `user-schema-change` job. This migration admits that kind in
-- the device admission order and under the one write slot, then adds the claim, the settlement, the
-- recovery, and the cancel rule of the one Google call that the job sends.
--
-- The job holds one call. The worker claims the plan, compares the fresh `etag` (C7), sends the one
-- part, and settles one outcome. A settle writes the schema cache in the same transaction as the
-- outcome, so the cache and the job never disagree (B section 9).

-- 1. The one attempt of the detail row. The device detail holds the same token and lease columns.
ALTER TABLE cc.user_schema_change_jobs
  ADD COLUMN dispatch_token uuid,
  ADD COLUMN dispatch_count integer NOT NULL DEFAULT 0 CHECK(dispatch_count>=0),
  ADD COLUMN start_deadline_at timestamptz,
  ADD COLUMN kestra_execution_id text,
  ADD COLUMN first_claimed_at timestamptz,
  ADD COLUMN attempt uuid,
  ADD COLUMN attempt_expires_at timestamptz,
  -- The Google reason of a failed call stays beside the job failure code, which holds one token
  -- (B section 7.3 "with the Google reason").
  ADD COLUMN failure_reason text CHECK(failure_reason IS NULL OR length(failure_reason) BETWEEN 1 AND 256);

-- 2. The three outcome codes of the category call join the job failure vocabulary (B section 7.3).
ALTER TABLE cc.jobs DROP CONSTRAINT jobs_failure_check;
ALTER TABLE cc.jobs ADD CONSTRAINT jobs_failure_check CHECK(failure IS NULL OR failure IN
  ('credential-rejected','delegation-not-authorized','api-not-enabled','policy-restricted','network-failure',
   'scope-mismatch','permission-denied','quota','provider-unavailable','invalid-response','wrong-customer',
   'request-failed','key-unavailable','interrupted','orchestration-unavailable','permission-changed',
   'connection-changed','storage-unavailable','inventory-unavailable','export-too-large','drive-unavailable',
   'sheet-write-failed','name-in-use','category-changed','not-found'));
CREATE OR REPLACE FUNCTION cc.job_failure_known(p_failure text) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT p_failure IN ('credential-rejected','delegation-not-authorized','api-not-enabled','policy-restricted',
    'network-failure','scope-mismatch','permission-denied','quota','provider-unavailable','invalid-response',
    'wrong-customer','request-failed','key-unavailable','interrupted','orchestration-unavailable',
    'permission-changed','connection-changed','storage-unavailable','inventory-unavailable','export-too-large',
    'drive-unavailable','sheet-write-failed','name-in-use','category-changed','not-found');
$$;

-- 3. The stop reason of the category job: the confirmer keeps `users:schema-manage`, and the
-- connection keeps its generation (B section 6.2 step 1). It mirrors cc.device_update_stop_reason.
CREATE FUNCTION cc.user_schema_change_stop_reason(p_customer text,p_confirmer uuid,p_version integer,
  p_generation integer) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT CASE
    WHEN NOT EXISTS(SELECT 1 FROM cc.application_principals p WHERE p.id=p_confirmer AND p.enabled AND
        p.permission_version=p_version) OR NOT EXISTS(SELECT 1 FROM cc.application_grants g
        WHERE g.principal_id=p_confirmer AND g.action='users:schema-manage' AND
        (g.scope='{"kind":"platform"}'::jsonb OR
        (g.scope->>'kind'='district' AND g.scope->>'customerId'=p_customer))) THEN 'permission-changed'
    WHEN NOT EXISTS(SELECT 1 FROM cc.google_connection c WHERE c.customer_id=p_customer AND
        c.generation=p_generation AND c.active) THEN 'connection-changed'
  END;
$$;

-- 4. The cache purge of B section 9. A removal drops one attribute name from every cached user.
-- A delete drops the whole category name. Both run inside the settlement transaction that writes
-- the schema cache.
CREATE FUNCTION cc.remove_user_attribute(p_customer text,p_schema_name text,p_field_name text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  UPDATE cc.users u SET custom_schemas=jsonb_set(u.custom_schemas,ARRAY[p_schema_name],
      (u.custom_schemas->p_schema_name)-p_field_name)
    WHERE u.customer_id=p_customer AND u.custom_schemas ? p_schema_name
      AND u.custom_schemas->p_schema_name ? p_field_name;
$$;
CREATE FUNCTION cc.remove_user_category(p_customer text,p_schema_name text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  UPDATE cc.users u SET custom_schemas=u.custom_schemas-p_schema_name
    WHERE u.customer_id=p_customer AND u.custom_schemas ? p_schema_name;
$$;
-- C12: after an edit makes one attribute multi-valued, each cached single value becomes a list of
-- one entry. The write runs in the transaction of the schema cache write.
CREATE FUNCTION cc.widen_user_attribute(p_customer text,p_schema_name text,p_field_name text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  UPDATE cc.users u SET custom_schemas=jsonb_set(u.custom_schemas,ARRAY[p_schema_name,p_field_name],
      jsonb_build_array(u.custom_schemas->p_schema_name->p_field_name))
    WHERE u.customer_id=p_customer AND u.custom_schemas ? p_schema_name
      AND u.custom_schemas->p_schema_name ? p_field_name
      AND jsonb_typeof(u.custom_schemas->p_schema_name->p_field_name) NOT IN ('array','null');
$$;

-- 5. One schema observation: the cached row and every purge that the observation implies (B
-- section 9, C12). The caller holds the category advisory lock and the settlement transaction.
CREATE FUNCTION cc.store_user_attribute_category(p_customer text,p_schema jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE previous jsonb; schema_name text; removed jsonb; widened jsonb;
BEGIN
  IF jsonb_typeof(p_schema) IS DISTINCT FROM 'object' OR
    jsonb_typeof(p_schema->'schemaId') IS DISTINCT FROM 'string' OR
    jsonb_typeof(p_schema->'schemaName') IS DISTINCT FROM 'string' OR
    jsonb_typeof(p_schema->'displayName') IS DISTINCT FROM 'string' OR
    jsonb_typeof(p_schema->'fields') IS DISTINCT FROM 'array' OR
    jsonb_array_length(p_schema->'fields') NOT BETWEEN 1 AND 100 OR
    (p_schema ? 'etag' AND jsonb_typeof(p_schema->'etag') NOT IN ('string','null')) THEN
    RAISE EXCEPTION 'The category observation is invalid.' USING ERRCODE='22023';
  END IF;
  schema_name:=p_schema->>'schemaName';
  SELECT c.fields INTO previous FROM cc.user_attribute_categories c
    WHERE c.customer_id=p_customer AND c.schema_id=p_schema->>'schemaId';
  -- A removed attribute is one cached field name that the new observation does not hold.
  IF previous IS NOT NULL THEN
    SELECT jsonb_agg(DISTINCT old_field->>'fieldName') INTO removed
      FROM jsonb_array_elements(previous) old_field
      WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_schema->'fields') new_field
        WHERE new_field->>'fieldName'=old_field->>'fieldName');
    FOR schema_name IN SELECT jsonb_array_elements_text(COALESCE(removed,'[]'::jsonb)) LOOP
      PERFORM cc.remove_user_attribute(p_customer,p_schema->>'schemaName',schema_name);
    END LOOP;
    -- C12: a kept field that turns multi-valued wraps the single value of every cached user.
    FOR widened IN SELECT new_field FROM jsonb_array_elements(p_schema->'fields') new_field
        WHERE COALESCE((new_field->>'multiValued')::boolean,false)
          AND EXISTS(SELECT 1 FROM jsonb_array_elements(previous) old_field
            WHERE old_field->>'fieldId'=new_field->>'fieldId'
              AND NOT COALESCE((old_field->>'multiValued')::boolean,false)) LOOP
      PERFORM cc.widen_user_attribute(p_customer,p_schema->>'schemaName',widened->>'fieldName');
    END LOOP;
  END IF;
  INSERT INTO cc.user_attribute_categories(customer_id,schema_id,schema_name,display_name,etag,fields,read_at)
    VALUES(p_customer,p_schema->>'schemaId',p_schema->>'schemaName',p_schema->>'displayName',
      CASE WHEN jsonb_typeof(p_schema->'etag')='string' THEN p_schema->>'etag' END,
      p_schema->'fields',clock_timestamp())
  ON CONFLICT(customer_id,schema_id) DO UPDATE SET schema_name=EXCLUDED.schema_name,
    display_name=EXCLUDED.display_name,etag=EXCLUDED.etag,fields=EXCLUDED.fields,read_at=EXCLUDED.read_at;
END;
$$;

-- 6. One `schemas.list` answer replaces the cached set. A failed call refreshes the cache with this
-- helper, so the next plan compares the current Google state (C6, C7). It mirrors
-- cc.replace_user_attribute_categories without the actor gate, because the worker holds no actor.
CREATE FUNCTION cc.store_user_attribute_categories(p_customer text,p_categories jsonb,
  p_read_at timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE item jsonb;
BEGIN
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
  INSERT INTO cc.user_attribute_category_state(customer_id,read_at) VALUES(p_customer,p_read_at)
  ON CONFLICT(customer_id) DO UPDATE SET read_at=EXCLUDED.read_at;
  DELETE FROM cc.user_attribute_categories WHERE customer_id=p_customer;
  INSERT INTO cc.user_attribute_categories(customer_id,schema_id,schema_name,display_name,etag,fields,read_at)
    SELECT p_customer,e.value->>'schemaId',e.value->>'schemaName',e.value->>'displayName',
      CASE WHEN jsonb_typeof(e.value->'etag')='string' THEN e.value->>'etag' END,
      e.value->'fields',p_read_at
    FROM jsonb_array_elements(p_categories) e;
END;
$$;

-- 7. The admission of 017 admits the category kind in the same order and under the same write slot.
-- The device candidates take the same path as before, and the category job locks its own detail row.
CREATE OR REPLACE FUNCTION cc.admit_device_update_job(p_customer text,p_held boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; candidates cc.jobs[]:='{}'; admitted jsonb:=NULL; now_at timestamptz; running boolean;
  token uuid; label text; awaited uuid; waiting boolean;
BEGIN
  -- S2: the admission holds no fence without its customer. A null hold flag rejects before any lock, so an
  -- unknown hold state never admits a job (section 6.5 step 1: admission fails closed).
  IF p_customer IS NULL OR p_held IS NULL THEN
    RAISE EXCEPTION 'The device update job does not exist.' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cc.job-admission:'||p_customer)::bigint);
  -- S1: every pending header locks first, in admission order.
  FOR job IN SELECT j.* FROM cc.jobs j WHERE j.customer_id=p_customer AND j.kind IN ('device-update','device-command','device-status','user-schema-change')
      AND j.status IN ('accepted','queued','held') ORDER BY j.target_count,j.created_at,j.display_id FOR UPDATE LOOP
    candidates:=candidates||job;
  END LOOP;
  -- S1 (round 3, R2-F3): the clock reads after every header wait, before the validation and before the
  -- detail lock, on every path. The admitted path reads it again after its detail wait below.
  now_at:=clock_timestamp();
  -- S1 (round 2): the one-running flag reads after every header wait, so a job that ended in a wait
  -- leaves the write slot free for this admission. The category kind holds the same write slot (E8).
  SELECT EXISTS(SELECT 1 FROM cc.jobs j WHERE j.customer_id=p_customer AND j.kind IN ('device-update','device-command','device-status','user-schema-change') AND j.status='running')
    INTO running;
  -- S1 (round 3): a status change publishes, and the publication row references the connection row. A
  -- credential read holds that row FOR UPDATE (008), so the connection row locks here, after the validation,
  -- and no publication insert waits on it. After that wait the clock and the one-running flag read again.
  IF cardinality(candidates)>0 THEN
    PERFORM 1 FROM cc.google_connection c WHERE c.customer_id=p_customer FOR KEY SHARE;
    now_at:=clock_timestamp();
    SELECT EXISTS(SELECT 1 FROM cc.jobs j WHERE j.customer_id=p_customer AND j.kind IN ('device-update','device-command','device-status','user-schema-change') AND
      j.status='running') INTO running;
  END IF;
  label:=CASE WHEN p_held THEN 'held' ELSE 'queued' END;
  FOREACH job IN ARRAY candidates LOOP
    -- A status job of an import plan waits for its update job (design section 3, "The wait"). The
    -- awaited header reads without a lock, and final means a finished status, cancelled included.
    -- A candidate that still waits keeps the queue and never takes the write slot or the dispatch.
    -- A category job holds no awaited job, so the read finds no row and the candidate never waits.
    SELECT u.wait_for_job_id INTO awaited FROM cc.device_update_jobs u WHERE u.job_id=job.job_id;
    waiting:=awaited IS NOT NULL AND NOT EXISTS(SELECT 1 FROM cc.jobs w WHERE w.job_id=awaited AND
      w.finished_at IS NOT NULL);
    IF waiting THEN
      -- The unfinished dependency decides before the hold flag: a candidate that still waits keeps the
      -- queue and never takes the write slot, the dispatch, or the held label (design section 3, "The
      -- wait"; review round 1, R5).
      IF job.status<>'queued' THEN
        UPDATE cc.jobs SET status='queued' WHERE job_id=job.job_id;
        PERFORM cc.record_job_change(job.job_id,true);
      END IF;
    ELSIF running OR p_held THEN
      IF job.status<>label THEN
        UPDATE cc.jobs SET status=label WHERE job_id=job.job_id;
        PERFORM cc.record_job_change(job.job_id,true);
      END IF;
    ELSIF admitted IS NULL THEN
      -- S1: the detail row locks after the validation. The clock reads again after the header, connection, and
      -- detail waits, so a long wait never consumes the start window (round 2, round 3).
      IF job.kind='user-schema-change' THEN
        PERFORM 1 FROM cc.user_schema_change_jobs u WHERE u.job_id=job.job_id FOR UPDATE;
      ELSE
        PERFORM 1 FROM cc.device_update_jobs u WHERE u.job_id=job.job_id FOR UPDATE;
      END IF;
      now_at:=clock_timestamp();
      UPDATE cc.jobs SET status='running',admitted_at=now_at WHERE job_id=job.job_id;
      IF job.kind='user-schema-change' THEN
        UPDATE cc.user_schema_change_jobs SET dispatch_token=gen_random_uuid(),dispatch_count=1,
          start_deadline_at=now_at+interval '120 seconds' WHERE job_id=job.job_id RETURNING dispatch_token INTO token;
      ELSE
        UPDATE cc.device_update_jobs SET dispatch_token=gen_random_uuid(),dispatch_count=1,
          start_deadline_at=now_at+interval '120 seconds' WHERE job_id=job.job_id RETURNING dispatch_token INTO token;
      END IF;
      PERFORM cc.record_job_change(job.job_id,true);
      admitted:=jsonb_build_object('jobId',job.job_id,'displayId',job.display_id,'dispatchToken',token,
        'correlationId',job.correlation_id,'targetCount',job.target_count,'kind',job.kind);
    ELSE
      UPDATE cc.jobs SET status='queued' WHERE job_id=job.job_id;
      PERFORM cc.record_job_change(job.job_id,true);
    END IF;
  END LOOP;
  RETURN admitted;
END;
$$;

-- 8. The admit record of the job service (design section 5.3). Only the admitted token records.
CREATE FUNCTION cc.record_user_schema_change_start(p_customer text,p_job uuid,p_token uuid,p_execution text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE detail cc.user_schema_change_jobs;
BEGIN
  IF p_customer IS NULL OR p_job IS NULL OR p_token IS NULL OR p_execution IS NULL THEN
    RAISE EXCEPTION 'The category job start is invalid.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO detail FROM cc.user_schema_change_jobs u WHERE u.job_id=p_job FOR UPDATE;
  IF detail.job_id IS NULL OR detail.dispatch_token IS DISTINCT FROM p_token THEN RETURN; END IF;
  UPDATE cc.user_schema_change_jobs SET kestra_execution_id=p_execution WHERE job_id=p_job;
END;
$$;
-- A 4xx start refusal ends the job Failed `orchestration-unavailable`, as the device start does.
-- The job service then admits the next candidate (design section 6.5).
CREATE FUNCTION cc.abandon_user_schema_change_start(p_customer text,p_job uuid,p_token uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.user_schema_change_jobs; now_at timestamptz;
BEGIN
  IF p_customer IS NULL OR p_job IS NULL OR p_token IS NULL THEN
    RAISE EXCEPTION 'The category job start is invalid.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  IF job.job_id IS NULL OR job.kind<>'user-schema-change' THEN RETURN; END IF;
  now_at:=clock_timestamp();
  -- S3: a terminal job and a superseded call change nothing.
  SELECT * INTO detail FROM cc.user_schema_change_jobs u WHERE u.job_id=p_job;
  IF detail.job_id IS NULL OR job.status<>'running' OR job.finished_at IS NOT NULL OR
    detail.dispatch_token IS DISTINCT FROM p_token OR detail.first_claimed_at IS NOT NULL THEN
    RETURN;
  END IF;
  SELECT * INTO detail FROM cc.user_schema_change_jobs u WHERE u.job_id=p_job FOR UPDATE;
  now_at:=clock_timestamp();
  IF detail.job_id IS NULL OR job.status<>'running' OR job.finished_at IS NOT NULL OR
    detail.dispatch_token IS DISTINCT FROM p_token OR detail.first_claimed_at IS NOT NULL THEN
    RETURN;
  END IF;
  PERFORM 1 FROM cc.google_connection c WHERE c.customer_id=p_customer FOR KEY SHARE;
  UPDATE cc.jobs SET status='failed',failed=1,failure='orchestration-unavailable',finished_at=now_at
    WHERE job_id=p_job;
  PERFORM cc.record_job_change(p_job,true);
END;
$$;

-- 9. The claim of the one call. It fences the attempt, revalidates the confirmer and the connection,
-- and answers the plan, the frozen body, and the encrypted credential (B section 6.2 step 1).
-- A claim that finds the job stopped settles Failed and answers `stopped`. A repeated claim of a
-- claimed job answers `resume`, because a POST is never sent twice (B section 7.3).
CREATE FUNCTION cc.claim_user_schema_change(p_customer text,p_job uuid,p_token uuid,p_attempt uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.user_schema_change_jobs; plan cc.user_category_plans;
  connection cc.google_connection; envelope jsonb; now_at timestamptz; stopped text;
BEGIN
  IF p_customer IS NULL OR p_job IS NULL OR p_token IS NULL OR p_attempt IS NULL THEN
    RAISE EXCEPTION 'The category job attempt is fenced.' USING DETAIL='attempt-fenced';
  END IF;
  -- Rule G: the credential read below reaches the global access lock, so the claim takes it first.
  PERFORM pg_advisory_xact_lock(7240173008);
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  IF job.job_id IS NULL OR job.kind<>'user-schema-change' THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  SELECT * INTO detail FROM cc.user_schema_change_jobs u WHERE u.job_id=p_job FOR UPDATE;
  now_at:=clock_timestamp();
  IF job.status<>'running' OR job.finished_at IS NOT NULL OR detail.job_id IS NULL OR
    detail.dispatch_token IS DISTINCT FROM p_token THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  SELECT * INTO plan FROM cc.user_category_plans p WHERE p.plan_id=detail.plan_id;
  IF plan.plan_id IS NULL THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  -- A recorded job failure is the first stop reason, as the device claim holds it (B2c ruling 4).
  stopped:=COALESCE(job.failure,cc.user_schema_change_stop_reason(p_customer,detail.confirmed_by,
    detail.confirmer_permission_version,job.generation));
  IF stopped IS NULL THEN
    connection:=cc.google_current_generation(p_customer,job.generation);
    stopped:=cc.user_schema_change_stop_reason(p_customer,detail.confirmed_by,
      detail.confirmer_permission_version,job.generation);
  END IF;
  now_at:=clock_timestamp();
  IF stopped IS NOT NULL THEN
    PERFORM 1 FROM cc.application_principals p WHERE p.id=job.requested_by FOR KEY SHARE;
    PERFORM 1 FROM cc.google_connection c WHERE c.customer_id=p_customer FOR KEY SHARE;
    UPDATE cc.jobs SET status='failed',failed=1,failure=stopped,finished_at=now_at WHERE job_id=p_job;
    PERFORM cc.record_job_change(p_job,true);
    RETURN jsonb_build_object('outcome','stopped','failure',stopped);
  END IF;
  SELECT c.envelope INTO envelope FROM cc.google_credentials c WHERE c.id=connection.credential_id;
  IF envelope IS NULL THEN
    PERFORM 1 FROM cc.google_connection c WHERE c.customer_id=p_customer FOR KEY SHARE;
    UPDATE cc.jobs SET status='failed',failed=1,failure='key-unavailable',finished_at=now_at WHERE job_id=p_job;
    PERFORM cc.record_job_change(p_job,true);
    RETURN jsonb_build_object('outcome','stopped','failure','key-unavailable');
  END IF;
  UPDATE cc.user_schema_change_jobs SET attempt=p_attempt,attempt_expires_at=now_at+interval '10 minutes',
    first_claimed_at=COALESCE(first_claimed_at,now_at) WHERE job_id=p_job;
  UPDATE cc.jobs SET started_at=COALESCE(started_at,now_at) WHERE job_id=p_job;
  RETURN jsonb_build_object('outcome','claimed','generation',connection.generation,
    'credentialId',connection.credential_id,'envelope',envelope,'action',plan.action,
    'schemaId',plan.schema_id,'schemaName',plan.schema_name,'body',plan.body,
    'baseEtag',plan.base_etag,'planId',plan.plan_id,
    -- A second claim of a job whose call already left only reads Google back.
    'resume',detail.first_claimed_at IS NOT NULL);
END;
$$;

-- 10. The settlement of the one call. It applies the job outcome and the schema cache write in one
-- transaction (B section 9), and purges the removed attributes of a removal or a delete.
-- A stale attempt is fenced and writes nothing.
CREATE FUNCTION cc.settle_user_schema_change(p_customer text,p_job uuid,p_token uuid,p_attempt uuid,
  p_outcome text,p_failure text DEFAULT NULL,p_reason text DEFAULT NULL,p_schema jsonb DEFAULT NULL,
  p_categories jsonb DEFAULT NULL,p_observed_at timestamptz DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.user_schema_change_jobs; plan cc.user_category_plans; now_at timestamptz;
BEGIN
  IF p_customer IS NULL OR p_job IS NULL OR p_token IS NULL OR p_attempt IS NULL OR p_observed_at IS NULL OR
    p_outcome IS NULL OR p_outcome NOT IN ('succeeded','failed','unknown') OR
    (p_failure IS NOT NULL AND NOT cc.job_failure_known(p_failure)) OR
    (p_failure IS NOT NULL AND p_outcome NOT IN ('failed','unknown')) OR
    (p_reason IS NOT NULL AND (p_outcome NOT IN ('failed','unknown') OR char_length(p_reason)>256)) OR
    (p_schema IS NOT NULL AND jsonb_typeof(p_schema) IS DISTINCT FROM 'object') OR
    (p_categories IS NOT NULL AND jsonb_typeof(p_categories) IS DISTINCT FROM 'array') THEN
    RAISE EXCEPTION 'The category settlement is invalid.' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(7240173008);
  -- The category set lock serializes this cache write with the category read route (021).
  PERFORM pg_advisory_xact_lock(hashtext('cc:user_attribute_categories'),hashtext(p_customer));
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  IF job.job_id IS NULL OR job.kind<>'user-schema-change' THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  SELECT * INTO detail FROM cc.user_schema_change_jobs u WHERE u.job_id=p_job FOR UPDATE;
  now_at:=clock_timestamp();
  IF job.status<>'running' OR job.finished_at IS NOT NULL OR detail.job_id IS NULL OR
    detail.dispatch_token IS DISTINCT FROM p_token OR detail.attempt IS DISTINCT FROM p_attempt THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  SELECT * INTO plan FROM cc.user_category_plans p WHERE p.plan_id=detail.plan_id;
  PERFORM 1 FROM cc.google_connection c WHERE c.customer_id=p_customer FOR KEY SHARE;
  -- A refreshed set from a failed call replaces the cache before the outcome (C6).
  IF p_categories IS NOT NULL THEN
    PERFORM cc.store_user_attribute_categories(p_customer,p_categories,p_observed_at);
  END IF;
  -- A delete that succeeded leaves the cache and purges the whole category from every cached user.
  IF p_outcome='succeeded' AND plan.action='delete-category' THEN
    DELETE FROM cc.user_attribute_categories c
      WHERE c.customer_id=p_customer AND c.schema_id=plan.schema_id;
    PERFORM cc.remove_user_category(p_customer,plan.schema_name);
    INSERT INTO cc.user_attribute_category_state(customer_id,read_at) VALUES(p_customer,p_observed_at)
    ON CONFLICT(customer_id) DO UPDATE SET read_at=EXCLUDED.read_at;
  ELSIF p_schema IS NOT NULL THEN
    -- The answered schema of an insert or an update, and the fresh schema of a changed category.
    PERFORM cc.store_user_attribute_category(p_customer,p_schema);
  END IF;
  IF p_outcome='succeeded' THEN
    UPDATE cc.jobs SET status='completed',succeeded=1,finished_at=now_at WHERE job_id=p_job;
  ELSIF p_outcome='failed' THEN
    UPDATE cc.jobs SET status='failed',failed=1,failure=p_failure,finished_at=now_at WHERE job_id=p_job;
    UPDATE cc.user_schema_change_jobs SET failure_reason=p_reason WHERE job_id=p_job;
  ELSE
    -- An unanswered call may have applied. The job holds needs-review, and the schema state above
    -- stays as the worker observed it (B section 7.3). The Google reason explains the answer.
    UPDATE cc.jobs SET status='needs-review',unknown=1,failure=p_failure,finished_at=now_at WHERE job_id=p_job;
    UPDATE cc.user_schema_change_jobs SET failure_reason=p_reason WHERE job_id=p_job;
  END IF;
  PERFORM cc.record_job_change(p_job,true);
  RETURN jsonb_build_object('outcome','settled','status',(SELECT j.status FROM cc.jobs j WHERE j.job_id=p_job));
END;
$$;

-- 11. The recovery of the job service (design section 5.3). A running job that never claimed and
-- passed its start window gets one new start, up to 3. A claimed call whose attempt lease lapsed
-- lost its runner: the call may have applied, so the job ends needs-review with `interrupted`.
CREATE FUNCTION cc.recover_user_schema_change_jobs(p_customer text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.user_schema_change_jobs; now_at timestamptz; token uuid;
  candidates cc.jobs[]:='{}'; starts jsonb:='[]'::jsonb;
BEGIN
  IF p_customer IS NULL THEN
    RAISE EXCEPTION 'The category job recovery is invalid.' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cc.job-admission:'||p_customer)::bigint);
  FOR job IN SELECT j.* FROM cc.jobs j WHERE j.customer_id=p_customer AND j.kind='user-schema-change'
      AND j.status='running' AND j.finished_at IS NULL ORDER BY j.target_count,j.created_at,j.display_id
      FOR UPDATE LOOP
    candidates:=candidates||job;
  END LOOP;
  IF cardinality(candidates)>0 THEN
    PERFORM 1 FROM cc.google_connection c WHERE c.customer_id=p_customer FOR KEY SHARE;
  END IF;
  FOREACH job IN ARRAY candidates LOOP
    SELECT * INTO detail FROM cc.user_schema_change_jobs u WHERE u.job_id=job.job_id FOR UPDATE;
    now_at:=clock_timestamp();
    IF detail.first_claimed_at IS NOT NULL THEN
      IF detail.attempt IS NOT NULL AND detail.attempt_expires_at IS NOT NULL AND detail.attempt_expires_at<=now_at THEN
        UPDATE cc.jobs SET status='needs-review',unknown=1,failure='interrupted',finished_at=now_at
          WHERE job_id=job.job_id;
        PERFORM cc.record_job_change(job.job_id,true);
      END IF;
    ELSIF detail.start_deadline_at IS NOT NULL AND detail.start_deadline_at<=now_at THEN
      IF detail.dispatch_count>=3 THEN
        UPDATE cc.jobs SET status='failed',failed=1,failure='orchestration-unavailable',finished_at=now_at
          WHERE job_id=job.job_id;
        PERFORM cc.record_job_change(job.job_id,true);
      ELSE
        UPDATE cc.user_schema_change_jobs SET dispatch_token=gen_random_uuid(),
          dispatch_count=dispatch_count+1,start_deadline_at=now_at+interval '120 seconds'
          WHERE job_id=job.job_id RETURNING dispatch_token INTO token;
        starts:=starts||jsonb_build_object('jobId',job.job_id,'displayId',job.display_id,
          'dispatchToken',token,'correlationId',job.correlation_id,'targetCount',job.target_count,
          'kind',job.kind);
        PERFORM cc.record_job_change(job.job_id,true);
      END IF;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('starts',starts);
END;
$$;

-- 12. The cancel rule of B section 7.4. A category job that never claimed ends at once. After its
-- one call leaves, the call cannot stop, and the request answers `nothing-to-stop`.
-- This is the 020 definition with one detail lock and one decision branch for the category kind.
CREATE OR REPLACE FUNCTION cc.request_job_cancel(p_actor uuid,p_version integer,p_customer text,p_display_id text,
  p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.device_update_jobs; now_at timestamptz; request_at timestamptz;
  pending integer; dispatched integer;
  stop_now boolean:=false; claimed_at timestamptz; waiting_jobs cc.jobs[]:='{}'; waiting_job cc.jobs;
  waiting_detail cc.device_update_jobs; schema_detail cc.user_schema_change_jobs;
BEGIN
  -- S2: a null identifier never matches a header.
  IF p_actor IS NULL OR p_customer IS NULL OR p_display_id IS NULL OR p_correlation IS NULL THEN
    RAISE EXCEPTION 'The cancel request is invalid.' USING ERRCODE='22023';
  END IF;
  -- Lock order (section 2 table): the admission lock first, as admission and hold cleanup take it.
  PERFORM pg_advisory_xact_lock(hashtext('cc.job-admission:'||p_customer)::bigint);
  -- The kind and the scope never change after creation, so this unlocked read only chooses the lock order.
  -- Every decision below reads the row under its lock.
  SELECT * INTO job FROM cc.jobs j WHERE j.customer_id=p_customer AND j.display_id=p_display_id;
  IF job.job_id IS NULL THEN
    RAISE EXCEPTION 'The job does not exist.' USING DETAIL='job-not-found';
  END IF;
  IF job.scope_kind='all-devices' AND job.entity_type='user' THEN
    -- A user full sync holds its state row first, as its claim, its lease, and its finish do (020).
    PERFORM 1 FROM cc.user_sync_state s WHERE s.customer_id=p_customer FOR UPDATE;
  ELSIF job.scope_kind='all-devices' THEN
    -- A device full sync holds its state row first, as its claim, its lease, its finish, and its abandon do (016).
    PERFORM 1 FROM cc.device_sync_state s WHERE s.customer_id=p_customer FOR UPDATE;
  END IF;
  -- The header locks second on every path, as every write-job and refresh writer takes it.
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=job.job_id AND j.customer_id=p_customer FOR UPDATE;
  -- A selected-device refresh locks its detail row after the header, as the batch finish does (016).
  IF job.scope_kind='devices' AND job.kind='inventory-refresh' THEN
    PERFORM 1 FROM cc.entity_sync_jobs u WHERE u.job_id=job.job_id FOR UPDATE;
  END IF;
  -- A file job locks its detail row after the header, as its claim, lease, and finish do (design
  -- section 3).
  IF job.kind='device-export' THEN
    PERFORM 1 FROM cc.device_export_jobs e WHERE e.job_id=job.job_id FOR UPDATE;
  ELSIF job.kind='device-import' THEN
    PERFORM 1 FROM cc.device_import_jobs i WHERE i.job_id=job.job_id FOR UPDATE;
  -- A category job locks its detail row after the header, as its claim and settlement do.
  ELSIF job.kind='user-schema-change' THEN
    PERFORM 1 FROM cc.user_schema_change_jobs u WHERE u.job_id=job.job_id FOR UPDATE;
  END IF;
  -- The person sees the job, or the call answers as a missing job (017 cc.job_visible).
  IF NOT cc.job_visible(p_actor,p_version,p_customer,job.requested_by) THEN
    RAISE EXCEPTION 'The job does not exist.' USING DETAIL='job-not-found';
  END IF;
  -- The requester, a jobs:manage holder of the customer, or a platform administrator cancels (record:75).
  IF job.requested_by<>p_actor AND NOT EXISTS(SELECT 1 FROM cc.application_grants g
      WHERE g.principal_id=p_actor AND g.action='jobs:manage' AND
      (g.scope='{"kind":"platform"}'::jsonb OR
      (g.scope->>'kind'='district' AND g.scope->>'customerId'=p_customer))) THEN
    RAISE EXCEPTION 'The cancel is not permitted.' USING DETAIL='cancel-not-permitted';
  END IF;
  -- A request ends any job at once, so a header that holds one answers `repeated` and keeps the first
  -- person and time. A repeated request writes no second audit row.
  IF job.cancel_requested_at IS NOT NULL THEN
    RETURN jsonb_build_object('outcome','repeated');
  END IF;
  IF job.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'The job has finished.' USING DETAIL='job-finished';
  END IF;
  IF job.kind IN ('device-export','device-import') THEN
    -- A file job that never claimed ends at once. After its first claim the request stays and the
    -- worker stops at its next batch, then its finish ends the job (design section 3).
    claimed_at:=CASE job.kind WHEN 'device-export'
      THEN (SELECT e.first_claimed_at FROM cc.device_export_jobs e WHERE e.job_id=job.job_id)
      ELSE (SELECT i.first_claimed_at FROM cc.device_import_jobs i WHERE i.job_id=job.job_id) END;
    stop_now:=claimed_at IS NULL;
    -- A Sheet export that already stamped its Sheet offers nothing to stop, because a cancel cannot
    -- remove a Sheet (design section 6, `record:336`). The stamp holds the same header lock, so the two
    -- requests order one after the other and this read is the committed stamp.
    IF job.kind='device-export' AND (SELECT e.sheet_started_at FROM cc.device_export_jobs e
        WHERE e.job_id=job.job_id) IS NOT NULL THEN
      RAISE EXCEPTION 'The job holds no work to stop.' USING DETAIL='nothing-to-stop';
    END IF;
  ELSIF job.kind='user-schema-change' THEN
    -- B section 7.4: a category job holds one call. Before that call leaves, the request ends the job
    -- at once. After it leaves, the call cannot stop, so the request answers `nothing-to-stop`.
    SELECT * INTO schema_detail FROM cc.user_schema_change_jobs u WHERE u.job_id=job.job_id;
    IF schema_detail.first_claimed_at IS NOT NULL THEN
      RAISE EXCEPTION 'The job holds no work to stop.' USING DETAIL='nothing-to-stop';
    END IF;
    stop_now:=true;
  ELSIF job.kind<>'inventory-refresh' THEN
    -- The header lock holds every operation status: each writer of an operation status locks the header
    -- first (017 cc.settle_device_update_operations, cc.claim_device_update_verification).
    SELECT count(*) FILTER (WHERE o.status='pending'),count(*) FILTER (WHERE o.status='dispatched')
      INTO pending,dispatched
      FROM cc.device_update_operations o WHERE o.job_id=job.job_id;
    IF job.status='awaiting-devices' OR pending+dispatched=0 THEN
      RAISE EXCEPTION 'The job holds no work to stop.' USING DETAIL='nothing-to-stop';
    END IF;
    -- A job after its first claim changes only its header, and its worker settles the operations
    -- (section 3). The claim writes first_claimed_at under the header lock, so this read holds.
    SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=job.job_id;
    stop_now:=job.status<>'running' OR detail.first_claimed_at IS NULL;
    -- Lock order (section 2 table): the pending operations lock by number before the requester row and
    -- the connection row. The header lock is held, so the complete set never waits.
    IF stop_now THEN
      PERFORM 1 FROM cc.device_update_operations o WHERE o.job_id=job.job_id AND o.status='pending'
        ORDER BY o.operation_number FOR UPDATE;
    END IF;
    -- The waiting status jobs of an import's update job (design section 3, "The cancel"). Each waiting
    -- header locks after the update's operations, in display ID order (cancel design item 8), so a
    -- later-created job never overtakes an earlier display ID. Its pending operations lock after its
    -- header.
    IF job.kind='device-update' AND detail.import_job_id IS NOT NULL THEN
      FOR waiting_job IN SELECT w.* FROM cc.jobs w JOIN cc.device_update_jobs u ON u.job_id=w.job_id
          WHERE u.wait_for_job_id=job.job_id AND w.finished_at IS NULL
          ORDER BY w.display_id FOR UPDATE OF w LOOP
        waiting_jobs:=waiting_jobs||waiting_job;
        PERFORM 1 FROM cc.device_update_operations o WHERE o.job_id=waiting_job.job_id AND
          o.status='pending' ORDER BY o.operation_number FOR UPDATE;
      END LOOP;
    END IF;
  END IF;
  -- The request names the actor and the publication names the connection row. Those rows lock before the
  -- first write, the principal row before the connection row, as the credential functions take them.
  PERFORM 1 FROM cc.application_principals p WHERE p.id=p_actor FOR KEY SHARE;
  PERFORM 1 FROM cc.google_connection c WHERE c.customer_id=p_customer FOR KEY SHARE;
  -- The header lock holds job state. It holds neither the principal nor its grants, so an access change
  -- that committed during either wait above leaves the early checks stale (review round 1, P1). Both
  -- rules run again here, after the last blocking lock and before the first write, so a refused cancel
  -- changes nothing. They repeat the early reasons, so a refused person learns nothing about the job.
  -- A platform administrator holds jobs:manage at platform scope, so the grant covers that case.
  IF NOT cc.job_visible(p_actor,p_version,p_customer,job.requested_by) THEN
    RAISE EXCEPTION 'The job does not exist.' USING DETAIL='job-not-found';
  END IF;
  IF job.requested_by<>p_actor AND NOT EXISTS(SELECT 1 FROM cc.application_grants g
      WHERE g.principal_id=p_actor AND g.action='jobs:manage' AND
      (g.scope='{"kind":"platform"}'::jsonb OR
      (g.scope->>'kind'='district' AND g.scope->>'customerId'=p_customer))) THEN
    RAISE EXCEPTION 'The cancel is not permitted.' USING DETAIL='cancel-not-permitted';
  END IF;
  now_at:=clock_timestamp();
  -- The request time stays one value: the update job and each waiting status job store the same
  -- request, so a reader never sees two requests for one call.
  request_at:=now_at;
  UPDATE cc.jobs SET cancel_requested_at=request_at,cancel_requested_by=p_actor WHERE job_id=job.job_id;
  IF job.kind IN ('device-export','device-import') THEN
    -- A request that ends a file job before its first claim keeps no report. The cancelled count holds
    -- the rows left, at least 1, as the cancelled finish does (design section 3).
    IF stop_now THEN
      IF job.kind='device-import' THEN
        DELETE FROM cc.device_import_changes WHERE job_id=job.job_id;
        DELETE FROM cc.device_import_rejections WHERE job_id=job.job_id;
        DELETE FROM cc.device_import_warnings WHERE job_id=job.job_id;
      END IF;
      UPDATE cc.jobs SET status='cancelled',finished_at=now_at,
        cancelled=GREATEST(COALESCE(target_count,0)-succeeded,1) WHERE job_id=job.job_id;
    END IF;
  ELSIF job.kind='user-schema-change' THEN
    -- The one call never left. The job is finished, and its one operation counts cancelled.
    IF stop_now THEN
      UPDATE cc.jobs SET status='cancelled',finished_at=now_at,cancelled=1 WHERE job_id=job.job_id;
    END IF;
  ELSIF job.kind='inventory-refresh' THEN
    IF job.scope_kind='all-devices' AND job.entity_type='user' THEN
      -- The five sync columns clear, so the runner's stage, lease, and finish fence on a changed sync.
      -- The generation, the user count, and the failure stay.
      UPDATE cc.user_sync_state SET sync_id=NULL,sync_actor=NULL,sync_generation=NULL,sync_attempt=NULL,
        sync_expires_at=NULL WHERE customer_id=p_customer;
    ELSIF job.scope_kind='all-devices' THEN
      -- The five sync columns clear, so the runner's stage, lease, and finish fence on a changed sync.
      -- The generation, the device count, and the failure stay.
      UPDATE cc.device_sync_state SET sync_id=NULL,sync_actor=NULL,sync_generation=NULL,sync_attempt=NULL,
        sync_expires_at=NULL WHERE customer_id=p_customer;
    ELSE
      -- A selected-device refresh closes its detail row and keeps its batch records.
      UPDATE cc.entity_sync_jobs SET finished_at=now_at WHERE job_id=job.job_id;
    END IF;
    PERFORM cc.close_refresh_job(job.job_id,NULL);
  ELSE
    -- A job that never claimed stops at once: every pending operation settles Cancelled and the terminal
    -- rule ends the job. The pending set is already locked above, and the skip re-locks rows this call
    -- holds.
    IF stop_now THEN
      PERFORM cc.skip_device_update_pending(job.job_id,'cancelled');
      PERFORM cc.refresh_device_update_counters(job.job_id);
      -- The closure clock reads after the operation locks.
      now_at:=clock_timestamp();
      UPDATE cc.jobs SET status=cc.device_update_terminal_status(job.job_id),finished_at=now_at
      WHERE job_id=job.job_id;
    END IF;
    -- The same request lands on each waiting status job of an import's update job. Each one that never
    -- claimed ends at once with every operation Cancelled, and each affected job keeps one audit row
    -- for the one request (design section 3, "The cancel").
    FOREACH waiting_job IN ARRAY waiting_jobs LOOP
      UPDATE cc.jobs SET cancel_requested_at=request_at,cancel_requested_by=p_actor
      WHERE job_id=waiting_job.job_id;
      SELECT * INTO waiting_detail FROM cc.device_update_jobs u WHERE u.job_id=waiting_job.job_id;
      IF waiting_detail.first_claimed_at IS NULL THEN
        PERFORM cc.skip_device_update_pending(waiting_job.job_id,'cancelled');
        PERFORM cc.refresh_device_update_counters(waiting_job.job_id);
        UPDATE cc.jobs SET status=cc.device_update_terminal_status(waiting_job.job_id),finished_at=now_at
        WHERE job_id=waiting_job.job_id;
      END IF;
      PERFORM cc.record_job_change(waiting_job.job_id,true);
      -- One audit row for each waiting status job that this request ends or marks, with the request's
      -- actor and correlation ID, so a reader sees one request across the job group.
      INSERT INTO cc.security_events(id,actor_id,event,correlation_id,detail)
        VALUES(gen_random_uuid(),p_actor,'job-cancel-requested',p_correlation,waiting_job.display_id);
    END LOOP;
  END IF;
  PERFORM cc.record_job_change(job.job_id,true);
  -- One audit row per request. The display ID names the job, and the row holds no reason (section 2).
  INSERT INTO cc.security_events(id,actor_id,event,correlation_id,detail)
    VALUES(gen_random_uuid(),p_actor,'job-cancel-requested',p_correlation,job.display_id);
  RETURN jsonb_build_object('outcome','requested');
END;
$$;


REVOKE ALL ON FUNCTION cc.user_schema_change_stop_reason(text,uuid,integer,integer),
  cc.remove_user_attribute(text,text,text),
  cc.remove_user_category(text,text),
  cc.widen_user_attribute(text,text,text),
  cc.store_user_attribute_category(text,jsonb),
  cc.store_user_attribute_categories(text,jsonb,timestamptz),
  cc.record_user_schema_change_start(text,uuid,uuid,text),
  cc.abandon_user_schema_change_start(text,uuid,uuid),
  cc.claim_user_schema_change(text,uuid,uuid,uuid),
  cc.settle_user_schema_change(text,uuid,uuid,uuid,text,text,text,jsonb,jsonb,timestamptz),
  cc.recover_user_schema_change_jobs(text) FROM PUBLIC;