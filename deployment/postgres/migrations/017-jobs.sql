-- The job header, the write-job tables, the fenced functions, the overlays, the purge, and the three actions.
-- 016 keeps the device inventory and the refresh job model. This file adds new objects only.
-- The only statement below that alters a 016 object is the dependency-forced foreign key of cc.entity_sync_jobs.
INSERT INTO cc.application_actions(action,scope_kinds) VALUES('devices:write',ARRAY['platform','district']),
  ('devices:bulk-actions',ARRAY['platform','district']),('jobs:read',ARRAY['platform','district']);

CREATE SEQUENCE cc.job_number_upd;
CREATE SEQUENCE cc.job_number_ref;
CREATE SEQUENCE cc.preview_number_pv;

-- One header row per background job. Refresh jobs keep cc.entity_sync_jobs as their detail table.
CREATE TABLE cc.jobs (
  job_id uuid PRIMARY KEY,
  display_id text NOT NULL UNIQUE CHECK(display_id ~ '^(UPD|REF)-[0-9]{3,}$'),
  customer_id text NOT NULL REFERENCES cc.google_connection(customer_id),
  kind text NOT NULL CHECK(kind IN ('inventory-refresh','device-update')),
  scope_kind text NOT NULL CHECK(scope_kind IN ('devices','all-devices')),
  status text NOT NULL CHECK(status IN ('accepted','queued','held','running','completed',
    'completed-with-errors','failed','needs-review')),
  requested_by uuid NOT NULL REFERENCES cc.application_principals(id),
  generation integer NOT NULL,
  target_count integer CHECK(target_count IS NULL OR target_count>=0),
  target_org_unit_paths text[],
  succeeded integer NOT NULL DEFAULT 0 CHECK(succeeded>=0),
  failed integer NOT NULL DEFAULT 0 CHECK(failed>=0),
  unknown integer NOT NULL DEFAULT 0 CHECK(unknown>=0),
  skipped integer NOT NULL DEFAULT 0 CHECK(skipped>=0),
  failure text CHECK(failure IN ('credential-rejected','delegation-not-authorized','api-not-enabled',
    'policy-restricted','network-failure','scope-mismatch','permission-denied','quota','provider-unavailable',
    'invalid-response','wrong-customer','request-failed','key-unavailable','interrupted','orchestration-unavailable',
    'permission-changed','connection-changed')),
  revision bigint NOT NULL DEFAULT 1,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  admitted_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  CHECK(scope_kind<>'devices' OR (target_count IS NOT NULL AND target_count BETWEEN 1 AND 100000))
);
CREATE INDEX jobs_recent ON cc.jobs(customer_id,created_at DESC,display_id DESC);
CREATE UNIQUE INDEX jobs_one_running ON cc.jobs(customer_id)
  WHERE kind='device-update' AND status='running';
CREATE INDEX jobs_admission ON cc.jobs(customer_id,target_count,created_at,display_id)
  WHERE kind='device-update' AND status IN ('accepted','queued','held');
CREATE INDEX jobs_finished ON cc.jobs(customer_id,finished_at DESC) WHERE finished_at IS NOT NULL;

-- The refresh detail row shares the header identity. 016 defines the detail table, so 017 adds this constraint.
ALTER TABLE cc.entity_sync_jobs ADD CONSTRAINT entity_sync_jobs_header
  FOREIGN KEY(job_id) REFERENCES cc.jobs(job_id) ON DELETE CASCADE;

-- One refresh target at creation, or one staged full-sync device. The OrgUnit path stays with the target.
CREATE TABLE cc.job_targets (
  job_id uuid NOT NULL REFERENCES cc.jobs(job_id) ON DELETE CASCADE,
  device_id text NOT NULL CHECK(length(device_id) BETWEEN 1 AND 128),
  org_unit_path text CHECK(org_unit_path IS NULL OR length(org_unit_path)<=4096),
  observed_at timestamptz NOT NULL,
  PRIMARY KEY(job_id,device_id)
);

-- One prepared preview of an annotated-location update.
CREATE TABLE cc.device_update_previews (
  preview_id uuid PRIMARY KEY,
  display_id text NOT NULL UNIQUE CHECK(display_id ~ '^PV-[0-9]{3,}$'),
  customer_id text NOT NULL REFERENCES cc.google_connection(customer_id),
  created_by uuid NOT NULL REFERENCES cc.application_principals(id),
  permission_version integer NOT NULL,
  generation integer NOT NULL,
  field text NOT NULL CHECK(field IN ('annotatedLocation')),
  mode text NOT NULL CHECK(mode IN ('replace','clear')),
  value text,
  action_version integer NOT NULL DEFAULT 1 CHECK(action_version>=1),
  selected integer NOT NULL CHECK(selected>=0),
  eligible integer NOT NULL CHECK(eligible>=0),
  unchanged integer NOT NULL CHECK(unchanged>=0),
  excluded integer NOT NULL CHECK(excluded>=0),
  oldest_observed_at timestamptz,
  manifest_digest text NOT NULL,
  prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  job_id uuid UNIQUE REFERENCES cc.jobs(job_id),
  CHECK(selected=eligible+unchanged+excluded),
  CHECK((mode='clear')=(value IS NULL))
);

-- The frozen target list of one preview.
CREATE TABLE cc.device_update_preview_targets (
  preview_id uuid NOT NULL REFERENCES cc.device_update_previews(preview_id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK(ordinal>=0),
  device_id text NOT NULL,
  serial_number text NOT NULL,
  org_unit_path text NOT NULL,
  observed_value text,
  observed_at timestamptz,
  disposition text NOT NULL CHECK(disposition IN ('eligible','unchanged','excluded')),
  exclusion_reason text,
  PRIMARY KEY(preview_id,ordinal),
  UNIQUE(preview_id,device_id),
  CHECK(disposition='excluded' OR exclusion_reason IS NULL)
);

-- One write job, with its dispatch state, its retry registry, and its evidence files.
CREATE TABLE cc.device_update_jobs (
  job_id uuid PRIMARY KEY REFERENCES cc.jobs(job_id) ON DELETE CASCADE,
  preview_id uuid NOT NULL UNIQUE REFERENCES cc.device_update_previews(preview_id),
  field text NOT NULL CHECK(field IN ('annotatedLocation')),
  mode text NOT NULL CHECK(mode IN ('replace','clear')),
  value text,
  confirmed_by uuid NOT NULL REFERENCES cc.application_principals(id),
  confirmer_permission_version integer NOT NULL,
  delegated_subject text NOT NULL,
  batch_size integer NOT NULL CHECK(batch_size BETWEEN 1 AND 250),
  batch_count integer NOT NULL CHECK(batch_count>=1),
  dispatch_token uuid,
  dispatch_count integer NOT NULL DEFAULT 0 CHECK(dispatch_count>=0),
  start_deadline_at timestamptz,
  kestra_execution_id text,
  first_claimed_at timestamptz,
  heartbeat_at timestamptz,
  backoff_attempt uuid,
  backoff_sequence integer,
  backoff_reported_at timestamptz,
  hold_attempt uuid,
  hold_sequence integer,
  hold_written_at timestamptz,
  hold_cleaned_at timestamptz,
  manifest_artifact_id text,
  result_artifact_id text
);

-- One batch of a write job. The row holds the lease of one attempt.
CREATE TABLE cc.device_update_batches (
  job_id uuid NOT NULL REFERENCES cc.device_update_jobs(job_id) ON DELETE CASCADE,
  batch integer NOT NULL CHECK(batch>=0),
  attempt_id uuid,
  execution_id text,
  lease_expires_at timestamptz,
  claimed_at timestamptz,
  settled_at timestamptz,
  PRIMARY KEY(job_id,batch)
);

-- One eligible target, with its baseline, its request, and its outcome evidence.
CREATE TABLE cc.device_update_operations (
  job_id uuid NOT NULL REFERENCES cc.device_update_jobs(job_id) ON DELETE CASCADE,
  operation_number integer NOT NULL CHECK(operation_number>=1),
  device_id text NOT NULL,
  serial_number text NOT NULL,
  org_unit_path text NOT NULL,
  baseline_value text,
  requested_value text,
  batch integer NOT NULL CHECK(batch>=0),
  status text NOT NULL CHECK(status IN ('pending','dispatched','succeeded','failed','unknown','skipped')),
  attempt_id uuid,
  google_status integer,
  google_reason text,
  quota_retries integer NOT NULL DEFAULT 0 CHECK(quota_retries>=0),
  transient_retries integer NOT NULL DEFAULT 0 CHECK(transient_retries>=0),
  observed_value text,
  observed_at timestamptz,
  verified_by text CHECK(verified_by IN ('write-response','read-back')),
  outcome_reason text,
  verify_attempt uuid,
  verify_lease_expires_at timestamptz,
  verify_after timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(job_id,operation_number)
);
CREATE INDEX device_update_operations_activity
  ON cc.device_update_operations(job_id,status,updated_at DESC,operation_number);

-- The accepted value of one device, until a list converges or the overlay expires.
CREATE TABLE cc.device_write_overlays (
  customer_id text NOT NULL REFERENCES cc.google_connection(customer_id),
  device_id text NOT NULL,
  field text NOT NULL CHECK(field IN ('annotatedLocation')),
  value text,
  observed_at timestamptz NOT NULL,
  source text NOT NULL CHECK(source IN ('write-response','read-back','refresh-read')),
  job_id uuid NOT NULL REFERENCES cc.jobs(job_id),
  operation_number integer,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(customer_id,device_id,field)
);

-- The time each person last cleared the activity attention dot.
CREATE TABLE cc.job_activity_seen (
  principal_id uuid PRIMARY KEY REFERENCES cc.application_principals(id),
  seen_at timestamptz NOT NULL
);

-- One committed job change that Redis does not carry yet. The publication outbox of section 3.6.
CREATE TABLE cc.job_publications (
  publication_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id text NOT NULL REFERENCES cc.google_connection(customer_id),
  job_id uuid NOT NULL REFERENCES cc.jobs(job_id) ON DELETE CASCADE,
  revision bigint NOT NULL,
  status_changed boolean NOT NULL DEFAULT false,
  device_ids jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK(jsonb_typeof(device_ids)='array' AND jsonb_array_length(device_ids)<=1000),
  removed_ids jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK(jsonb_typeof(removed_ids)='array' AND jsonb_array_length(removed_ids)<=1000),
  batch integer,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(jsonb_array_length(device_ids)+jsonb_array_length(removed_ids)<=1000)
);
CREATE INDEX job_publications_ready ON cc.job_publications(customer_id,publication_id);

-- The display format is the prefix, a hyphen, and the number with at least three digits.
CREATE FUNCTION cc.job_display_id(p_prefix text,p_number bigint) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT p_prefix||'-'||CASE WHEN p_number<1000 THEN lpad(p_number::text,3,'0') ELSE p_number::text END;
$$;

-- The visibility predicate of section 2.1. A holder of jobs:read sees every job of the customer.
CREATE FUNCTION cc.job_visible(p_actor uuid,p_version integer,p_customer text,p_requested_by uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM cc.application_principals p
      WHERE p.id=p_actor AND p.enabled AND p.permission_version=p_version) THEN
    RETURN false;
  END IF;
  IF p_requested_by IS NOT NULL AND p_requested_by=p_actor THEN RETURN true; END IF;
  RETURN EXISTS(SELECT 1 FROM cc.application_grants g WHERE g.principal_id=p_actor AND g.action='jobs:read' AND
    (g.scope='{"kind":"platform"}'::jsonb OR
    (g.scope->>'kind'='district' AND g.scope->>'customerId'=p_customer)));
END;
$$;

-- The sync state projection for one caller. A failure shows only to its failure requester.
CREATE FUNCTION cc.visible_device_sync(p_actor uuid,p_version integer,p_customer text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE call jsonb; state cc.device_sync_state; now_at timestamptz:=clock_timestamp(); requester uuid;
BEGIN
  SELECT * INTO state FROM cc.device_sync_state s WHERE s.customer_id=p_customer;
  call:=cc.device_sync_projection(p_customer);
  requester:=CASE WHEN state.sync_id IS NULL THEN state.failure_requested_by
    WHEN state.sync_expires_at>now_at THEN NULL ELSE state.sync_actor END;
  IF NOT cc.job_visible(p_actor,p_version,p_customer,requester) THEN
    call:=jsonb_set(call,'{failure}','null'::jsonb);
  END IF;
  IF NOT cc.job_visible(p_actor,p_version,p_customer,state.telemetry_failure_requested_by) THEN
    call:=jsonb_set(call,'{telemetryFailure}','null'::jsonb);
  END IF;
  RETURN call;
END;
$$;

-- The publication element of one row. batchCount is null without devices.
CREATE FUNCTION cc.job_publication_element(j cc.jobs,p cc.job_publications) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT jsonb_build_object('publicationId',p.publication_id,'jobId',p.job_id,'displayId',j.display_id,
    'requestedBy',j.requested_by,'revision',j.revision,'statusChanged',p.status_changed,
    'deviceIds',p.device_ids,'removedIds',p.removed_ids,'batch',p.batch,
    'batchCount',CASE WHEN jsonb_array_length(p.device_ids)+jsonb_array_length(p.removed_ids)>0
      THEN (SELECT u.batch_count FROM cc.device_update_jobs u WHERE u.job_id=p.job_id) END);
$$;

-- Every job-changing function records its change through this call, in its own transaction.
CREATE FUNCTION cc.record_job_change(p_job uuid,p_status_changed boolean DEFAULT false,
  p_device_ids jsonb DEFAULT '[]'::jsonb,p_removed_ids jsonb DEFAULT '[]'::jsonb,p_batch integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; publication cc.job_publications;
BEGIN
  IF jsonb_typeof(p_device_ids) IS DISTINCT FROM 'array' OR jsonb_typeof(p_removed_ids) IS DISTINCT FROM 'array' OR
    jsonb_array_length(p_device_ids)+jsonb_array_length(p_removed_ids)>1000 THEN
    RAISE EXCEPTION 'The publication devices are invalid.' USING ERRCODE='22023';
  END IF;
  UPDATE cc.jobs SET revision=revision+1,changed_at=clock_timestamp() WHERE job_id=p_job RETURNING * INTO job;
  IF job.job_id IS NULL THEN
    RAISE EXCEPTION 'The job does not exist.' USING ERRCODE='22023';
  END IF;
  INSERT INTO cc.job_publications(customer_id,job_id,revision,status_changed,device_ids,removed_ids,batch)
    VALUES(job.customer_id,job.job_id,job.revision,p_status_changed,p_device_ids,p_removed_ids,p_batch)
    RETURNING * INTO publication;
  RETURN cc.job_publication_element(job,publication);
END;
$$;

-- The relay reads every progress-only row, every refresh row, and every other row older than five seconds.
CREATE FUNCTION cc.read_job_publications(p_customer text,p_limit integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT COALESCE(jsonb_agg(cc.job_publication_element(j,p) ORDER BY p.publication_id),'[]'::jsonb)
  FROM (SELECT p.* FROM cc.job_publications p JOIN cc.jobs j ON j.job_id=p.job_id
    WHERE p.customer_id=p_customer AND (j.kind='inventory-refresh' OR
      (NOT p.status_changed AND jsonb_array_length(p.device_ids)=0 AND jsonb_array_length(p.removed_ids)=0) OR
      p.created_at<clock_timestamp()-interval '5 seconds')
    ORDER BY p.publication_id LIMIT LEAST(GREATEST(p_limit,1),500)) picked
  JOIN cc.jobs j ON j.job_id=picked.job_id JOIN cc.job_publications p ON p.publication_id=picked.publication_id;
$$;

CREATE FUNCTION cc.complete_job_publications(p_customer text,p_ids jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE removed integer;
BEGIN
  IF jsonb_typeof(p_ids) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'The publication list is invalid.' USING ERRCODE='22023';
  END IF;
  DELETE FROM cc.job_publications WHERE customer_id=p_customer
    AND publication_id IN (SELECT (e.value)::bigint FROM jsonb_array_elements(p_ids) e);
  GET DIAGNOSTICS removed=ROW_COUNT;
  RETURN removed;
END;
$$;

-- The header counters of a write job come from its operations.
CREATE FUNCTION cc.refresh_device_update_counters(p_job uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
BEGIN
  UPDATE cc.jobs j SET
    succeeded=(SELECT count(*) FROM cc.device_update_operations o WHERE o.job_id=p_job AND o.status='succeeded'),
    failed=(SELECT count(*) FROM cc.device_update_operations o WHERE o.job_id=p_job AND o.status='failed'),
    unknown=(SELECT count(*) FROM cc.device_update_operations o WHERE o.job_id=p_job AND o.status='unknown'),
    skipped=(SELECT count(*) FROM cc.device_update_operations o WHERE o.job_id=p_job AND o.status='skipped')
  WHERE j.job_id=p_job;
END;
$$;

-- The status rule of section 5.10. It reads only counters.
CREATE FUNCTION cc.device_update_terminal_status(p_job uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT CASE WHEN j.unknown>0 THEN 'needs-review'
    WHEN j.succeeded=j.target_count THEN 'completed'
    WHEN j.succeeded>0 AND j.failed+j.skipped>0 THEN 'completed-with-errors'
    ELSE 'failed' END
  FROM cc.jobs j WHERE j.job_id=p_job;
$$;

-- A dispatched operation of a lost attempt becomes unknown. Read-back settles it later.
CREATE FUNCTION cc.fence_device_update_operations(p_job uuid,p_attempt uuid,p_operations jsonb,
  p_verify_after timestamptz,p_lease interval DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE fenced jsonb;
BEGIN
  WITH changed AS (
    UPDATE cc.device_update_operations o SET status='unknown',outcome_reason='interrupted',
      verify_attempt=p_attempt,verify_after=p_verify_after,
      verify_lease_expires_at=CASE WHEN p_lease IS NULL THEN NULL ELSE p_verify_after+p_lease END,
      updated_at=clock_timestamp()
    WHERE o.job_id=p_job AND o.status='dispatched' AND
      (p_operations IS NULL OR o.operation_number IN (SELECT (e.value)::integer FROM jsonb_array_elements(p_operations) e))
    RETURNING o.operation_number,o.device_id,o.serial_number,o.baseline_value,o.requested_value)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('operationNumber',c.operation_number,'deviceId',c.device_id,
    'serialNumber',c.serial_number,'baselineValue',c.baseline_value,'requestedValue',c.requested_value)),'[]'::jsonb)
  INTO fenced FROM changed c;
  RETURN fenced;
END;
$$;

CREATE FUNCTION cc.skip_device_update_pending(p_job uuid,p_reason text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE skipped integer;
BEGIN
  UPDATE cc.device_update_operations SET status='skipped',outcome_reason=COALESCE(outcome_reason,p_reason),
    updated_at=clock_timestamp()
  WHERE job_id=p_job AND status='pending';
  GET DIAGNOSTICS skipped=ROW_COUNT;
  RETURN skipped;
END;
$$;

-- A refresh header that ends without its live sync lease ends as failed.
CREATE FUNCTION cc.close_refresh_job(p_job uuid,p_failure text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
BEGIN
  UPDATE cc.jobs SET status='failed',failure=COALESCE(failure,p_failure),
    finished_at=COALESCE(finished_at,clock_timestamp())
  WHERE job_id=p_job AND finished_at IS NULL;
  IF FOUND THEN PERFORM cc.record_job_change(p_job,true); END IF;
END;
$$;

-- The confirmer of a write job still holds both write actions at the connection scope.
CREATE FUNCTION cc.write_capable(p_actor uuid,p_customer text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT count(DISTINCT g.action)=2 FROM cc.application_grants g
  WHERE g.principal_id=p_actor AND g.action IN ('devices:write','devices:bulk-actions')
    AND (g.scope='{"kind":"platform"}'::jsonb OR
    (g.scope->>'kind'='district' AND g.scope->>'customerId'=p_customer));
$$;

-- Admission order: smallest target count, then oldest creation, then lowest display ID.
CREATE FUNCTION cc.admit_device_update_job(p_customer text,p_held boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; admitted jsonb:=NULL; now_at timestamptz:=clock_timestamp(); running boolean; token uuid;
  label text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('cc.job-admission:'||p_customer)::bigint);
  SELECT EXISTS(SELECT 1 FROM cc.jobs j WHERE j.customer_id=p_customer AND j.kind='device-update' AND j.status='running')
    INTO running;
  label:=CASE WHEN p_held THEN 'held' ELSE 'queued' END;
  FOR job IN SELECT j.* FROM cc.jobs j WHERE j.customer_id=p_customer AND j.kind='device-update'
      AND j.status IN ('accepted','queued','held') ORDER BY j.target_count,j.created_at,j.display_id FOR UPDATE LOOP
    IF running OR p_held THEN
      IF job.status<>label THEN
        UPDATE cc.jobs SET status=label WHERE job_id=job.job_id;
        PERFORM cc.record_job_change(job.job_id,true);
      END IF;
    ELSIF admitted IS NULL THEN
      UPDATE cc.jobs SET status='running',admitted_at=now_at WHERE job_id=job.job_id;
      UPDATE cc.device_update_jobs SET dispatch_token=gen_random_uuid(),dispatch_count=1,
        start_deadline_at=now_at+interval '120 seconds' WHERE job_id=job.job_id RETURNING dispatch_token INTO token;
      PERFORM cc.record_job_change(job.job_id,true);
      admitted:=jsonb_build_object('jobId',job.job_id,'displayId',job.display_id,'dispatchToken',token,
        'correlationId',job.correlation_id,'targetCount',job.target_count);
    ELSE
      UPDATE cc.jobs SET status='queued' WHERE job_id=job.job_id;
      PERFORM cc.record_job_change(job.job_id,true);
    END IF;
  END LOOP;
  RETURN admitted;
END;
$$;

-- The tick records the Kestra execution of one admitted job.
CREATE FUNCTION cc.record_device_update_start(p_customer text,p_job uuid,p_token uuid,p_execution text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE detail cc.device_update_jobs;
BEGIN
  SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=p_job FOR UPDATE;
  IF detail.job_id IS NULL OR detail.dispatch_token IS DISTINCT FROM p_token THEN
    RAISE EXCEPTION 'The device update attempt is fenced.' USING DETAIL='attempt-fenced';
  END IF;
  UPDATE cc.device_update_jobs SET kestra_execution_id=p_execution WHERE job_id=p_job;
END;
$$;

-- A refused start ends the job. The fence is the current token and no first claim.
CREATE FUNCTION cc.abandon_device_update_start(p_customer text,p_job uuid,p_token uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.device_update_jobs; now_at timestamptz:=clock_timestamp();
BEGIN
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=p_job;
  IF job.job_id IS NULL OR job.status<>'running' OR detail.dispatch_token IS DISTINCT FROM p_token OR
    detail.first_claimed_at IS NOT NULL THEN
    RETURN;
  END IF;
  UPDATE cc.jobs SET status='failed',failure='orchestration-unavailable',finished_at=now_at WHERE job_id=p_job;
  PERFORM cc.skip_device_update_pending(p_job,'orchestration-unavailable');
  PERFORM cc.refresh_device_update_counters(p_job);
  PERFORM cc.record_job_change(p_job,true);
END;
$$;

-- The tick resolves an unclaimed start and a lost runner. At three executions the job ends.
CREATE FUNCTION cc.recover_device_update_jobs(p_customer text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.device_update_jobs; now_at timestamptz:=clock_timestamp(); token uuid;
  starts jsonb:='[]'::jsonb; reconciles jsonb:='[]'::jsonb; live boolean;
BEGIN
  FOR job IN SELECT j.* FROM cc.jobs j WHERE j.customer_id=p_customer AND j.kind='device-update' AND j.status='running'
      ORDER BY j.created_at FOR UPDATE LOOP
    SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=job.job_id;
    SELECT EXISTS(SELECT 1 FROM cc.device_update_batches b WHERE b.job_id=job.job_id AND b.lease_expires_at>now_at)
      INTO live;
    IF detail.first_claimed_at IS NULL AND detail.start_deadline_at<=now_at THEN
      IF detail.dispatch_count<3 THEN
        token:=gen_random_uuid();
        UPDATE cc.device_update_jobs SET dispatch_token=token,dispatch_count=dispatch_count+1,
          start_deadline_at=now_at+interval '120 seconds' WHERE job_id=job.job_id;
        starts:=starts||jsonb_build_array(jsonb_build_object('jobId',job.job_id,'displayId',job.display_id,
          'dispatchToken',token,'correlationId',job.correlation_id,'targetCount',job.target_count));
      ELSE
        PERFORM cc.abandon_device_update_start(p_customer,job.job_id,detail.dispatch_token);
      END IF;
    ELSIF detail.first_claimed_at IS NOT NULL AND NOT live AND
      detail.heartbeat_at<=now_at-interval '10 minutes' THEN
      IF detail.dispatch_count<3 THEN
        token:=gen_random_uuid();
        UPDATE cc.device_update_jobs SET dispatch_token=token,dispatch_count=dispatch_count+1,heartbeat_at=now_at,
          start_deadline_at=now_at+interval '120 seconds' WHERE job_id=job.job_id;
        starts:=starts||jsonb_build_array(jsonb_build_object('jobId',job.job_id,'displayId',job.display_id,
          'dispatchToken',token,'correlationId',job.correlation_id,'targetCount',job.target_count));
      ELSE
        PERFORM cc.finalize_device_update_job(p_customer,job.job_id,NULL);
        IF EXISTS(SELECT 1 FROM cc.device_update_operations o WHERE o.job_id=job.job_id AND o.status='unknown') THEN
          reconciles:=reconciles||jsonb_build_array(job.job_id::text);
        END IF;
      END IF;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('starts',starts,'reconciles',reconciles);
END;
$$;

-- A batch claim. It fences a lost attempt, revalidates the confirmer, and reads the credential envelope.
CREATE FUNCTION cc.claim_device_update_batch(p_customer text,p_job uuid,p_token uuid,p_batch integer,
  p_attempt uuid,p_execution text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.device_update_jobs; held cc.device_update_batches; connection cc.google_connection;
  confirmer cc.application_principals; now_at timestamptz:=clock_timestamp(); stopped text:=NULL;
  claim jsonb:='[]'::jsonb; readback jsonb:='[]'::jsonb; live boolean;
BEGIN
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  IF job.job_id IS NULL THEN
    RAISE EXCEPTION 'The device update job does not exist.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=p_job;
  IF job.status<>'running' OR detail.dispatch_token IS DISTINCT FROM p_token OR p_attempt IS NULL THEN
    RETURN jsonb_build_object('outcome','superseded');
  END IF;
  IF p_batch IS NULL OR p_batch<0 OR p_batch>=detail.batch_count THEN
    RAISE EXCEPTION 'The device update batch is invalid.' USING ERRCODE='22023';
  END IF;
  -- Revalidation before dispatch (section 5.6).
  SELECT * INTO confirmer FROM cc.application_principals p WHERE p.id=detail.confirmed_by;
  IF confirmer.id IS NULL OR NOT confirmer.enabled OR
    confirmer.permission_version<>detail.confirmer_permission_version THEN
    stopped:='permission-changed';
  ELSIF NOT cc.write_capable(detail.confirmed_by,p_customer) THEN
    stopped:='permission-changed';
  ELSIF NOT EXISTS(SELECT 1 FROM cc.google_connection c WHERE c.customer_id=p_customer AND
      c.generation=job.generation AND c.active) THEN
    stopped:='connection-changed';
  END IF;
  IF stopped IS NOT NULL THEN
    UPDATE cc.jobs SET failure=COALESCE(failure,stopped) WHERE job_id=p_job;
    PERFORM cc.skip_device_update_pending(p_job,stopped);
    PERFORM cc.refresh_device_update_counters(p_job);
    PERFORM cc.record_job_change(p_job,false);
    RETURN jsonb_build_object('outcome','stopped','failure',stopped);
  END IF;
  SELECT * INTO held FROM cc.device_update_batches b WHERE b.job_id=p_job AND b.batch=p_batch FOR UPDATE;
  live:=held.lease_expires_at IS NOT NULL AND held.lease_expires_at+interval '30 seconds'>now_at;
  IF held.attempt_id IS NOT NULL AND held.attempt_id<>p_attempt THEN
    IF live THEN RETURN jsonb_build_object('outcome','busy'); END IF;
    readback:=cc.fence_device_update_operations(p_job,p_attempt,
      (SELECT COALESCE(jsonb_agg(o.operation_number),'[]'::jsonb) FROM cc.device_update_operations o
        WHERE o.job_id=p_job AND o.batch=p_batch AND o.status='dispatched' AND o.attempt_id=held.attempt_id),
      now_at,interval '120 seconds');
  END IF;
  WITH claimed AS (
    UPDATE cc.device_update_operations o SET status='dispatched',attempt_id=p_attempt,updated_at=now_at
    WHERE o.job_id=p_job AND o.batch=p_batch AND o.status='pending'
    RETURNING o.operation_number,o.device_id,o.serial_number,o.baseline_value,o.requested_value)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('operationNumber',c.operation_number,'deviceId',c.device_id,
    'serialNumber',c.serial_number,'baselineValue',c.baseline_value,'requestedValue',c.requested_value)),'[]'::jsonb)
  INTO claim FROM claimed c;
  IF jsonb_array_length(claim)=0 AND jsonb_array_length(readback)=0 THEN
    RETURN jsonb_build_object('outcome','done');
  END IF;
  INSERT INTO cc.device_update_batches(job_id,batch,attempt_id,execution_id,lease_expires_at,claimed_at)
    VALUES(p_job,p_batch,p_attempt,p_execution,now_at+interval '180 seconds',now_at)
  ON CONFLICT(job_id,batch) DO UPDATE SET attempt_id=EXCLUDED.attempt_id,execution_id=EXCLUDED.execution_id,
    lease_expires_at=EXCLUDED.lease_expires_at,claimed_at=EXCLUDED.claimed_at,settled_at=NULL;
  UPDATE cc.device_update_jobs SET heartbeat_at=now_at,first_claimed_at=COALESCE(first_claimed_at,now_at)
  WHERE job_id=p_job;
  UPDATE cc.jobs SET started_at=COALESCE(started_at,now_at) WHERE job_id=p_job;
  connection:=cc.google_current_generation(p_customer,job.generation);
  RETURN jsonb_build_object('outcome','claimed','generation',connection.generation,
    'credentialId',connection.credential_id,
    'envelope',(SELECT envelope FROM cc.google_credentials WHERE id=connection.credential_id),
    'batchCount',detail.batch_count,'operations',claim,'readBack',readback);
END;
$$;

CREATE FUNCTION cc.renew_device_update_batch(p_customer text,p_job uuid,p_token uuid,p_batch integer,p_attempt uuid)
RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.device_update_jobs; batch cc.device_update_batches;
  now_at timestamptz:=clock_timestamp();
BEGIN
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=p_job;
  SELECT * INTO batch FROM cc.device_update_batches b WHERE b.job_id=p_job AND b.batch=p_batch FOR UPDATE;
  IF job.status<>'running' OR detail.dispatch_token IS DISTINCT FROM p_token OR
    batch.attempt_id IS DISTINCT FROM p_attempt OR batch.lease_expires_at IS NULL OR batch.lease_expires_at<=now_at THEN
    RAISE EXCEPTION 'The device update attempt is fenced.' USING DETAIL='attempt-fenced';
  END IF;
  UPDATE cc.device_update_batches b SET lease_expires_at=now_at+interval '180 seconds'
  WHERE b.job_id=p_job AND b.batch=p_batch;
  UPDATE cc.device_update_jobs SET heartbeat_at=now_at WHERE job_id=p_job;
  RETURN now_at;
END;
$$;

-- A graceful stop clears the lease. The next attempt claims the batch at once.
CREATE FUNCTION cc.release_device_update_batch(p_customer text,p_job uuid,p_token uuid,p_batch integer,p_attempt uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.device_update_jobs;
BEGIN
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=p_job;
  IF detail.dispatch_token IS DISTINCT FROM p_token THEN
    RAISE EXCEPTION 'The device update attempt is fenced.' USING DETAIL='attempt-fenced';
  END IF;
  UPDATE cc.device_update_batches b SET attempt_id=NULL,execution_id=NULL,lease_expires_at=NULL,
    settled_at=clock_timestamp()
  WHERE b.job_id=p_job AND b.batch=p_batch AND b.attempt_id=p_attempt;
END;
$$;

-- The fenced recording of one batch, or of one read-back. A fenced result changes nothing.
CREATE FUNCTION cc.settle_device_update_operations(p_customer text,p_job uuid,p_token uuid,p_attempt uuid,
  p_kind text,p_results jsonb,p_observed_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.device_update_jobs; now_at timestamptz:=clock_timestamp(); bad integer;
  before text; after text; first_batch integer; element jsonb:=NULL;
  settled jsonb:='[]'::jsonb; devices jsonb:='[]'::jsonb; removed jsonb:='[]'::jsonb;
BEGIN
  IF p_kind NOT IN ('write','read-back') OR jsonb_typeof(p_results) IS DISTINCT FROM 'array' OR
    p_observed_at IS NULL OR p_attempt IS NULL THEN
    RAISE EXCEPTION 'The settlement is invalid.' USING ERRCODE='22023';
  END IF;
  SELECT count(*) INTO bad FROM jsonb_array_elements(p_results) r
    WHERE r->>'outcome' NOT IN ('succeeded','failed','unknown','pending','skipped') OR r->>'operationNumber' IS NULL;
  IF bad>0 THEN
    RAISE EXCEPTION 'The settlement results are invalid.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  IF job.job_id IS NULL THEN
    RAISE EXCEPTION 'The device update job does not exist.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=p_job;
  IF p_kind='write' AND (job.status<>'running' OR detail.dispatch_token IS DISTINCT FROM p_token) THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  before:=job.status;
  -- Every overlay writer locks its device rows in device_id order first.
  PERFORM 1 FROM cc.devices d WHERE d.customer_id=p_customer AND d.device_id IN (
      SELECT o.device_id FROM cc.device_update_operations o JOIN jsonb_array_elements(p_results) r
        ON o.operation_number=(r->>'operationNumber')::integer WHERE o.job_id=p_job)
    ORDER BY d.device_id FOR UPDATE;
  WITH results AS (
    SELECT (r->>'operationNumber')::integer AS operation_number,r FROM jsonb_array_elements(p_results) r
  ), eligible AS (
    SELECT res.operation_number,res.r,o.batch,o.device_id,
      CASE WHEN res.r ? 'value' THEN res.r->>'value' ELSE o.requested_value END AS value
    FROM results res JOIN cc.device_update_operations o ON o.job_id=p_job AND o.operation_number=res.operation_number
    WHERE (p_kind='write' AND o.status='dispatched' AND o.attempt_id=p_attempt) OR
      (p_kind='read-back' AND o.status='unknown' AND o.verify_attempt=p_attempt AND
        o.verify_lease_expires_at>now_at)
  ), applied AS (
    UPDATE cc.device_update_operations o SET status=e.r->>'outcome',
      google_status=(e.r->>'googleStatus')::integer,google_reason=e.r->>'googleReason',
      quota_retries=COALESCE((e.r->>'quotaRetries')::integer,0),
      transient_retries=COALESCE((e.r->>'transientRetries')::integer,0),
      observed_value=e.value,
      observed_at=CASE WHEN e.r->>'outcome'='succeeded' THEN p_observed_at ELSE o.observed_at END,
      verified_by=e.r->>'verifiedBy',outcome_reason=e.r->>'outcomeReason',updated_at=now_at,
      verify_attempt=NULL,verify_lease_expires_at=NULL,verify_after=NULL
    FROM eligible e WHERE o.job_id=p_job AND o.operation_number=e.operation_number
    RETURNING o.operation_number,o.device_id,o.batch,o.status,e.value,e.r->>'verifiedBy' AS verified_by,
      e.r->>'outcomeReason' AS outcome_reason
  ), published AS (
    UPDATE cc.devices d SET annotated_location=a.value,annotated_location_observed_at=p_observed_at
    FROM applied a WHERE a.status='succeeded' AND a.verified_by IN ('write-response','read-back') AND
      d.customer_id=p_customer AND d.device_id=a.device_id AND
      (d.annotated_location_observed_at IS NULL OR p_observed_at>d.annotated_location_observed_at)
    RETURNING d.device_id,a.value,a.operation_number,a.verified_by
  ), overlay AS (
    INSERT INTO cc.device_write_overlays(customer_id,device_id,field,value,observed_at,source,job_id,
      operation_number,expires_at)
    SELECT p_customer,p.device_id,'annotatedLocation',p.value,p_observed_at,p.verified_by,p_job,p.operation_number,
      p_observed_at+interval '36 hours' FROM published p
    ON CONFLICT(customer_id,device_id,field) DO UPDATE SET value=EXCLUDED.value,observed_at=EXCLUDED.observed_at,
      source=EXCLUDED.source,job_id=EXCLUDED.job_id,operation_number=EXCLUDED.operation_number,
      expires_at=EXCLUDED.expires_at
    RETURNING device_id
  ), missing AS (
    SELECT DISTINCT a.device_id FROM applied a WHERE a.status='failed' AND a.verified_by='read-back' AND
      a.outcome_reason='not-found'
  ), soft AS (
    UPDATE cc.devices d SET removed_at=COALESCE(d.removed_at,now_at) FROM missing m
    WHERE d.customer_id=p_customer AND d.device_id=m.device_id RETURNING d.device_id
  )
  SELECT (SELECT COALESCE(jsonb_agg(jsonb_build_object('operationNumber',a.operation_number,'deviceId',a.device_id,
      'status',a.status,'batch',a.batch)),'[]'::jsonb) FROM applied a),
    (SELECT COALESCE(jsonb_agg(p.device_id),'[]'::jsonb) FROM published p),
    (SELECT COALESCE(jsonb_agg(m.device_id),'[]'::jsonb) FROM missing m)
  INTO settled,devices,removed;
  IF jsonb_array_length(settled)=0 THEN
    RETURN jsonb_build_object('outcome','settled','settled',settled,'publication',NULL);
  END IF;
  SELECT min((s->>'batch')::integer) INTO first_batch FROM jsonb_array_elements(settled) s;
  PERFORM cc.refresh_device_update_counters(p_job);
  IF p_kind='read-back' AND before NOT IN ('accepted','queued','held','running') THEN
    UPDATE cc.jobs SET status=cc.device_update_terminal_status(p_job) WHERE job_id=p_job RETURNING status INTO after;
  ELSE
    after:=before;
  END IF;
  UPDATE cc.device_update_jobs SET heartbeat_at=now_at WHERE job_id=p_job;
  element:=cc.record_job_change(p_job,after IS DISTINCT FROM before,devices,removed,first_batch);
  RETURN jsonb_build_object('outcome','settled','settled',settled,'published',devices,'removed',removed,
    'publication',element);
END;
$$;

-- One read-back claim of the named unknown operations, or of every unknown operation.
CREATE FUNCTION cc.claim_device_update_verification(p_customer text,p_job uuid,p_operations jsonb,p_attempt uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; now_at timestamptz:=clock_timestamp(); claimed jsonb:='[]'::jsonb;
BEGIN
  IF p_attempt IS NULL OR (p_operations IS NOT NULL AND jsonb_typeof(p_operations) IS DISTINCT FROM 'array') THEN
    RAISE EXCEPTION 'The read-back claim is invalid.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer;
  IF job.job_id IS NULL THEN
    RAISE EXCEPTION 'The device update job does not exist.' USING ERRCODE='22023';
  END IF;
  WITH picked AS (
    UPDATE cc.device_update_operations o SET verify_attempt=p_attempt,
      verify_lease_expires_at=now_at+interval '120 seconds'
    WHERE o.job_id=p_job AND o.status='unknown' AND
      (o.verify_lease_expires_at IS NULL OR o.verify_lease_expires_at<=now_at) AND
      (p_operations IS NULL OR o.operation_number IN (SELECT (e.value)::integer FROM jsonb_array_elements(p_operations) e))
    RETURNING o.operation_number,o.device_id,o.serial_number,o.baseline_value,o.requested_value,o.verify_after)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('operationNumber',c.operation_number,'deviceId',c.device_id,
    'serialNumber',c.serial_number,'baselineValue',c.baseline_value,'requestedValue',c.requested_value,
    'verifyAfter',c.verify_after)),'[]'::jsonb)
  INTO claimed FROM picked c;
  RETURN claimed;
END;
$$;

-- Finish steps 1 to 4 of section 5.10. A live lease answers busy, and the caller polls.
CREATE FUNCTION cc.prepare_device_update_finish(p_customer text,p_job uuid,p_token uuid,p_failure text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.device_update_jobs; now_at timestamptz:=clock_timestamp();
BEGIN
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  IF job.job_id IS NULL THEN
    RAISE EXCEPTION 'The device update job does not exist.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=p_job;
  IF detail.dispatch_token IS DISTINCT FROM p_token THEN
    RETURN jsonb_build_object('outcome','superseded');
  END IF;
  IF job.finished_at IS NOT NULL THEN
    RETURN jsonb_build_object('outcome','finished','status',job.status);
  END IF;
  IF EXISTS(SELECT 1 FROM cc.device_update_batches b WHERE b.job_id=p_job AND
      b.lease_expires_at+interval '30 seconds'>now_at) THEN
    RETURN jsonb_build_object('outcome','busy');
  END IF;
  IF p_failure IS NOT NULL THEN
    UPDATE cc.jobs SET failure=COALESCE(failure,p_failure) WHERE job_id=p_job;
  END IF;
  PERFORM cc.fence_device_update_operations(p_job,NULL,NULL,now_at,NULL);
  PERFORM cc.skip_device_update_pending(p_job,COALESCE(p_failure,'interrupted'));
  PERFORM cc.refresh_device_update_counters(p_job);
  PERFORM cc.record_job_change(p_job,false);
  RETURN jsonb_build_object('outcome','ready',
    'failure',(SELECT j.failure FROM cc.jobs j WHERE j.job_id=p_job));
END;
$$;

-- Finish steps 6 and 7. The status rule reads only the counters.
CREATE FUNCTION cc.finish_device_update_job(p_customer text,p_job uuid,p_failure text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; now_at timestamptz:=clock_timestamp(); before text; after text;
BEGIN
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  IF job.job_id IS NULL THEN
    RAISE EXCEPTION 'The device update job does not exist.' USING ERRCODE='22023';
  END IF;
  before:=job.status;
  IF p_failure IS NOT NULL THEN
    UPDATE cc.jobs SET failure=COALESCE(failure,p_failure) WHERE job_id=p_job;
  END IF;
  PERFORM cc.refresh_device_update_counters(p_job);
  after:=cc.device_update_terminal_status(p_job);
  UPDATE cc.jobs SET status=after,finished_at=COALESCE(finished_at,now_at) WHERE job_id=p_job;
  PERFORM cc.record_job_change(p_job,after IS DISTINCT FROM before);
  RETURN jsonb_build_object('jobId',p_job,'status',after,
    'succeeded',(SELECT j.succeeded FROM cc.jobs j WHERE j.job_id=p_job),
    'failed',(SELECT j.failed FROM cc.jobs j WHERE j.job_id=p_job),
    'unknown',(SELECT j.unknown FROM cc.jobs j WHERE j.job_id=p_job),
    'skipped',(SELECT j.skipped FROM cc.jobs j WHERE j.job_id=p_job),
    'finishedAt',(SELECT j.finished_at FROM cc.jobs j WHERE j.job_id=p_job));
END;
$$;

-- The reaper applies steps 1 to 4, 6, and 7 in one transaction. It never acts while a lease lives.
CREATE FUNCTION cc.finalize_device_update_job(p_customer text,p_job uuid,p_failure text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; now_at timestamptz:=clock_timestamp(); before text; after text;
BEGIN
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  IF job.job_id IS NULL THEN
    RAISE EXCEPTION 'The device update job does not exist.' USING ERRCODE='22023';
  END IF;
  IF job.finished_at IS NOT NULL THEN
    RETURN jsonb_build_object('jobId',p_job,'status',job.status);
  END IF;
  before:=job.status;
  IF p_failure IS NOT NULL THEN
    UPDATE cc.jobs SET failure=COALESCE(failure,p_failure) WHERE job_id=p_job;
  END IF;
  PERFORM cc.fence_device_update_operations(p_job,NULL,NULL,now_at,NULL);
  PERFORM cc.skip_device_update_pending(p_job,COALESCE(p_failure,'interrupted'));
  PERFORM cc.refresh_device_update_counters(p_job);
  after:=cc.device_update_terminal_status(p_job);
  UPDATE cc.jobs SET status=after,finished_at=now_at WHERE job_id=p_job;
  PERFORM cc.record_job_change(p_job,true);
  RETURN jsonb_build_object('jobId',p_job,'status',after,
    'succeeded',(SELECT j.succeeded FROM cc.jobs j WHERE j.job_id=p_job),
    'failed',(SELECT j.failed FROM cc.jobs j WHERE j.job_id=p_job),
    'unknown',(SELECT j.unknown FROM cc.jobs j WHERE j.job_id=p_job),
    'skipped',(SELECT j.skipped FROM cc.jobs j WHERE j.job_id=p_job),
    'finishedAt',(SELECT j.finished_at FROM cc.jobs j WHERE j.job_id=p_job));
END;
$$;

-- A backoff report of the attempt that holds its batch with a live lease.
CREATE FUNCTION cc.report_device_update_backoff(p_customer text,p_job uuid,p_token uuid,p_batch integer,
  p_attempt uuid,p_sequence integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.device_update_jobs; batch cc.device_update_batches;
  now_at timestamptz:=clock_timestamp();
BEGIN
  IF p_sequence IS NULL THEN
    RAISE EXCEPTION 'The backoff report is invalid.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=p_job FOR UPDATE;
  SELECT * INTO batch FROM cc.device_update_batches b WHERE b.job_id=p_job AND b.batch=p_batch;
  IF job.job_id IS NULL OR job.status<>'running' OR detail.dispatch_token IS DISTINCT FROM p_token OR
    batch.attempt_id IS DISTINCT FROM p_attempt OR batch.lease_expires_at IS NULL OR
    batch.lease_expires_at<=now_at THEN
    RETURN false;
  END IF;
  IF detail.backoff_attempt=p_attempt AND detail.backoff_sequence IS NOT NULL AND
    p_sequence<=detail.backoff_sequence THEN
    RETURN false;
  END IF;
  UPDATE cc.device_update_jobs SET backoff_attempt=p_attempt,backoff_sequence=p_sequence,
    backoff_reported_at=now_at WHERE job_id=p_job;
  RETURN true;
END;
$$;

-- The job service applies the newest accepted report. The registry entry exists before the Redis write.
CREATE FUNCTION cc.accept_device_update_hold(p_customer text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.device_update_jobs; now_at timestamptz:=clock_timestamp();
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('cc.job-admission:'||p_customer)::bigint);
  FOR job IN SELECT j.* FROM cc.jobs j WHERE j.customer_id=p_customer AND j.kind='device-update' AND
      j.status='running' ORDER BY j.created_at FOR UPDATE LOOP
    SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=job.job_id;
    IF detail.backoff_reported_at IS NULL OR detail.backoff_reported_at<now_at-interval '30 seconds' THEN
      CONTINUE;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM cc.device_update_batches b WHERE b.job_id=job.job_id AND
        b.attempt_id=detail.backoff_attempt AND b.lease_expires_at>now_at) THEN
      CONTINUE;
    END IF;
    IF detail.hold_attempt=detail.backoff_attempt AND detail.hold_sequence>=detail.backoff_sequence THEN
      CONTINUE;
    END IF;
    UPDATE cc.device_update_jobs SET hold_attempt=detail.backoff_attempt,hold_sequence=detail.backoff_sequence,
      hold_written_at=now_at WHERE job_id=job.job_id;
    RETURN jsonb_build_object('jobId',job.job_id,'displayId',job.display_id,'holdAttempt',detail.backoff_attempt,
      'holdSequence',detail.backoff_sequence);
  END LOOP;
  RETURN NULL;
END;
$$;

-- The purge keeps write jobs. Refresh jobs leave after seven days, previews and overlays when they lapse.
CREATE FUNCTION cc.purge_jobs(p_customer text,p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE removed integer; job cc.jobs; now_at timestamptz:=clock_timestamp();
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'The purge limit is invalid.' USING ERRCODE='22023';
  END IF;
  -- An ID-list refresh that stays unfinished for two hours ends as interrupted.
  FOR job IN SELECT j.* FROM cc.jobs j WHERE j.customer_id=p_customer AND j.kind='inventory-refresh' AND
      j.scope_kind='devices' AND j.finished_at IS NULL AND j.created_at<now_at-interval '2 hours' LOOP
    UPDATE cc.entity_sync_jobs SET failure=COALESCE(failure,'interrupted'),finished_at=now_at
    WHERE job_id=job.job_id AND finished_at IS NULL;
    UPDATE cc.jobs SET status='failed',failure=COALESCE(failure,'interrupted'),finished_at=now_at
    WHERE job_id=job.job_id;
    PERFORM cc.record_job_change(job.job_id,true);
  END LOOP;
  -- A full-sync header without a live sync lease ends as interrupted.
  FOR job IN SELECT j.* FROM cc.jobs j LEFT JOIN cc.device_sync_state s ON s.customer_id=j.customer_id
      WHERE j.customer_id=p_customer AND j.kind='inventory-refresh' AND j.scope_kind='all-devices' AND
        j.status='running' AND (s.sync_id IS DISTINCT FROM j.job_id OR s.sync_expires_at<=now_at) LOOP
    UPDATE cc.jobs SET status='failed',failure=COALESCE(failure,'interrupted'),finished_at=now_at
    WHERE job_id=job.job_id;
    PERFORM cc.record_job_change(job.job_id,true);
  END LOOP;
  -- Refresh jobs leave with their detail, batch, and target rows. A write job never leaves.
  DELETE FROM cc.jobs WHERE job_id IN (
    SELECT j.job_id FROM cc.jobs j WHERE j.customer_id=p_customer AND j.kind='inventory-refresh' AND
      j.finished_at IS NOT NULL AND j.finished_at<now_at-interval '7 days'
    ORDER BY j.finished_at LIMIT p_limit);
  GET DIAGNOSTICS removed=ROW_COUNT;
  -- An unconfirmed preview leaves 24 hours after its expiry, with its targets.
  DELETE FROM cc.device_update_previews WHERE customer_id=p_customer AND job_id IS NULL AND
    expires_at<now_at-interval '24 hours';
  -- An expired overlay leaves. The current-value stamp stays.
  DELETE FROM cc.device_write_overlays WHERE customer_id=p_customer AND expires_at<=now_at;
  RETURN removed;
END;
$$;

REVOKE ALL ON cc.jobs,cc.job_targets,cc.device_update_previews,cc.device_update_preview_targets,
  cc.device_update_jobs,cc.device_update_batches,cc.device_update_operations,cc.device_write_overlays,
  cc.job_activity_seen,cc.job_publications FROM PUBLIC;
REVOKE ALL ON FUNCTION cc.job_display_id(text,bigint),cc.job_visible(uuid,integer,text,uuid),
  cc.visible_device_sync(uuid,integer,text),cc.job_publication_element(cc.jobs,cc.job_publications),
  cc.record_job_change(uuid,boolean,jsonb,jsonb,integer),cc.read_job_publications(text,integer),
  cc.complete_job_publications(text,jsonb),cc.refresh_device_update_counters(uuid),
  cc.device_update_terminal_status(uuid),cc.fence_device_update_operations(uuid,uuid,jsonb,timestamptz,interval),
  cc.skip_device_update_pending(uuid,text),cc.close_refresh_job(uuid,text),cc.write_capable(uuid,text),
  cc.admit_device_update_job(text,boolean),cc.record_device_update_start(text,uuid,uuid,text),
  cc.abandon_device_update_start(text,uuid,uuid),cc.recover_device_update_jobs(text),
  cc.claim_device_update_batch(text,uuid,uuid,integer,uuid,text),
  cc.renew_device_update_batch(text,uuid,uuid,integer,uuid),
  cc.release_device_update_batch(text,uuid,uuid,integer,uuid),
  cc.settle_device_update_operations(text,uuid,uuid,uuid,text,jsonb,timestamptz),
  cc.claim_device_update_verification(text,uuid,jsonb,uuid),
  cc.prepare_device_update_finish(text,uuid,uuid,text),cc.finish_device_update_job(text,uuid,text),
  cc.finalize_device_update_job(text,uuid,text),
  cc.report_device_update_backoff(text,uuid,uuid,integer,uuid,integer),cc.accept_device_update_hold(text),
  cc.purge_jobs(text,integer) FROM PUBLIC;