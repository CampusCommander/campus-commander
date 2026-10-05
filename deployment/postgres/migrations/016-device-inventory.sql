-- Device inventory publishes one complete sync per customer. Reads never take connection locks.
INSERT INTO cc.application_actions(action,scope_kinds) VALUES('devices:read',ARRAY['platform','district']);

CREATE TABLE cc.device_sync_state (
  customer_id text PRIMARY KEY REFERENCES cc.google_connection(customer_id),
  current_sync_id uuid,
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
  CHECK((current_sync_id IS NULL)=(observed_at IS NULL)),
  CHECK((sync_id IS NULL)=(sync_expires_at IS NULL))
);

CREATE TABLE cc.devices (
  customer_id text NOT NULL,
  sync_id uuid NOT NULL,
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
  CHECK((battery_status='reported')=(battery_health IS NOT NULL AND battery_reported_at IS NOT NULL)),
  PRIMARY KEY(sync_id,device_id)
);
CREATE INDEX devices_customer ON cc.devices(customer_id,sync_id);
CREATE INDEX devices_serial ON cc.devices(sync_id,serial_number,device_id);
CREATE INDEX devices_model ON cc.devices(sync_id,model,device_id);
CREATE INDEX devices_asset ON cc.devices(sync_id,asset_tag,device_id);
CREATE INDEX devices_org_unit ON cc.devices(sync_id,org_unit_path text_pattern_ops);
CREATE INDEX devices_contact ON cc.devices(sync_id,last_contact,device_id);

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
  INSERT INTO cc.device_sync_state(customer_id) VALUES(p_customer) ON CONFLICT(customer_id) DO NOTHING;
  SELECT * INTO prior FROM cc.device_sync_state WHERE customer_id=p_customer FOR UPDATE;
  IF prior.sync_id IS NOT NULL AND prior.sync_expires_at>now_at THEN
    RAISE EXCEPTION 'A device sync is running.' USING DETAIL='device-sync-running';
  END IF;
  UPDATE cc.device_sync_state SET
    failure=CASE WHEN prior.sync_id IS NOT NULL THEN 'interrupted' ELSE failure END,
    checked_at=CASE WHEN prior.sync_id IS NOT NULL THEN prior.sync_expires_at ELSE checked_at END,
    sync_id=p_id,sync_actor=p_actor,sync_generation=p_generation,sync_attempt=NULL,
    sync_started_at=now_at,sync_expires_at=now_at+interval '15 minutes',correlation_id=p_correlation
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

CREATE FUNCTION cc.stage_devices(p_customer text,p_id uuid,p_attempt uuid,p_devices jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE staged integer;
BEGIN
  PERFORM cc.device_sync_lease(p_customer,p_id,p_attempt);
  IF jsonb_typeof(p_devices) IS DISTINCT FROM 'array' OR jsonb_array_length(p_devices)>1000 THEN
    RAISE EXCEPTION 'The device page is invalid.' USING ERRCODE='22023';
  END IF;
  INSERT INTO cc.devices(customer_id,sync_id,device_id,serial_number,model,asset_tag,org_unit_path,last_contact,
    annotated_location,notes,status)
  SELECT DISTINCT ON (e.value->>'deviceId') p_customer,p_id,e.value->>'deviceId',e.value->>'serialNumber',
    e.value->>'model',e.value->>'assetTag',e.value->>'orgUnitPath',(e.value->>'lastContact')::timestamptz,
    e.value->>'annotatedLocation',e.value->>'notes',e.value->>'status'
  FROM jsonb_array_elements(p_devices) WITH ORDINALITY AS e(value,position)
  ORDER BY e.value->>'deviceId',e.position DESC
  ON CONFLICT(sync_id,device_id) DO UPDATE SET serial_number=EXCLUDED.serial_number,model=EXCLUDED.model,
    asset_tag=EXCLUDED.asset_tag,org_unit_path=EXCLUDED.org_unit_path,last_contact=EXCLUDED.last_contact,
    annotated_location=EXCLUDED.annotated_location,notes=EXCLUDED.notes,status=EXCLUDED.status;
  GET DIAGNOSTICS staged=ROW_COUNT;
  RETURN staged;
END;
$$;

CREATE FUNCTION cc.stage_device_batteries(p_customer text,p_id uuid,p_attempt uuid,p_batteries jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE staged integer;
BEGIN
  PERFORM cc.device_sync_lease(p_customer,p_id,p_attempt);
  IF jsonb_typeof(p_batteries) IS DISTINCT FROM 'array' OR jsonb_array_length(p_batteries)>1000 THEN
    RAISE EXCEPTION 'The battery page is invalid.' USING ERRCODE='22023';
  END IF;
  UPDATE cc.devices d SET battery_status=b.status,battery_health=b.health,battery_capacity_percent=b.capacity,
    battery_reported_at=b.reported_at,battery_reports=COALESCE(b.reports,'[]'::jsonb)
  FROM (SELECT DISTINCT ON (x."deviceId") x."deviceId" AS device_id,x.battery->>'status' AS status,
      x.battery->>'health' AS health,(x.battery->>'capacityPercent')::integer AS capacity,
      (x.battery->>'reportedAt')::timestamptz AS reported_at,x.reports
    FROM jsonb_to_recordset(p_batteries) AS x("deviceId" text,battery jsonb,reports jsonb)) b
  WHERE d.sync_id=p_id AND d.device_id=b.device_id;
  GET DIAGNOSTICS staged=ROW_COUNT;
  RETURN staged;
END;
$$;

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
    IF p_telemetry_failure IS NOT NULL THEN
      UPDATE cc.devices SET battery_status='unavailable',battery_health=NULL,battery_capacity_percent=NULL,
        battery_reported_at=NULL,battery_reports='[]'::jsonb
      WHERE sync_id=p_id;
    END IF;
    UPDATE cc.device_sync_state SET current_sync_id=p_id,generation=pending.sync_generation,observed_at=now_at,
      device_count=(SELECT count(*) FROM cc.devices WHERE sync_id=p_id),telemetry_failure=p_telemetry_failure,failure=NULL
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

CREATE FUNCTION cc.purge_device_syncs(p_customer text,p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE state cc.device_sync_state; removed integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'The purge limit is invalid.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO state FROM cc.device_sync_state WHERE customer_id=p_customer FOR SHARE;
  DELETE FROM cc.devices WHERE ctid IN (
    SELECT ctid FROM cc.devices WHERE customer_id=p_customer
      AND sync_id IS DISTINCT FROM state.current_sync_id AND sync_id IS DISTINCT FROM state.sync_id
    LIMIT p_limit);
  GET DIAGNOSTICS removed=ROW_COUNT;
  RETURN removed;
END;
$$;

REVOKE ALL ON cc.device_sync_state,cc.devices FROM PUBLIC;
REVOKE ALL ON FUNCTION cc.device_reader(uuid,integer),cc.device_sync_projection(text),
  cc.read_device_sync(uuid,integer),cc.request_device_sync(uuid,integer,text,integer,uuid,uuid),
  cc.abandon_device_sync(uuid,integer,text,uuid,text),cc.claim_device_sync(text,uuid,uuid),
  cc.device_sync_lease(text,uuid,uuid),cc.stage_devices(text,uuid,uuid,jsonb),
  cc.stage_device_batteries(text,uuid,uuid,jsonb),cc.finish_device_sync(text,uuid,uuid,text,text),
  cc.purge_device_syncs(text,integer) FROM PUBLIC;
