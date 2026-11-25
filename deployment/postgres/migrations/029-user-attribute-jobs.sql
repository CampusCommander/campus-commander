-- K24: the value job worker. Document B sections 7.2, 7.3, 7.4, 8.4, 9, and 13.
-- A `user-attribute-update` job writes the final value of each eligible user of one confirmed
-- preview. One envelope holds at most 250 parts, and a part is one `users.patch` or one
-- `users.update` (K21 C9). Each written user is read back no earlier than 30 seconds after its write
-- answer. This migration adds the one attempt of the job, the outcomes of its users, the claim, the
-- settlement, the finish, the read-back claim, the cancel skip, and the recovery. The job shares the
-- write slot of the device and category jobs (E8, 027).

-- 1. The one attempt of a value job. `write_started_at` is the first envelope, which no retry
-- repeats (B section 7.3). `first_claimed_at` separates a start that never claimed from a lost
-- runner (B section 7.4).
ALTER TABLE cc.user_attribute_update_jobs
  ADD COLUMN dispatch_token uuid,
  ADD COLUMN dispatch_count integer NOT NULL DEFAULT 0 CHECK(dispatch_count>=0),
  ADD COLUMN start_deadline_at timestamptz,
  ADD COLUMN kestra_execution_id text,
  ADD COLUMN first_claimed_at timestamptz,
  ADD COLUMN attempt uuid,
  ADD COLUMN attempt_expires_at timestamptz,
  ADD COLUMN write_started_at timestamptz,
  ADD COLUMN write_finished_at timestamptz,
  -- The Google reason of a failed write stays beside the job failure code, which holds one token
  -- (B section 7.3 "with the Google reason").
  ADD COLUMN failure_reason text CHECK(failure_reason IS NULL OR length(failure_reason) BETWEEN 1 AND 256);

-- 2. One outcome for each eligible user (B section 7.3). A SQL null on an eligible row reads
-- `pending`, so a preview that 028 wrote keeps its meaning. A row of another disposition holds no
-- outcome, because only an eligible user is written.
ALTER TABLE cc.user_attribute_preview_targets
  ADD COLUMN outcome text CHECK(outcome IS NULL OR (disposition='eligible' AND outcome IN
    ('pending','dispatched','succeeded','failed','unknown','skipped','cancelled'))),
  -- The write attempt that holds the row. A live lease keeps a second runner away (R1).
  ADD COLUMN attempt uuid,
  ADD COLUMN attempt_expires_at timestamptz,
  -- The moment the send gate released the envelope that names this row. A row that is dispatched
  -- without `sent_at` never left the worker, so a cancel counts it Cancelled (B section 7.4).
  ADD COLUMN sent_at timestamptz,
  -- The moment the write answer arrived. The read-back starts 30 seconds later (C11).
  ADD COLUMN answered_at timestamptz,
  ADD COLUMN verify_after timestamptz,
  ADD COLUMN verify_attempt uuid,
  ADD COLUMN verify_lease_expires_at timestamptz,
  -- The automatic read-back passes of the row. Three passes bound the automatic loop, so an
  -- unprovable operation stays Unknown for a person (B section 7.3).
  ADD COLUMN verify_count integer NOT NULL DEFAULT 0 CHECK(verify_count>=0),
  -- The outcome evidence of B section 7.3.
  ADD COLUMN failure text CHECK(failure IS NULL OR length(failure) BETWEEN 1 AND 64),
  ADD COLUMN outcome_reason text CHECK(outcome_reason IS NULL OR length(outcome_reason) BETWEEN 1 AND 256),
  ADD COLUMN google_status integer CHECK(google_status IS NULL OR google_status BETWEEN 100 AND 599),
  ADD COLUMN google_reason text CHECK(google_reason IS NULL OR length(google_reason) BETWEEN 1 AND 256),
  ADD COLUMN verified_by text CHECK(verified_by IS NULL OR verified_by IN ('write-response','read-back')),
  -- The values that the answer or the read-back showed for the user's changed categories.
  ADD COLUMN observed_value jsonb,
  -- The observation time of the write answer or the read-back. The preview keeps its own
  -- `observed_at`, the Google read that froze the baseline.
  ADD COLUMN value_observed_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp();

-- The claim and the read-back walk the same rows in ordinal order.
CREATE INDEX user_attribute_targets_work ON cc.user_attribute_preview_targets(preview_id,ordinal)
  WHERE disposition='eligible';
-- The admission scan of 026 reads the running value job beside the device kinds.
CREATE INDEX jobs_admission_value ON cc.jobs(customer_id) WHERE kind='user-attribute-update'
  AND status IN ('accepted','queued','held','running');

-- 3. The terminal rule of a value job. It repeats the device rule (017 cc.device_update_terminal_status)
-- over the eligible users of the preview.
CREATE FUNCTION cc.user_attribute_terminal_status(p_job uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT CASE WHEN j.cancelled>0 THEN 'cancelled'
    WHEN j.unknown>0 THEN 'needs-review'
    WHEN j.succeeded=j.target_count THEN 'completed'
    WHEN j.succeeded>0 AND j.failed+j.skipped>0 THEN 'completed-with-errors'
    ELSE 'failed' END
  FROM cc.jobs j WHERE j.job_id=p_job;
$$;

-- 4. The job counters over the eligible users. One outcome belongs to one row, so the five counters
-- add up to `target_count`, the eligible user count of the confirm.
CREATE FUNCTION cc.refresh_user_attribute_counters(p_job uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  UPDATE cc.jobs j SET
    succeeded=s.succeeded,failed=s.failed,unknown=s.unknown,skipped=s.skipped,cancelled=s.cancelled
  FROM (
    SELECT count(*) FILTER (WHERE COALESCE(t.outcome,'pending')='succeeded') AS succeeded,
      count(*) FILTER (WHERE t.outcome='failed') AS failed,
      count(*) FILTER (WHERE t.outcome='unknown') AS unknown,
      count(*) FILTER (WHERE t.outcome='skipped') AS skipped,
      count(*) FILTER (WHERE t.outcome='cancelled') AS cancelled
    FROM cc.user_attribute_preview_targets t
    JOIN cc.user_attribute_update_jobs u ON u.preview_id=t.preview_id
    WHERE u.job_id=p_job AND t.disposition='eligible'
  ) s
  WHERE j.job_id=p_job;
$$;

-- 5. The stop reason of a value job (B section 7.3). A selection preview needs `users:bulk-actions`
-- beside `users:write`, as its confirm did.
CREATE FUNCTION cc.user_attribute_stop_reason(p_customer text,p_confirmer uuid,p_version integer,
  p_generation integer,p_selection boolean) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT CASE
    WHEN NOT EXISTS(SELECT 1 FROM cc.application_principals p WHERE p.id=p_confirmer AND p.enabled AND
        p.permission_version=p_version) OR NOT EXISTS(SELECT 1 FROM cc.application_grants g
        WHERE g.principal_id=p_confirmer AND g.action='users:write' AND
        (g.scope='{"kind":"platform"}'::jsonb OR
        (g.scope->>'kind'='district' AND g.scope->>'customerId'=p_customer))) OR
      (p_selection AND NOT EXISTS(SELECT 1 FROM cc.application_grants g
        WHERE g.principal_id=p_confirmer AND g.action='users:bulk-actions' AND
        (g.scope='{"kind":"platform"}'::jsonb OR
        (g.scope->>'kind'='district' AND g.scope->>'customerId'=p_customer)))) THEN 'permission-changed'
    WHEN NOT EXISTS(SELECT 1 FROM cc.google_connection c WHERE c.customer_id=p_customer AND
        c.generation=p_generation AND c.active) THEN 'connection-changed'
  END;
$$;

-- 6. The changed attributes of one preview, once for the whole batch. A null `fieldType` means the
-- category cache no longer holds the attribute, so the worker compares exactly.
CREATE FUNCTION cc.user_attribute_work_fields(p_preview uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('schemaName',f.schema_name,'fieldName',f.field_name,
    'fieldType',f.field_type,'multiValued',COALESCE(f.multi_valued,false))
    ORDER BY f.schema_name,f.field_name),'[]'::jsonb)
  FROM (
    SELECT v.schema_name,v.field_name,
      (SELECT a->>'fieldType' FROM cc.user_attribute_categories c,
        LATERAL jsonb_array_elements(c.fields) a
        WHERE c.customer_id=p.customer_id AND c.schema_name=v.schema_name AND
          a->>'fieldName'=v.field_name LIMIT 1) AS field_type,
      (SELECT (a->>'multiValued')::boolean FROM cc.user_attribute_categories c,
        LATERAL jsonb_array_elements(c.fields) a
        WHERE c.customer_id=p.customer_id AND c.schema_name=v.schema_name AND
          a->>'fieldName'=v.field_name LIMIT 1) AS multi_valued
    FROM cc.user_attribute_target_values v
    JOIN cc.user_attribute_previews p ON p.preview_id=v.preview_id
    WHERE v.preview_id=p_preview AND v.disposition='eligible'
    GROUP BY v.schema_name,v.field_name,p.customer_id
  ) f;
$$;

-- 7. One eligible user of one preview, as one write part and one read part. The values are the
-- final values of the changed attributes, and a SQL null in a category value means a clear.
CREATE FUNCTION cc.user_attribute_work_row(t cc.user_attribute_preview_targets,p_preview uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT jsonb_build_object('ordinal',t.ordinal,'userId',t.user_id,'primaryEmail',t.primary_email,
    'customSchemas',COALESCE((SELECT jsonb_object_agg(s.schema_name,s.fields ORDER BY s.schema_name)
      FROM (SELECT v.schema_name,jsonb_object_agg(v.field_name,v.requested_value ORDER BY v.field_name)
        AS fields FROM cc.user_attribute_target_values v
        WHERE v.preview_id=p_preview AND v.ordinal=t.ordinal AND v.disposition='eligible'
        GROUP BY v.schema_name) s),'{}'::jsonb));
$$;

-- 8. The claim of the next envelope. It fences the attempt, revalidates the confirmer, and claims up
-- to 250 pending users in ordinal order. A cancel or a stop reason ends the job here, before any
-- further part leaves the worker (B section 7.4). A live lease of another attempt answers `busy`.
CREATE FUNCTION cc.claim_user_attribute_updates(p_customer text,p_job uuid,p_token uuid,p_attempt uuid,
  p_limit integer DEFAULT 250) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.user_attribute_update_jobs; preview cc.user_attribute_previews;
  connection cc.google_connection; envelope jsonb; now_at timestamptz; stopped text; busy integer;
  rows_out jsonb; left_over integer;
BEGIN
  IF p_customer IS NULL OR p_job IS NULL OR p_token IS NULL OR p_attempt IS NULL OR
    p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 250 THEN
    RAISE EXCEPTION 'The value job attempt is invalid.' USING ERRCODE='22023';
  END IF;
  -- Rule G: the credential read below reaches the global access lock, so the claim takes it first.
  PERFORM pg_advisory_xact_lock(7240173008);
  -- The admission lock orders the claim after an admission and a hold cleanup of the customer.
  PERFORM pg_advisory_xact_lock(hashtext('cc.job-admission:'||p_customer)::bigint);
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  IF job.job_id IS NULL OR job.kind<>'user-attribute-update' THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  SELECT * INTO detail FROM cc.user_attribute_update_jobs u WHERE u.job_id=p_job FOR UPDATE;
  now_at:=clock_timestamp();
  IF job.status<>'running' OR job.finished_at IS NOT NULL OR detail.job_id IS NULL OR
    detail.dispatch_token IS DISTINCT FROM p_token THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  SELECT * INTO preview FROM cc.user_attribute_previews p WHERE p.preview_id=detail.preview_id;
  IF preview.preview_id IS NULL THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  -- R1: the live owner keeps the job. Another attempt is fenced and changes nothing.
  IF detail.attempt IS NOT NULL AND detail.attempt IS DISTINCT FROM p_attempt AND
    detail.attempt_expires_at IS NOT NULL AND detail.attempt_expires_at>now_at THEN
    RETURN jsonb_build_object('outcome','busy');
  END IF;
  SELECT count(*) INTO busy FROM cc.user_attribute_preview_targets t
    WHERE t.preview_id=preview.preview_id AND t.disposition='eligible' AND t.outcome='dispatched'
      AND t.attempt IS DISTINCT FROM p_attempt AND t.attempt_expires_at>now_at;
  IF busy>0 THEN
    RETURN jsonb_build_object('outcome','busy');
  END IF;
  -- A recorded job failure, a revoked action, or a moved connection stops the job before any further
  -- part leaves the worker. The connection read below takes the row FOR KEY SHARE, so the reason
  -- runs again after that wait.
  stopped:=COALESCE(job.failure,cc.user_attribute_stop_reason(p_customer,detail.confirmed_by,
    detail.confirmer_permission_version,job.generation,preview.source='selection'));
  IF stopped IS NULL THEN
    PERFORM 1 FROM cc.google_connection c WHERE c.customer_id=p_customer FOR KEY SHARE;
    stopped:=cc.user_attribute_stop_reason(p_customer,detail.confirmed_by,
      detail.confirmer_permission_version,job.generation,preview.source='selection');
  END IF;
  now_at:=clock_timestamp();
  IF stopped IS NOT NULL THEN
    PERFORM 1 FROM cc.application_principals p WHERE p.id=job.requested_by FOR KEY SHARE;
    UPDATE cc.user_attribute_preview_targets t SET outcome='skipped',failure=stopped,
      outcome_reason=NULL,updated_at=now_at
      WHERE t.preview_id=preview.preview_id AND t.disposition='eligible' AND
        COALESCE(t.outcome,'pending')='pending';
    PERFORM cc.refresh_user_attribute_counters(p_job);
    UPDATE cc.jobs SET status='failed',failure=COALESCE(failure,stopped),finished_at=now_at
      WHERE job_id=p_job;
    PERFORM cc.record_job_change(p_job,true);
    RETURN jsonb_build_object('outcome','stopped','failure',stopped);
  END IF;
  IF job.cancel_requested_at IS NOT NULL THEN
    PERFORM cc.skip_user_attribute_pending(p_job,'cancelled');
    PERFORM cc.refresh_user_attribute_counters(p_job);
    now_at:=clock_timestamp();
    UPDATE cc.jobs SET status=cc.user_attribute_terminal_status(p_job),finished_at=now_at
      WHERE job_id=p_job;
    PERFORM cc.record_job_change(p_job,true);
    RETURN jsonb_build_object('outcome','done',
      'status',(SELECT j.status FROM cc.jobs j WHERE j.job_id=p_job));
  END IF;
  -- The credential of the job generation. A missing envelope stops the job before its first part.
  SELECT * INTO connection FROM cc.google_connection c WHERE c.customer_id=p_customer;
  IF connection.credential_id IS NOT NULL THEN
    SELECT c.envelope INTO envelope FROM cc.google_credentials c WHERE c.id=connection.credential_id;
  END IF;
  IF envelope IS NULL THEN
    PERFORM 1 FROM cc.google_connection c WHERE c.customer_id=p_customer FOR KEY SHARE;
    UPDATE cc.user_attribute_preview_targets t SET outcome='skipped',failure='key-unavailable',
      updated_at=now_at WHERE t.preview_id=preview.preview_id AND t.disposition='eligible' AND
      COALESCE(t.outcome,'pending')='pending';
    PERFORM cc.refresh_user_attribute_counters(p_job);
    UPDATE cc.jobs SET status='failed',failure='key-unavailable',finished_at=now_at WHERE job_id=p_job;
    PERFORM cc.record_job_change(p_job,true);
    RETURN jsonb_build_object('outcome','stopped','failure','key-unavailable');
  END IF;
  -- The claim proves the start reached the worker, so the startup window of that dispatch ends here. A
  -- lost runner can then be replaced at once, and the replacement keeps its own window (R4).
  UPDATE cc.jobs SET started_at=COALESCE(started_at,now_at) WHERE job_id=p_job;
  UPDATE cc.user_attribute_update_jobs SET attempt=p_attempt,
    attempt_expires_at=now_at+interval '10 minutes',first_claimed_at=COALESCE(first_claimed_at,now_at),
    start_deadline_at=NULL
    WHERE job_id=p_job;
  -- One envelope holds at most 250 pending users, in ordinal order. A row that another live attempt
  -- dispatched is not pending, and the busy answer above already covers that attempt. A fresh claim
  -- clears the send proof and the read-back count of the rows it owns (B section 7.4).
  WITH claimed AS (
    UPDATE cc.user_attribute_preview_targets t SET outcome='dispatched',attempt=p_attempt,
      attempt_expires_at=now_at+interval '10 minutes',sent_at=NULL,answered_at=NULL,verify_after=NULL,
      verify_attempt=NULL,verify_lease_expires_at=NULL,verify_count=0,
      failure=NULL,outcome_reason=NULL,google_status=NULL,google_reason=NULL,updated_at=now_at
    WHERE t.preview_id=preview.preview_id AND t.disposition='eligible' AND
      COALESCE(t.outcome,'pending')='pending'
      AND t.ordinal IN (SELECT o.ordinal FROM cc.user_attribute_preview_targets o
        WHERE o.preview_id=preview.preview_id AND o.disposition='eligible' AND
          COALESCE(o.outcome,'pending')='pending' ORDER BY o.ordinal LIMIT p_limit)
    RETURNING t.ordinal
  ) SELECT jsonb_agg(k.ordinal ORDER BY k.ordinal) INTO rows_out FROM claimed k;
  SELECT count(*) INTO left_over FROM cc.user_attribute_preview_targets t
    WHERE t.preview_id=preview.preview_id AND t.disposition='eligible' AND
      COALESCE(t.outcome,'pending')='pending';
  RETURN jsonb_build_object('outcome','claimed','generation',connection.generation,
    'credentialId',connection.credential_id,'envelope',envelope,'source',preview.source,
    'fields',cc.user_attribute_work_fields(preview.preview_id),
    'mask',COALESCE((SELECT jsonb_agg(DISTINCT v.schema_name ORDER BY v.schema_name)
      FROM cc.user_attribute_target_values v WHERE v.preview_id=preview.preview_id AND
      v.disposition='eligible'),'[]'::jsonb),
    'users',COALESCE((SELECT jsonb_agg(cc.user_attribute_work_row(t,preview.preview_id)
        ORDER BY t.ordinal)
      FROM cc.user_attribute_preview_targets t WHERE t.preview_id=preview.preview_id AND
      t.disposition='eligible' AND t.attempt=p_attempt AND
      (t.outcome='dispatched' OR t.outcome IS NULL) AND
      t.ordinal IN (SELECT (e.value)::integer FROM jsonb_array_elements(rows_out) e)),
      '[]'::jsonb),
    'remaining',left_over>0);
END;
$$;

-- 9. The settlement of one envelope (B section 7.3). Each result carries the outcome of one user,
-- and the transaction writes the user rows that a success proves (B section 9). A 2xx answer
-- without the requested values and a read-back without an answer stay Unknown, and their rows keep
-- the read-back fence. A 404 settles Failed `not-found` and removes the user (B section 13).
-- `p_failure` is the evidence of the envelope, never a job stop: the job ends only through
-- `cc.stop_user_attribute_job` or the claim's stop reason (R2).
CREATE FUNCTION cc.settle_user_attribute_updates(p_customer text,p_job uuid,p_token uuid,p_attempt uuid,
  p_results jsonb,p_observed_at timestamptz,p_failure text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.user_attribute_update_jobs; preview cc.user_attribute_previews;
  bad integer; now_at timestamptz; changed jsonb:='[]'::jsonb; removed jsonb:='[]'::jsonb;
  left_over integer; result_row jsonb; ordinal_key integer; user_key text; status_after text;
  covered text[]; accepted integer; ignored integer:=0;
BEGIN
  IF p_customer IS NULL OR p_job IS NULL OR p_token IS NULL OR p_attempt IS NULL OR
    p_observed_at IS NULL OR jsonb_typeof(p_results) IS DISTINCT FROM 'array' OR
    jsonb_array_length(p_results)>250 OR
    (p_failure IS NOT NULL AND NOT cc.job_failure_known(p_failure)) THEN
    RAISE EXCEPTION 'The value job settlement is invalid.' USING ERRCODE='22023';
  END IF;
  -- Each result names one ordinal, one outcome, and the evidence of that outcome.
  SELECT count(*) INTO bad FROM jsonb_array_elements(p_results) r
    WHERE jsonb_typeof(r) IS DISTINCT FROM 'object' OR
      COALESCE(r->>'ordinal','') !~ '^[0-9]{1,9}$' OR
      COALESCE(r->>'outcome','') NOT IN ('succeeded','failed','unknown','cancelled','skipped') OR
      (r->'observed' IS NOT NULL AND r->'observed'<>'null'::jsonb AND
        jsonb_typeof(r->'observed')<>'object') OR
      (r->'failure' IS NOT NULL AND r->'failure'<>'null'::jsonb AND
        (jsonb_typeof(r->'failure')<>'string' OR NOT cc.job_failure_known(r->>'failure'))) OR
      (r->'verifiedBy' IS NOT NULL AND r->'verifiedBy'<>'null'::jsonb AND
        r->>'verifiedBy' NOT IN ('write-response','read-back')) OR
      (r->'googleStatus' IS NOT NULL AND r->'googleStatus'<>'null'::jsonb AND
        (jsonb_typeof(r->'googleStatus')<>'number' OR
          (r->>'googleStatus')::integer NOT BETWEEN 100 AND 599));
  IF bad>0 OR (SELECT count(DISTINCT (r->>'ordinal')) FROM jsonb_array_elements(p_results) r)
      <>jsonb_array_length(p_results) THEN
    RAISE EXCEPTION 'The value job settlement is invalid.' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(7240173008);
  PERFORM pg_advisory_xact_lock(hashtext('cc.job-admission:'||p_customer)::bigint);
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  IF job.job_id IS NULL OR job.kind<>'user-attribute-update' THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  SELECT * INTO detail FROM cc.user_attribute_update_jobs u WHERE u.job_id=p_job FOR UPDATE;
  IF detail.job_id IS NULL THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  SELECT * INTO preview FROM cc.user_attribute_previews p WHERE p.preview_id=detail.preview_id;
  -- The targets lock in ordinal order, the order of the claim and the cancel.
  PERFORM 1 FROM cc.user_attribute_preview_targets t WHERE t.preview_id=preview.preview_id AND
    t.disposition='eligible' ORDER BY t.ordinal FOR UPDATE;
  -- R7: every fence reads again after the target lock wait, and the lease must still be live.
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job FOR UPDATE;
  SELECT * INTO detail FROM cc.user_attribute_update_jobs u WHERE u.job_id=p_job FOR UPDATE;
  now_at:=clock_timestamp();
  IF job.status<>'running' OR job.finished_at IS NOT NULL OR detail.dispatch_token IS DISTINCT FROM p_token
    OR detail.attempt IS DISTINCT FROM p_attempt OR detail.attempt_expires_at IS NULL OR
    detail.attempt_expires_at<=now_at THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  -- The categories that the read or the answer covers. An absent category was cleared, so the cache
  -- drops it instead of keeping the older value (B section 9, R5).
  covered:=ARRAY(SELECT DISTINCT v.schema_name FROM cc.user_attribute_target_values v
    WHERE v.preview_id=preview.preview_id AND v.disposition='eligible' ORDER BY v.schema_name);
  FOR result_row IN SELECT value FROM jsonb_array_elements(p_results) LOOP
    ordinal_key:=(result_row->>'ordinal')::integer;
    -- Only a row that this attempt claimed, for its write or for its read-back, settles (R7).
    SELECT t.user_id INTO user_key FROM cc.user_attribute_preview_targets t
      WHERE t.preview_id=preview.preview_id AND t.ordinal=ordinal_key AND t.disposition='eligible'
        AND ((t.attempt=p_attempt AND t.outcome='dispatched') OR
          (t.verify_attempt=p_attempt AND t.outcome='unknown'));
    IF user_key IS NULL THEN
      ignored:=ignored+1;
      CONTINUE;
    END IF;
    IF result_row->>'outcome'='succeeded' THEN
      UPDATE cc.user_attribute_preview_targets t SET outcome='succeeded',failure=NULL,
        outcome_reason=NULL,verified_by=COALESCE(result_row->>'verifiedBy','write-response'),
        google_status=(result_row->>'googleStatus')::integer,
        google_reason=result_row->>'googleReason',
        observed_value=result_row->'observed',value_observed_at=p_observed_at,answered_at=p_observed_at,
        verify_after=NULL,verify_attempt=NULL,verify_lease_expires_at=NULL,updated_at=now_at
        WHERE t.preview_id=preview.preview_id AND t.ordinal=ordinal_key;
      -- B section 9: each settled user writes its row. A category that the observation covers and
      -- does not hold is cleared, and an unrelated category stays. A newer cached observation or
      -- category transition wins (R5, R6).
      IF result_row->'observed' IS NOT NULL AND result_row->'observed'<>'null'::jsonb AND
        jsonb_typeof(result_row->'observed')='object' THEN
        WITH next AS (
          SELECT (u.custom_schemas-COALESCE(covered,'{}'::text[]))||(result_row->'observed') AS value
          FROM cc.users u WHERE u.customer_id=p_customer AND u.user_id=user_key
        )
        UPDATE cc.users u SET custom_schemas=n.value,custom_schemas_changed_at=p_observed_at
          FROM next n
          WHERE u.customer_id=p_customer AND u.user_id=user_key AND
            u.last_entity_sync<=p_observed_at AND
            (u.custom_schemas_changed_at IS NULL OR u.custom_schemas_changed_at<=p_observed_at) AND
            u.custom_schemas IS DISTINCT FROM n.value;
        GET DIAGNOSTICS accepted=ROW_COUNT;
        IF accepted>0 THEN changed:=changed||jsonb_build_array(user_key); END IF;
      END IF;
    ELSIF result_row->>'outcome'='failed' THEN
      UPDATE cc.user_attribute_preview_targets t SET outcome='failed',
        failure=COALESCE(result_row->>'failure','request-failed'),
        outcome_reason=result_row->>'reason',verified_by=result_row->>'verifiedBy',
        google_status=(result_row->>'googleStatus')::integer,
        google_reason=result_row->>'googleReason',
        observed_value=result_row->'observed',value_observed_at=p_observed_at,answered_at=p_observed_at,
        verify_after=NULL,verify_attempt=NULL,verify_lease_expires_at=NULL,updated_at=now_at
        WHERE t.preview_id=preview.preview_id AND t.ordinal=ordinal_key;
      -- B section 13: a 404 removes the user, and the next sync adds it again when Google lists it.
      IF result_row->>'failure'='not-found' THEN
        removed:=removed||COALESCE(cc.soft_delete_users(p_customer,jsonb_build_array(user_key),
          p_observed_at),'[]'::jsonb);
      END IF;
    ELSIF result_row->>'outcome'='unknown' THEN
      UPDATE cc.user_attribute_preview_targets t SET outcome='unknown',
        failure=COALESCE(result_row->>'failure','invalid-response'),
        outcome_reason=result_row->>'reason',verified_by=result_row->>'verifiedBy',
        google_status=(result_row->>'googleStatus')::integer,
        google_reason=result_row->>'googleReason',
        observed_value=result_row->'observed',value_observed_at=p_observed_at,answered_at=p_observed_at,
        -- C11: the read-back starts 30 seconds after the write answer or later.
        verify_after=p_observed_at+interval '30 seconds',verify_attempt=NULL,
        verify_lease_expires_at=NULL,updated_at=now_at
        WHERE t.preview_id=preview.preview_id AND t.ordinal=ordinal_key;
    ELSE
      UPDATE cc.user_attribute_preview_targets t SET outcome=result_row->>'outcome',
        failure=result_row->>'failure',outcome_reason=result_row->>'reason',
        answered_at=p_observed_at,updated_at=now_at
        WHERE t.preview_id=preview.preview_id AND t.ordinal=ordinal_key AND
          COALESCE(t.outcome,'pending') IN ('dispatched','pending');
    END IF;
  END LOOP;
  UPDATE cc.user_attribute_update_jobs SET write_started_at=COALESCE(write_started_at,now_at),
    write_finished_at=COALESCE(write_finished_at,now_at),
    failure_reason=COALESCE(p_failure,failure_reason) WHERE job_id=p_job;
  PERFORM cc.refresh_user_attribute_counters(p_job);
  SELECT count(*) INTO left_over FROM cc.user_attribute_preview_targets t
    WHERE t.preview_id=preview.preview_id AND t.disposition='eligible' AND
      COALESCE(t.outcome,'pending') IN ('pending','dispatched');
  status_after:=(SELECT j.status FROM cc.jobs j WHERE j.job_id=p_job);
  PERFORM cc.record_job_change(p_job,false);
  RETURN jsonb_build_object('outcome','settled','status',status_after,'changed',changed,
    'removed',removed,'remaining',left_over>0,'ignored',ignored);
END;
$$;

-- 10. The end of the job. The finish reads the counters, so the terminal rule of 3 decides, and a
-- remaining dispatched row keeps the job running for the recovery.
CREATE FUNCTION cc.finish_user_attribute_job(p_customer text,p_job uuid,p_token uuid,p_attempt uuid,
  p_failure text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.user_attribute_update_jobs; status_after text; now_at timestamptz;
BEGIN
  IF p_customer IS NULL OR p_job IS NULL OR p_token IS NULL OR p_attempt IS NULL OR
    (p_failure IS NOT NULL AND NOT cc.job_failure_known(p_failure)) THEN
    RAISE EXCEPTION 'The value job finish is invalid.' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cc.job-admission:'||p_customer)::bigint);
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  IF job.job_id IS NULL OR job.kind<>'user-attribute-update' THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  SELECT * INTO detail FROM cc.user_attribute_update_jobs u WHERE u.job_id=p_job FOR UPDATE;
  now_at:=clock_timestamp();
  -- R7: only the live owner finishes the job. An expired attempt waits for its recovery.
  IF detail.job_id IS NULL OR detail.dispatch_token IS DISTINCT FROM p_token OR
    detail.attempt IS DISTINCT FROM p_attempt OR detail.attempt_expires_at IS NULL OR
    detail.attempt_expires_at<=now_at THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  IF job.status<>'running' THEN
    RETURN jsonb_build_object('outcome','finished','status',job.status);
  END IF;
  IF EXISTS(SELECT 1 FROM cc.user_attribute_preview_targets t
      JOIN cc.user_attribute_update_jobs u ON u.preview_id=t.preview_id
      WHERE u.job_id=p_job AND t.disposition='eligible' AND
        COALESCE(t.outcome,'pending') IN ('pending','dispatched')) THEN
    RETURN jsonb_build_object('outcome','busy');
  END IF;
  IF p_failure IS NOT NULL THEN
    UPDATE cc.jobs SET failure=COALESCE(failure,p_failure) WHERE job_id=p_job;
  END IF;
  PERFORM cc.refresh_user_attribute_counters(p_job);
  status_after:=cc.user_attribute_terminal_status(p_job);
  -- A failed job names a code. The first failed user's code stands when the worker named none.
  UPDATE cc.jobs SET status=status_after,finished_at=clock_timestamp(),
    failure=CASE WHEN status_after IN ('failed','completed-with-errors') AND failure IS NULL THEN
      (SELECT min(t.failure) FROM cc.user_attribute_preview_targets t
        JOIN cc.user_attribute_update_jobs u ON u.preview_id=t.preview_id
        WHERE u.job_id=p_job AND t.disposition='eligible' AND t.outcome='failed')
      ELSE failure END
    WHERE job_id=p_job;
  PERFORM cc.record_job_change(p_job,true);
  RETURN jsonb_build_object('outcome','finished','status',status_after);
END;
$$;

-- 11. The read-back claim of one batch (B section 7.3, C11). It claims the due Unknown rows of a
-- running job in ordinal order and returns their requested values. It never claims a row before its
-- `verify_after`, so no read starts within 30 seconds of the write answer.
CREATE FUNCTION cc.claim_user_attribute_verification(p_customer text,p_job uuid,p_attempt uuid,
  p_ordinals jsonb DEFAULT NULL,p_limit integer DEFAULT 250) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.user_attribute_update_jobs; preview cc.user_attribute_previews;
  connection cc.google_connection; envelope jsonb; now_at timestamptz; rows_out jsonb;
  due timestamptz; remaining integer; busy integer;
BEGIN
  IF p_customer IS NULL OR p_job IS NULL OR p_attempt IS NULL OR p_limit IS NULL OR
    p_limit NOT BETWEEN 1 AND 250 OR (p_ordinals IS NOT NULL AND
      (jsonb_typeof(p_ordinals) IS DISTINCT FROM 'array' OR jsonb_array_length(p_ordinals)>250)) THEN
    RAISE EXCEPTION 'The value job read-back is invalid.' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(7240173008);
  PERFORM pg_advisory_xact_lock(hashtext('cc.job-admission:'||p_customer)::bigint);
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  IF job.job_id IS NULL OR job.kind<>'user-attribute-update' OR job.status<>'running' THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  SELECT * INTO detail FROM cc.user_attribute_update_jobs u WHERE u.job_id=p_job FOR UPDATE;
  now_at:=clock_timestamp();
  IF detail.job_id IS NULL OR detail.attempt IS DISTINCT FROM p_attempt OR
    (detail.attempt_expires_at IS NOT NULL AND detail.attempt_expires_at<=now_at) THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  SELECT * INTO preview FROM cc.user_attribute_previews p WHERE p.preview_id=detail.preview_id;
  IF preview.preview_id IS NULL THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  SELECT count(*) INTO busy FROM cc.user_attribute_preview_targets t
    WHERE t.preview_id=preview.preview_id AND t.disposition='eligible' AND t.outcome='unknown'
      AND t.verify_lease_expires_at IS NOT NULL AND t.verify_lease_expires_at>now_at;
  IF busy>0 THEN
    RETURN jsonb_build_object('outcome','busy');
  END IF;
  SELECT min(t.verify_after) INTO due FROM cc.user_attribute_preview_targets t
    WHERE t.preview_id=preview.preview_id AND t.disposition='eligible' AND t.outcome='unknown' AND
      t.verify_count<3;
  SELECT * INTO connection FROM cc.google_connection c WHERE c.customer_id=p_customer FOR KEY SHARE;
  IF connection.credential_id IS NOT NULL THEN
    SELECT c.envelope INTO envelope FROM cc.google_credentials c WHERE c.id=connection.credential_id;
  END IF;
  IF envelope IS NULL THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  -- The read-back extends the write attempt, so the recovery never restarts a live read.
  UPDATE cc.user_attribute_update_jobs SET attempt_expires_at=now_at+interval '10 minutes'
    WHERE job_id=p_job;
  WITH claimed AS (
    UPDATE cc.user_attribute_preview_targets t SET verify_attempt=p_attempt,
      verify_lease_expires_at=now_at+interval '10 minutes',verify_count=verify_count+1,updated_at=now_at
    WHERE t.preview_id=preview.preview_id AND t.disposition='eligible' AND t.outcome='unknown' AND
      -- Three automatic passes bound the loop, so an unprovable operation stays for a person.
      t.verify_count<3 AND
      t.verify_after IS NOT NULL AND t.verify_after<=now_at AND
      (p_ordinals IS NULL OR
        t.ordinal IN (SELECT (e.value)::integer FROM jsonb_array_elements(p_ordinals) e)) AND
      t.ordinal IN (SELECT o.ordinal FROM cc.user_attribute_preview_targets o
        WHERE o.preview_id=preview.preview_id AND o.disposition='eligible' AND o.outcome='unknown' AND
          o.verify_count<3 AND o.verify_after IS NOT NULL AND o.verify_after<=now_at
          ORDER BY o.ordinal LIMIT p_limit)
    RETURNING t.ordinal
  ) SELECT jsonb_agg(k.ordinal ORDER BY k.ordinal) INTO rows_out FROM claimed k;
  SELECT count(*) INTO remaining FROM cc.user_attribute_preview_targets t
    WHERE t.preview_id=preview.preview_id AND t.disposition='eligible' AND t.outcome='unknown' AND
      t.verify_count<3;
  RETURN jsonb_build_object('outcome','claimed','generation',connection.generation,
    'credentialId',connection.credential_id,'envelope',envelope,'source',preview.source,
    'mask',COALESCE((SELECT jsonb_agg(DISTINCT v.schema_name ORDER BY v.schema_name)
      FROM cc.user_attribute_target_values v WHERE v.preview_id=preview.preview_id AND
      v.disposition='eligible'),'[]'::jsonb),
    'fields',cc.user_attribute_work_fields(preview.preview_id),
    'users',COALESCE((SELECT jsonb_agg(cc.user_attribute_work_row(t,preview.preview_id)
        ORDER BY t.ordinal)
      FROM cc.user_attribute_preview_targets t WHERE t.preview_id=preview.preview_id AND
      t.disposition='eligible' AND t.verify_attempt=p_attempt AND t.outcome='unknown' AND
      t.ordinal IN (SELECT (e.value)::integer FROM jsonb_array_elements(COALESCE(rows_out,'[]'::jsonb)) e)),
      '[]'::jsonb),
    'remaining',remaining,
    'waitMilliseconds',CASE WHEN due IS NULL OR due<=now_at THEN 0
      ELSE CEIL(EXTRACT(EPOCH FROM (due-now_at))*1000)::integer END);
END;
$$;

-- 12. Every pending user of a job becomes skipped, or cancelled when the header holds a cancel
-- request. The complete set locks first, in ordinal order, so the update never waits. A row that the
-- claim marked dispatched without a released send gate never left the worker, so it settles the same
-- way as a pending row (B section 7.4, R8).
CREATE FUNCTION cc.skip_user_attribute_pending(p_job uuid,p_reason text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE skipped integer; requested boolean; preview uuid; unsent integer;
BEGIN
  IF p_reason NOT IN ('cancelled','interrupted','interrupted-unknown') THEN
    RAISE EXCEPTION 'The value job skip reason is invalid.' USING ERRCODE='22023';
  END IF;
  SELECT u.preview_id INTO preview FROM cc.user_attribute_update_jobs u WHERE u.job_id=p_job;
  IF preview IS NULL THEN
    RETURN 0;
  END IF;
  SELECT cancel_requested_at IS NOT NULL INTO requested FROM cc.jobs j WHERE j.job_id=p_job;
  PERFORM 1 FROM cc.user_attribute_preview_targets t WHERE t.preview_id=preview AND
    t.disposition='eligible' AND (COALESCE(t.outcome,'pending')='pending' OR
      (t.outcome='dispatched' AND t.sent_at IS NULL))
    ORDER BY t.ordinal FOR UPDATE;
  WITH changed AS (
    UPDATE cc.user_attribute_preview_targets t SET
      outcome=CASE WHEN requested OR p_reason='cancelled' THEN 'cancelled' ELSE 'skipped' END,
      failure=CASE WHEN requested OR p_reason='cancelled' THEN NULL ELSE
        CASE p_reason WHEN 'interrupted' THEN 'interrupted' ELSE 'network-failure' END END,
      updated_at=clock_timestamp()
    WHERE t.preview_id=preview AND t.disposition='eligible' AND
      COALESCE(t.outcome,'pending')='pending'
    RETURNING t.ordinal
  ) SELECT count(*) INTO skipped FROM changed;
  -- A claimed row without a released send gate is proven unsent, so it stops like a pending row.
  WITH changed AS (
    UPDATE cc.user_attribute_preview_targets t SET
      outcome=CASE WHEN requested OR p_reason='cancelled' THEN 'cancelled' ELSE 'skipped' END,
      failure=CASE WHEN requested OR p_reason='cancelled' THEN NULL ELSE
        CASE p_reason WHEN 'interrupted' THEN 'interrupted' ELSE 'network-failure' END END,
      outcome_reason=NULL,updated_at=clock_timestamp()
    WHERE t.preview_id=preview AND t.disposition='eligible' AND t.outcome='dispatched' AND
      t.sent_at IS NULL
    RETURNING t.ordinal
  ) SELECT count(*) INTO unsent FROM changed;
  skipped:=skipped+unsent;
  -- B section 7.4: a user whose envelope may have reached Google stays Unknown, so the read-back
  -- decides. Only a row that the send gate released can have reached Google.
  UPDATE cc.user_attribute_preview_targets t SET outcome='unknown',
    failure=COALESCE(t.failure,'interrupted'),outcome_reason='interrupted',
    verify_after=clock_timestamp()+interval '30 seconds',verify_attempt=NULL,
    verify_lease_expires_at=NULL,updated_at=clock_timestamp()
    WHERE t.preview_id=preview AND t.disposition='eligible' AND t.outcome='dispatched' AND
      t.sent_at IS NOT NULL;
  RETURN skipped;
END;
$$;

-- 13. The recovery of a value job (B section 7.4). A start that never claimed is dispatched again
-- while its count allows. A lost runner is started again, and its dispatched users become Unknown so
-- the next attempt reads them back. A cancel request ends the job.
CREATE FUNCTION cc.recover_user_attribute_jobs(p_customer text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.user_attribute_update_jobs; token uuid; starts jsonb:='[]'::jsonb;
  now_at timestamptz;
BEGIN
  IF p_customer IS NULL THEN
    RAISE EXCEPTION 'The value job recovery is invalid.' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cc.job-admission:'||p_customer)::bigint);
  FOR job IN SELECT j.* FROM cc.jobs j WHERE j.customer_id=p_customer AND
      j.kind='user-attribute-update' AND j.status='running' ORDER BY j.display_id FOR UPDATE LOOP
    SELECT * INTO detail FROM cc.user_attribute_update_jobs u WHERE u.job_id=job.job_id FOR UPDATE;
    IF detail.job_id IS NULL THEN
      CONTINUE;
    END IF;
    now_at:=clock_timestamp();
    -- A cancel request that a lost runner left ends the job here.
    IF job.cancel_requested_at IS NOT NULL AND (detail.attempt IS NULL OR
        detail.attempt_expires_at IS NULL OR detail.attempt_expires_at<=now_at) THEN
      PERFORM cc.skip_user_attribute_pending(job.job_id,'cancelled');
      PERFORM cc.refresh_user_attribute_counters(job.job_id);
      now_at:=clock_timestamp();
      UPDATE cc.jobs SET status=cc.user_attribute_terminal_status(job.job_id),finished_at=now_at
        WHERE job_id=job.job_id;
      PERFORM cc.record_job_change(job.job_id,true);
      CONTINUE;
    END IF;
    -- A live attempt keeps the job.
    IF detail.attempt IS NOT NULL AND detail.attempt_expires_at IS NOT NULL AND
      detail.attempt_expires_at>now_at THEN
      CONTINUE;
    END IF;
    -- A start that never reached the worker is dispatched again while the count allows (three).
    IF detail.first_claimed_at IS NULL AND detail.write_started_at IS NULL THEN
      IF detail.dispatch_count<3 AND (detail.start_deadline_at IS NULL OR
          detail.start_deadline_at<=now_at) THEN
        UPDATE cc.user_attribute_update_jobs SET dispatch_token=gen_random_uuid(),dispatch_count=dispatch_count+1,
          start_deadline_at=now_at+interval '120 seconds' WHERE job_id=job.job_id
          RETURNING dispatch_token INTO token;
        starts:=starts||jsonb_build_object('jobId',job.job_id,'displayId',job.display_id,
          'dispatchToken',token,'correlationId',job.correlation_id,'targetCount',job.target_count,
          'kind',job.kind);
        PERFORM cc.record_job_change(job.job_id,true);
      ELSIF detail.dispatch_count>=3 AND (detail.start_deadline_at IS NULL OR
        detail.start_deadline_at<=now_at) THEN
        PERFORM cc.skip_user_attribute_pending(job.job_id,'interrupted');
        PERFORM cc.refresh_user_attribute_counters(job.job_id);
        UPDATE cc.jobs SET status='failed',failure='orchestration-unavailable',finished_at=now_at
          WHERE job_id=job.job_id;
        PERFORM cc.record_job_change(job.job_id,true);
      END IF;
      CONTINUE;
    END IF;
    -- A lost runner after its first claim no longer owns the job (R7).
    UPDATE cc.user_attribute_update_jobs SET attempt=NULL,attempt_expires_at=NULL
      WHERE job_id=job.job_id;
    -- A row that the send gate released may have reached Google, so it becomes Unknown and the next
    -- attempt reads it back (B section 7.3). A row without that proof never left the worker, so it
    -- goes back to pending for the replacement envelope (R8).
    UPDATE cc.user_attribute_preview_targets t SET outcome='unknown',
      failure=COALESCE(t.failure,'interrupted'),outcome_reason='interrupted',
      verify_after=now_at+interval '30 seconds',verify_attempt=NULL,verify_lease_expires_at=NULL,
      attempt=NULL,attempt_expires_at=NULL,updated_at=now_at
      WHERE t.preview_id=detail.preview_id AND t.disposition='eligible' AND t.outcome='dispatched'
        AND t.sent_at IS NOT NULL;
    UPDATE cc.user_attribute_preview_targets t SET outcome='pending',attempt=NULL,
      attempt_expires_at=NULL,updated_at=now_at
      WHERE t.preview_id=detail.preview_id AND t.disposition='eligible' AND t.outcome='dispatched'
        AND t.sent_at IS NULL;
    PERFORM cc.refresh_user_attribute_counters(job.job_id);
    -- R4: a replacement start keeps its own startup window, so a recovery run before it expires
    -- consumes no further start (design sections 5.3 and 6.5).
    IF detail.start_deadline_at IS NOT NULL AND detail.start_deadline_at>now_at THEN
      PERFORM cc.record_job_change(job.job_id,true);
      CONTINUE;
    END IF;
    IF detail.dispatch_count<3 THEN
      UPDATE cc.user_attribute_update_jobs SET dispatch_token=gen_random_uuid(),dispatch_count=dispatch_count+1,
        start_deadline_at=now_at+interval '120 seconds' WHERE job_id=job.job_id
        RETURNING dispatch_token INTO token;
      starts:=starts||jsonb_build_object('jobId',job.job_id,'displayId',job.display_id,
        'dispatchToken',token,'correlationId',job.correlation_id,'targetCount',job.target_count,
        'kind',job.kind);
      PERFORM cc.record_job_change(job.job_id,true);
    ELSE
      PERFORM cc.skip_user_attribute_pending(job.job_id,'interrupted');
      PERFORM cc.refresh_user_attribute_counters(job.job_id);
      UPDATE cc.jobs SET status=cc.user_attribute_terminal_status(job.job_id),finished_at=now_at
        WHERE job_id=job.job_id;
      PERFORM cc.record_job_change(job.job_id,true);
    END IF;
  END LOOP;
  RETURN jsonb_build_object('starts',starts);
END;
$$;

-- 14. The fence of one reconcile read (B section 7.3). The route names the operation number, and the
-- worker reads the user with the masked read. A row inside its 30-second window answers `waiting`.
CREATE FUNCTION cc.claim_user_attribute_verification_one(p_customer text,p_job uuid,p_attempt uuid,
  p_operation_number integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.user_attribute_update_jobs; preview cc.user_attribute_previews;
  target cc.user_attribute_preview_targets; now_at timestamptz;
BEGIN
  IF p_customer IS NULL OR p_job IS NULL OR p_attempt IS NULL OR p_operation_number IS NULL OR
    p_operation_number<1 THEN
    RAISE EXCEPTION 'The value operation read-back is invalid.' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(7240173008);
  PERFORM pg_advisory_xact_lock(hashtext('cc.job-admission:'||p_customer)::bigint);
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  IF job.job_id IS NULL OR job.kind<>'user-attribute-update' THEN
    RETURN jsonb_build_object('outcome','not-found');
  END IF;
  SELECT * INTO detail FROM cc.user_attribute_update_jobs u WHERE u.job_id=p_job FOR UPDATE;
  IF detail.job_id IS NULL THEN
    RETURN jsonb_build_object('outcome','not-found');
  END IF;
  SELECT * INTO preview FROM cc.user_attribute_previews p WHERE p.preview_id=detail.preview_id;
  SELECT t.* INTO target FROM (SELECT o.*,row_number() OVER (ORDER BY o.ordinal) AS number
      FROM cc.user_attribute_preview_targets o WHERE o.preview_id=preview.preview_id AND
      o.disposition='eligible') t WHERE t.number=p_operation_number;
  IF target.preview_id IS NULL THEN
    RETURN jsonb_build_object('outcome','not-found');
  END IF;
  now_at:=clock_timestamp();
  IF COALESCE(target.outcome,'pending')<>'unknown' THEN
    RETURN jsonb_build_object('outcome','settled','outcomeOf',COALESCE(target.outcome,'pending'));
  END IF;
  IF target.verify_after IS NOT NULL AND target.verify_after>now_at THEN
    RETURN jsonb_build_object('outcome','waiting','verifyAfter',target.verify_after);
  END IF;
  IF target.verify_lease_expires_at IS NOT NULL AND target.verify_lease_expires_at>now_at THEN
    RETURN jsonb_build_object('outcome','busy');
  END IF;
  UPDATE cc.user_attribute_preview_targets t SET verify_attempt=p_attempt,
    verify_lease_expires_at=now_at+interval '120 seconds',verify_count=verify_count+1,updated_at=now_at
    WHERE t.preview_id=preview.preview_id AND t.ordinal=target.ordinal;
  RETURN jsonb_build_object('outcome','claimed','ordinal',target.ordinal,
    'mask',COALESCE((SELECT jsonb_agg(DISTINCT v.schema_name ORDER BY v.schema_name)
      FROM cc.user_attribute_target_values v WHERE v.preview_id=preview.preview_id AND
      v.disposition='eligible'),'[]'::jsonb),
    'fields',cc.user_attribute_work_fields(preview.preview_id),
    'user',cc.user_attribute_work_row(target,preview.preview_id));
END;
$$;

-- 15. The settlement of one reconcile read (B section 7.3). A read-back that proves the value, or
-- proves a 404, settles the operation. A read that proves nothing keeps it Unknown with its fence
-- cleared, so a person can read again later. The settlement recomputes the terminal status when no
-- work is left, so a reconciled job leaves Needs review (R9).
CREATE FUNCTION cc.settle_user_attribute_verification(p_customer text,p_job uuid,p_attempt uuid,
  p_ordinal integer,p_outcome text,p_failure text,p_reason text,p_google_status integer,
  p_google_reason text,p_observed jsonb,p_observed_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.user_attribute_update_jobs; preview cc.user_attribute_previews;
  target cc.user_attribute_preview_targets; now_at timestamptz; removed jsonb:='[]'::jsonb;
  changed jsonb:='[]'::jsonb; status_after text; covered text[]; accepted integer; left_over integer;
BEGIN
  IF p_customer IS NULL OR p_job IS NULL OR p_attempt IS NULL OR p_ordinal IS NULL OR
    p_observed_at IS NULL OR p_outcome NOT IN ('succeeded','failed','unknown') OR
    (p_failure IS NOT NULL AND NOT cc.job_failure_known(p_failure)) OR
    (p_observed IS NOT NULL AND jsonb_typeof(p_observed)<>'object') OR
    (p_google_status IS NOT NULL AND p_google_status NOT BETWEEN 100 AND 599) THEN
    RAISE EXCEPTION 'The value operation settlement is invalid.' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(7240173008);
  PERFORM pg_advisory_xact_lock(hashtext('cc.job-admission:'||p_customer)::bigint);
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  IF job.job_id IS NULL OR job.kind<>'user-attribute-update' THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  SELECT * INTO detail FROM cc.user_attribute_update_jobs u WHERE u.job_id=p_job FOR UPDATE;
  IF detail.job_id IS NULL THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  SELECT * INTO preview FROM cc.user_attribute_previews p WHERE p.preview_id=detail.preview_id;
  SELECT t.* INTO target FROM cc.user_attribute_preview_targets t
    WHERE t.preview_id=preview.preview_id AND t.ordinal=p_ordinal AND t.disposition='eligible'
    FOR UPDATE;
  now_at:=clock_timestamp();
  -- R7: only the live read-back owner settles, and the lease must still hold.
  IF target.preview_id IS NULL OR target.outcome<>'unknown' OR
    target.verify_attempt IS DISTINCT FROM p_attempt OR target.verify_lease_expires_at IS NULL OR
    target.verify_lease_expires_at<=now_at THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  covered:=ARRAY(SELECT DISTINCT v.schema_name FROM cc.user_attribute_target_values v
    WHERE v.preview_id=preview.preview_id AND v.disposition='eligible' ORDER BY v.schema_name);
  IF p_outcome='succeeded' THEN
    UPDATE cc.user_attribute_preview_targets t SET outcome='succeeded',failure=NULL,
      outcome_reason=NULL,verified_by='read-back',google_status=p_google_status,
      google_reason=p_google_reason,observed_value=p_observed,value_observed_at=p_observed_at,
      verify_after=NULL,verify_attempt=NULL,verify_lease_expires_at=NULL,updated_at=now_at
      WHERE t.preview_id=preview.preview_id AND t.ordinal=p_ordinal;
    -- R5 and R6: a covered category that the read does not hold is cleared, and a newer cached
    -- observation or category transition wins.
    IF p_observed IS NOT NULL THEN
      WITH next AS (
        SELECT (u.custom_schemas-COALESCE(covered,'{}'::text[]))||p_observed AS value
        FROM cc.users u WHERE u.customer_id=p_customer AND u.user_id=target.user_id
      )
      UPDATE cc.users u SET custom_schemas=n.value,custom_schemas_changed_at=p_observed_at
        FROM next n
        WHERE u.customer_id=p_customer AND u.user_id=target.user_id AND
          u.last_entity_sync<=p_observed_at AND
          (u.custom_schemas_changed_at IS NULL OR u.custom_schemas_changed_at<=p_observed_at) AND
          u.custom_schemas IS DISTINCT FROM n.value;
      GET DIAGNOSTICS accepted=ROW_COUNT;
      IF accepted>0 THEN changed:=jsonb_build_array(target.user_id); END IF;
    END IF;
  ELSIF p_outcome='failed' THEN
    UPDATE cc.user_attribute_preview_targets t SET outcome='failed',
      failure=COALESCE(p_failure,'request-failed'),outcome_reason=p_reason,verified_by='read-back',
      google_status=p_google_status,google_reason=p_google_reason,observed_value=p_observed,
      value_observed_at=p_observed_at,verify_after=NULL,verify_attempt=NULL,verify_lease_expires_at=NULL,
      updated_at=now_at WHERE t.preview_id=preview.preview_id AND t.ordinal=p_ordinal;
    IF p_failure='not-found' THEN
      removed:=COALESCE(cc.soft_delete_users(p_customer,jsonb_build_array(target.user_id),
        p_observed_at),'[]'::jsonb);
    END IF;
  ELSE
    -- A read that proves nothing settles nothing. The fence clears, so the next read may claim.
    UPDATE cc.user_attribute_preview_targets t SET failure=COALESCE(p_failure,t.failure),
      outcome_reason=COALESCE(p_reason,t.outcome_reason),google_status=p_google_status,
      google_reason=p_google_reason,verified_by='read-back',verify_attempt=NULL,
      verify_lease_expires_at=NULL,updated_at=now_at
      WHERE t.preview_id=preview.preview_id AND t.ordinal=p_ordinal;
  END IF;
  PERFORM cc.refresh_user_attribute_counters(p_job);
  -- R9: the reconciliation decides the terminal status when no operation is left. A job that still
  -- holds pending or dispatched work keeps its running state, and a cancelled or failed job keeps
  -- its status.
  SELECT count(*) INTO left_over FROM cc.user_attribute_preview_targets t
    WHERE t.preview_id=preview.preview_id AND t.disposition='eligible' AND
      COALESCE(t.outcome,'pending') IN ('pending','dispatched','unknown');
  IF left_over=0 AND (SELECT j.status FROM cc.jobs j WHERE j.job_id=p_job) IN ('running','needs-review') THEN
    UPDATE cc.jobs SET status=cc.user_attribute_terminal_status(p_job),finished_at=COALESCE(finished_at,now_at)
      WHERE job_id=p_job;
  END IF;
  status_after:=(SELECT j.status FROM cc.jobs j WHERE j.job_id=p_job);
  PERFORM cc.record_job_change(p_job,true);
  RETURN jsonb_build_object('outcome','settled','status',status_after,'removed',removed,
    'changed',changed,'outcomeOf',(SELECT t.outcome FROM cc.user_attribute_preview_targets t WHERE
      t.preview_id=preview.preview_id AND t.ordinal=p_ordinal));
END;
$$;

-- 16. The start receipts of the flow. The device start writes the execution ID, and the deadline
-- resolves a lost start (design sections 5.3 and 6.5).
CREATE FUNCTION cc.record_user_attribute_start(p_customer text,p_job uuid,p_token uuid,p_execution text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; changed integer;
BEGIN
  IF p_customer IS NULL OR p_job IS NULL OR p_token IS NULL OR p_execution IS NULL OR
    length(p_execution) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'The value job start is invalid.' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cc.job-admission:'||p_customer)::bigint);
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  PERFORM 1 FROM cc.user_attribute_update_jobs u WHERE u.job_id=p_job FOR UPDATE;
  IF job.job_id IS NULL OR job.kind<>'user-attribute-update' THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  -- R4: the startup window stays. A recovery run before it expires consumes no further start, and
  -- the third start still reaches its exhaustion closure.
  UPDATE cc.user_attribute_update_jobs SET kestra_execution_id=p_execution
    WHERE job_id=p_job AND dispatch_token=p_token;
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed=0 THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  RETURN jsonb_build_object('outcome','recorded');
END;
$$;

CREATE FUNCTION cc.abandon_user_attribute_start(p_customer text,p_job uuid,p_token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.user_attribute_update_jobs; now_at timestamptz;
BEGIN
  IF p_customer IS NULL OR p_job IS NULL OR p_token IS NULL THEN
    RAISE EXCEPTION 'The value job start is invalid.' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cc.job-admission:'||p_customer)::bigint);
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  SELECT * INTO detail FROM cc.user_attribute_update_jobs u WHERE u.job_id=p_job FOR UPDATE;
  IF job.job_id IS NULL OR job.kind<>'user-attribute-update' OR
    detail.dispatch_token IS DISTINCT FROM p_token OR detail.first_claimed_at IS NOT NULL OR
    job.status<>'running' THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  now_at:=clock_timestamp();
  PERFORM cc.skip_user_attribute_pending(p_job,'interrupted');
  PERFORM cc.refresh_user_attribute_counters(p_job);
  UPDATE cc.jobs SET status='failed',failure='orchestration-unavailable',finished_at=now_at
    WHERE job_id=p_job;
  PERFORM cc.record_job_change(p_job,true);
  RETURN jsonb_build_object('outcome','failed','failure','orchestration-unavailable');
END;
$$;

-- 15b. The one fenced operation of a reconcile read. The route claimed the row with its attempt, and
-- this read returns the values, the mask, and the credential of that attempt. It changes nothing.
CREATE FUNCTION cc.read_user_attribute_verification(p_customer text,p_job uuid,p_attempt uuid,
  p_operation_number integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.user_attribute_update_jobs; preview cc.user_attribute_previews;
  connection cc.google_connection; envelope jsonb; target cc.user_attribute_preview_targets;
BEGIN
  IF p_customer IS NULL OR p_job IS NULL OR p_attempt IS NULL OR p_operation_number IS NULL OR
    p_operation_number<1 THEN
    RAISE EXCEPTION 'The value operation read-back is invalid.' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(7240173008);
  PERFORM pg_advisory_xact_lock(hashtext('cc.job-admission:'||p_customer)::bigint);
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  IF job.job_id IS NULL OR job.kind<>'user-attribute-update' THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  SELECT * INTO detail FROM cc.user_attribute_update_jobs u WHERE u.job_id=p_job FOR UPDATE;
  IF detail.job_id IS NULL THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  SELECT * INTO preview FROM cc.user_attribute_previews p WHERE p.preview_id=detail.preview_id;
  SELECT t.* INTO target FROM (SELECT o.*,row_number() OVER (ORDER BY o.ordinal) AS number
      FROM cc.user_attribute_preview_targets o WHERE o.preview_id=preview.preview_id AND
      o.disposition='eligible') t WHERE t.number=p_operation_number;
  IF target.preview_id IS NULL OR target.outcome<>'unknown' OR
    target.verify_attempt IS DISTINCT FROM p_attempt OR target.verify_lease_expires_at IS NULL OR
    target.verify_lease_expires_at<=clock_timestamp() THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  SELECT * INTO connection FROM cc.google_connection c WHERE c.customer_id=p_customer FOR KEY SHARE;
  IF connection.credential_id IS NOT NULL THEN
    SELECT c.envelope INTO envelope FROM cc.google_credentials c WHERE c.id=connection.credential_id;
  END IF;
  IF envelope IS NULL THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  RETURN jsonb_build_object('outcome','read','ordinal',target.ordinal,
    'generation',connection.generation,'credentialId',connection.credential_id,'envelope',envelope,
    'mask',COALESCE((SELECT jsonb_agg(DISTINCT v.schema_name ORDER BY v.schema_name)
      FROM cc.user_attribute_target_values v WHERE v.preview_id=preview.preview_id AND
      v.disposition='eligible'),'[]'::jsonb),
    'fields',cc.user_attribute_work_fields(preview.preview_id),
    'user',cc.user_attribute_work_row(target,preview.preview_id));
END;
$$;

-- 16b. The send gate of one value envelope (R4). It runs after the token mint and immediately before
-- the multipart request, so a cancel or a lost ownership before it stops the envelope there.
CREATE FUNCTION cc.begin_user_attribute_write(p_customer text,p_job uuid,p_token uuid,p_attempt uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.user_attribute_update_jobs; now_at timestamptz;
BEGIN
  IF p_customer IS NULL OR p_job IS NULL OR p_token IS NULL OR p_attempt IS NULL THEN
    RAISE EXCEPTION 'The value job write is invalid.' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cc.job-admission:'||p_customer)::bigint);
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  IF job.job_id IS NULL OR job.kind<>'user-attribute-update' THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  SELECT * INTO detail FROM cc.user_attribute_update_jobs u WHERE u.job_id=p_job FOR UPDATE;
  now_at:=clock_timestamp();
  IF job.status<>'running' OR job.finished_at IS NOT NULL OR job.cancel_requested_at IS NOT NULL OR
    detail.job_id IS NULL OR detail.dispatch_token IS DISTINCT FROM p_token OR
    detail.attempt IS DISTINCT FROM p_attempt OR detail.attempt_expires_at IS NULL OR
    detail.attempt_expires_at<=now_at THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  UPDATE cc.user_attribute_update_jobs SET write_started_at=COALESCE(write_started_at,now_at)
    WHERE job_id=p_job;
  -- The envelope leaves the worker after this answer, so every row it carries is proven sent. A
  -- cancel or a recovery can no longer treat those rows as unsent (B section 7.4, R8).
  UPDATE cc.user_attribute_preview_targets t SET sent_at=now_at,updated_at=now_at
    WHERE t.preview_id=detail.preview_id AND t.disposition='eligible' AND t.outcome='dispatched' AND
      t.attempt=p_attempt AND t.sent_at IS NULL;
  RETURN jsonb_build_object('outcome','writing');
END;
$$;

-- 16c. The lease extension of one multipart round. A long envelope never loses its attempt. Only the
-- live owner extends, so an obsolete runner never renews across a replacement dispatch (R7).
CREATE FUNCTION cc.extend_user_attribute_attempt(p_customer text,p_job uuid,p_token uuid,p_attempt uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.user_attribute_update_jobs; now_at timestamptz;
BEGIN
  IF p_customer IS NULL OR p_job IS NULL OR p_token IS NULL OR p_attempt IS NULL THEN
    RAISE EXCEPTION 'The value job attempt is invalid.' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cc.job-admission:'||p_customer)::bigint);
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  SELECT * INTO detail FROM cc.user_attribute_update_jobs u WHERE u.job_id=p_job FOR UPDATE;
  now_at:=clock_timestamp();
  IF job.job_id IS NULL OR job.kind<>'user-attribute-update' OR job.status<>'running' OR
    job.finished_at IS NOT NULL OR detail.dispatch_token IS DISTINCT FROM p_token OR
    detail.attempt IS DISTINCT FROM p_attempt OR detail.attempt_expires_at IS NULL OR
    detail.attempt_expires_at<=now_at THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  UPDATE cc.user_attribute_update_jobs SET attempt_expires_at=now_at+interval '10 minutes'
    WHERE job_id=p_job;
  RETURN jsonb_build_object('outcome','extended');
END;
$$;

-- 16d. The stop of one value job (B sections 7.3 and 7.4). The worker calls it when a fatal auth
-- answer, a missing credential, or a refused send gate ends the run. A proven-unsent user settles
-- Skipped, or Cancelled for a cancel. A user whose envelope left stays Unknown for the read-back.
-- Only the live owner stops the job (R7).
CREATE FUNCTION cc.stop_user_attribute_job(p_customer text,p_job uuid,p_token uuid,p_attempt uuid,
  p_failure text,p_cancel boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.user_attribute_update_jobs; preview uuid; now_at timestamptz;
  status_after text; stopped integer; in_flight integer;
BEGIN
  IF p_customer IS NULL OR p_job IS NULL OR p_token IS NULL OR p_attempt IS NULL OR
    p_cancel IS NULL OR (p_failure IS NOT NULL AND NOT cc.job_failure_known(p_failure)) OR
    (p_cancel AND p_failure IS NOT NULL) THEN
    RAISE EXCEPTION 'The value job stop is invalid.' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cc.job-admission:'||p_customer)::bigint);
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  IF job.job_id IS NULL OR job.kind<>'user-attribute-update' THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  SELECT * INTO detail FROM cc.user_attribute_update_jobs u WHERE u.job_id=p_job FOR UPDATE;
  SELECT u.preview_id INTO preview FROM cc.user_attribute_update_jobs u WHERE u.job_id=p_job;
  PERFORM 1 FROM cc.user_attribute_preview_targets t WHERE t.preview_id=preview AND
    t.disposition='eligible' ORDER BY t.ordinal FOR UPDATE;
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job FOR UPDATE;
  SELECT * INTO detail FROM cc.user_attribute_update_jobs u WHERE u.job_id=p_job FOR UPDATE;
  now_at:=clock_timestamp();
  IF job.status<>'running' OR job.finished_at IS NOT NULL OR detail.dispatch_token IS DISTINCT FROM p_token
    OR detail.attempt IS DISTINCT FROM p_attempt OR detail.attempt_expires_at IS NULL OR
    detail.attempt_expires_at<=now_at THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  -- Every row this attempt has not released through its send gate never left the worker.
  WITH changed AS (
    UPDATE cc.user_attribute_preview_targets t SET
      outcome=CASE WHEN p_cancel THEN 'cancelled' ELSE 'skipped' END,
      failure=CASE WHEN p_cancel THEN NULL ELSE COALESCE(p_failure,'interrupted') END,
      outcome_reason=NULL,answered_at=now_at,updated_at=now_at
    WHERE t.preview_id=preview AND t.disposition='eligible' AND
      COALESCE(t.outcome,'pending') IN ('pending','dispatched') AND t.sent_at IS NULL
    RETURNING t.ordinal
  ) SELECT count(*) INTO stopped FROM changed;
  WITH changed AS (
    UPDATE cc.user_attribute_preview_targets t SET outcome='unknown',
      failure=COALESCE(t.failure,'interrupted'),outcome_reason='interrupted',
      verify_after=now_at+interval '30 seconds',verify_attempt=NULL,verify_lease_expires_at=NULL,
      updated_at=now_at
    WHERE t.preview_id=preview AND t.disposition='eligible' AND t.outcome='dispatched' AND
      t.sent_at IS NOT NULL
    RETURNING t.ordinal
  ) SELECT count(*) INTO in_flight FROM changed;
  PERFORM cc.refresh_user_attribute_counters(p_job);
  status_after:=cc.user_attribute_terminal_status(p_job);
  UPDATE cc.jobs SET status=status_after,finished_at=now_at,
    failure=CASE WHEN p_cancel THEN failure ELSE COALESCE(failure,p_failure) END
    WHERE job_id=p_job;
  PERFORM cc.record_job_change(p_job,true);
  RETURN jsonb_build_object('outcome','stopped','status',status_after,'stopped',stopped,
    'inFlight',in_flight);
END;
$$;

REVOKE ALL ON FUNCTION
  cc.begin_user_attribute_write(text,uuid,uuid,uuid),
  cc.extend_user_attribute_attempt(text,uuid,uuid,uuid),
  cc.stop_user_attribute_job(text,uuid,uuid,uuid,text,boolean),
  cc.user_attribute_terminal_status(uuid),
  cc.refresh_user_attribute_counters(uuid),
  cc.user_attribute_stop_reason(text,uuid,integer,integer,boolean),
  cc.user_attribute_work_fields(uuid),
  cc.user_attribute_work_row(cc.user_attribute_preview_targets,uuid),
  cc.claim_user_attribute_updates(text,uuid,uuid,uuid,integer),
  cc.settle_user_attribute_updates(text,uuid,uuid,uuid,jsonb,timestamptz,text),
  cc.finish_user_attribute_job(text,uuid,uuid,uuid,text),
  cc.claim_user_attribute_verification(text,uuid,uuid,jsonb,integer),
  cc.skip_user_attribute_pending(uuid,text),
  cc.recover_user_attribute_jobs(text),
  cc.claim_user_attribute_verification_one(text,uuid,uuid,integer),
  cc.settle_user_attribute_verification(text,uuid,uuid,integer,text,text,text,integer,text,jsonb,timestamptz),
  cc.read_user_attribute_verification(text,uuid,uuid,integer),
  cc.record_user_attribute_start(text,uuid,uuid,text),
  cc.abandon_user_attribute_start(text,uuid,uuid) FROM PUBLIC;
-- 17. The cancel rule of B section 7.4 replaces the 026 definition with one branch for the value
-- kind. Every other branch keeps its exact text.
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
  -- A value job locks its detail row after the header, as its claim and its settlement do.
  ELSIF job.kind='user-attribute-update' THEN
    PERFORM 1 FROM cc.user_attribute_update_jobs u WHERE u.job_id=job.job_id FOR UPDATE;
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
    -- B section 7.4: a category job holds one call. Before that call begins, the request ends the
    -- job at once, even after the claim. After it begins, the call cannot stop, so the request
    -- answers `nothing-to-stop`. The write gate of 9b reads cancel_requested_at under this lock, so
    -- a cancel before the gate always stops the send (R4).
    SELECT * INTO schema_detail FROM cc.user_schema_change_jobs u WHERE u.job_id=job.job_id;
    IF schema_detail.write_started_at IS NOT NULL THEN
      RAISE EXCEPTION 'The job holds no work to stop.' USING DETAIL='nothing-to-stop';
    END IF;
    stop_now:=true;
  ELSIF job.kind='user-attribute-update' THEN
    -- B section 7.4: a value job sends one envelope at a time, and its claim reads
    -- cancel_requested_at under this header lock before each envelope. Before the first envelope the
    -- request ends the job at once. After it, the request stays, and the worker stops the remaining
    -- envelopes at its next claim.
    IF NOT EXISTS(SELECT 1 FROM cc.user_attribute_preview_targets t
        JOIN cc.user_attribute_update_jobs u ON u.preview_id=t.preview_id
        WHERE u.job_id=job.job_id AND t.disposition='eligible' AND
          COALESCE(t.outcome,'pending') IN ('pending','dispatched')) THEN
      RAISE EXCEPTION 'The job holds no work to stop.' USING DETAIL='nothing-to-stop';
    END IF;
    stop_now:=job.status<>'running' OR
      (SELECT u.write_started_at IS NULL FROM cc.user_attribute_update_jobs u
        WHERE u.job_id=job.job_id);
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
  ELSIF job.kind='user-attribute-update' THEN
    -- The first envelope never left. The pending users count cancelled, and the terminal rule ends
    -- the job. A request after the first envelope keeps the header and the worker settles the rest.
    IF stop_now THEN
      PERFORM cc.skip_user_attribute_pending(job.job_id,'cancelled');
      PERFORM cc.refresh_user_attribute_counters(job.job_id);
      now_at:=clock_timestamp();
      UPDATE cc.jobs SET status=cc.user_attribute_terminal_status(job.job_id),finished_at=now_at
        WHERE job_id=job.job_id;
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

REVOKE ALL ON FUNCTION cc.request_job_cancel(uuid,integer,text,text,uuid) FROM PUBLIC;

-- 20. The admission of the one write slot (design section 5.3; card K24). This definition repeats
-- `026-user-category-jobs.sql` with one more kind, so a value job takes the slot of a device or a
-- category job and no second write job of the customer starts beside it (E8). Every other line is
-- the released one.
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
  FOR job IN SELECT j.* FROM cc.jobs j WHERE j.customer_id=p_customer AND j.kind IN ('device-update','device-command','device-status','user-schema-change','user-attribute-update')
      AND j.status IN ('accepted','queued','held') ORDER BY j.target_count,j.created_at,j.display_id FOR UPDATE LOOP
    candidates:=candidates||job;
  END LOOP;
  -- S1 (round 3, R2-F3): the clock reads after every header wait, before the validation and before the
  -- detail lock, on every path. The admitted path reads it again after its detail wait below.
  now_at:=clock_timestamp();
  -- S1 (round 2): the one-running flag reads after every header wait, so a job that ended in a wait
  -- leaves the write slot free for this admission. The category and value kinds hold the same write
  -- slot (E8).
  SELECT EXISTS(SELECT 1 FROM cc.jobs j WHERE j.customer_id=p_customer AND j.kind IN ('device-update','device-command','device-status','user-schema-change','user-attribute-update') AND j.status='running')
    INTO running;
  -- S1 (round 3): a status change publishes, and the publication row references the connection row. A
  -- credential read holds that row FOR UPDATE (008), so the connection row locks here, after the validation,
  -- and no publication insert waits on it. After that wait the clock and the one-running flag read again.
  IF cardinality(candidates)>0 THEN
    PERFORM 1 FROM cc.google_connection c WHERE c.customer_id=p_customer FOR KEY SHARE;
    now_at:=clock_timestamp();
    SELECT EXISTS(SELECT 1 FROM cc.jobs j WHERE j.customer_id=p_customer AND j.kind IN ('device-update','device-command','device-status','user-schema-change','user-attribute-update') AND
      j.status='running') INTO running;
  END IF;
  label:=CASE WHEN p_held THEN 'held' ELSE 'queued' END;
  FOREACH job IN ARRAY candidates LOOP
    -- A status job of an import plan waits for its update job (design section 3, "The wait"). The
    -- awaited header reads without a lock, and final means a finished status, cancelled included.
    -- A candidate that still waits keeps the queue and never takes the write slot or the dispatch.
    -- A category job and a value job hold no awaited job, so the read finds no row and the candidate
    -- never waits.
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
      ELSIF job.kind='user-attribute-update' THEN
        PERFORM 1 FROM cc.user_attribute_update_jobs u WHERE u.job_id=job.job_id FOR UPDATE;
      ELSE
        PERFORM 1 FROM cc.device_update_jobs u WHERE u.job_id=job.job_id FOR UPDATE;
      END IF;
      now_at:=clock_timestamp();
      UPDATE cc.jobs SET status='running',admitted_at=now_at WHERE job_id=job.job_id;
      IF job.kind='user-schema-change' THEN
        UPDATE cc.user_schema_change_jobs SET dispatch_token=gen_random_uuid(),dispatch_count=1,
          start_deadline_at=now_at+interval '120 seconds' WHERE job_id=job.job_id RETURNING dispatch_token INTO token;
      ELSIF job.kind='user-attribute-update' THEN
        UPDATE cc.user_attribute_update_jobs SET dispatch_token=gen_random_uuid(),dispatch_count=1,
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

REVOKE ALL ON FUNCTION cc.admit_device_update_job(text,boolean) FROM PUBLIC;
