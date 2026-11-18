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

-- The read-back settlement is the fourth writer of cc.devices.removed_at. It carries the observation
-- time of the read-back answer, refuses an answer older than the newest presence or removal, advances
-- a repeated absence, and answers only the IDs that it holds removed. The worker publishes and evicts
-- only those IDs.
CREATE OR REPLACE FUNCTION cc.settle_device_update_operations(p_customer text,p_job uuid,p_token uuid,p_attempt uuid,
  p_kind text,p_results jsonb,p_observed_at timestamptz,p_failure text DEFAULT NULL,
  p_scope_failure text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.device_update_jobs; now_at timestamptz; bad integer; provenance text;
  before text; after text; first_batch integer; element jsonb:=NULL; candidates integer[];
  -- The cached field of a command or a status action: a status change writes `status` (addendum
  -- section 5). An update action writes its field rows instead.
  write_field text;
  -- True when the job's action writes the four fields of an update. The action never changes after
  -- confirm, so this read takes no lock (addendum section 4, result checks).
  action_is_update boolean;
  settled jsonb:='[]'::jsonb; devices jsonb:='[]'::jsonb; removed jsonb:='[]'::jsonb;
BEGIN
  -- S2 (round 2, F2): a null kind never matches NOT IN, so the kind rejects explicitly before any lock.
  -- `issue` records the answer of one command POST (section 4 step 3).
  IF p_kind IS NULL OR p_kind NOT IN ('write','read-back','issue') OR jsonb_typeof(p_results) IS DISTINCT FROM 'array' OR
    p_observed_at IS NULL OR p_attempt IS NULL THEN
    RAISE EXCEPTION 'The settlement is invalid.' USING ERRCODE='22023';
  END IF;
  -- S2 (B2c ruling 4): the job failure and the scope failure hold a value of their domain before any
  -- lock. A read-back settlement records neither, and a scope failure names a job failure.
  IF p_failure IS NOT NULL AND (NOT cc.job_failure_known(p_failure) OR p_kind='read-back') THEN
    RAISE EXCEPTION 'The settlement is invalid.' USING ERRCODE='22023';
  END IF;
  IF p_scope_failure IS NOT NULL AND (p_scope_failure NOT IN ('delegation-not-authorized','scope-mismatch') OR
    p_kind='read-back' OR p_failure IS NULL) THEN
    RAISE EXCEPTION 'The settlement is invalid.' USING ERRCODE='22023';
  END IF;
  -- The observation source of each kind: a 2xx write answer (section 7.1) or a read (section 5.7).
  -- An issue answer is a write answer too.
  provenance:=CASE p_kind WHEN 'read-back' THEN 'read-back' ELSE 'write-response' END;
  -- An update result carries `values` instead of `value` (addendum section 4). The action of the job
  -- decides the contract, and it never changes after confirm, so this read takes no lock.
  SELECT u.action='annotated-location' INTO action_is_update
  FROM cc.device_update_jobs u WHERE u.job_id=p_job;
  action_is_update:=COALESCE(action_is_update,false);
  -- S2/R6-1, round 2 F2, round 3 R2-F1: every result field holds a value of its domain, or the call rejects
  -- before any lock and changes nothing. No cast or CHECK below can then fail after a lock.
  -- 1. The operation number is a whole number from 1 to the integer limit.
  -- 2. The outcome is a transition of its kind (section 5.5). A write also accepts pending and skipped.
  -- 3. A present provenance names the source of its kind, and a success always names it (eng-lead ruling 1).
  -- 4. A value is null or a string that fits the device field (016 annotated_location CHECK).
  -- 5. The Google status and the retry counts are whole numbers. The retry counts are not negative.
  -- 6. A read-back delay is a timestamp.
  -- Each CASE tests the type before its cast, so the validation itself never fails.
  SELECT count(*) INTO bad FROM jsonb_array_elements(p_results) r
    WHERE jsonb_typeof(r) IS DISTINCT FROM 'object' OR
      CASE WHEN jsonb_typeof(r->'operationNumber')='number' AND pg_input_is_valid(r->>'operationNumber','integer')
        THEN (r->>'operationNumber')::integer<1 ELSE true END OR
      jsonb_typeof(r->'outcome') IS DISTINCT FROM 'string' OR
      (p_kind='write' AND r->>'outcome' NOT IN ('succeeded','failed','unknown','pending','skipped')) OR
      (p_kind='issue' AND r->>'outcome' NOT IN ('issued','failed','unknown','pending','skipped')) OR
      (p_kind='read-back' AND r->>'outcome' NOT IN ('succeeded','failed','unknown')) OR
      (r->>'verifiedBy' IS NOT NULL AND r->'verifiedBy' IS DISTINCT FROM to_jsonb(provenance)) OR
      (r->>'outcome'='succeeded' AND r->'verifiedBy' IS DISTINCT FROM to_jsonb(provenance)) OR
      (r->>'value' IS NOT NULL AND (jsonb_typeof(r->'value')<>'string' OR length(r->>'value')>4096)) OR
      CASE WHEN r->>'googleStatus' IS NULL THEN false
        ELSE jsonb_typeof(r->'googleStatus')<>'number' OR NOT pg_input_is_valid(r->>'googleStatus','integer') END OR
      CASE WHEN r->>'quotaRetries' IS NULL THEN false
        WHEN jsonb_typeof(r->'quotaRetries')='number' AND pg_input_is_valid(r->>'quotaRetries','integer')
        THEN (r->>'quotaRetries')::integer<0 ELSE true END OR
      CASE WHEN r->>'transientRetries' IS NULL THEN false
        WHEN jsonb_typeof(r->'transientRetries')='number' AND pg_input_is_valid(r->>'transientRetries','integer')
        THEN (r->>'transientRetries')::integer<0 ELSE true END OR
      CASE WHEN r->>'verifyAfter' IS NULL THEN false
        ELSE jsonb_typeof(r->'verifyAfter')<>'string' OR NOT pg_input_is_valid(r->>'verifyAfter','timestamptz') END OR
      -- An issued result names the digit command ID of its 2xx answer. No other issue result names one.
      CASE WHEN r->'commandId' IS NULL THEN r->>'outcome'='issued'
        ELSE jsonb_typeof(r->'commandId')<>'string' OR r->>'commandId' !~ '^[0-9]{1,20}$' OR r->>'outcome'<>'issued' END OR
      -- 7. An update result carries `values` when it publishes or reports a differing value, and no
      -- other result of an update names one. Every result of a command or status action names none.
      CASE WHEN action_is_update AND p_kind IN ('write','read-back') THEN
        CASE WHEN r->>'outcome'='succeeded' OR
            (r->>'outcome'='failed' AND r->>'outcomeReason'='value-differs')
          THEN jsonb_typeof(r->'values') IS DISTINCT FROM 'object'
          ELSE r ? 'values' END
        ELSE r ? 'values' END;
  IF bad>0 THEN
    RAISE EXCEPTION 'The settlement results are invalid.' USING ERRCODE='22023';
  END IF;
  -- 8. A present `values` names exactly the field rows of its operation, and each value fits the
  -- domain of its outcome (addendum section 4). Field rows never change after confirm, so these
  -- checks read them without a row lock and change nothing. PostgreSQL length() counts code points.
  SELECT count(*) INTO bad FROM jsonb_array_elements(p_results) r,
      LATERAL jsonb_object_keys(CASE WHEN jsonb_typeof(r->'values')='object' THEN r->'values'
        ELSE '{}'::jsonb END) k(field)
    WHERE NOT EXISTS(SELECT 1 FROM cc.device_update_operation_fields f
      WHERE f.job_id=p_job AND f.operation_number=(r->>'operationNumber')::integer AND f.field=k.field);
  IF bad>0 THEN
    RAISE EXCEPTION 'The settlement results are invalid.' USING ERRCODE='22023';
  END IF;
  SELECT count(*) INTO bad FROM jsonb_array_elements(p_results) r
    WHERE jsonb_typeof(r->'values')='object' AND EXISTS(
      SELECT 1 FROM cc.device_update_operation_fields f
      WHERE f.job_id=p_job AND f.operation_number=(r->>'operationNumber')::integer AND
        NOT ((r->'values') ? f.field));
  IF bad>0 THEN
    RAISE EXCEPTION 'The settlement results are invalid.' USING ERRCODE='22023';
  END IF;
  -- A published path holds a value with a leading '/', because 016 requires one. A failed path is
  -- evidence alone, so it may hold null. Every other field publishes null or a text value.
  SELECT count(*) INTO bad FROM (
    SELECT r->>'outcome' AS outcome,f.field AS field,(r->'values'->f.field) AS value
    FROM jsonb_array_elements(p_results) r
    JOIN cc.device_update_operation_fields f
      ON f.job_id=p_job AND f.operation_number=(r->>'operationNumber')::integer
    WHERE jsonb_typeof(r->'values')='object' AND ((r->'values') ? f.field)) v
  WHERE CASE WHEN v.value='null'::jsonb THEN v.field='orgUnitPath' AND v.outcome='succeeded'
    ELSE jsonb_typeof(v.value)<>'string' OR length(v.value #>> '{}')>4096 OR
      (v.field='orgUnitPath' AND v.outcome='succeeded' AND left(v.value #>> '{}',1)<>'/') END;
  IF bad>0 THEN
    RAISE EXCEPTION 'The settlement results are invalid.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  IF job.job_id IS NULL THEN
    RAISE EXCEPTION 'The device update job does not exist.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=p_job;
  -- S1: the clock and the header fence read under the header lock, before the descendant locks.
  now_at:=clock_timestamp();
  -- S2: a write or issue settlement rejects a null token explicitly. A read-back settlement stays
  -- attempt-fenced and token-independent, so a terminal job can settle its review (section 5.7).
  -- Review F1: command issuance reuses this ownership contract, so the issue kind takes every fence.
  IF p_kind IN ('write','issue') AND (p_token IS NULL OR detail.job_id IS NULL OR job.kind NOT IN ('device-update','device-command','device-status') OR
      job.status<>'running' OR job.finished_at IS NOT NULL OR detail.dispatch_token IS DISTINCT FROM p_token) THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  before:=job.status;
  -- S1/R6-1 (round 2, F2): the prefix names the eligible results under the header. Only their operation
  -- and device rows lock below, so a fenced result never waits on its operation or device row.
  SELECT array_agg(DISTINCT o.operation_number ORDER BY o.operation_number) INTO candidates
  FROM cc.device_update_operations o JOIN jsonb_array_elements(p_results) r
      ON o.operation_number=(r->>'operationNumber')::integer
    WHERE o.job_id=p_job AND (
      (p_kind IN ('write','issue') AND o.status='dispatched' AND o.attempt_id=p_attempt AND
        EXISTS(SELECT 1 FROM cc.device_update_batches b WHERE b.job_id=o.job_id AND b.batch=o.batch AND
          b.attempt_id=p_attempt AND b.lease_expires_at>now_at)) OR
      (p_kind='read-back' AND o.status='unknown' AND o.verify_attempt=p_attempt AND
        o.verify_lease_expires_at>now_at));
  IF candidates IS NULL THEN
    RETURN jsonb_build_object('outcome','settled','settled',settled,'publication',NULL);
  END IF;
  -- S1: the eligible operation rows lock after the header row and before the device rows, in operation_number
  -- order, so a concurrent verification claim serializes with the fences below (review F15). The detail row
  -- locks next, so the heartbeat write below never waits (round 2).
  PERFORM 1 FROM cc.device_update_operations o WHERE o.job_id=p_job AND o.operation_number=ANY(candidates)
    ORDER BY o.operation_number FOR UPDATE;
  SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=p_job FOR UPDATE;
  -- S1 (round 2): after those waits the clock reads again. The token repeats on the locked detail row, and
  -- a result whose lease lapsed in a wait leaves the device lock set. Review F1: an issue settlement
  -- repeats the token here too; read-back remains the one token-independent kind.
  now_at:=clock_timestamp();
  IF p_kind IN ('write','issue') AND (detail.job_id IS NULL OR detail.dispatch_token IS DISTINCT FROM p_token) THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  SELECT array_agg(o.operation_number ORDER BY o.operation_number) INTO candidates
  FROM cc.device_update_operations o WHERE o.job_id=p_job AND o.operation_number=ANY(candidates) AND (
      (p_kind IN ('write','issue') AND o.status='dispatched' AND o.attempt_id=p_attempt AND
        EXISTS(SELECT 1 FROM cc.device_update_batches b WHERE b.job_id=o.job_id AND b.batch=o.batch AND
          b.attempt_id=p_attempt AND b.lease_expires_at>now_at)) OR
      (p_kind='read-back' AND o.status='unknown' AND o.verify_attempt=p_attempt AND
        o.verify_lease_expires_at>now_at));
  IF candidates IS NULL THEN
    RETURN jsonb_build_object('outcome','settled','settled',settled,'publication',NULL);
  END IF;
  -- The action names the observation column of a command or status job. A Deprovision is a status
  -- change, so it publishes its requested `DEPROVISIONED`. An update action publishes each field row
  -- into its own column instead, so `write_field` stays null for it (section 4).
  write_field:=CASE detail.action WHEN 'disable' THEN 'status' WHEN 'reenable' THEN 'status'
    WHEN 'deprovision' THEN 'status' END;
  -- S1 (round 3): the overlay and publication rows reference the connection row, so their insert checks
  -- take a key-share lock on it. That lock comes here, before the device rows: a full-sync finish takes the
  -- connection row first and its device rows second (016, cc.finish_device_sync), so the two calls never
  -- form a lock cycle.
  PERFORM 1 FROM cc.google_connection c WHERE c.customer_id=p_customer FOR KEY SHARE;
  -- Every overlay writer locks its device rows in device_id order after the operation rows. Only the device
  -- rows that an eligible result changes lock: a published success and a read-back 404 (round 2, F2). The
  -- settlement kind decides the 404 removal, so an optional provenance never skips it (round 3, class of
  -- R2-F1, design sections 5.7 and 5.8 rule 7).
  PERFORM 1 FROM cc.devices d WHERE d.customer_id=p_customer AND d.device_id IN (
      SELECT o.device_id FROM cc.device_update_operations o JOIN jsonb_array_elements(p_results) r
        ON o.operation_number=(r->>'operationNumber')::integer
      WHERE o.job_id=p_job AND o.operation_number=ANY(candidates) AND (
        (r->>'outcome'='succeeded' AND r->>'verifiedBy' IN ('write-response','read-back')) OR
        (p_kind='read-back' AND r->>'outcome'='failed' AND r->>'outcomeReason'='not-found')))
    ORDER BY d.device_id FOR UPDATE;
  -- S1 (round 3): a published success replaces the overlay of its device. The overlay rows lock in device_id
  -- order after the device rows, as every overlay writer takes them. No write below then waits, so the clock
  -- below reads after every wait of this call.
  PERFORM 1 FROM cc.device_write_overlays w WHERE w.customer_id=p_customer AND
      (w.device_id,w.field) IN (
        SELECT o.device_id,f.field FROM cc.device_update_operations o
          JOIN jsonb_array_elements(p_results) r ON o.operation_number=(r->>'operationNumber')::integer
          JOIN cc.device_update_operation_fields f
            ON f.job_id=o.job_id AND f.operation_number=o.operation_number
        WHERE o.job_id=p_job AND o.operation_number=ANY(candidates) AND r->>'outcome'='succeeded'
        UNION ALL
        SELECT o.device_id,'status'::text FROM cc.device_update_operations o
          JOIN jsonb_array_elements(p_results) r ON o.operation_number=(r->>'operationNumber')::integer
        WHERE o.job_id=p_job AND o.operation_number=ANY(candidates) AND r->>'outcome'='succeeded' AND
          write_field='status')
    ORDER BY w.device_id,w.field FOR UPDATE;
  -- S1 (round 4, R4): the field rows of the eligible results lock next, in operation and contract-field
  -- order. A result without `values` leaves its field rows unchanged and locks none. The clock below
  -- then reads after this wait, so an attempt whose lease lapses in it changes nothing (review F3).
  PERFORM 1 FROM cc.device_update_operation_fields f
  WHERE f.job_id=p_job AND f.operation_number=ANY(candidates) AND EXISTS(
      SELECT 1 FROM jsonb_array_elements(p_results) r
      WHERE (r->>'operationNumber')::integer=f.operation_number AND
        jsonb_typeof(r->'values')='object' AND ((r->'values') ? f.field))
  ORDER BY f.operation_number,
    array_position(ARRAY['annotatedLocation','annotatedAssetId','annotatedUser','notes','orgUnitPath'],f.field)
  FOR UPDATE;
  -- The write and read-back lease fences below read the clock after every row lock (review F3, F15).
  now_at:=clock_timestamp();
  WITH results AS (
    SELECT (r->>'operationNumber')::integer AS operation_number,r FROM jsonb_array_elements(p_results) r
  ), eligible AS (
    SELECT res.operation_number,res.r,o.batch,o.device_id,
      -- An update carries its values in the field rows, so its operation value columns stay null
      -- (addendum sections 2 and 4). A command or a status change keeps the requested-value default.
      CASE WHEN action_is_update THEN NULL
        WHEN res.r ? 'value' THEN res.r->>'value' ELSE o.requested_value END AS value
    FROM results res JOIN cc.device_update_operations o ON o.job_id=p_job AND o.operation_number=res.operation_number
    -- Only a locked candidate settles, so no write below takes a row lock that the prefix did not decide.
    WHERE o.operation_number=ANY(candidates) AND ((p_kind IN ('write','issue') AND o.status='dispatched' AND o.attempt_id=p_attempt AND
        -- The attempt owns the batch of the operation with a live lease (section 5.4, review F3).
        EXISTS(SELECT 1 FROM cc.device_update_batches b WHERE b.job_id=o.job_id AND b.batch=o.batch AND
          b.attempt_id=p_attempt AND b.lease_expires_at>now_at)) OR
      (p_kind='read-back' AND o.status='unknown' AND o.verify_attempt=p_attempt AND
        o.verify_lease_expires_at>now_at))
  ), applied AS (
    UPDATE cc.device_update_operations o SET status=e.r->>'outcome',
      -- A stored status is an HTTP status from 100 to 599, or null when no answer arrived (fix D1).
      google_status=CASE WHEN (e.r->>'googleStatus')::integer BETWEEN 100 AND 599
        THEN (e.r->>'googleStatus')::integer END,
      google_reason=e.r->>'googleReason',
      quota_retries=COALESCE((e.r->>'quotaRetries')::integer,0),
      transient_retries=COALESCE((e.r->>'transientRetries')::integer,0),
      observed_value=e.value,
      observed_at=CASE WHEN e.r->>'outcome'='succeeded' AND NOT action_is_update THEN p_observed_at
        ELSE o.observed_at END,
      verified_by=e.r->>'verifiedBy',outcome_reason=e.r->>'outcomeReason',updated_at=now_at,
      -- An accepted issue stores Google's command and its first poll (section 4 step 3). The poll waits
      -- 15 s from this settlement. The watch window ends 30 days after the issue answer for Wipe user
      -- data and Powerwash (ruling 2), and 7 days after it for Reboot.
      command_id=CASE WHEN p_kind='issue' AND e.r->>'outcome'='issued' THEN e.r->>'commandId' ELSE o.command_id END,
      command_state=CASE WHEN p_kind='issue' AND e.r->>'outcome'='issued' THEN 'pending-delivery' ELSE o.command_state END,
      poll_after=CASE WHEN p_kind='issue' AND e.r->>'outcome'='issued' THEN now_at+interval '15 seconds' ELSE o.poll_after END,
      poll_deadline_at=CASE WHEN p_kind='issue' AND e.r->>'outcome'='issued'
        THEN p_observed_at+CASE WHEN detail.action IN ('wipe-users','powerwash') THEN interval '30 days'
          ELSE interval '7 days' END
        ELSE o.poll_deadline_at END,
      -- An open request keeps the read-back of this attempt and its delay (section 5.7, review F5).
      verify_attempt=CASE WHEN p_kind='write' AND e.r->>'outcome'='unknown' THEN p_attempt END,
      verify_lease_expires_at=CASE WHEN p_kind='write' AND e.r->>'outcome'='unknown'
        THEN p_observed_at+interval '120 seconds' END,
      verify_after=CASE WHEN p_kind='write' AND e.r->>'outcome'='unknown'
        THEN COALESCE((e.r->>'verifyAfter')::timestamptz,p_observed_at+interval '30 seconds') END
    FROM eligible e WHERE o.job_id=p_job AND o.operation_number=e.operation_number
    RETURNING o.operation_number,o.device_id,o.batch,o.status,e.value,e.r->>'verifiedBy' AS verified_by,
      e.r->>'outcomeReason' AS outcome_reason,e.r AS result
  ), field_applied AS (
    -- Each field row takes the value that its operation's result reported (addendum section 4). A
    -- result without `values` leaves its field rows unchanged.
    UPDATE cc.device_update_operation_fields f
      SET observed_value=(a.result->'values'->f.field) #>> '{}'
    FROM applied a
    WHERE f.job_id=p_job AND f.operation_number=a.operation_number AND
      jsonb_typeof(a.result->'values')='object' AND ((a.result->'values') ? f.field)
    RETURNING f.operation_number
  ), changes AS (
    -- One row per published device and field, after the current-value stamp rule of step 4 rule 2.
    -- `values` is read from the result, because a sibling CTE never reads another one's write.
    SELECT a.device_id,a.operation_number,a.verified_by,v.field,v.value
    FROM applied a
    JOIN cc.devices d ON d.customer_id=p_customer AND d.device_id=a.device_id
    CROSS JOIN LATERAL (
      SELECT f.field,(a.result->'values'->f.field) #>> '{}' AS value
      FROM cc.device_update_operation_fields f
      WHERE f.job_id=p_job AND f.operation_number=a.operation_number AND
        jsonb_typeof(a.result->'values')='object' AND ((a.result->'values') ? f.field)
      UNION ALL
      SELECT 'status',a.value WHERE write_field='status'
    ) v
    WHERE a.status='succeeded' AND a.verified_by IN ('write-response','read-back') AND
      CASE v.field
        WHEN 'annotatedLocation' THEN
          d.annotated_location_observed_at IS NULL OR p_observed_at>d.annotated_location_observed_at
        WHEN 'annotatedAssetId' THEN
          d.asset_tag_observed_at IS NULL OR p_observed_at>d.asset_tag_observed_at
        WHEN 'annotatedUser' THEN
          d.annotated_user_observed_at IS NULL OR p_observed_at>d.annotated_user_observed_at
        WHEN 'notes' THEN d.notes_observed_at IS NULL OR p_observed_at>d.notes_observed_at
        WHEN 'orgUnitPath' THEN
          d.org_unit_path_observed_at IS NULL OR p_observed_at>d.org_unit_path_observed_at
        ELSE d.status_observed_at IS NULL OR p_observed_at>d.status_observed_at END
  ), pivot AS (
    -- One source row per device, so one UPDATE sets each published field and its own stamp.
    SELECT c.device_id,c.operation_number,c.verified_by,
      bool_or(c.field='annotatedLocation') AS has_annotated_location,
      max(c.value) FILTER (WHERE c.field='annotatedLocation') AS annotated_location,
      bool_or(c.field='annotatedAssetId') AS has_asset_tag,
      max(c.value) FILTER (WHERE c.field='annotatedAssetId') AS asset_tag,
      bool_or(c.field='annotatedUser') AS has_annotated_user,
      max(c.value) FILTER (WHERE c.field='annotatedUser') AS annotated_user,
      bool_or(c.field='notes') AS has_notes,
      max(c.value) FILTER (WHERE c.field='notes') AS notes,
      bool_or(c.field='orgUnitPath') AS has_org_unit_path,
      max(c.value) FILTER (WHERE c.field='orgUnitPath') AS org_unit_path,
      bool_or(c.field='status') AS has_status,
      max(c.value) FILTER (WHERE c.field='status') AS status_value
    FROM changes c GROUP BY c.device_id,c.operation_number,c.verified_by
  ), published AS (
    UPDATE cc.devices d SET
      annotated_location=CASE WHEN v.has_annotated_location THEN v.annotated_location
        ELSE d.annotated_location END,
      annotated_location_observed_at=CASE WHEN v.has_annotated_location THEN p_observed_at
        ELSE d.annotated_location_observed_at END,
      asset_tag=CASE WHEN v.has_asset_tag THEN v.asset_tag ELSE d.asset_tag END,
      asset_tag_observed_at=CASE WHEN v.has_asset_tag THEN p_observed_at
        ELSE d.asset_tag_observed_at END,
      annotated_user=CASE WHEN v.has_annotated_user THEN v.annotated_user ELSE d.annotated_user END,
      annotated_user_observed_at=CASE WHEN v.has_annotated_user THEN p_observed_at
        ELSE d.annotated_user_observed_at END,
      notes=CASE WHEN v.has_notes THEN v.notes ELSE d.notes END,
      notes_observed_at=CASE WHEN v.has_notes THEN p_observed_at ELSE d.notes_observed_at END,
      org_unit_path=CASE WHEN v.has_org_unit_path THEN v.org_unit_path ELSE d.org_unit_path END,
      org_unit_path_observed_at=CASE WHEN v.has_org_unit_path THEN p_observed_at
        ELSE d.org_unit_path_observed_at END,
      status=CASE WHEN v.has_status THEN v.status_value ELSE d.status END,
      status_observed_at=CASE WHEN v.has_status THEN p_observed_at ELSE d.status_observed_at END
    FROM pivot v
    WHERE d.customer_id=p_customer AND d.device_id=v.device_id
    RETURNING d.device_id,v.operation_number,v.verified_by,
      v.has_annotated_location,v.annotated_location,v.has_asset_tag,v.asset_tag,
      v.has_annotated_user,v.annotated_user,
      v.has_notes,v.notes,v.has_org_unit_path,v.org_unit_path,v.has_status,v.status_value
  ), overlay AS (
    INSERT INTO cc.device_write_overlays(customer_id,device_id,field,value,observed_at,source,job_id,
      operation_number,expires_at)
    SELECT p_customer,p.device_id,v.field,v.value,p_observed_at,p.verified_by,p_job,p.operation_number,
      p_observed_at+interval '36 hours'
    FROM published p
    CROSS JOIN LATERAL (VALUES
      ('annotatedLocation',p.annotated_location,p.has_annotated_location),
      ('annotatedAssetId',p.asset_tag,p.has_asset_tag),
      ('annotatedUser',p.annotated_user,p.has_annotated_user),
      ('notes',p.notes,p.has_notes),
      ('orgUnitPath',p.org_unit_path,p.has_org_unit_path),
      ('status',p.status_value,p.has_status)) v(field,value,published_field)
    WHERE v.published_field
    ON CONFLICT(customer_id,device_id,field) DO UPDATE SET value=EXCLUDED.value,observed_at=EXCLUDED.observed_at,
      source=EXCLUDED.source,job_id=EXCLUDED.job_id,operation_number=EXCLUDED.operation_number,
      expires_at=EXCLUDED.expires_at
    RETURNING device_id
  ), missing AS (
    SELECT DISTINCT a.device_id FROM applied a WHERE p_kind='read-back' AND a.status='failed' AND
      a.outcome_reason='not-found'
  ), accepted AS (
    -- The removal carries the read-back observation time, not the settlement clock. A presence
    -- observation or an absence newer than this answer fences it. A repeated absence advances an
    -- older tombstone, so a held presence answer that both absences predate cannot restore the row.
    UPDATE cc.devices d SET removed_at=p_observed_at FROM missing m
    WHERE d.customer_id=p_customer AND d.device_id=m.device_id AND
      d.last_entity_sync<=p_observed_at AND (d.removed_at IS NULL OR d.removed_at<p_observed_at)
    RETURNING d.device_id
  )
  SELECT (SELECT COALESCE(jsonb_agg(jsonb_build_object('operationNumber',a.operation_number,'deviceId',a.device_id,
      'status',a.status,'batch',a.batch) ORDER BY a.operation_number),'[]'::jsonb) FROM applied a),
    (SELECT COALESCE(jsonb_agg(p.device_id ORDER BY p.device_id),'[]'::jsonb) FROM published p),
    (SELECT COALESCE(jsonb_agg(r.device_id ORDER BY r.device_id),'[]'::jsonb) FROM accepted r)
  INTO settled,devices,removed;
  IF jsonb_array_length(settled)=0 THEN
    RETURN jsonb_build_object('outcome','settled','settled',settled,'publication',NULL);
  END IF;
  -- S1 (B2c ruling 4): the job failure writes on the header row that this call holds from step 2. The
  -- write precedes the counters and the job change, so the publication element includes the failure.
  IF p_failure IS NOT NULL THEN
    UPDATE cc.jobs SET failure=COALESCE(failure,p_failure) WHERE job_id=p_job;
  END IF;
  SELECT min((s->>'batch')::integer) INTO first_batch FROM jsonb_array_elements(settled) s;
  PERFORM cc.refresh_device_update_counters(p_job);
  IF p_kind='read-back' AND before NOT IN ('accepted','queued','held','running') THEN
    UPDATE cc.jobs SET status=cc.device_update_terminal_status(p_job) WHERE job_id=p_job RETURNING status INTO after;
  ELSE
    after:=before;
  END IF;
  -- S1 (B2c ruling 5): the scope observation writes on the detail row that this call holds from step 4.
  -- One settlement records one observation, so the count and its latest code change together.
  UPDATE cc.device_update_jobs SET heartbeat_at=now_at,
    scope_observations=scope_observations+CASE WHEN p_scope_failure IS NULL THEN 0 ELSE 1 END,
    scope_failure=CASE WHEN p_scope_failure IS NULL THEN scope_failure ELSE p_scope_failure END
  WHERE job_id=p_job;
  element:=cc.record_job_change(p_job,after IS DISTINCT FROM before,devices,removed,first_batch);
  RETURN jsonb_build_object('outcome','settled','settled',settled,'published',devices,'removed',removed,
    'publication',element);
END;
$$;

REVOKE ALL ON FUNCTION cc.soft_delete_devices(text,jsonb,timestamptz) FROM PUBLIC;
