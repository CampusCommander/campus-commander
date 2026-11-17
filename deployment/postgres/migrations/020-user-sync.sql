-- The full user sync and the user refresh job (design card K7).
-- It mirrors the device sync of 016 with the typed read gate of 019: a user sync needs users:read.
-- Nothing is deleted. removed_at marks a user that Google no longer returns.

-- The state of one customer, as the API and the worker read it. It copies the device state without
-- telemetry (document A section 7).
CREATE FUNCTION cc.user_sync_projection(p_customer text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT jsonb_build_object('customerId',c.customer_id,'generation',c.generation,'status',x.status,
    'observedAt',s.observed_at,'userCount',COALESCE(s.user_count,0),
    'failure',CASE WHEN x.status='failed' THEN COALESCE(CASE WHEN s.sync_id IS NOT NULL THEN 'interrupted' END,s.failure) END,
    'startedAt',s.sync_started_at,'checkedAt',s.checked_at,
    'stale',COALESCE(s.observed_at IS NOT NULL AND
      (x.status='failed' OR s.observed_at<clock_timestamp()-interval '24 hours'),false))
  FROM cc.google_connection c
  LEFT JOIN cc.user_sync_state s ON s.customer_id=c.customer_id
  CROSS JOIN LATERAL (SELECT CASE
    WHEN s.sync_id IS NOT NULL AND s.sync_expires_at>clock_timestamp() THEN 'running'
    WHEN s.sync_id IS NOT NULL OR s.failure IS NOT NULL THEN 'failed'
    WHEN s.observed_at IS NOT NULL THEN 'ready'
    ELSE 'never' END AS status) x
  WHERE c.customer_id=p_customer;
$$;

-- Refresh Users starts one full user sync under a lease. The gate accepts users:read only
-- (document A section 8). The lock order repeats cc.request_device_sync of 016.
CREATE FUNCTION cc.request_user_sync(p_actor uuid,p_version integer,p_customer text,p_generation integer,
  p_id uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection; prior cc.user_sync_state; header record; now_at timestamptz;
BEGIN
  connection:=cc.entity_job_reader(p_actor,p_version,'user');
  IF connection.customer_id IS DISTINCT FROM p_customer OR connection.generation IS DISTINCT FROM p_generation OR
    connection.active IS NOT TRUE THEN
    RAISE EXCEPTION 'The Google connection changed.' USING DETAIL='connection-changed';
  END IF;
  IF p_id IS NULL OR p_correlation IS NULL THEN
    RAISE EXCEPTION 'The sync identifier is required.' USING ERRCODE='22023';
  END IF;
  -- S1 (B2b round 2): the first request of a customer creates the state row, and the customer key of that
  -- row takes the connection KEY SHARE lock. The requester principal row locks before the state insert.
  PERFORM 1 FROM cc.application_principals p WHERE p.id=p_actor FOR KEY SHARE;
  INSERT INTO cc.user_sync_state(customer_id) VALUES(p_customer) ON CONFLICT(customer_id) DO NOTHING;
  SELECT * INTO prior FROM cc.user_sync_state WHERE customer_id=p_customer FOR UPDATE;
  -- S1: the sync state row locks first. The customer-scoped header of the sync it replaces locks second,
  -- and a missing header rejects at once.
  IF prior.sync_id IS NOT NULL THEN
    SELECT * INTO header FROM cc.jobs j WHERE j.job_id=prior.sync_id AND j.customer_id=p_customer FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'The user sync expired or changed.' USING DETAIL='user-sync-changed';
    END IF;
  END IF;
  -- S1: the new header references the requester and the replaced sync actor, and the header and the
  -- publications reference the connection row. The principal rows lock before the connection row.
  PERFORM 1 FROM cc.application_principals p WHERE p.id=prior.sync_actor FOR KEY SHARE;
  PERFORM 1 FROM cc.google_connection c WHERE c.customer_id=p_customer FOR KEY SHARE;
  now_at:=clock_timestamp();
  connection:=cc.entity_job_reader(p_actor,p_version,'user');
  IF connection.customer_id IS DISTINCT FROM p_customer OR connection.generation IS DISTINCT FROM p_generation OR
    connection.active IS NOT TRUE THEN
    RAISE EXCEPTION 'The Google connection changed.' USING DETAIL='connection-changed';
  END IF;
  IF prior.sync_id IS NOT NULL AND prior.sync_expires_at>now_at THEN
    RAISE EXCEPTION 'A user sync is running.' USING DETAIL='user-sync-running';
  END IF;
  -- The header records every Refresh Users with its requester. The sync ID is the header ID.
  INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,status,requested_by,generation,
    correlation_id,created_at,started_at)
  VALUES(p_id,cc.job_display_id('REF',nextval('cc.job_number_ref')),p_customer,'inventory-refresh','all-devices',
    'running',p_actor,p_generation,p_correlation,now_at,now_at);
  UPDATE cc.user_sync_state SET
    failure=CASE WHEN prior.sync_id IS NOT NULL THEN 'interrupted' ELSE failure END,
    failure_requested_by=CASE WHEN prior.sync_id IS NOT NULL THEN prior.sync_actor ELSE failure_requested_by END,
    checked_at=CASE WHEN prior.sync_id IS NOT NULL THEN prior.sync_expires_at ELSE checked_at END,
    sync_id=p_id,sync_actor=p_actor,sync_generation=p_generation,sync_attempt=NULL,
    sync_started_at=now_at,sync_expires_at=now_at+interval '2 minutes',correlation_id=p_correlation
  WHERE customer_id=p_customer;
  -- A request that replaces an expired sync closes its header as interrupted.
  IF prior.sync_id IS NOT NULL THEN PERFORM cc.close_refresh_job(prior.sync_id,'interrupted'); END IF;
  PERFORM cc.record_job_change(p_id,true);
  RETURN cc.user_sync_projection(p_customer);
END;
$$;

CREATE FUNCTION cc.claim_user_sync(p_customer text,p_id uuid,p_attempt uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE pending cc.user_sync_state; header record; connection cc.google_connection; now_at timestamptz;
BEGIN
  -- S2: the fence rejects a null identifier, token, or attempt explicitly.
  IF p_customer IS NULL OR p_id IS NULL OR p_attempt IS NULL THEN
    RAISE EXCEPTION 'The user sync expired or changed.' USING DETAIL='user-sync-changed';
  END IF;
  -- Rule G: advisory lock 7240173008 is the global access lock. The generation helper below takes it,
  -- so the claim takes it first, before any row lock.
  PERFORM pg_advisory_xact_lock(7240173008);
  SELECT * INTO pending FROM cc.user_sync_state WHERE customer_id=p_customer FOR UPDATE;
  -- S1: the state row locks first, the scoped header second, and the clock third.
  SELECT * INTO header FROM cc.jobs j WHERE j.job_id=p_id AND j.customer_id=p_customer FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The user sync expired or changed.' USING DETAIL='user-sync-changed';
  END IF;
  now_at:=clock_timestamp();
  IF header.status<>'running' OR header.finished_at IS NOT NULL OR
    pending.sync_id IS DISTINCT FROM p_id OR pending.sync_expires_at IS NULL OR pending.sync_expires_at<=now_at THEN
    RAISE EXCEPTION 'The user sync expired or changed.' USING DETAIL='user-sync-changed';
  END IF;
  IF pending.sync_attempt IS NOT NULL AND pending.sync_attempt<>p_attempt THEN
    RAISE EXCEPTION 'Another worker claimed this user sync.' USING DETAIL='user-sync-claimed';
  END IF;
  connection:=cc.google_current_generation(p_customer,pending.sync_generation);
  -- S1 rule 6: the generation helper waits on the advisory lock and the connection row. After those
  -- waits the clock reads again, and the lease repeats before the claim writes its attempt.
  now_at:=clock_timestamp();
  IF pending.sync_expires_at<=now_at THEN
    RAISE EXCEPTION 'The user sync expired or changed.' USING DETAIL='user-sync-changed';
  END IF;
  UPDATE cc.user_sync_state SET sync_attempt=p_attempt,sync_expires_at=now_at+interval '10 minutes'
  WHERE customer_id=p_customer;
  RETURN jsonb_build_object('generation',connection.generation,'credentialId',connection.credential_id,
    'envelope',(SELECT envelope FROM cc.google_credentials WHERE id=connection.credential_id));
END;
$$;

CREATE FUNCTION cc.user_sync_lease(p_customer text,p_id uuid,p_attempt uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE pending cc.user_sync_state; header record; now_at timestamptz;
BEGIN
  SELECT * INTO pending FROM cc.user_sync_state s WHERE s.customer_id=p_customer FOR UPDATE;
  -- S1: the state row locks first, the scoped header second, and the clock third.
  SELECT * INTO header FROM cc.jobs j WHERE j.job_id=p_id AND j.customer_id=p_customer FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The user sync expired or changed.' USING DETAIL='user-sync-changed';
  END IF;
  now_at:=clock_timestamp();
  IF header.status<>'running' OR header.finished_at IS NOT NULL OR
    p_id IS NULL OR p_attempt IS NULL OR pending.sync_id IS DISTINCT FROM p_id OR
    pending.sync_attempt IS DISTINCT FROM p_attempt OR pending.sync_expires_at IS NULL OR
    pending.sync_expires_at<=now_at THEN
    RAISE EXCEPTION 'The user sync expired or changed.' USING DETAIL='user-sync-changed';
  END IF;
  UPDATE cc.user_sync_state SET sync_expires_at=now_at+interval '10 minutes'
  WHERE customer_id=p_customer;
END;
$$;

-- One user as the worker stores it and Redis carries it. The raw customSchemas object stays unchanged.
CREATE FUNCTION cc.user_record(u cc.users) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT jsonb_build_object('userId',u.user_id,'primaryEmail',u.primary_email,'orgUnitPath',u.org_unit_path,
    'givenName',u.given_name,'familyName',u.family_name,'fullName',u.full_name,
    'suspended',u.suspended,'suspensionReason',u.suspension_reason,'archived',u.archived,
    'lastLoginTime',u.last_login_time,'creationTime',u.creation_time,'twoStepEnrolled',u.two_step_enrolled,
    'department',u.department,'title',u.title,'aliases',u.aliases,
    'customSchemas',u.custom_schemas,'lastEntitySync',u.last_entity_sync);
$$;

-- Both sync paths write through this upsert. A returned user is present again.
CREATE FUNCTION cc.upsert_users(p_customer text,p_users jsonb,p_synced_at timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE written integer;
BEGIN
  IF jsonb_typeof(p_users) IS DISTINCT FROM 'array' OR jsonb_array_length(p_users)>1000 OR
    p_synced_at IS NULL THEN
    RAISE EXCEPTION 'The user page is invalid.' USING ERRCODE='22023';
  END IF;
  -- S1: a page user without a row checks the connection foreign key on insert, and that check takes
  -- the connection row FOR KEY SHARE. The lock comes here, before every user row.
  PERFORM 1 FROM cc.google_connection c WHERE c.customer_id=p_customer FOR KEY SHARE;
  PERFORM 1 FROM cc.users u WHERE u.customer_id=p_customer AND u.user_id IN (
      SELECT e.value->>'userId' FROM jsonb_array_elements(p_users) e)
    ORDER BY u.user_id FOR UPDATE;
  WITH incoming AS (
    SELECT DISTINCT ON (e.value->>'userId') e.value->>'userId' AS user_id,e.value AS row_value
    FROM jsonb_array_elements(p_users) WITH ORDINALITY e(value,position)
    ORDER BY e.value->>'userId',e.position DESC
  ), upserted AS (
    INSERT INTO cc.users(customer_id,user_id,primary_email,org_unit_path,given_name,family_name,full_name,
      suspended,suspension_reason,archived,last_login_time,creation_time,two_step_enrolled,department,title,
      aliases,custom_schemas,last_entity_sync)
    SELECT p_customer,i.user_id,i.row_value->>'primaryEmail',i.row_value->>'orgUnitPath',
      i.row_value->>'givenName',i.row_value->>'familyName',i.row_value->>'fullName',
      COALESCE((i.row_value->>'suspended')::boolean,false),i.row_value->>'suspensionReason',
      COALESCE((i.row_value->>'archived')::boolean,false),(i.row_value->>'lastLoginTime')::timestamptz,
      (i.row_value->>'creationTime')::timestamptz,COALESCE((i.row_value->>'twoStepEnrolled')::boolean,false),
      i.row_value->>'department',i.row_value->>'title',COALESCE(i.row_value->'aliases','[]'::jsonb),
      COALESCE(i.row_value->'customSchemas','{}'::jsonb),p_synced_at
    FROM incoming i
    ON CONFLICT(customer_id,user_id) DO UPDATE SET
      primary_email=EXCLUDED.primary_email,org_unit_path=EXCLUDED.org_unit_path,
      given_name=EXCLUDED.given_name,family_name=EXCLUDED.family_name,full_name=EXCLUDED.full_name,
      suspended=EXCLUDED.suspended,suspension_reason=EXCLUDED.suspension_reason,
      archived=EXCLUDED.archived,last_login_time=EXCLUDED.last_login_time,
      creation_time=EXCLUDED.creation_time,two_step_enrolled=EXCLUDED.two_step_enrolled,
      department=EXCLUDED.department,title=EXCLUDED.title,aliases=EXCLUDED.aliases,
      custom_schemas=EXCLUDED.custom_schemas,last_entity_sync=EXCLUDED.last_entity_sync,removed_at=NULL
    WHERE cc.users.last_entity_sync<=EXCLUDED.last_entity_sync
    RETURNING cc.users.user_id
  )
  SELECT count(*) INTO written FROM upserted;
  RETURN written;
END;
$$;

-- Google answered 404 for these users. The rows stay.
CREATE FUNCTION cc.soft_delete_users(p_customer text,p_ids jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE removed integer;
BEGIN
  IF jsonb_typeof(p_ids) IS DISTINCT FROM 'array' OR jsonb_array_length(p_ids)>1000 THEN
    RAISE EXCEPTION 'The user list is invalid.' USING ERRCODE='22023';
  END IF;
  -- Lock the requested rows in user_id order first, so concurrent writers cannot deadlock.
  PERFORM 1 FROM cc.users u WHERE u.customer_id=p_customer AND
      u.user_id IN (SELECT jsonb_array_elements_text(p_ids))
    ORDER BY u.user_id FOR UPDATE;
  UPDATE cc.users SET removed_at=clock_timestamp()
  WHERE customer_id=p_customer AND removed_at IS NULL
    AND user_id IN (SELECT jsonb_array_elements_text(p_ids));
  GET DIAGNOSTICS removed=ROW_COUNT;
  RETURN removed;
END;
$$;

CREATE FUNCTION cc.read_user_records(p_customer text,p_ids jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('version',u.record_version,
      'record',cc.user_record(u)) ORDER BY u.user_id),'[]'::jsonb)
  FROM cc.users u
  WHERE u.customer_id=p_customer AND u.removed_at IS NULL
    AND u.user_id IN (SELECT jsonb_array_elements_text(p_ids));
$$;

-- Present users after p_after in user_id order. An empty p_after starts at the first user.
CREATE FUNCTION cc.page_user_records(p_customer text,p_after text,p_limit integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT COALESCE(jsonb_agg(entry ORDER BY user_id),'[]'::jsonb) FROM (
    SELECT u.user_id,jsonb_build_object('version',u.record_version,
      'record',cc.user_record(u)) AS entry
    FROM cc.users u
    WHERE u.customer_id=p_customer AND u.removed_at IS NULL AND u.user_id>COALESCE(p_after,'')
    ORDER BY u.user_id LIMIT LEAST(GREATEST(p_limit,1),1000)) page;
$$;

-- Users that the last finished full sync removed, after p_after in user_id order.
CREATE FUNCTION cc.page_last_removed_user_ids(p_customer text,p_after text,p_limit integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT COALESCE(jsonb_agg(user_id ORDER BY user_id),'[]'::jsonb) FROM (
    SELECT u.user_id FROM cc.users u
    WHERE u.customer_id=p_customer AND u.user_id>COALESCE(p_after,'')
      AND u.removed_at=(SELECT s.checked_at FROM cc.user_sync_state s WHERE s.customer_id=p_customer)
    ORDER BY u.user_id LIMIT LEAST(GREATEST(p_limit,1),1000)) page;
$$;

CREATE FUNCTION cc.stage_users(p_customer text,p_id uuid,p_attempt uuid,p_users jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE staged integer; lease timestamptz; now_at timestamptz;
BEGIN
  -- S1: the lease helper locks the state row, then the header, then reads the clock and fences the attempt.
  PERFORM cc.user_sync_lease(p_customer,p_id,p_attempt);
  IF jsonb_typeof(p_users) IS DISTINCT FROM 'array' OR jsonb_array_length(p_users)>1000 THEN
    RAISE EXCEPTION 'The user page is invalid.' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM cc.jobs j WHERE j.job_id=p_id AND j.customer_id=p_customer FOR UPDATE;
  -- S1: the user inserts and the publication reference the connection row, so it locks after the header
  -- and before the user rows. The user rows of the page then lock in user_id order.
  PERFORM 1 FROM cc.google_connection c WHERE c.customer_id=p_customer FOR KEY SHARE;
  PERFORM 1 FROM cc.users u WHERE u.customer_id=p_customer AND u.user_id IN (
      SELECT e.value->>'userId' FROM jsonb_array_elements(p_users) e)
    ORDER BY u.user_id FOR UPDATE;
  SELECT s.sync_expires_at INTO lease FROM cc.user_sync_state s WHERE s.customer_id=p_customer;
  now_at:=clock_timestamp();
  IF lease IS NULL OR lease<=now_at THEN
    RAISE EXCEPTION 'The user sync expired or changed.' USING DETAIL='user-sync-changed';
  END IF;
  -- Each staged user records its listed OrgUnit path on the job (section 1.3).
  INSERT INTO cc.job_targets(job_id,device_id,org_unit_path,observed_at)
  SELECT p_id,t.user_id,t.listed_path,clock_timestamp()
  FROM (SELECT DISTINCT ON (e.value->>'userId') e.value->>'userId' AS user_id,
      e.value->>'orgUnitPath' AS listed_path
    FROM jsonb_array_elements(p_users) WITH ORDINALITY e(value,position)
    ORDER BY e.value->>'userId',e.position DESC) t
  ON CONFLICT(job_id,device_id) DO UPDATE SET org_unit_path=EXCLUDED.org_unit_path,observed_at=EXCLUDED.observed_at;
  staged:=cc.upsert_users(p_customer,p_users,clock_timestamp());
  -- S1 rule 6: the lease repeats after the upsert and before the header write. A lapse in that wait
  -- raises, and the transaction commits no target or user change.
  now_at:=clock_timestamp();
  IF lease<=now_at THEN
    RAISE EXCEPTION 'The user sync expired or changed.' USING DETAIL='user-sync-changed';
  END IF;
  UPDATE cc.jobs SET succeeded=(SELECT count(*) FROM cc.job_targets t WHERE t.job_id=p_id) WHERE job_id=p_id;
  PERFORM cc.record_job_change(p_id,false);
  RETURN staged;
END;
$$;

-- A successful full sync marks every user the enumeration did not touch as removed.
CREATE FUNCTION cc.finish_user_sync(p_customer text,p_id uuid,p_attempt uuid,p_failure text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE pending cc.user_sync_state; header record; now_at timestamptz; staged integer;
BEGIN
  -- Rule G: a successful finish reaches the global access lock through the generation helper, so every
  -- finish takes that lock first, before any row lock.
  PERFORM pg_advisory_xact_lock(7240173008);
  SELECT * INTO pending FROM cc.user_sync_state WHERE customer_id=p_customer FOR UPDATE;
  -- S1: the sync state row locks first, the header second, and the clock third.
  SELECT * INTO header FROM cc.jobs j WHERE j.job_id=p_id AND j.customer_id=p_customer FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The user sync expired or changed.' USING DETAIL='user-sync-changed';
  END IF;
  now_at:=clock_timestamp();
  IF p_id IS NULL OR p_attempt IS NULL OR pending.sync_id IS DISTINCT FROM p_id OR
    pending.sync_attempt IS DISTINCT FROM p_attempt OR pending.sync_expires_at IS NULL OR
    pending.sync_expires_at<=now_at OR header.status<>'running' OR
    header.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'The user sync expired or changed.' USING DETAIL='user-sync-changed';
  END IF;
  SELECT count(*) INTO staged FROM cc.job_targets t WHERE t.job_id=p_id;
  IF p_failure IS NULL THEN
    PERFORM cc.google_current_generation(p_customer,pending.sync_generation);
    -- The state write names the sync actor as the failure requester. That principal row locks here.
    PERFORM 1 FROM cc.application_principals p WHERE p.id=pending.sync_actor FOR KEY SHARE;
    -- The removal locks every candidate row in user_id order first.
    PERFORM 1 FROM cc.users u WHERE u.customer_id=p_customer AND
        u.last_entity_sync<pending.sync_started_at
      ORDER BY u.user_id FOR UPDATE;
  ELSE
    -- S1: a failed finish reads no generation, so it holds no connection lock yet. Its state write names
    -- the failure requester, and its publication references the connection row.
    PERFORM 1 FROM cc.application_principals p WHERE p.id=pending.sync_actor FOR KEY SHARE;
    PERFORM 1 FROM cc.google_connection c WHERE c.customer_id=p_customer FOR KEY SHARE;
  END IF;
  -- The lease fence reads the database clock again after the user and connection locks.
  now_at:=clock_timestamp();
  IF pending.sync_expires_at<=now_at THEN
    RAISE EXCEPTION 'The user sync expired or changed.' USING DETAIL='user-sync-changed';
  END IF;
  IF p_failure IS NULL THEN
    UPDATE cc.users SET removed_at=now_at
    WHERE customer_id=p_customer AND removed_at IS NULL AND last_entity_sync<pending.sync_started_at;
    UPDATE cc.user_sync_state SET generation=pending.sync_generation,observed_at=now_at,
      user_count=(SELECT count(*) FROM cc.users WHERE customer_id=p_customer AND removed_at IS NULL),
      failure=NULL,failure_requested_by=NULL
    WHERE customer_id=p_customer;
    UPDATE cc.jobs SET target_count=staged,
      target_org_unit_paths=(SELECT COALESCE(array_agg(DISTINCT t.org_unit_path)
        FILTER (WHERE t.org_unit_path IS NOT NULL),'{}'::text[]) FROM cc.job_targets t WHERE t.job_id=p_id),
      succeeded=staged,status='completed',failure=NULL
    WHERE job_id=p_id;
  ELSE
    UPDATE cc.user_sync_state SET failure=p_failure,failure_requested_by=pending.sync_actor
    WHERE customer_id=p_customer;
    UPDATE cc.jobs SET target_count=staged,
      target_org_unit_paths=(SELECT COALESCE(array_agg(DISTINCT t.org_unit_path)
        FILTER (WHERE t.org_unit_path IS NOT NULL),'{}'::text[]) FROM cc.job_targets t WHERE t.job_id=p_id),
      status='failed',failure=p_failure WHERE job_id=p_id;
  END IF;
  UPDATE cc.user_sync_state SET checked_at=now_at,sync_id=NULL,sync_actor=NULL,sync_generation=NULL,
    sync_attempt=NULL,sync_expires_at=NULL
  WHERE customer_id=p_customer;
  UPDATE cc.jobs SET finished_at=now_at WHERE job_id=p_id;
  PERFORM cc.record_job_change(p_id,true);
  RETURN cc.user_sync_projection(p_customer);
END;
$$;

-- The batch runner learns the entity type of its refresh job from the job row. The worker reads a
-- user batch through the user reader of document A section 6.
CREATE OR REPLACE FUNCTION cc.read_entity_sync_batch(p_customer text,p_job uuid,p_batch integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.entity_sync_jobs; connection cc.google_connection;
BEGIN
  SELECT * INTO job FROM cc.entity_sync_jobs WHERE job_id=p_job AND customer_id=p_customer;
  IF job.job_id IS NULL OR job.finished_at IS NOT NULL OR p_batch IS NULL OR p_batch<0 OR p_batch>=job.batch_count THEN
    RAISE EXCEPTION 'The entity sync job changed.' USING DETAIL='entity-sync-changed';
  END IF;
  connection:=cc.google_current_generation(p_customer,job.generation);
  RETURN jsonb_build_object('generation',connection.generation,'credentialId',connection.credential_id,
    'envelope',(SELECT envelope FROM cc.google_credentials WHERE id=connection.credential_id),
    'batchCount',job.batch_count,'entityType',job.entity_type,
    'ids',(SELECT COALESCE(jsonb_agg(e.value ORDER BY e.ordinality),'[]'::jsonb)
      FROM jsonb_array_elements(job.ids) WITH ORDINALITY e
      WHERE e.ordinality>p_batch*job.batch_size AND e.ordinality<=(p_batch+1)*job.batch_size));
END;
$$;

REVOKE ALL ON FUNCTION cc.user_sync_projection(text),
  cc.request_user_sync(uuid,integer,text,integer,uuid,uuid),cc.claim_user_sync(text,uuid,uuid),
  cc.user_sync_lease(text,uuid,uuid),cc.user_record(cc.users),cc.upsert_users(text,jsonb,timestamptz),
  cc.soft_delete_users(text,jsonb),cc.read_user_records(text,jsonb),
  cc.page_user_records(text,text,integer),cc.page_last_removed_user_ids(text,text,integer),
  cc.stage_users(text,uuid,uuid,jsonb),cc.finish_user_sync(text,uuid,uuid,text) FROM PUBLIC;