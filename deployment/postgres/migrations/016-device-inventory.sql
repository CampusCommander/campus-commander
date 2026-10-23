-- Device inventory keeps one row per device with the time of its last Google read.
-- A full sync enumerates the inventory under a lease. An entity sync refreshes a list of devices in batches.
-- Nothing is deleted. removed_at marks a device that Google no longer returns.
INSERT INTO cc.application_actions(action,scope_kinds) VALUES('devices:read',ARRAY['platform','district']);

CREATE TABLE cc.device_sync_state (
  customer_id text PRIMARY KEY REFERENCES cc.google_connection(customer_id),
  generation integer,
  observed_at timestamptz,
  device_count integer NOT NULL DEFAULT 0 CHECK(device_count>=0),
  telemetry_failure text CHECK(telemetry_failure IN ('credential-rejected','delegation-not-authorized','api-not-enabled',
    'policy-restricted','network-failure','scope-mismatch','permission-denied','quota','provider-unavailable',
    'invalid-response','wrong-customer','request-failed')),
  failure text CHECK(failure IN ('credential-rejected','delegation-not-authorized','api-not-enabled',
    'policy-restricted','network-failure','scope-mismatch','permission-denied','quota','provider-unavailable',
    'invalid-response','wrong-customer','request-failed','key-unavailable','interrupted','orchestration-unavailable')),
  checked_at timestamptz,
  sync_id uuid,
  sync_actor uuid REFERENCES cc.application_principals(id),
  sync_generation integer,
  sync_attempt uuid,
  sync_started_at timestamptz,
  sync_expires_at timestamptz,
  correlation_id uuid,
  failure_requested_by uuid REFERENCES cc.application_principals(id),
  telemetry_failure_requested_by uuid REFERENCES cc.application_principals(id),
  -- Raises by one when telemetry_failure changes. The requester does not raise it (section 5.11).
  telemetry_version bigint NOT NULL DEFAULT 1,
  CHECK((sync_id IS NULL)=(sync_expires_at IS NULL)),
  CHECK((failure IS NULL)=(failure_requested_by IS NULL)),
  CHECK((telemetry_failure IS NULL)=(telemetry_failure_requested_by IS NULL))
);

CREATE TABLE cc.devices (
  customer_id text NOT NULL REFERENCES cc.google_connection(customer_id),
  device_id text NOT NULL CHECK(length(device_id) BETWEEN 1 AND 128),
  serial_number text NOT NULL CHECK(length(serial_number)<=256),
  model text CHECK(length(model)<=256),
  asset_tag text CHECK(length(asset_tag)<=4096),
  org_unit_path text NOT NULL CHECK(left(org_unit_path,1)='/' AND length(org_unit_path)<=4096),
  last_contact timestamptz,
  annotated_location text CHECK(length(annotated_location)<=4096),
  annotated_user text CHECK(length(annotated_user)<=4096),
  notes text CHECK(length(notes)<=4096),
  status text CHECK(length(status)<=64),
  battery_status text NOT NULL DEFAULT 'no-report' CHECK(battery_status IN ('reported','no-report','unavailable')),
  battery_health text CHECK(battery_health IN ('normal','replace-soon','replace-now')),
  battery_capacity_percent integer CHECK(battery_capacity_percent BETWEEN 0 AND 200),
  battery_reported_at timestamptz,
  battery_reports jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK(jsonb_typeof(battery_reports)='array' AND jsonb_array_length(battery_reports)<=30),
  last_entity_sync timestamptz NOT NULL,
  removed_at timestamptz,
  annotated_location_observed_at timestamptz,
  -- The current-value stamp of each field that carries an overlay (section 5.8 rule 2).
  annotated_user_observed_at timestamptz,
  notes_observed_at timestamptz,
  org_unit_path_observed_at timestamptz,
  status_observed_at timestamptz,
  -- Raises by one when any other column changes. See the trigger below.
  record_version bigint NOT NULL DEFAULT 1,
  CHECK((battery_status='reported')=(battery_health IS NOT NULL AND battery_reported_at IS NOT NULL)),
  PRIMARY KEY(customer_id,device_id)
);
CREATE INDEX devices_serial ON cc.devices(customer_id,serial_number,device_id);
CREATE INDEX devices_model ON cc.devices(customer_id,model,device_id);
CREATE INDEX devices_asset ON cc.devices(customer_id,asset_tag,device_id);
CREATE INDEX devices_org_unit ON cc.devices(customer_id,org_unit_path text_pattern_ops);
CREATE INDEX devices_contact ON cc.devices(customer_id,last_contact,device_id);
CREATE INDEX devices_freshness ON cc.devices(customer_id,last_entity_sync);

-- Every writer raises the record version. An update that changes no other column keeps it.
-- The trigger takes no lock: it reads the row values that the update already holds.
CREATE FUNCTION cc.bump_device_record_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
BEGIN
  NEW.record_version:=CASE
    WHEN (to_jsonb(NEW)-'record_version') IS DISTINCT FROM (to_jsonb(OLD)-'record_version')
      THEN OLD.record_version+1
    ELSE OLD.record_version END;
  RETURN NEW;
END;
$$;
CREATE TRIGGER devices_record_version BEFORE UPDATE ON cc.devices
FOR EACH ROW EXECUTE FUNCTION cc.bump_device_record_version();

-- A change of the telemetry failure raises the telemetry version. Its requester alone does not.
-- The version never decreases: a row rewrite keeps the old value unless the failure changes.
CREATE FUNCTION cc.bump_telemetry_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
BEGIN
  NEW.telemetry_version:=CASE
    WHEN NEW.telemetry_failure IS DISTINCT FROM OLD.telemetry_failure
      THEN OLD.telemetry_version+1
    ELSE OLD.telemetry_version END;
  RETURN NEW;
END;
$$;
CREATE TRIGGER device_sync_state_telemetry_version BEFORE UPDATE ON cc.device_sync_state
FOR EACH ROW EXECUTE FUNCTION cc.bump_telemetry_version();

-- One refresh job: the ID list, its batch size, and the connection generation it reads with.
CREATE TABLE cc.entity_sync_jobs (
  job_id uuid PRIMARY KEY,
  customer_id text NOT NULL REFERENCES cc.google_connection(customer_id),
  entity_type text NOT NULL CHECK(entity_type IN ('device')),
  generation integer NOT NULL,
  ids jsonb NOT NULL CHECK(jsonb_typeof(ids)='array' AND jsonb_array_length(ids) BETWEEN 1 AND 100000),
  batch_size integer NOT NULL CHECK(batch_size BETWEEN 1 AND 1000),
  batch_count integer NOT NULL CHECK(batch_count>=1),
  requested_by uuid REFERENCES cc.application_principals(id),
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  failure text CHECK(failure IN ('credential-rejected','delegation-not-authorized','api-not-enabled',
    'policy-restricted','network-failure','scope-mismatch','permission-denied','quota','provider-unavailable',
    'invalid-response','wrong-customer','request-failed','key-unavailable','interrupted','orchestration-unavailable')),
  finished_at timestamptz
);
CREATE INDEX entity_sync_jobs_customer ON cc.entity_sync_jobs(customer_id,created_at);

-- Each batch records once. A re-dispatched batch replaces its own record.
CREATE TABLE cc.entity_sync_batches (
  job_id uuid NOT NULL REFERENCES cc.entity_sync_jobs(job_id) ON DELETE CASCADE,
  batch integer NOT NULL CHECK(batch>=0),
  status text NOT NULL CHECK(status IN ('completed','failed')),
  failure text,
  finished_at timestamptz NOT NULL,
  PRIMARY KEY(job_id,batch)
);

CREATE FUNCTION cc.device_reader(p_actor uuid,p_version integer) RETURNS cc.google_connection
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection;
BEGIN
  SELECT * INTO connection FROM cc.google_connection WHERE singleton;
  IF NOT EXISTS(SELECT 1 FROM cc.application_principals p
      WHERE p.id=p_actor AND p.enabled AND p.permission_version=p_version) OR
    NOT EXISTS(SELECT 1 FROM cc.application_grants g WHERE g.principal_id=p_actor AND g.action='devices:read' AND (
      g.scope='{"kind":"platform"}'::jsonb OR
      (g.scope->>'kind'='district' AND g.scope->>'customerId'=connection.customer_id))) THEN
    RAISE EXCEPTION 'Device read authority is required.' USING ERRCODE='42501';
  END IF;
  RETURN connection;
END;
$$;

CREATE FUNCTION cc.device_sync_projection(p_customer text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT jsonb_build_object('customerId',c.customer_id,'generation',c.generation,'status',x.status,
    'observedAt',s.observed_at,'deviceCount',COALESCE(s.device_count,0),
    'failure',CASE WHEN x.status='failed' THEN COALESCE(CASE WHEN s.sync_id IS NOT NULL THEN 'interrupted' END,s.failure) END,
    'telemetryFailure',s.telemetry_failure,'startedAt',s.sync_started_at,'checkedAt',s.checked_at,
    'stale',COALESCE(s.observed_at IS NOT NULL AND
      (x.status='failed' OR s.observed_at<clock_timestamp()-interval '24 hours'),false))
  FROM cc.google_connection c
  LEFT JOIN cc.device_sync_state s ON s.customer_id=c.customer_id
  CROSS JOIN LATERAL (SELECT CASE
    WHEN s.sync_id IS NOT NULL AND s.sync_expires_at>clock_timestamp() THEN 'running'
    WHEN s.sync_id IS NOT NULL OR s.failure IS NOT NULL THEN 'failed'
    WHEN s.observed_at IS NOT NULL THEN 'ready'
    ELSE 'never' END AS status) x
  WHERE c.customer_id=p_customer;
$$;

CREATE FUNCTION cc.read_device_sync(p_actor uuid,p_version integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection;
BEGIN
  connection:=cc.device_reader(p_actor,p_version);
  IF connection.customer_id IS NULL THEN RETURN NULL; END IF;
  RETURN cc.visible_device_sync(p_actor,p_version,connection.customer_id);
END;
$$;

CREATE FUNCTION cc.request_device_sync(p_actor uuid,p_version integer,p_customer text,p_generation integer,
  p_id uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection; prior cc.device_sync_state; header record; now_at timestamptz;
BEGIN
  connection:=cc.device_reader(p_actor,p_version);
  IF connection.customer_id IS DISTINCT FROM p_customer OR connection.generation IS DISTINCT FROM p_generation OR
    connection.active IS NOT TRUE THEN
    RAISE EXCEPTION 'The Google connection changed.' USING DETAIL='connection-changed';
  END IF;
  IF p_id IS NULL OR p_correlation IS NULL THEN
    RAISE EXCEPTION 'The sync identifier is required.' USING ERRCODE='22023';
  END IF;
  -- An unclaimed sync expires quickly. A worker claim extends the lease while pages stage.
  -- S1 (B2b round 2): the first request of a customer creates the state row, and the customer key of that
  -- row takes the connection KEY SHARE lock. The requester principal row therefore locks before the state
  -- insert, as the credential functions take a principal row before the connection row (007
  -- cc.google_connection_actor).
  PERFORM 1 FROM cc.application_principals p WHERE p.id=p_actor FOR KEY SHARE;
  INSERT INTO cc.device_sync_state(customer_id) VALUES(p_customer) ON CONFLICT(customer_id) DO NOTHING;
  SELECT * INTO prior FROM cc.device_sync_state WHERE customer_id=p_customer FOR UPDATE;
  -- S1: the sync state row locks first. The customer-scoped header of the sync it replaces locks second,
  -- and a missing header rejects at once (B2b round 2, R1-F2). The purge keeps the header that the state
  -- names (017 cc.purge_jobs), so an expired sync stays replaceable.
  IF prior.sync_id IS NOT NULL THEN
    SELECT * INTO header FROM cc.jobs j WHERE j.job_id=prior.sync_id AND j.customer_id=p_customer FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'The device sync expired or changed.' USING DETAIL='device-sync-changed';
    END IF;
  END IF;
  -- S1 (R1-F2): the new header and the state reference the requester and the replaced sync actor, and the
  -- header and the publications reference the connection row. The actor of the replaced sync locks here.
  -- A new state row has no sync actor, and an existing state row took no connection lock at the insert
  -- above. This principal lock therefore precedes every connection lock as well. No insert or update below
  -- then waits. The clock reads after these waits, and the authority, the connection, and the replaced
  -- lease revalidate on fresh reads.
  PERFORM 1 FROM cc.application_principals p WHERE p.id=prior.sync_actor FOR KEY SHARE;
  PERFORM 1 FROM cc.google_connection c WHERE c.customer_id=p_customer FOR KEY SHARE;
  now_at:=clock_timestamp();
  connection:=cc.device_reader(p_actor,p_version);
  IF connection.customer_id IS DISTINCT FROM p_customer OR connection.generation IS DISTINCT FROM p_generation OR
    connection.active IS NOT TRUE THEN
    RAISE EXCEPTION 'The Google connection changed.' USING DETAIL='connection-changed';
  END IF;
  IF prior.sync_id IS NOT NULL AND prior.sync_expires_at>now_at THEN
    RAISE EXCEPTION 'A device sync is running.' USING DETAIL='device-sync-running';
  END IF;
  -- The header records every Refresh all with its requester. The sync ID is the header ID.
  INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,status,requested_by,generation,
    correlation_id,created_at,started_at)
  VALUES(p_id,cc.job_display_id('REF',nextval('cc.job_number_ref')),p_customer,'inventory-refresh','all-devices',
    'running',p_actor,p_generation,p_correlation,now_at,now_at);
  UPDATE cc.device_sync_state SET
    failure=CASE WHEN prior.sync_id IS NOT NULL THEN 'interrupted' ELSE failure END,
    failure_requested_by=CASE WHEN prior.sync_id IS NOT NULL THEN prior.sync_actor ELSE failure_requested_by END,
    checked_at=CASE WHEN prior.sync_id IS NOT NULL THEN prior.sync_expires_at ELSE checked_at END,
    sync_id=p_id,sync_actor=p_actor,sync_generation=p_generation,sync_attempt=NULL,
    sync_started_at=now_at,sync_expires_at=now_at+interval '2 minutes',correlation_id=p_correlation
  WHERE customer_id=p_customer;
  -- A request that replaces an expired sync closes its header as interrupted.
  IF prior.sync_id IS NOT NULL THEN PERFORM cc.close_refresh_job(prior.sync_id,'interrupted'); END IF;
  PERFORM cc.record_job_change(p_id,true);
  RETURN cc.visible_device_sync(p_actor,p_version,p_customer);
END;
$$;

CREATE FUNCTION cc.abandon_device_sync(p_actor uuid,p_version integer,p_customer text,p_id uuid,p_failure text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE pending cc.device_sync_state; header record; now_at timestamptz;
BEGIN
  PERFORM cc.device_reader(p_actor,p_version);
  IF p_failure IS DISTINCT FROM 'orchestration-unavailable' THEN
    RAISE EXCEPTION 'Only an undispatched sync can be abandoned.' USING ERRCODE='22023';
  END IF;
  -- S2: a null identifier never matches a state row or a header.
  IF p_customer IS NULL OR p_id IS NULL THEN
    RAISE EXCEPTION 'The sync identifier is required.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO pending FROM cc.device_sync_state WHERE customer_id=p_customer FOR UPDATE;
  -- S1: the state row locks first, the header second, and the clock third.
  -- The header type stays dynamic here, because 016 runs before 017 creates cc.jobs.
  SELECT * INTO header FROM cc.jobs j WHERE j.job_id=p_id AND j.customer_id=p_customer FOR UPDATE;
  -- S3: a superseded call changes nothing. A missing scoped header returns at once.
  IF NOT FOUND THEN
    RETURN cc.visible_device_sync(p_actor,p_version,p_customer);
  END IF;
  now_at:=clock_timestamp();
  IF pending.sync_id IS DISTINCT FROM p_id OR pending.sync_attempt IS NOT NULL OR
    header.status<>'running' OR header.finished_at IS NOT NULL THEN
    RETURN cc.visible_device_sync(p_actor,p_version,p_customer);
  END IF;
  -- S1 (B2b round 2): the state write references the failure requester, and the closure publication
  -- references the connection row. Those rows lock here, the principal row before the connection row, as
  -- the credential functions take them (007 cc.google_connection_actor), so no write below waits. The
  -- state and header locks hold every value that the fence read, and the clock reads again after these
  -- waits.
  PERFORM 1 FROM cc.application_principals p WHERE p.id=pending.sync_actor FOR KEY SHARE;
  PERFORM 1 FROM cc.google_connection c WHERE c.customer_id=p_customer FOR KEY SHARE;
  now_at:=clock_timestamp();
  UPDATE cc.device_sync_state SET failure=p_failure,failure_requested_by=sync_actor,checked_at=now_at,
    sync_id=NULL,sync_actor=NULL,sync_generation=NULL,sync_attempt=NULL,sync_expires_at=NULL
  WHERE customer_id=p_customer;
  PERFORM cc.close_refresh_job(p_id,'orchestration-unavailable');
  RETURN cc.visible_device_sync(p_actor,p_version,p_customer);
END;
$$;

CREATE FUNCTION cc.claim_device_sync(p_customer text,p_id uuid,p_attempt uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE pending cc.device_sync_state; header record; connection cc.google_connection; now_at timestamptz;
BEGIN
  -- S2: the fence rejects a null identifier, token, or attempt explicitly.
  IF p_customer IS NULL OR p_id IS NULL OR p_attempt IS NULL THEN
    RAISE EXCEPTION 'The device sync expired or changed.' USING DETAIL='device-sync-changed';
  END IF;
  -- Rule G (B2b round 3): advisory lock 7240173008 is the global access lock. The generation helper below
  -- takes it, so the claim takes it first, before any row lock. No claim then holds a row lock while it
  -- waits for that lock. The helper takes the lock again, and the lock is re-entrant.
  PERFORM pg_advisory_xact_lock(7240173008);
  SELECT * INTO pending FROM cc.device_sync_state WHERE customer_id=p_customer FOR UPDATE;
  -- S1: the state row locks first, the scoped header second, and the clock third. The header loads
  -- here, so the fence validates its presence and its running, unfinished lifecycle under the lock
  -- (round 6, R6-10).
  SELECT * INTO header FROM cc.jobs j WHERE j.job_id=p_id AND j.customer_id=p_customer FOR UPDATE;
  -- S1: a missing scoped header returns the rejection at once, before the clock and the state fence.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The device sync expired or changed.' USING DETAIL='device-sync-changed';
  END IF;
  -- The lease and lifecycle fence reads the clock after the state row lock and the header lock
  -- (review F3, S1).
  now_at:=clock_timestamp();
  IF header.status<>'running' OR header.finished_at IS NOT NULL OR
    pending.sync_id IS DISTINCT FROM p_id OR pending.sync_expires_at IS NULL OR pending.sync_expires_at<=now_at THEN
    RAISE EXCEPTION 'The device sync expired or changed.' USING DETAIL='device-sync-changed';
  END IF;
  IF pending.sync_attempt IS NOT NULL AND pending.sync_attempt<>p_attempt THEN
    RAISE EXCEPTION 'Another worker claimed this device sync.' USING DETAIL='device-sync-claimed';
  END IF;
  connection:=cc.google_current_generation(p_customer,pending.sync_generation);
  -- S1 rule 6 (B2b round 2, R1-F3): the generation helper waits on the advisory lock and on the connection
  -- row. After those waits the clock reads again, and the lease repeats before the claim writes its attempt
  -- or returns the credential envelope. The state and header locks hold every other value of the fence.
  now_at:=clock_timestamp();
  IF pending.sync_expires_at<=now_at THEN
    RAISE EXCEPTION 'The device sync expired or changed.' USING DETAIL='device-sync-changed';
  END IF;
  UPDATE cc.device_sync_state SET sync_attempt=p_attempt,sync_expires_at=now_at+interval '10 minutes'
  WHERE customer_id=p_customer;
  RETURN jsonb_build_object('generation',connection.generation,'credentialId',connection.credential_id,
    'envelope',(SELECT envelope FROM cc.google_credentials WHERE id=connection.credential_id));
END;
$$;

CREATE FUNCTION cc.device_sync_lease(p_customer text,p_id uuid,p_attempt uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE pending cc.device_sync_state; header record; now_at timestamptz;
BEGIN
  SELECT * INTO pending FROM cc.device_sync_state s WHERE s.customer_id=p_customer FOR UPDATE;
  -- S1: the state row locks first, the scoped header second, and the clock third. The header loads
  -- here, so the fence validates its presence and its running, unfinished lifecycle under the lock
  -- (round 6, R6-11).
  SELECT * INTO header FROM cc.jobs j WHERE j.job_id=p_id AND j.customer_id=p_customer FOR UPDATE;
  -- S1: a missing scoped header returns the rejection at once, before the clock and the state fence.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The device sync expired or changed.' USING DETAIL='device-sync-changed';
  END IF;
  now_at:=clock_timestamp();
  -- A null sync or attempt is rejected before the comparison (section 5.4, review F16, S2).
  -- The header lifecycle fence follows the same locks (round 6, R6-11).
  IF header.status<>'running' OR header.finished_at IS NOT NULL OR
    p_id IS NULL OR p_attempt IS NULL OR pending.sync_id IS DISTINCT FROM p_id OR
    pending.sync_attempt IS DISTINCT FROM p_attempt OR pending.sync_expires_at IS NULL OR
    pending.sync_expires_at<=now_at THEN
    RAISE EXCEPTION 'The device sync expired or changed.' USING DETAIL='device-sync-changed';
  END IF;
  UPDATE cc.device_sync_state SET sync_expires_at=now_at+interval '10 minutes'
  WHERE customer_id=p_customer;
END;
$$;

-- One device as the API and Redis carry it. Battery reads as unavailable after a telemetry failure.
CREATE FUNCTION cc.device_record(d cc.devices,p_telemetry_failure text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT jsonb_build_object('deviceId',d.device_id,'serialNumber',d.serial_number,'model',d.model,'assetTag',d.asset_tag,
    'orgUnitPath',d.org_unit_path,'lastContact',d.last_contact,'annotatedLocation',d.annotated_location,
    'annotatedUser',d.annotated_user,'notes',d.notes,
    'status',d.status,
    'battery',CASE WHEN p_telemetry_failure IS NOT NULL THEN jsonb_build_object('status','unavailable')
      WHEN d.battery_status='reported' THEN jsonb_build_object('status','reported','health',d.battery_health,
        'capacityPercent',d.battery_capacity_percent,'reportedAt',d.battery_reported_at)
      ELSE jsonb_build_object('status',d.battery_status) END,
    'lastEntitySync',d.last_entity_sync,'removedAt',d.removed_at);
$$;

-- Both sync kinds write through this upsert. A returned device is present again.
-- The observation kind orders a current read against a list (section 5.8).
CREATE FUNCTION cc.upsert_devices(p_customer text,p_devices jsonb,p_synced_at timestamptz,
  p_observation text DEFAULT 'list') RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE written integer;
BEGIN
  IF jsonb_typeof(p_devices) IS DISTINCT FROM 'array' OR jsonb_array_length(p_devices)>1000 OR
    p_synced_at IS NULL OR p_observation NOT IN ('read','list') THEN
    RAISE EXCEPTION 'The device page is invalid.' USING ERRCODE='22023';
  END IF;
  -- S1 (B2c F1): a page device without a row checks the connection foreign key on insert, and that
  -- check takes the connection row FOR KEY SHARE. The lock comes here, after the input check and
  -- before every device row, as cc.stage_devices takes it, so a full-sync finish never forms a
  -- lock cycle with this call.
  PERFORM 1 FROM cc.google_connection c WHERE c.customer_id=p_customer FOR KEY SHARE;
  -- Every function that reads or changes an overlay locks the device rows first (section 5.8).
  -- The lock waits for a concurrent settlement. The upsert statement then takes a fresh snapshot
  -- and sees the overlay that the settlement committed (review F1).
  PERFORM 1 FROM cc.devices d WHERE d.customer_id=p_customer AND d.device_id IN (
      SELECT e.value->>'deviceId' FROM jsonb_array_elements(p_devices) e)
    ORDER BY d.device_id FOR UPDATE;
  WITH incoming AS (
    SELECT DISTINCT ON (e.value->>'deviceId') e.value->>'deviceId' AS device_id,e.value AS row_value
    FROM jsonb_array_elements(p_devices) WITH ORDINALITY e(value,position)
    ORDER BY e.value->>'deviceId',e.position DESC
  ), upserted AS (
    INSERT INTO cc.devices(customer_id,device_id,serial_number,model,asset_tag,org_unit_path,last_contact,
      annotated_location,annotated_user,notes,status,last_entity_sync,annotated_location_observed_at,
      annotated_user_observed_at,notes_observed_at,org_unit_path_observed_at,status_observed_at)
    SELECT p_customer,i.device_id,i.row_value->>'serialNumber',i.row_value->>'model',i.row_value->>'assetTag',
      i.row_value->>'orgUnitPath',(i.row_value->>'lastContact')::timestamptz,i.row_value->>'annotatedLocation',
      i.row_value->>'annotatedUser',i.row_value->>'notes',i.row_value->>'status',p_synced_at,
      -- A read observation stamps every field that it observes (section 5.8 rule 2).
      CASE WHEN p_observation='read' THEN p_synced_at END,
      CASE WHEN p_observation='read' THEN p_synced_at END,
      CASE WHEN p_observation='read' THEN p_synced_at END,
      CASE WHEN p_observation='read' THEN p_synced_at END,
      CASE WHEN p_observation='read' THEN p_synced_at END
    FROM incoming i
    ON CONFLICT(customer_id,device_id) DO UPDATE SET
      serial_number=CASE WHEN cc.devices.last_entity_sync<=EXCLUDED.last_entity_sync THEN EXCLUDED.serial_number
        ELSE cc.devices.serial_number END,
      model=CASE WHEN cc.devices.last_entity_sync<=EXCLUDED.last_entity_sync THEN EXCLUDED.model
        ELSE cc.devices.model END,
      asset_tag=CASE WHEN cc.devices.last_entity_sync<=EXCLUDED.last_entity_sync THEN EXCLUDED.asset_tag
        ELSE cc.devices.asset_tag END,
      org_unit_path=CASE
        WHEN p_observation='read' AND (cc.devices.org_unit_path_observed_at IS NULL OR
          EXCLUDED.last_entity_sync>cc.devices.org_unit_path_observed_at) THEN EXCLUDED.org_unit_path
        WHEN p_observation='list' AND NOT EXISTS(SELECT 1 FROM cc.device_write_overlays o
          WHERE o.customer_id=cc.devices.customer_id AND o.device_id=cc.devices.device_id AND
            o.field='orgUnitPath' AND o.expires_at>clock_timestamp()) THEN EXCLUDED.org_unit_path
        ELSE cc.devices.org_unit_path END,
      org_unit_path_observed_at=CASE
        WHEN p_observation='read' AND (cc.devices.org_unit_path_observed_at IS NULL OR
          EXCLUDED.last_entity_sync>cc.devices.org_unit_path_observed_at) THEN EXCLUDED.last_entity_sync
        ELSE cc.devices.org_unit_path_observed_at END,
      last_contact=CASE WHEN cc.devices.last_entity_sync<=EXCLUDED.last_entity_sync THEN EXCLUDED.last_contact
        ELSE cc.devices.last_contact END,
      notes=CASE
        WHEN p_observation='read' AND (cc.devices.notes_observed_at IS NULL OR
          EXCLUDED.last_entity_sync>cc.devices.notes_observed_at) THEN EXCLUDED.notes
        WHEN p_observation='list' AND NOT EXISTS(SELECT 1 FROM cc.device_write_overlays o
          WHERE o.customer_id=cc.devices.customer_id AND o.device_id=cc.devices.device_id AND
            o.field='notes' AND o.expires_at>clock_timestamp()) THEN EXCLUDED.notes
        ELSE cc.devices.notes END,
      notes_observed_at=CASE
        WHEN p_observation='read' AND (cc.devices.notes_observed_at IS NULL OR
          EXCLUDED.last_entity_sync>cc.devices.notes_observed_at) THEN EXCLUDED.last_entity_sync
        ELSE cc.devices.notes_observed_at END,
      status=CASE
        WHEN p_observation='read' AND (cc.devices.status_observed_at IS NULL OR
          EXCLUDED.last_entity_sync>cc.devices.status_observed_at) THEN EXCLUDED.status
        WHEN p_observation='list' AND NOT EXISTS(SELECT 1 FROM cc.device_write_overlays o
          WHERE o.customer_id=cc.devices.customer_id AND o.device_id=cc.devices.device_id AND
            o.field='status' AND o.expires_at>clock_timestamp()) THEN EXCLUDED.status
        ELSE cc.devices.status END,
      last_entity_sync=CASE WHEN cc.devices.last_entity_sync<=EXCLUDED.last_entity_sync THEN EXCLUDED.last_entity_sync
        ELSE cc.devices.last_entity_sync END,
      removed_at=CASE WHEN cc.devices.last_entity_sync<=EXCLUDED.last_entity_sync THEN NULL
        ELSE cc.devices.removed_at END,
      status_observed_at=CASE
        WHEN p_observation='read' AND (cc.devices.status_observed_at IS NULL OR
          EXCLUDED.last_entity_sync>cc.devices.status_observed_at) THEN EXCLUDED.last_entity_sync
        ELSE cc.devices.status_observed_at END,
      annotated_location=CASE
        WHEN p_observation='read' AND (cc.devices.annotated_location_observed_at IS NULL OR
          EXCLUDED.last_entity_sync>cc.devices.annotated_location_observed_at) THEN EXCLUDED.annotated_location
        WHEN p_observation='list' AND NOT EXISTS(SELECT 1 FROM cc.device_write_overlays o
          WHERE o.customer_id=cc.devices.customer_id AND o.device_id=cc.devices.device_id AND
            o.field='annotatedLocation' AND o.expires_at>clock_timestamp()) THEN EXCLUDED.annotated_location
        ELSE cc.devices.annotated_location END,
      annotated_location_observed_at=CASE
        WHEN p_observation='read' AND (cc.devices.annotated_location_observed_at IS NULL OR
          EXCLUDED.last_entity_sync>cc.devices.annotated_location_observed_at) THEN EXCLUDED.last_entity_sync
        ELSE cc.devices.annotated_location_observed_at END,
      annotated_user=CASE
        WHEN p_observation='read' AND (cc.devices.annotated_user_observed_at IS NULL OR
          EXCLUDED.last_entity_sync>cc.devices.annotated_user_observed_at) THEN EXCLUDED.annotated_user
        WHEN p_observation='list' AND NOT EXISTS(SELECT 1 FROM cc.device_write_overlays o
          WHERE o.customer_id=cc.devices.customer_id AND o.device_id=cc.devices.device_id AND
            o.field='annotatedUser' AND o.expires_at>clock_timestamp()) THEN EXCLUDED.annotated_user
        ELSE cc.devices.annotated_user END,
      annotated_user_observed_at=CASE
        WHEN p_observation='read' AND (cc.devices.annotated_user_observed_at IS NULL OR
          EXCLUDED.last_entity_sync>cc.devices.annotated_user_observed_at) THEN EXCLUDED.last_entity_sync
        ELSE cc.devices.annotated_user_observed_at END
    WHERE cc.devices.last_entity_sync<=EXCLUDED.last_entity_sync OR (p_observation='read' AND
      ((cc.devices.annotated_location_observed_at IS NULL OR
        EXCLUDED.last_entity_sync>cc.devices.annotated_location_observed_at) OR
       (cc.devices.annotated_user_observed_at IS NULL OR
        EXCLUDED.last_entity_sync>cc.devices.annotated_user_observed_at) OR
       (cc.devices.notes_observed_at IS NULL OR
        EXCLUDED.last_entity_sync>cc.devices.notes_observed_at) OR
       (cc.devices.org_unit_path_observed_at IS NULL OR
        EXCLUDED.last_entity_sync>cc.devices.org_unit_path_observed_at) OR
       (cc.devices.status_observed_at IS NULL OR
        EXCLUDED.last_entity_sync>cc.devices.status_observed_at)))
    RETURNING cc.devices.device_id AS device_id,
      cc.devices.annotated_location AS annotated_location_value,cc.devices.annotated_user AS annotated_user_value,
      cc.devices.notes AS notes_value,cc.devices.org_unit_path AS org_unit_path_value,
      cc.devices.status AS status_value,
      (p_observation='read' AND cc.devices.annotated_location_observed_at IS NOT DISTINCT FROM p_synced_at)
        AS annotated_location_moved,
      (p_observation='read' AND cc.devices.annotated_user_observed_at IS NOT DISTINCT FROM p_synced_at)
        AS annotated_user_moved,
      (p_observation='read' AND cc.devices.notes_observed_at IS NOT DISTINCT FROM p_synced_at)
        AS notes_moved,
      (p_observation='read' AND cc.devices.org_unit_path_observed_at IS NOT DISTINCT FROM p_synced_at)
        AS org_unit_path_moved,
      (p_observation='read' AND cc.devices.status_observed_at IS NOT DISTINCT FROM p_synced_at)
        AS status_moved
  ), converged AS (
    DELETE FROM cc.device_write_overlays o USING upserted u,incoming i
    WHERE p_observation='list' AND o.customer_id=p_customer AND o.device_id=u.device_id AND
      o.expires_at>clock_timestamp() AND i.device_id=u.device_id AND
      ((o.field='annotatedLocation' AND o.value IS NOT DISTINCT FROM (i.row_value->>'annotatedLocation')) OR
       (o.field='annotatedUser' AND o.value IS NOT DISTINCT FROM (i.row_value->>'annotatedUser')) OR
       (o.field='notes' AND o.value IS NOT DISTINCT FROM (i.row_value->>'notes')) OR
       -- Google OU paths are case-insensitive, so a path converges without case.
       (o.field='orgUnitPath' AND lower(o.value)=lower(i.row_value->>'orgUnitPath')) OR
       (o.field='status' AND o.value IS NOT DISTINCT FROM (i.row_value->>'status')))
  ), moved AS (
    UPDATE cc.device_write_overlays o SET
      value=CASE o.field WHEN 'status' THEN u.status_value
        WHEN 'annotatedLocation' THEN u.annotated_location_value
        WHEN 'annotatedUser' THEN u.annotated_user_value WHEN 'notes' THEN u.notes_value
        ELSE u.org_unit_path_value END,
      observed_at=p_synced_at,source='refresh-read',expires_at=p_synced_at+interval '36 hours'
    FROM upserted u
    WHERE p_observation='read' AND o.customer_id=p_customer AND o.device_id=u.device_id AND
      o.expires_at>clock_timestamp() AND
      ((o.field='annotatedLocation' AND u.annotated_location_moved) OR
       (o.field='annotatedUser' AND u.annotated_user_moved) OR
       (o.field='notes' AND u.notes_moved) OR
       (o.field='orgUnitPath' AND u.org_unit_path_moved) OR
       (o.field='status' AND u.status_moved))
  )
  SELECT count(*) INTO written FROM upserted;
  RETURN written;
END;
$$;

CREATE FUNCTION cc.upsert_device_batteries(p_customer text,p_batteries jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE written integer;
BEGIN
  IF jsonb_typeof(p_batteries) IS DISTINCT FROM 'array' OR jsonb_array_length(p_batteries)>1000 THEN
    RAISE EXCEPTION 'The battery page is invalid.' USING ERRCODE='22023';
  END IF;
  -- Lock the written rows in device_id order first, so concurrent writers cannot deadlock.
  PERFORM 1 FROM cc.devices d WHERE d.customer_id=p_customer AND d.device_id IN (
      SELECT DISTINCT ON (x."deviceId") x."deviceId" FROM jsonb_to_recordset(p_batteries)
        AS x("deviceId" text,battery jsonb,reports jsonb))
    ORDER BY d.device_id FOR UPDATE;
  UPDATE cc.devices d SET battery_status=b.status,battery_health=b.health,battery_capacity_percent=b.capacity,
    battery_reported_at=b.reported_at,battery_reports=COALESCE(b.reports,'[]'::jsonb)
  FROM (SELECT DISTINCT ON (x."deviceId") x."deviceId" AS device_id,x.battery->>'status' AS status,
      x.battery->>'health' AS health,(x.battery->>'capacityPercent')::integer AS capacity,
      (x.battery->>'reportedAt')::timestamptz AS reported_at,x.reports
    FROM jsonb_to_recordset(p_batteries) AS x("deviceId" text,battery jsonb,reports jsonb)) b
  WHERE d.customer_id=p_customer AND d.device_id=b.device_id;
  GET DIAGNOSTICS written=ROW_COUNT;
  RETURN written;
END;
$$;

-- Google answered 404 for these devices. The rows stay.
CREATE FUNCTION cc.soft_delete_devices(p_customer text,p_ids jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE removed integer;
BEGIN
  IF jsonb_typeof(p_ids) IS DISTINCT FROM 'array' OR jsonb_array_length(p_ids)>1000 THEN
    RAISE EXCEPTION 'The device list is invalid.' USING ERRCODE='22023';
  END IF;
  -- Lock the requested rows in device_id order first, so concurrent writers cannot deadlock.
  -- Every requested row takes the lock, including a removed row that a refresh can revive (review F20).
  PERFORM 1 FROM cc.devices d WHERE d.customer_id=p_customer AND
      d.device_id IN (SELECT jsonb_array_elements_text(p_ids))
    ORDER BY d.device_id FOR UPDATE;
  UPDATE cc.devices SET removed_at=clock_timestamp()
  WHERE customer_id=p_customer AND removed_at IS NULL
    AND device_id IN (SELECT jsonb_array_elements_text(p_ids));
  GET DIAGNOSTICS removed=ROW_COUNT;
  RETURN removed;
END;
$$;

CREATE FUNCTION cc.read_device_records(p_customer text,p_ids jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('version',
      d.record_version+COALESCE(s.telemetry_version,1),
      'record',cc.device_record(d,s.telemetry_failure)-'removedAt') ORDER BY d.device_id),'[]'::jsonb)
  FROM cc.devices d LEFT JOIN cc.device_sync_state s ON s.customer_id=d.customer_id
  WHERE d.customer_id=p_customer AND d.removed_at IS NULL
    AND d.device_id IN (SELECT jsonb_array_elements_text(p_ids));
$$;

-- Present devices after p_after in device_id order. An empty p_after starts at the first device.
CREATE FUNCTION cc.page_device_records(p_customer text,p_after text,p_limit integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT COALESCE(jsonb_agg(entry ORDER BY device_id),'[]'::jsonb) FROM (
    SELECT d.device_id,jsonb_build_object('version',
      d.record_version+COALESCE(s.telemetry_version,1),
      'record',cc.device_record(d,s.telemetry_failure)-'removedAt') AS entry
    FROM cc.devices d LEFT JOIN cc.device_sync_state s ON s.customer_id=d.customer_id
    WHERE d.customer_id=p_customer AND d.removed_at IS NULL AND d.device_id>COALESCE(p_after,'')
    ORDER BY d.device_id LIMIT LEAST(GREATEST(p_limit,1),1000)) page;
$$;

-- Devices that the last finished full sync removed, after p_after in device_id order.
CREATE FUNCTION cc.page_last_removed_device_ids(p_customer text,p_after text,p_limit integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT COALESCE(jsonb_agg(device_id ORDER BY device_id),'[]'::jsonb) FROM (
    SELECT d.device_id FROM cc.devices d
    WHERE d.customer_id=p_customer AND d.device_id>COALESCE(p_after,'')
      AND d.removed_at=(SELECT s.checked_at FROM cc.device_sync_state s WHERE s.customer_id=p_customer)
    ORDER BY d.device_id LIMIT LEAST(GREATEST(p_limit,1),1000)) page;
$$;

CREATE FUNCTION cc.stage_devices(p_customer text,p_id uuid,p_attempt uuid,p_devices jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE staged integer; lease timestamptz; now_at timestamptz;
BEGIN
  -- S1: the lease helper locks the state row, then the header, then reads the clock and fences the attempt.
  PERFORM cc.device_sync_lease(p_customer,p_id,p_attempt);
  IF jsonb_typeof(p_devices) IS DISTINCT FROM 'array' OR jsonb_array_length(p_devices)>1000 THEN
    RAISE EXCEPTION 'The device page is invalid.' USING ERRCODE='22023';
  END IF;
  -- The header lock is already held by the lease helper. The device locks follow it (section 1.8, review F11).
  PERFORM 1 FROM cc.jobs j WHERE j.job_id=p_id AND j.customer_id=p_customer FOR UPDATE;
  -- S1 (B2b round 2, R1-F4): the device inserts and the publication reference the connection row, so it
  -- locks after the header and before the device rows, as every writer takes them. The device rows of the
  -- page then lock in device_id order, the set that cc.upsert_devices locks. After those waits the clock
  -- reads again, and the renewed lease repeats before any write.
  PERFORM 1 FROM cc.google_connection c WHERE c.customer_id=p_customer FOR KEY SHARE;
  PERFORM 1 FROM cc.devices d WHERE d.customer_id=p_customer AND d.device_id IN (
      SELECT e.value->>'deviceId' FROM jsonb_array_elements(p_devices) e)
    ORDER BY d.device_id FOR UPDATE;
  SELECT s.sync_expires_at INTO lease FROM cc.device_sync_state s WHERE s.customer_id=p_customer;
  now_at:=clock_timestamp();
  IF lease IS NULL OR lease<=now_at THEN
    RAISE EXCEPTION 'The device sync expired or changed.' USING DETAIL='device-sync-changed';
  END IF;
  -- Each staged device records its listed OrgUnit path on the job (section 1.3).
  -- The staged path wins over the cached device path, because the upsert below follows the list.
  INSERT INTO cc.job_targets(job_id,device_id,org_unit_path,observed_at)
  SELECT p_id,t.device_id,t.listed_path,clock_timestamp()
  FROM (SELECT DISTINCT ON (e.value->>'deviceId') e.value->>'deviceId' AS device_id,
      e.value->>'orgUnitPath' AS listed_path
    FROM jsonb_array_elements(p_devices) WITH ORDINALITY e(value,position)
    ORDER BY e.value->>'deviceId',e.position DESC) t
  ON CONFLICT(job_id,device_id) DO UPDATE SET org_unit_path=EXCLUDED.org_unit_path,observed_at=EXCLUDED.observed_at;
  staged:=cc.upsert_devices(p_customer,p_devices,clock_timestamp(),'list');
  -- S1 rule 6: a device that another session inserts in the same moment has no row to lock above, so the
  -- upsert can still wait on it. The lease repeats after the upsert and before the header and publication
  -- writes. A lapse in that wait raises, and the transaction commits no target or device change.
  now_at:=clock_timestamp();
  IF lease<=now_at THEN
    RAISE EXCEPTION 'The device sync expired or changed.' USING DETAIL='device-sync-changed';
  END IF;
  UPDATE cc.jobs SET succeeded=(SELECT count(*) FROM cc.job_targets t WHERE t.job_id=p_id) WHERE job_id=p_id;
  PERFORM cc.record_job_change(p_id,false);
  RETURN staged;
END;
$$;

CREATE FUNCTION cc.stage_device_batteries(p_customer text,p_id uuid,p_attempt uuid,p_batteries jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE lease timestamptz; now_at timestamptz; staged integer;
BEGIN
  PERFORM cc.device_sync_lease(p_customer,p_id,p_attempt);
  IF jsonb_typeof(p_batteries) IS DISTINCT FROM 'array' OR jsonb_array_length(p_batteries)>1000 THEN
    RAISE EXCEPTION 'The battery page is invalid.' USING ERRCODE='22023';
  END IF;
  -- S1 (B2b round 2, R1-F5): the device rows of the page lock in device_id order, the set that
  -- cc.upsert_device_batteries locks. After that wait the clock reads again, and the renewed lease repeats
  -- before any battery write. The battery update changes no key, so it takes no other lock.
  PERFORM 1 FROM cc.devices d WHERE d.customer_id=p_customer AND d.device_id IN (
      SELECT x."deviceId" FROM jsonb_to_recordset(p_batteries) AS x("deviceId" text,battery jsonb,reports jsonb))
    ORDER BY d.device_id FOR UPDATE;
  SELECT s.sync_expires_at INTO lease FROM cc.device_sync_state s WHERE s.customer_id=p_customer;
  now_at:=clock_timestamp();
  IF lease IS NULL OR lease<=now_at THEN
    RAISE EXCEPTION 'The device sync expired or changed.' USING DETAIL='device-sync-changed';
  END IF;
  staged:=cc.upsert_device_batteries(p_customer,p_batteries);
  -- S1 rule 6 (B2b round 3, R2-F2): the helper locks the page devices again from a fresh snapshot. A device
  -- that another session inserted during the wait above is visible only to that lock, so the helper can
  -- wait on it after the fence above. The lease repeats after the helper returns. A lapse raises, and the
  -- transaction commits no battery, device, or lease change.
  now_at:=clock_timestamp();
  IF lease<=now_at THEN
    RAISE EXCEPTION 'The device sync expired or changed.' USING DETAIL='device-sync-changed';
  END IF;
  RETURN staged;
END;
$$;

-- A successful full sync marks every device the enumeration did not touch as removed.
CREATE FUNCTION cc.finish_device_sync(p_customer text,p_id uuid,p_attempt uuid,p_failure text,p_telemetry_failure text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE pending cc.device_sync_state; header record; now_at timestamptz; staged integer;
BEGIN
  -- Rule G (B2b round 3): a successful finish reaches the global access lock (advisory lock 7240173008)
  -- through the generation helper, so every finish takes that lock first, before any row lock. The
  -- generation call still precedes the principal KEY SHARE below.
  PERFORM pg_advisory_xact_lock(7240173008);
  SELECT * INTO pending FROM cc.device_sync_state WHERE customer_id=p_customer FOR UPDATE;
  -- S1: the sync state row locks first, the header second, and the clock third (section 1.8, review F11).
  -- The header type stays dynamic here, because 016 runs before 017 creates cc.jobs.
  SELECT * INTO header FROM cc.jobs j WHERE j.job_id=p_id AND j.customer_id=p_customer FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The device sync expired or changed.' USING DETAIL='device-sync-changed';
  END IF;
  now_at:=clock_timestamp();
  IF p_id IS NULL OR p_attempt IS NULL OR pending.sync_id IS DISTINCT FROM p_id OR
    pending.sync_attempt IS DISTINCT FROM p_attempt OR pending.sync_expires_at IS NULL OR
    pending.sync_expires_at<=now_at OR header.status<>'running' OR
    header.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'The device sync expired or changed.' USING DETAIL='device-sync-changed';
  END IF;
  SELECT count(*) INTO staged FROM cc.job_targets t WHERE t.job_id=p_id;
  IF p_failure IS NULL THEN
    PERFORM cc.google_current_generation(p_customer,pending.sync_generation);
    -- The state write can name the sync actor as the telemetry failure requester. That principal row locks
    -- here, under the advisory lock of the generation helper, which every principal FOR UPDATE caller takes
    -- first (004, 007, 013), so the state write never waits on it.
    PERFORM 1 FROM cc.application_principals p WHERE p.id=pending.sync_actor FOR KEY SHARE;
    -- The removal locks every candidate row in device_id order first (section 1.8, review F11).
    -- A removed row that a refresh revives stays in the set, so the prelock covers the UPDATE (review F20).
    PERFORM 1 FROM cc.devices d WHERE d.customer_id=p_customer AND
        d.last_entity_sync<pending.sync_started_at
      ORDER BY d.device_id FOR UPDATE;
  ELSE
    -- S1 (B2b round 2, R1-F6): a failed finish reads no generation, so it holds no connection lock yet. Its
    -- state write names the failure requester, and its publication references the connection row. Those
    -- rows lock here, the principal row before the connection row, as the credential functions take them
    -- (007 cc.google_connection_actor), so no write below waits. A disconnected generation still records
    -- the failure, because this lock reads no generation.
    PERFORM 1 FROM cc.application_principals p WHERE p.id=pending.sync_actor FOR KEY SHARE;
    PERFORM 1 FROM cc.google_connection c WHERE c.customer_id=p_customer FOR KEY SHARE;
  END IF;
  -- The lease fence reads the database clock again after the device and connection locks (review F17,
  -- R1-F6).
  now_at:=clock_timestamp();
  IF pending.sync_expires_at<=now_at THEN
    RAISE EXCEPTION 'The device sync expired or changed.' USING DETAIL='device-sync-changed';
  END IF;
  IF p_failure IS NULL THEN
    UPDATE cc.devices SET removed_at=now_at
    WHERE customer_id=p_customer AND removed_at IS NULL AND last_entity_sync<pending.sync_started_at;
    UPDATE cc.device_sync_state SET generation=pending.sync_generation,observed_at=now_at,
      device_count=(SELECT count(*) FROM cc.devices WHERE customer_id=p_customer AND removed_at IS NULL),
      telemetry_failure=p_telemetry_failure,
      telemetry_failure_requested_by=CASE WHEN p_telemetry_failure IS NULL THEN NULL ELSE pending.sync_actor END,
      failure=NULL,failure_requested_by=NULL
    WHERE customer_id=p_customer;
    UPDATE cc.jobs SET target_count=staged,
      target_org_unit_paths=(SELECT COALESCE(array_agg(DISTINCT t.org_unit_path)
        FILTER (WHERE t.org_unit_path IS NOT NULL),'{}'::text[]) FROM cc.job_targets t WHERE t.job_id=p_id),
      succeeded=staged,status='completed',failure=NULL
    WHERE job_id=p_id;
  ELSE
    UPDATE cc.device_sync_state SET failure=p_failure,failure_requested_by=pending.sync_actor
    WHERE customer_id=p_customer;
    -- A failed finish records its observed target paths too (section 1.2, review F13).
    UPDATE cc.jobs SET target_count=staged,
      target_org_unit_paths=(SELECT COALESCE(array_agg(DISTINCT t.org_unit_path)
        FILTER (WHERE t.org_unit_path IS NOT NULL),'{}'::text[]) FROM cc.job_targets t WHERE t.job_id=p_id),
      status='failed',failure=p_failure WHERE job_id=p_id;
  END IF;
  UPDATE cc.device_sync_state SET checked_at=now_at,sync_id=NULL,sync_actor=NULL,sync_generation=NULL,
    sync_attempt=NULL,sync_expires_at=NULL
  WHERE customer_id=p_customer;
  UPDATE cc.jobs SET finished_at=now_at WHERE job_id=p_id;
  PERFORM cc.record_job_change(p_id,true);
  RETURN cc.device_sync_projection(p_customer);
END;
$$;

CREATE FUNCTION cc.entity_sync_job_projection(j cc.entity_sync_jobs) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT jsonb_build_object('jobId',j.job_id,'customerId',j.customer_id,'entityType',j.entity_type,
    'batchCount',j.batch_count,
    'completedBatches',(SELECT count(*) FROM cc.entity_sync_batches b WHERE b.job_id=j.job_id AND b.status='completed'),
    'failedBatches',(SELECT count(*) FROM cc.entity_sync_batches b WHERE b.job_id=j.job_id AND b.status='failed'),
    'failure',j.failure,'createdAt',j.created_at,'finishedAt',j.finished_at);
$$;

CREATE FUNCTION cc.create_entity_sync_job(p_actor uuid,p_version integer,p_customer text,p_type text,p_ids jsonb,
  p_batch_size integer,p_job uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection; job cc.entity_sync_jobs; now_at timestamptz;
BEGIN
  connection:=cc.device_reader(p_actor,p_version);
  IF connection.customer_id IS DISTINCT FROM p_customer OR connection.active IS NOT TRUE THEN
    RAISE EXCEPTION 'The Google connection changed.' USING DETAIL='connection-changed';
  END IF;
  IF p_job IS NULL OR p_correlation IS NULL OR jsonb_typeof(p_ids) IS DISTINCT FROM 'array' OR
    p_batch_size IS NULL OR p_batch_size NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'The job is invalid.' USING ERRCODE='22023';
  END IF;
  -- Device IDs travel into Google request paths. Only plain identifiers enter a job.
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
  connection:=cc.device_reader(p_actor,p_version);
  IF connection.customer_id IS DISTINCT FROM p_customer OR connection.active IS NOT TRUE THEN
    RAISE EXCEPTION 'The Google connection changed.' USING DETAIL='connection-changed';
  END IF;
  -- The header lands first. The refresh detail row shares its identity.
  INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,status,requested_by,generation,
    target_count,correlation_id,created_at,started_at)
  VALUES(p_job,cc.job_display_id('REF',nextval('cc.job_number_ref')),p_customer,'inventory-refresh','devices',
    'running',p_actor,connection.generation,jsonb_array_length(p_ids),p_correlation,now_at,now_at);
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

CREATE FUNCTION cc.abandon_entity_sync_job(p_actor uuid,p_version integer,p_customer text,p_job uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE header record; job cc.entity_sync_jobs; now_at timestamptz;
BEGIN
  PERFORM cc.device_reader(p_actor,p_version);
  -- S2: a null identifier never matches a header.
  IF p_customer IS NULL OR p_job IS NULL THEN
    RAISE EXCEPTION 'The job changed.' USING DETAIL='entity-sync-changed';
  END IF;
  -- S1: the job header locks before the detail row and before the clock. A header waiter holds no detail lock.
  -- The header type stays dynamic here, because 016 runs before 017 creates cc.jobs.
  SELECT * INTO header FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The job changed.' USING DETAIL='entity-sync-changed';
  END IF;
  -- S1: the clock reads after the header lock and the header lifecycle fence follows it, before any
  -- detail lock (round 6, R6-9). The detail row and the batch records read here without a lock.
  now_at:=clock_timestamp();
  IF header.kind<>'inventory-refresh' OR header.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'The job changed.' USING DETAIL='entity-sync-changed';
  END IF;
  SELECT * INTO job FROM cc.entity_sync_jobs u WHERE u.job_id=p_job;
  IF job.job_id IS NULL OR job.finished_at IS NOT NULL OR
    EXISTS(SELECT 1 FROM cc.entity_sync_batches b WHERE b.job_id=p_job) THEN
    RAISE EXCEPTION 'The job changed.' USING DETAIL='entity-sync-changed';
  END IF;
  -- S1: only after that validation does the detail row lock. The clock reads again after the wait
  -- and the fences repeat on the fresh rows (S1 rule 6).
  SELECT * INTO job FROM cc.entity_sync_jobs u WHERE u.job_id=p_job FOR UPDATE;
  -- S1 (B2b round 2): the closure publication references the connection row, so that row locks after the
  -- header and detail rows and before the clock. No write below then waits.
  PERFORM 1 FROM cc.google_connection c WHERE c.customer_id=p_customer FOR KEY SHARE;
  now_at:=clock_timestamp();
  IF job.job_id IS NULL OR job.finished_at IS NOT NULL OR
    EXISTS(SELECT 1 FROM cc.entity_sync_batches b WHERE b.job_id=p_job) THEN
    RAISE EXCEPTION 'The job changed.' USING DETAIL='entity-sync-changed';
  END IF;
  UPDATE cc.entity_sync_jobs SET failure='orchestration-unavailable',finished_at=now_at
  WHERE job_id=p_job RETURNING * INTO job;
  UPDATE cc.jobs SET status='failed',failure='orchestration-unavailable',finished_at=now_at WHERE job_id=p_job;
  PERFORM cc.record_job_change(p_job,true);
  RETURN cc.entity_sync_job_projection(job);
END;
$$;

-- The batch runner reads its slice and the credential envelope for the job's generation.
CREATE FUNCTION cc.read_entity_sync_batch(p_customer text,p_job uuid,p_batch integer) RETURNS jsonb
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
    'batchCount',job.batch_count,
    'ids',(SELECT COALESCE(jsonb_agg(e.value ORDER BY e.ordinality),'[]'::jsonb)
      FROM jsonb_array_elements(job.ids) WITH ORDINALITY e
      WHERE e.ordinality>p_batch*job.batch_size AND e.ordinality<=(p_batch+1)*job.batch_size));
END;
$$;

CREATE FUNCTION cc.finish_entity_sync_batch(p_customer text,p_job uuid,p_batch integer,p_failure text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE header record; job cc.entity_sync_jobs; recorded integer; now_at timestamptz;
  succeeded_units integer:=0; failed_units integer:=0;
BEGIN
  -- S1: the job header locks before the detail row, the clock, and the batch records. A waiter
  -- on this header therefore holds no detail lock (review round 5).
  -- The header type stays dynamic here, because 016 runs before 017 creates cc.jobs.
  SELECT * INTO header FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The entity sync job changed.' USING DETAIL='entity-sync-changed';
  END IF;
  IF header.kind<>'inventory-refresh' THEN
    RAISE EXCEPTION 'The entity sync job changed.' USING DETAIL='entity-sync-changed';
  END IF;
  -- S1: the clock reads after the header lock and the validation follows it, before any detail or
  -- batch lock (round 6, R6-8). The detail row reads here without a lock.
  now_at:=clock_timestamp();
  SELECT * INTO job FROM cc.entity_sync_jobs u WHERE u.job_id=p_job;
  IF job.job_id IS NULL OR p_batch IS NULL OR p_batch<0 OR p_batch>=job.batch_count THEN
    RAISE EXCEPTION 'The entity sync job changed.' USING DETAIL='entity-sync-changed';
  END IF;
  -- S3: a closed job keeps its outcome. The purge and an abandon close a job before all batches
  -- record, and a late batch never revives it (section 1.5, review F18).
  IF header.finished_at IS NOT NULL THEN
    RETURN cc.entity_sync_job_projection(job);
  END IF;
  -- S1: only after that validation does the detail row lock. The clock reads again after the wait
  -- and the fences repeat on the fresh row (S1 rule 6).
  SELECT * INTO job FROM cc.entity_sync_jobs u WHERE u.job_id=p_job FOR UPDATE;
  -- S1 (B2b round 2): the batch publication references the connection row, so that row locks after the
  -- header and detail rows and before the clock. No write below then waits.
  PERFORM 1 FROM cc.google_connection c WHERE c.customer_id=p_customer FOR KEY SHARE;
  now_at:=clock_timestamp();
  IF job.job_id IS NULL THEN
    RAISE EXCEPTION 'The entity sync job changed.' USING DETAIL='entity-sync-changed';
  END IF;
  IF job.finished_at IS NOT NULL THEN
    RETURN cc.entity_sync_job_projection(job);
  END IF;
  INSERT INTO cc.entity_sync_batches(job_id,batch,status,failure,finished_at)
  VALUES(p_job,p_batch,CASE WHEN p_failure IS NULL THEN 'completed' ELSE 'failed' END,p_failure,now_at)
  ON CONFLICT(job_id,batch) DO UPDATE SET status=EXCLUDED.status,failure=EXCLUDED.failure,finished_at=EXCLUDED.finished_at;
  SELECT count(*) INTO recorded FROM cc.entity_sync_batches WHERE job_id=p_job;
  -- The failure derives from the current batch records, so a replaced batch clears its failure.
  UPDATE cc.entity_sync_jobs SET
    failure=(SELECT b.failure FROM cc.entity_sync_batches b WHERE b.job_id=p_job AND b.status='failed'
      ORDER BY b.batch DESC LIMIT 1),
    finished_at=CASE WHEN recorded>=batch_count THEN now_at ELSE finished_at END
  WHERE job_id=p_job RETURNING * INTO job;
  -- The header counters recompute from the batch records. A replaced batch counts once.
  SELECT COALESCE(sum(LEAST(job.batch_size,jsonb_array_length(job.ids)-b.batch*job.batch_size)),0) INTO succeeded_units
  FROM cc.entity_sync_batches b WHERE b.job_id=p_job AND b.status='completed';
  SELECT COALESCE(sum(LEAST(job.batch_size,jsonb_array_length(job.ids)-b.batch*job.batch_size)),0) INTO failed_units
  FROM cc.entity_sync_batches b WHERE b.job_id=p_job AND b.status='failed';
  UPDATE cc.jobs SET succeeded=succeeded_units,failed=failed_units,failure=job.failure,
    finished_at=CASE WHEN recorded>=job.batch_count THEN now_at ELSE finished_at END,
    status=CASE WHEN recorded<job.batch_count THEN status
      WHEN NOT EXISTS(SELECT 1 FROM cc.entity_sync_batches b WHERE b.job_id=p_job AND b.status='failed')
        THEN 'completed'
      WHEN succeeded_units>0 THEN 'completed-with-errors' ELSE 'failed' END
  WHERE job_id=p_job;
  PERFORM cc.record_job_change(p_job,true);
  RETURN cc.entity_sync_job_projection(job);
END;
$$;

REVOKE ALL ON cc.device_sync_state,cc.devices,cc.entity_sync_jobs,cc.entity_sync_batches FROM PUBLIC;
REVOKE ALL ON FUNCTION cc.device_reader(uuid,integer),cc.device_sync_projection(text),
  cc.read_device_sync(uuid,integer),cc.request_device_sync(uuid,integer,text,integer,uuid,uuid),
  cc.abandon_device_sync(uuid,integer,text,uuid,text),cc.claim_device_sync(text,uuid,uuid),
  cc.device_sync_lease(text,uuid,uuid),cc.device_record(cc.devices,text),
  cc.upsert_devices(text,jsonb,timestamptz,text),cc.upsert_device_batteries(text,jsonb),cc.soft_delete_devices(text,jsonb),
  cc.read_device_records(text,jsonb),cc.page_device_records(text,text,integer),
  cc.page_last_removed_device_ids(text,text,integer),
  cc.stage_devices(text,uuid,uuid,jsonb),cc.stage_device_batteries(text,uuid,uuid,jsonb),
  cc.finish_device_sync(text,uuid,uuid,text,text),cc.entity_sync_job_projection(cc.entity_sync_jobs),
  cc.create_entity_sync_job(uuid,integer,text,text,jsonb,integer,uuid,uuid),
  cc.abandon_entity_sync_job(uuid,integer,text,uuid),cc.read_entity_sync_batch(text,uuid,integer),
  cc.finish_entity_sync_batch(text,uuid,integer,text),
  cc.bump_device_record_version(),cc.bump_telemetry_version() FROM PUBLIC;
