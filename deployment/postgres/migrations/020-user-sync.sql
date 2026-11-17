-- The full user sync and the user refresh job (design card K7).
-- It mirrors the device sync of 016 with the typed read gate of 019: a user sync needs users:read.
-- Nothing is deleted. removed_at marks a user that Google no longer returns.

-- The entity of a job header. A full sync of either entity shares the inventory-refresh kind and the
-- all-devices scope, so cancellation, purge, and retention read this column to name the right state row.
-- Every existing job is a device job, so the default carries them.
ALTER TABLE cc.jobs ADD COLUMN entity_type text NOT NULL DEFAULT 'device'
  CHECK(entity_type IN ('device','user'));

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
  -- The header records every Refresh Users with its requester. The sync ID is the header ID. The entity
  -- column routes cancellation, purge, and retention to the user state row.
  INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,entity_type,status,requested_by,generation,
    correlation_id,created_at,started_at)
  VALUES(p_id,cc.job_display_id('REF',nextval('cc.job_number_ref')),p_customer,'inventory-refresh','all-devices',
    'user','running',p_actor,p_generation,p_correlation,now_at,now_at);
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
    WHERE cc.users.last_entity_sync<=EXCLUDED.last_entity_sync AND
      (cc.users.removed_at IS NULL OR cc.users.removed_at<EXCLUDED.last_entity_sync)
    RETURNING cc.users.user_id
  )
  SELECT count(*) INTO written FROM upserted;
  RETURN written;
END;
$$;

-- Google answered 404 for these users at p_observed_at. The rows stay. A presence observation newer
-- than the 404 keeps its row, because the older 404 cannot remove a user that a later read returned.
-- A repeated absence moves an older tombstone to the newer observation, so a presence read that both
-- absences predate cannot resurrect the user (R3a). The result names the users that this observation
-- holds removed, in user_id order. The worker evicts and publishes only those (R3b).
CREATE FUNCTION cc.soft_delete_users(p_customer text,p_ids jsonb,p_observed_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE removed jsonb;
BEGIN
  IF jsonb_typeof(p_ids) IS DISTINCT FROM 'array' OR jsonb_array_length(p_ids)>1000 OR
    p_observed_at IS NULL THEN
    RAISE EXCEPTION 'The user list is invalid.' USING ERRCODE='22023';
  END IF;
  -- Lock the requested rows in user_id order first, so concurrent writers cannot deadlock.
  PERFORM 1 FROM cc.users u WHERE u.customer_id=p_customer AND
      u.user_id IN (SELECT jsonb_array_elements_text(p_ids))
    ORDER BY u.user_id FOR UPDATE;
  -- The removal carries the observation time, not the call time, so a read that started after this
  -- observation clears it and a read that started before it does not (R3). A newer absence advances
  -- an older tombstone, so the fence always holds the newest absence.
  WITH observed AS (
    UPDATE cc.users SET removed_at=p_observed_at
    WHERE customer_id=p_customer AND (removed_at IS NULL OR removed_at<p_observed_at)
      AND last_entity_sync<=p_observed_at
      AND user_id IN (SELECT jsonb_array_elements_text(p_ids))
    RETURNING user_id
  )
  SELECT COALESCE(jsonb_agg(user_id ORDER BY user_id),'[]'::jsonb) INTO removed FROM observed;
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
DECLARE staged integer; lease timestamptz; started timestamptz; now_at timestamptz;
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
  SELECT s.sync_expires_at,s.sync_started_at INTO lease,started FROM cc.user_sync_state s WHERE s.customer_id=p_customer;
  now_at:=clock_timestamp();
  IF lease IS NULL OR lease<=now_at OR started IS NULL THEN
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
  -- Presence carries the start of the enumeration, so a later 404 or presence read orders against it.
  staged:=cc.upsert_users(p_customer,p_users,started);
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
    -- The removal shares the finish clock with the state's checked_at, so the Redis cleanup page
    -- finds exactly the users of this sync (device model, 016). A user that an earlier absence
    -- already removed moves to this observation, so the fence holds the newest absence (R3a).
    UPDATE cc.users SET removed_at=now_at
    WHERE customer_id=p_customer AND last_entity_sync<pending.sync_started_at
      AND (removed_at IS NULL OR removed_at<now_at);
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

-- The refresh job of either entity type. It repeats the 019 definition with the entity column, so
-- cancellation and the job surface can name the entity of a selected refresh.
CREATE OR REPLACE FUNCTION cc.create_entity_sync_job(p_actor uuid,p_version integer,p_customer text,p_type text,p_ids jsonb,
  p_batch_size integer,p_job uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection; job cc.entity_sync_jobs; now_at timestamptz;
BEGIN
  connection:=cc.entity_job_reader(p_actor,p_version,p_type);
  IF connection.customer_id IS DISTINCT FROM p_customer OR connection.active IS NOT TRUE THEN
    RAISE EXCEPTION 'The Google connection changed.' USING DETAIL='connection-changed';
  END IF;
  IF p_job IS NULL OR p_correlation IS NULL OR jsonb_typeof(p_ids) IS DISTINCT FROM 'array' OR
    p_batch_size IS NULL OR p_batch_size NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'The job is invalid.' USING ERRCODE='22023';
  END IF;
  -- Entity IDs travel into Google request paths. Only plain identifiers enter a job.
  IF jsonb_array_length(p_ids)=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_ids) e
      WHERE jsonb_typeof(e.value)<>'string' OR (e.value#>>'{}')!~'^[A-Za-z0-9_-]{1,128}$') THEN
    RAISE EXCEPTION 'The job IDs are invalid.' USING ERRCODE='22023';
  END IF;
  -- S1 (B2b round 2, class of R1-F2): the header and the detail row reference the requester and the
  -- connection row, and the publication references the connection row. Those rows lock here, the principal
  -- row before the connection row, as the credential functions take them (007 cc.google_connection_actor),
  -- so no insert below waits. The clock reads after these waits, and the authority and the connection
  -- revalidate on a fresh read. The job records the generation of that read.
  PERFORM 1 FROM cc.application_principals p WHERE p.id=p_actor FOR KEY SHARE;
  PERFORM 1 FROM cc.google_connection c WHERE c.customer_id=p_customer FOR KEY SHARE;
  now_at:=clock_timestamp();
  connection:=cc.entity_job_reader(p_actor,p_version,p_type);
  IF connection.customer_id IS DISTINCT FROM p_customer OR connection.active IS NOT TRUE THEN
    RAISE EXCEPTION 'The Google connection changed.' USING DETAIL='connection-changed';
  END IF;
  -- The header lands first. The refresh detail row shares its identity.
  INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,entity_type,status,requested_by,generation,
    target_count,correlation_id,created_at,started_at)
  VALUES(p_job,cc.job_display_id('REF',nextval('cc.job_number_ref')),p_customer,'inventory-refresh','devices',
    p_type,'running',p_actor,connection.generation,jsonb_array_length(p_ids),p_correlation,now_at,now_at);
  INSERT INTO cc.entity_sync_jobs(job_id,customer_id,entity_type,generation,ids,batch_size,batch_count,requested_by,correlation_id)
  VALUES(p_job,p_customer,p_type,connection.generation,p_ids,p_batch_size,
    ceil(jsonb_array_length(p_ids)::numeric/p_batch_size)::integer,p_actor,p_correlation)
  RETURNING * INTO job;
  -- Each requested ID records its OrgUnit path at creation (section 1.3).
  INSERT INTO cc.job_targets(job_id,device_id,org_unit_path,observed_at)
  SELECT p_job,e.value#>>'{}',d.org_unit_path,now_at
  FROM jsonb_array_elements(p_ids) e
  LEFT JOIN cc.devices d ON d.customer_id=p_customer AND d.device_id=e.value#>>'{}';
  -- The header names the distinct target paths at creation (section 1.2).
  UPDATE cc.jobs SET target_org_unit_paths=(SELECT COALESCE(array_agg(DISTINCT t.org_unit_path)
      FILTER (WHERE t.org_unit_path IS NOT NULL),'{}'::text[]) FROM cc.job_targets t WHERE t.job_id=p_job)
  WHERE job_id=p_job;
  PERFORM cc.record_job_change(p_job,true);
  RETURN cc.entity_sync_job_projection(job);
END;
$$;

-- The cancel request of section 2. It repeats the 017 definition with the entity-specific state row.
-- A user full sync clears only the user lease. A device full sync clears only the device lease. A job
-- it replaces or ends reaches no other entity's state.
CREATE OR REPLACE FUNCTION cc.request_job_cancel(p_actor uuid,p_version integer,p_customer text,p_display_id text,
  p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.device_update_jobs; now_at timestamptz; request_at timestamptz;
  pending integer; dispatched integer;
  stop_now boolean:=false; claimed_at timestamptz; waiting_jobs cc.jobs[]:='{}'; waiting_job cc.jobs;
  waiting_detail cc.device_update_jobs;
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

-- The purge keeps write jobs. Refresh jobs leave after seven days, previews and overlays when they lapse.
-- It repeats the 017 definition with the state row of each entity: a live user sync is interrupted only
-- when its own lease lapsed, and a header either sync state names stays for its replacement request.
CREATE OR REPLACE FUNCTION cc.purge_jobs(p_customer text,p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE removed integer:=0; job cc.jobs; candidate uuid; state cc.device_sync_state;
  user_state cc.user_sync_state; now_at timestamptz; locked text[];
BEGIN
  -- S2: a null customer never matches a job.
  IF p_customer IS NULL THEN
    RAISE EXCEPTION 'The customer is required.' USING ERRCODE='22023';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'The purge limit is invalid.' USING ERRCODE='22023';
  END IF;
  -- S1 (B2b round 2, R1-F1): the sync state rows lock once, before every header lock and every connection
  -- lock of this transaction. That includes the implicit KEY SHARE lock of each publication insert. The
  -- locks hold to the end of the transaction, so every loop below reads one stable state. The device
  -- state locks first and the user state second, the order of every caller that touches both.
  SELECT * INTO state FROM cc.device_sync_state s WHERE s.customer_id=p_customer FOR UPDATE;
  SELECT * INTO user_state FROM cc.user_sync_state s WHERE s.customer_id=p_customer FOR UPDATE;
  -- Every closure publishes, and each publication references the connection row. That row locks after the
  -- state rows and before the first clock read, so no closure below waits on it after its clock.
  PERFORM 1 FROM cc.google_connection c WHERE c.customer_id=p_customer FOR KEY SHARE;
  -- The candidate filter reads a clock. Every closure below re-reads the clock after its header locks.
  now_at:=clock_timestamp();
  -- An ID-list refresh that stays unfinished for two hours ends as interrupted.
  -- S1: the header locks before the detail row and before the clock, as every refresh writer takes them.
  FOR candidate IN SELECT j.job_id FROM cc.jobs j WHERE j.customer_id=p_customer AND j.kind='inventory-refresh' AND
      j.scope_kind='devices' AND j.finished_at IS NULL AND j.created_at<now_at-interval '2 hours'
      ORDER BY j.job_id LOOP
    SELECT * INTO job FROM cc.jobs j WHERE j.job_id=candidate AND j.customer_id=p_customer FOR UPDATE;
    IF job.job_id IS NULL OR job.finished_at IS NOT NULL THEN CONTINUE; END IF;
    now_at:=clock_timestamp();
    IF job.status<>'running' THEN CONTINUE; END IF;
    UPDATE cc.entity_sync_jobs SET failure=COALESCE(failure,'interrupted'),finished_at=now_at
    WHERE job_id=job.job_id AND finished_at IS NULL;
    UPDATE cc.jobs SET status='failed',failure=COALESCE(failure,'interrupted'),finished_at=now_at
    WHERE job_id=job.job_id AND status='running' AND finished_at IS NULL;
    IF FOUND THEN PERFORM cc.record_job_change(job.job_id,true); END IF;
  END LOOP;
  -- A full-sync header of either entity without a live lease of that entity ends as interrupted. S1: the
  -- state rows are already held, the header locks second, and the clock reads third. The lease check
  -- follows both locks (review F12).
  FOR candidate IN SELECT j.job_id FROM cc.jobs j
      LEFT JOIN cc.device_sync_state d ON d.customer_id=j.customer_id
      LEFT JOIN cc.user_sync_state u ON u.customer_id=j.customer_id
      WHERE j.customer_id=p_customer AND j.kind='inventory-refresh' AND j.scope_kind='all-devices' AND
        j.status='running' AND NOT (
          (j.entity_type='device' AND d.sync_id IS NOT DISTINCT FROM j.job_id AND d.sync_expires_at>now_at) OR
          (j.entity_type='user' AND u.sync_id IS NOT DISTINCT FROM j.job_id AND u.sync_expires_at>now_at))
      ORDER BY j.job_id LOOP
    SELECT * INTO job FROM cc.jobs j WHERE j.job_id=candidate AND j.customer_id=p_customer FOR UPDATE;
    IF job.job_id IS NULL OR job.status<>'running' OR job.finished_at IS NOT NULL THEN CONTINUE; END IF;
    now_at:=clock_timestamp();
    IF (job.entity_type='device' AND state.sync_id IS NOT DISTINCT FROM job.job_id AND state.sync_expires_at>now_at) OR
      (job.entity_type='user' AND user_state.sync_id IS NOT DISTINCT FROM job.job_id AND user_state.sync_expires_at>now_at) THEN
      CONTINUE;
    END IF;
    -- The closure records the targets the interrupted sync observed (section 1.2, review F19).
    UPDATE cc.jobs SET status='failed',failure=COALESCE(failure,'interrupted'),finished_at=now_at,
      target_count=(SELECT count(*) FROM cc.job_targets t WHERE t.job_id=job.job_id),
      succeeded=(SELECT count(*) FROM cc.job_targets t WHERE t.job_id=job.job_id),
      target_org_unit_paths=(SELECT COALESCE(array_agg(DISTINCT t.org_unit_path ORDER BY t.org_unit_path)
        FILTER (WHERE t.org_unit_path IS NOT NULL),'{}'::text[]) FROM cc.job_targets t WHERE t.job_id=job.job_id)
    WHERE job_id=job.job_id AND status='running' AND finished_at IS NULL;
    IF FOUND THEN PERFORM cc.record_job_change(job.job_id,true); END IF;
  END LOOP;
  now_at:=clock_timestamp();
  -- Refresh jobs leave with their detail, batch, and target rows. A write job never leaves.
  -- S1 (round 6, R6-12): the state rows are already held. Every retention candidate takes its header, then
  -- the clock, and it rechecks its eligibility under those locks. The deletion itself stays allowed.
  -- R1-F2 (B2b round 2): the header that either sync state names stays. A replacement request locks and
  -- validates that header, so a purge never leaves a state naming a missing header.
  FOR candidate IN SELECT j.job_id FROM cc.jobs j WHERE j.customer_id=p_customer AND j.kind='inventory-refresh' AND
      j.finished_at IS NOT NULL AND j.finished_at<now_at-interval '7 days' AND
      j.job_id IS DISTINCT FROM state.sync_id AND j.job_id IS DISTINCT FROM user_state.sync_id
      ORDER BY j.finished_at LIMIT p_limit LOOP
    SELECT * INTO job FROM cc.jobs j WHERE j.job_id=candidate AND j.customer_id=p_customer FOR UPDATE;
    IF job.job_id IS NULL OR job.finished_at IS NULL THEN CONTINUE; END IF;
    now_at:=clock_timestamp();
    IF job.finished_at>=now_at-interval '7 days' THEN CONTINUE; END IF;
    DELETE FROM cc.jobs WHERE job_id=candidate;
    removed:=removed+1;
  END LOOP;
  -- An import line table and an export target list leave 30 days after the file job ends (design
  -- section 3). The header, the mode, and the plan state stay with the job; a write job never leaves.
  -- S1: the header locks before the clock, and the detail row locks after the header.
  now_at:=clock_timestamp();
  FOR candidate IN SELECT j.job_id FROM cc.jobs j WHERE j.customer_id=p_customer AND
      j.kind IN ('device-export','device-import') AND j.finished_at IS NOT NULL AND
      j.finished_at<now_at-interval '30 days' AND (
        EXISTS(SELECT 1 FROM cc.device_export_targets t WHERE t.job_id=j.job_id) OR
        EXISTS(SELECT 1 FROM cc.device_import_changes c WHERE c.job_id=j.job_id) OR
        EXISTS(SELECT 1 FROM cc.device_import_rejections r WHERE r.job_id=j.job_id) OR
        EXISTS(SELECT 1 FROM cc.device_import_warnings w WHERE w.job_id=j.job_id))
      ORDER BY j.finished_at,j.job_id LIMIT p_limit LOOP
    SELECT * INTO job FROM cc.jobs j WHERE j.job_id=candidate AND j.customer_id=p_customer FOR UPDATE;
    IF job.job_id IS NULL OR job.finished_at IS NULL THEN CONTINUE; END IF;
    now_at:=clock_timestamp();
    IF job.finished_at>=now_at-interval '30 days' THEN CONTINUE; END IF;
    IF job.kind='device-import' THEN
      PERFORM 1 FROM cc.device_import_jobs i WHERE i.job_id=job.job_id FOR UPDATE;
      DELETE FROM cc.device_import_changes WHERE job_id=job.job_id;
      DELETE FROM cc.device_import_rejections WHERE job_id=job.job_id;
      DELETE FROM cc.device_import_warnings WHERE job_id=job.job_id;
    ELSE
      PERFORM 1 FROM cc.device_export_jobs e WHERE e.job_id=job.job_id FOR UPDATE;
      DELETE FROM cc.device_export_targets WHERE job_id=job.job_id;
    END IF;
    removed:=removed+1;
  END LOOP;
  -- An unconfirmed preview leaves 24 hours after its expiry, with its targets.
  DELETE FROM cc.device_update_previews WHERE customer_id=p_customer AND job_id IS NULL AND
    expires_at<now_at-interval '24 hours';
  -- An expired overlay leaves. The current-value stamp stays. Section 5.8: every function that changes an
  -- overlay locks its device row first. The device rows of the expired overlays lock in device_id order,
  -- after the header and connection locks, as every overlay writer takes them. Only the overlays of the
  -- locked rows leave. An overlay without a device row has no row to lock, and it leaves as well.
  SELECT COALESCE(array_agg(l.device_id),'{}'::text[]) INTO locked FROM (
    SELECT d.device_id FROM cc.devices d WHERE d.customer_id=p_customer AND d.device_id IN (
        SELECT o.device_id FROM cc.device_write_overlays o WHERE o.customer_id=p_customer AND o.expires_at<=now_at)
      ORDER BY d.device_id FOR UPDATE) l;
  DELETE FROM cc.device_write_overlays o WHERE o.customer_id=p_customer AND o.expires_at<=now_at AND
    (o.device_id=ANY(locked) OR NOT EXISTS(SELECT 1 FROM cc.devices d WHERE d.customer_id=p_customer AND
      d.device_id=o.device_id));
  RETURN removed;
END;
$$;

REVOKE ALL ON FUNCTION cc.user_sync_projection(text),
  cc.request_user_sync(uuid,integer,text,integer,uuid,uuid),cc.claim_user_sync(text,uuid,uuid),
  cc.user_sync_lease(text,uuid,uuid),cc.user_record(cc.users),cc.upsert_users(text,jsonb,timestamptz),
  cc.soft_delete_users(text,jsonb,timestamptz),cc.read_user_records(text,jsonb),
  cc.page_user_records(text,text,integer),cc.page_last_removed_user_ids(text,text,integer),
  cc.stage_users(text,uuid,uuid,jsonb),cc.finish_user_sync(text,uuid,uuid,text) FROM PUBLIC;