-- The target OrgUnit path of a selected refresh (design card K5 section 1.3).
-- It repeats 020 cc.create_entity_sync_job with the inventory of the job entity type: a user
-- refresh reads cc.users and a device refresh keeps cc.devices. The signature, the locks, the
-- lifecycle, and the projection are unchanged. Existing grants stay on the function.

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
  -- Each requested ID records its OrgUnit path at creation (section 1.3). The entity type picks the
  -- inventory. A device ID in a user refresh has no user row, so its path stays null.
  INSERT INTO cc.job_targets(job_id,device_id,org_unit_path,observed_at)
  SELECT p_job,e.value#>>'{}',CASE p_type WHEN 'user' THEN u.org_unit_path ELSE d.org_unit_path END,now_at
  FROM jsonb_array_elements(p_ids) e
  LEFT JOIN cc.users u ON p_type='user' AND u.customer_id=p_customer AND u.user_id=e.value#>>'{}'
  LEFT JOIN cc.devices d ON p_type='device' AND d.customer_id=p_customer AND d.device_id=e.value#>>'{}';
  -- The header names the distinct target paths at creation (section 1.2).
  UPDATE cc.jobs SET target_org_unit_paths=(SELECT COALESCE(array_agg(DISTINCT t.org_unit_path)
      FILTER (WHERE t.org_unit_path IS NOT NULL),'{}'::text[]) FROM cc.job_targets t WHERE t.job_id=p_job)
  WHERE job_id=p_job;
  PERFORM cc.record_job_change(p_job,true);
  RETURN cc.entity_sync_job_projection(job);
END;
$$;
