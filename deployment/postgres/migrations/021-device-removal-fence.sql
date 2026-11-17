-- Device presence and removal observations order against each other by their observation time.
-- A refresh read stamps its page before the Google call, and a 404 and a full-sync finish stamp
-- their absence at the observation. A presence answer older than the newest absence never clears the
-- removal, and a removal older than the newest presence never removes the row. A presence
-- observation newer than the newest removal restores the row, because it started after that absence.
CREATE OR REPLACE FUNCTION cc.upsert_devices(p_customer text,p_devices jsonb,p_synced_at timestamptz,
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
      asset_tag_observed_at,annotated_user_observed_at,notes_observed_at,org_unit_path_observed_at,
      status_observed_at)
    SELECT p_customer,i.device_id,i.row_value->>'serialNumber',i.row_value->>'model',i.row_value->>'assetTag',
      i.row_value->>'orgUnitPath',(i.row_value->>'lastContact')::timestamptz,i.row_value->>'annotatedLocation',
      i.row_value->>'annotatedUser',i.row_value->>'notes',i.row_value->>'status',p_synced_at,
      -- A read observation stamps every field that it observes (section 5.8 rule 2).
      CASE WHEN p_observation='read' THEN p_synced_at END,
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
      asset_tag=CASE
        WHEN p_observation='read' AND (cc.devices.asset_tag_observed_at IS NULL OR
          EXCLUDED.last_entity_sync>cc.devices.asset_tag_observed_at) THEN EXCLUDED.asset_tag
        WHEN p_observation='list' AND NOT EXISTS(SELECT 1 FROM cc.device_write_overlays o
          WHERE o.customer_id=cc.devices.customer_id AND o.device_id=cc.devices.device_id AND
            o.field='annotatedAssetId' AND o.expires_at>clock_timestamp()) THEN EXCLUDED.asset_tag
        ELSE cc.devices.asset_tag END,
      asset_tag_observed_at=CASE
        WHEN p_observation='read' AND (cc.devices.asset_tag_observed_at IS NULL OR
          EXCLUDED.last_entity_sync>cc.devices.asset_tag_observed_at) THEN EXCLUDED.last_entity_sync
        ELSE cc.devices.asset_tag_observed_at END,
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
      -- A presence observation clears a removal only when it is newer than that removal. An older
      -- refresh answer that lands after a newer absence leaves the removal in place.
      removed_at=CASE WHEN cc.devices.last_entity_sync<=EXCLUDED.last_entity_sync AND
        (cc.devices.removed_at IS NULL OR cc.devices.removed_at<EXCLUDED.last_entity_sync) THEN NULL
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
       (cc.devices.asset_tag_observed_at IS NULL OR
        EXCLUDED.last_entity_sync>cc.devices.asset_tag_observed_at) OR
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
      cc.devices.status AS status_value,cc.devices.asset_tag AS asset_tag_value,
      (p_observation='read' AND cc.devices.annotated_location_observed_at IS NOT DISTINCT FROM p_synced_at)
        AS annotated_location_moved,
      (p_observation='read' AND cc.devices.asset_tag_observed_at IS NOT DISTINCT FROM p_synced_at)
        AS asset_tag_moved,
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
       (o.field='annotatedAssetId' AND o.value IS NOT DISTINCT FROM (i.row_value->>'assetTag')) OR
       (o.field='annotatedUser' AND o.value IS NOT DISTINCT FROM (i.row_value->>'annotatedUser')) OR
       (o.field='notes' AND o.value IS NOT DISTINCT FROM (i.row_value->>'notes')) OR
       -- Google OU paths are case-insensitive, so a path converges without case.
       (o.field='orgUnitPath' AND lower(o.value)=lower(i.row_value->>'orgUnitPath')) OR
       (o.field='status' AND o.value IS NOT DISTINCT FROM (i.row_value->>'status')))
  ), moved AS (
    UPDATE cc.device_write_overlays o SET
      value=CASE o.field WHEN 'status' THEN u.status_value
        WHEN 'annotatedLocation' THEN u.annotated_location_value
        WHEN 'annotatedAssetId' THEN u.asset_tag_value
        WHEN 'annotatedUser' THEN u.annotated_user_value WHEN 'notes' THEN u.notes_value
        ELSE u.org_unit_path_value END,
      observed_at=p_synced_at,source='refresh-read',expires_at=p_synced_at+interval '36 hours'
    FROM upserted u
    WHERE p_observation='read' AND o.customer_id=p_customer AND o.device_id=u.device_id AND
      o.expires_at>clock_timestamp() AND
      ((o.field='annotatedLocation' AND u.annotated_location_moved) OR
       (o.field='annotatedAssetId' AND u.asset_tag_moved) OR
       (o.field='annotatedUser' AND u.annotated_user_moved) OR
       (o.field='notes' AND u.notes_moved) OR
       (o.field='orgUnitPath' AND u.org_unit_path_moved) OR
       (o.field='status' AND u.status_moved))
  )
  SELECT count(*) INTO written FROM upserted;
  RETURN written;
END;
$$;

-- A 404 carries its observation time, and it refuses an observation older than the newest presence.
DROP FUNCTION cc.soft_delete_devices(text,jsonb);

-- Google answered 404 for these devices at p_observed_at. The rows stay. A presence observation newer
-- than the 404 keeps its row, because the older 404 cannot remove a device that a later read returned.
-- A repeated absence moves an older tombstone to the newer observation, so a presence read that both
-- absences predate cannot restore the device. The result names the devices that this observation holds
-- removed, in device_id order. The worker evicts and publishes only those.
CREATE FUNCTION cc.soft_delete_devices(p_customer text,p_ids jsonb,p_observed_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE removed jsonb;
BEGIN
  IF jsonb_typeof(p_ids) IS DISTINCT FROM 'array' OR jsonb_array_length(p_ids)>1000 OR
    p_observed_at IS NULL THEN
    RAISE EXCEPTION 'The device list is invalid.' USING ERRCODE='22023';
  END IF;
  -- Lock the requested rows in device_id order first, so concurrent writers cannot deadlock.
  -- Every requested row takes the lock, including a removed row that a refresh can revive (review F20).
  PERFORM 1 FROM cc.devices d WHERE d.customer_id=p_customer AND
      d.device_id IN (SELECT jsonb_array_elements_text(p_ids))
    ORDER BY d.device_id FOR UPDATE;
  -- The removal carries the observation time, not the call time, so a read that started after this
  -- observation clears it and a read that started before it does not. A newer absence advances an
  -- older tombstone, so the fence always holds the newest absence.
  WITH observed AS (
    UPDATE cc.devices SET removed_at=p_observed_at
    WHERE customer_id=p_customer AND (removed_at IS NULL OR removed_at<p_observed_at)
      AND last_entity_sync<=p_observed_at
      AND device_id IN (SELECT jsonb_array_elements_text(p_ids))
    RETURNING device_id
  )
  SELECT COALESCE(jsonb_agg(device_id ORDER BY device_id),'[]'::jsonb) INTO removed FROM observed;
  RETURN removed;
END;
$$;

-- A successful full sync advances every absence it observes, including an older tombstone.
CREATE OR REPLACE FUNCTION cc.finish_device_sync(p_customer text,p_id uuid,p_attempt uuid,p_failure text,p_telemetry_failure text)
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
    -- The absence time is this finish, not the first absence. A repeated full sync moves the
    -- tombstone forward, so a held presence answer that both absences predate cannot restore the row.
    UPDATE cc.devices SET removed_at=now_at
    WHERE customer_id=p_customer AND (removed_at IS NULL OR removed_at<now_at)
      AND last_entity_sync<pending.sync_started_at;
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

REVOKE ALL ON FUNCTION cc.soft_delete_devices(text,jsonb,timestamptz) FROM PUBLIC;
