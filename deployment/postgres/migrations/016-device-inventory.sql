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
  CHECK((sync_id IS NULL)=(sync_expires_at IS NULL))
);

CREATE TABLE cc.devices (
  customer_id text NOT NULL REFERENCES cc.google_connection(customer_id),
  device_id text NOT NULL CHECK(length(device_id) BETWEEN 1 AND 128),
  serial_number text NOT NULL CHECK(length(serial_number)<=256),
  model text CHECK(length(model)<=256),
  asset_tag text CHECK(length(asset_tag)<=256),
  org_unit_path text NOT NULL CHECK(left(org_unit_path,1)='/' AND length(org_unit_path)<=4096),
  last_contact timestamptz,
  annotated_location text CHECK(length(annotated_location)<=4096),
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
  CHECK((battery_status='reported')=(battery_health IS NOT NULL AND battery_reported_at IS NOT NULL)),
  PRIMARY KEY(customer_id,device_id)
);
CREATE INDEX devices_serial ON cc.devices(customer_id,serial_number,device_id);
CREATE INDEX devices_model ON cc.devices(customer_id,model,device_id);
CREATE INDEX devices_asset ON cc.devices(customer_id,asset_tag,device_id);
CREATE INDEX devices_org_unit ON cc.devices(customer_id,org_unit_path text_pattern_ops);
CREATE INDEX devices_contact ON cc.devices(customer_id,last_contact,device_id);
CREATE INDEX devices_freshness ON cc.devices(customer_id,last_entity_sync);

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
  RETURN cc.device_sync_projection(connection.customer_id);
END;
$$;

CREATE FUNCTION cc.request_device_sync(p_actor uuid,p_version integer,p_customer text,p_generation integer,
  p_id uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection; prior cc.device_sync_state; now_at timestamptz:=clock_timestamp();
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
  INSERT INTO cc.device_sync_state(customer_id) VALUES(p_customer) ON CONFLICT(customer_id) DO NOTHING;
  SELECT * INTO prior FROM cc.device_sync_state WHERE customer_id=p_customer FOR UPDATE;
  IF prior.sync_id IS NOT NULL AND prior.sync_expires_at>now_at THEN
    RAISE EXCEPTION 'A device sync is running.' USING DETAIL='device-sync-running';
  END IF;
  UPDATE cc.device_sync_state SET
    failure=CASE WHEN prior.sync_id IS NOT NULL THEN 'interrupted' ELSE failure END,
    checked_at=CASE WHEN prior.sync_id IS NOT NULL THEN prior.sync_expires_at ELSE checked_at END,
    sync_id=p_id,sync_actor=p_actor,sync_generation=p_generation,sync_attempt=NULL,
    sync_started_at=now_at,sync_expires_at=now_at+interval '2 minutes',correlation_id=p_correlation
  WHERE customer_id=p_customer;
  RETURN cc.device_sync_projection(p_customer);
END;
$$;

CREATE FUNCTION cc.abandon_device_sync(p_actor uuid,p_version integer,p_customer text,p_id uuid,p_failure text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
BEGIN
  PERFORM cc.device_reader(p_actor,p_version);
  IF p_failure IS DISTINCT FROM 'orchestration-unavailable' THEN
    RAISE EXCEPTION 'Only an undispatched sync can be abandoned.' USING ERRCODE='22023';
  END IF;
  UPDATE cc.device_sync_state SET failure=p_failure,checked_at=clock_timestamp(),sync_id=NULL,sync_actor=NULL,
    sync_generation=NULL,sync_attempt=NULL,sync_expires_at=NULL
  WHERE customer_id=p_customer AND sync_id=p_id AND sync_attempt IS NULL;
  RETURN cc.device_sync_projection(p_customer);
END;
$$;

CREATE FUNCTION cc.claim_device_sync(p_customer text,p_id uuid,p_attempt uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE pending cc.device_sync_state; connection cc.google_connection; now_at timestamptz:=clock_timestamp();
BEGIN
  SELECT * INTO pending FROM cc.device_sync_state WHERE customer_id=p_customer FOR UPDATE;
  IF p_id IS NULL OR p_attempt IS NULL OR pending.sync_id IS DISTINCT FROM p_id OR pending.sync_expires_at<=now_at THEN
    RAISE EXCEPTION 'The device sync expired or changed.' USING DETAIL='device-sync-changed';
  END IF;
  IF pending.sync_attempt IS NOT NULL AND pending.sync_attempt<>p_attempt THEN
    RAISE EXCEPTION 'Another worker claimed this device sync.' USING DETAIL='device-sync-claimed';
  END IF;
  connection:=cc.google_current_generation(p_customer,pending.sync_generation);
  UPDATE cc.device_sync_state SET sync_attempt=p_attempt,sync_expires_at=now_at+interval '10 minutes'
  WHERE customer_id=p_customer;
  RETURN jsonb_build_object('generation',connection.generation,'credentialId',connection.credential_id,
    'envelope',(SELECT envelope FROM cc.google_credentials WHERE id=connection.credential_id));
END;
$$;

CREATE FUNCTION cc.device_sync_lease(p_customer text,p_id uuid,p_attempt uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE now_at timestamptz:=clock_timestamp();
BEGIN
  UPDATE cc.device_sync_state SET sync_expires_at=now_at+interval '10 minutes'
  WHERE customer_id=p_customer AND sync_id=p_id AND sync_attempt=p_attempt AND sync_expires_at>now_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The device sync expired or changed.' USING DETAIL='device-sync-changed';
  END IF;
END;
$$;

-- One device as the API and Redis carry it. Battery reads as unavailable after a telemetry failure.
CREATE FUNCTION cc.device_record(d cc.devices,p_telemetry_failure text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT jsonb_build_object('deviceId',d.device_id,'serialNumber',d.serial_number,'model',d.model,'assetTag',d.asset_tag,
    'orgUnitPath',d.org_unit_path,'lastContact',d.last_contact,'annotatedLocation',d.annotated_location,'notes',d.notes,
    'battery',CASE WHEN p_telemetry_failure IS NOT NULL THEN jsonb_build_object('status','unavailable')
      WHEN d.battery_status='reported' THEN jsonb_build_object('status','reported','health',d.battery_health,
        'capacityPercent',d.battery_capacity_percent,'reportedAt',d.battery_reported_at)
      ELSE jsonb_build_object('status',d.battery_status) END,
    'lastEntitySync',d.last_entity_sync,'removedAt',d.removed_at);
$$;

-- Both sync kinds write through this upsert. A returned device is present again.
CREATE FUNCTION cc.upsert_devices(p_customer text,p_devices jsonb,p_synced_at timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE written integer;
BEGIN
  IF jsonb_typeof(p_devices) IS DISTINCT FROM 'array' OR jsonb_array_length(p_devices)>1000 OR p_synced_at IS NULL THEN
    RAISE EXCEPTION 'The device page is invalid.' USING ERRCODE='22023';
  END IF;
  INSERT INTO cc.devices(customer_id,device_id,serial_number,model,asset_tag,org_unit_path,last_contact,
    annotated_location,notes,status,last_entity_sync)
  SELECT DISTINCT ON (e.value->>'deviceId') p_customer,e.value->>'deviceId',e.value->>'serialNumber',
    e.value->>'model',e.value->>'assetTag',e.value->>'orgUnitPath',(e.value->>'lastContact')::timestamptz,
    e.value->>'annotatedLocation',e.value->>'notes',e.value->>'status',p_synced_at
  FROM jsonb_array_elements(p_devices) WITH ORDINALITY AS e(value,position)
  ORDER BY e.value->>'deviceId',e.position DESC
  ON CONFLICT(customer_id,device_id) DO UPDATE SET serial_number=EXCLUDED.serial_number,model=EXCLUDED.model,
    asset_tag=EXCLUDED.asset_tag,org_unit_path=EXCLUDED.org_unit_path,last_contact=EXCLUDED.last_contact,
    annotated_location=EXCLUDED.annotated_location,notes=EXCLUDED.notes,status=EXCLUDED.status,
    last_entity_sync=EXCLUDED.last_entity_sync,removed_at=NULL
  WHERE cc.devices.last_entity_sync<=EXCLUDED.last_entity_sync;
  GET DIAGNOSTICS written=ROW_COUNT;
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
  UPDATE cc.devices SET removed_at=clock_timestamp()
  WHERE customer_id=p_customer AND removed_at IS NULL
    AND device_id IN (SELECT jsonb_array_elements_text(p_ids));
  GET DIAGNOSTICS removed=ROW_COUNT;
  RETURN removed;
END;
$$;

CREATE FUNCTION cc.read_device_records(p_customer text,p_ids jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT COALESCE(jsonb_agg(cc.device_record(d,s.telemetry_failure) ORDER BY d.device_id),'[]'::jsonb)
  FROM cc.devices d LEFT JOIN cc.device_sync_state s ON s.customer_id=d.customer_id
  WHERE d.customer_id=p_customer AND d.removed_at IS NULL
    AND d.device_id IN (SELECT jsonb_array_elements_text(p_ids));
$$;

-- Present devices after p_after in device_id order. An empty p_after starts at the first device.
CREATE FUNCTION cc.page_device_records(p_customer text,p_after text,p_limit integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT COALESCE(jsonb_agg(record ORDER BY device_id),'[]'::jsonb) FROM (
    SELECT d.device_id,cc.device_record(d,s.telemetry_failure) AS record
    FROM cc.devices d LEFT JOIN cc.device_sync_state s ON s.customer_id=d.customer_id
    WHERE d.customer_id=p_customer AND d.removed_at IS NULL AND d.device_id>COALESCE(p_after,'')
    ORDER BY d.device_id LIMIT LEAST(GREATEST(p_limit,1),1000)) page;
$$;

CREATE FUNCTION cc.stage_devices(p_customer text,p_id uuid,p_attempt uuid,p_devices jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
BEGIN
  PERFORM cc.device_sync_lease(p_customer,p_id,p_attempt);
  RETURN cc.upsert_devices(p_customer,p_devices,clock_timestamp());
END;
$$;

CREATE FUNCTION cc.stage_device_batteries(p_customer text,p_id uuid,p_attempt uuid,p_batteries jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
BEGIN
  PERFORM cc.device_sync_lease(p_customer,p_id,p_attempt);
  RETURN cc.upsert_device_batteries(p_customer,p_batteries);
END;
$$;

-- A successful full sync marks every device the enumeration did not touch as removed.
CREATE FUNCTION cc.finish_device_sync(p_customer text,p_id uuid,p_attempt uuid,p_failure text,p_telemetry_failure text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE pending cc.device_sync_state; now_at timestamptz:=clock_timestamp();
BEGIN
  SELECT * INTO pending FROM cc.device_sync_state WHERE customer_id=p_customer FOR UPDATE;
  IF p_id IS NULL OR p_attempt IS NULL OR pending.sync_id IS DISTINCT FROM p_id OR
    pending.sync_attempt IS DISTINCT FROM p_attempt OR pending.sync_expires_at<=now_at THEN
    RAISE EXCEPTION 'The device sync expired or changed.' USING DETAIL='device-sync-changed';
  END IF;
  IF p_failure IS NULL THEN
    PERFORM cc.google_current_generation(p_customer,pending.sync_generation);
    UPDATE cc.devices SET removed_at=now_at
    WHERE customer_id=p_customer AND removed_at IS NULL AND last_entity_sync<pending.sync_started_at;
    UPDATE cc.device_sync_state SET generation=pending.sync_generation,observed_at=now_at,
      device_count=(SELECT count(*) FROM cc.devices WHERE customer_id=p_customer AND removed_at IS NULL),
      telemetry_failure=p_telemetry_failure,failure=NULL
    WHERE customer_id=p_customer;
  ELSE
    UPDATE cc.device_sync_state SET failure=p_failure WHERE customer_id=p_customer;
  END IF;
  UPDATE cc.device_sync_state SET checked_at=now_at,sync_id=NULL,sync_actor=NULL,sync_generation=NULL,
    sync_attempt=NULL,sync_expires_at=NULL
  WHERE customer_id=p_customer;
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
DECLARE connection cc.google_connection; job cc.entity_sync_jobs;
BEGIN
  connection:=cc.device_reader(p_actor,p_version);
  IF connection.customer_id IS DISTINCT FROM p_customer OR connection.active IS NOT TRUE THEN
    RAISE EXCEPTION 'The Google connection changed.' USING DETAIL='connection-changed';
  END IF;
  IF p_job IS NULL OR p_correlation IS NULL OR jsonb_typeof(p_ids) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'The job is invalid.' USING ERRCODE='22023';
  END IF;
  INSERT INTO cc.entity_sync_jobs(job_id,customer_id,entity_type,generation,ids,batch_size,batch_count,requested_by,correlation_id)
  VALUES(p_job,p_customer,p_type,connection.generation,p_ids,p_batch_size,
    ceil(jsonb_array_length(p_ids)::numeric/p_batch_size)::integer,p_actor,p_correlation)
  RETURNING * INTO job;
  RETURN cc.entity_sync_job_projection(job);
END;
$$;

CREATE FUNCTION cc.abandon_entity_sync_job(p_actor uuid,p_version integer,p_customer text,p_job uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.entity_sync_jobs;
BEGIN
  PERFORM cc.device_reader(p_actor,p_version);
  UPDATE cc.entity_sync_jobs SET failure='orchestration-unavailable',finished_at=clock_timestamp()
  WHERE job_id=p_job AND customer_id=p_customer AND finished_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM cc.entity_sync_batches b WHERE b.job_id=p_job)
  RETURNING * INTO job;
  IF job.job_id IS NULL THEN
    RAISE EXCEPTION 'The job changed.' USING DETAIL='entity-sync-changed';
  END IF;
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
DECLARE job cc.entity_sync_jobs; recorded integer; now_at timestamptz:=clock_timestamp();
BEGIN
  SELECT * INTO job FROM cc.entity_sync_jobs WHERE job_id=p_job AND customer_id=p_customer FOR UPDATE;
  IF job.job_id IS NULL OR p_batch IS NULL OR p_batch<0 OR p_batch>=job.batch_count THEN
    RAISE EXCEPTION 'The entity sync job changed.' USING DETAIL='entity-sync-changed';
  END IF;
  INSERT INTO cc.entity_sync_batches(job_id,batch,status,failure,finished_at)
  VALUES(p_job,p_batch,CASE WHEN p_failure IS NULL THEN 'completed' ELSE 'failed' END,p_failure,now_at)
  ON CONFLICT(job_id,batch) DO UPDATE SET status=EXCLUDED.status,failure=EXCLUDED.failure,finished_at=EXCLUDED.finished_at;
  SELECT count(*) INTO recorded FROM cc.entity_sync_batches WHERE job_id=p_job;
  UPDATE cc.entity_sync_jobs SET
    failure=COALESCE(failure,p_failure),
    finished_at=CASE WHEN recorded>=batch_count THEN now_at ELSE finished_at END
  WHERE job_id=p_job RETURNING * INTO job;
  RETURN cc.entity_sync_job_projection(job);
END;
$$;

CREATE FUNCTION cc.purge_entity_sync_jobs(p_customer text,p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE removed integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'The purge limit is invalid.' USING ERRCODE='22023';
  END IF;
  DELETE FROM cc.entity_sync_jobs WHERE job_id IN (
    SELECT job_id FROM cc.entity_sync_jobs
    WHERE customer_id=p_customer AND finished_at<clock_timestamp()-interval '1 day'
    ORDER BY finished_at LIMIT p_limit);
  GET DIAGNOSTICS removed=ROW_COUNT;
  RETURN removed;
END;
$$;

REVOKE ALL ON cc.device_sync_state,cc.devices,cc.entity_sync_jobs,cc.entity_sync_batches FROM PUBLIC;
REVOKE ALL ON FUNCTION cc.device_reader(uuid,integer),cc.device_sync_projection(text),
  cc.read_device_sync(uuid,integer),cc.request_device_sync(uuid,integer,text,integer,uuid,uuid),
  cc.abandon_device_sync(uuid,integer,text,uuid,text),cc.claim_device_sync(text,uuid,uuid),
  cc.device_sync_lease(text,uuid,uuid),cc.device_record(cc.devices,text),
  cc.upsert_devices(text,jsonb,timestamptz),cc.upsert_device_batteries(text,jsonb),cc.soft_delete_devices(text,jsonb),
  cc.read_device_records(text,jsonb),cc.page_device_records(text,text,integer),
  cc.stage_devices(text,uuid,uuid,jsonb),cc.stage_device_batteries(text,uuid,uuid,jsonb),
  cc.finish_device_sync(text,uuid,uuid,text,text),cc.entity_sync_job_projection(cc.entity_sync_jobs),
  cc.create_entity_sync_job(uuid,integer,text,text,jsonb,integer,uuid,uuid),
  cc.abandon_entity_sync_job(uuid,integer,text,uuid),cc.read_entity_sync_batch(text,uuid,integer),
  cc.finish_entity_sync_batch(text,uuid,integer,text),cc.purge_entity_sync_jobs(text,integer) FROM PUBLIC;
