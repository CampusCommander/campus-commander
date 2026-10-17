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

-- Every pending operation of a job becomes skipped. The complete set locks first, in operation_number
-- order, so the update never waits and its clock reads after every wait (round 3, R2-F2). Every caller
-- locks the same set before its first write, so this lock never waits either.
CREATE FUNCTION cc.skip_device_update_pending(p_job uuid,p_reason text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE skipped integer;
BEGIN
  PERFORM 1 FROM cc.device_update_operations o WHERE o.job_id=p_job AND o.status='pending'
    ORDER BY o.operation_number FOR UPDATE;
  UPDATE cc.device_update_operations SET status='skipped',outcome_reason=COALESCE(outcome_reason,p_reason),
    updated_at=clock_timestamp()
  WHERE job_id=p_job AND status='pending';
  GET DIAGNOSTICS skipped=ROW_COUNT;
  RETURN skipped;
END;
$$;

-- A refresh header that ends without its live sync lease ends as failed.
-- A full-sync closure records the targets it observed before its one publication (section 1.2, review F19).
CREATE FUNCTION cc.close_refresh_job(p_job uuid,p_failure text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
BEGIN
  UPDATE cc.jobs SET status='failed',failure=COALESCE(failure,p_failure),
    finished_at=COALESCE(finished_at,clock_timestamp()),
    target_count=CASE WHEN scope_kind='all-devices'
      THEN (SELECT count(*) FROM cc.job_targets t WHERE t.job_id=p_job) ELSE target_count END,
    succeeded=CASE WHEN scope_kind='all-devices'
      THEN (SELECT count(*) FROM cc.job_targets t WHERE t.job_id=p_job) ELSE succeeded END,
    target_org_unit_paths=CASE WHEN scope_kind='all-devices'
      THEN (SELECT COALESCE(array_agg(DISTINCT t.org_unit_path ORDER BY t.org_unit_path)
        FILTER (WHERE t.org_unit_path IS NOT NULL),'{}'::text[]) FROM cc.job_targets t WHERE t.job_id=p_job)
      ELSE target_org_unit_paths END
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

-- The revalidation of section 5.6: the confirmer, its two write actions, and the connection generation.
-- A batch claim reads it under the header lock and again after its waits (round 2, F1). It reads without a
-- lock, and it returns null when the claim may dispatch.
CREATE FUNCTION cc.device_update_stop_reason(p_customer text,p_confirmer uuid,p_version integer,
  p_generation integer) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT CASE
    WHEN NOT EXISTS(SELECT 1 FROM cc.application_principals p WHERE p.id=p_confirmer AND p.enabled AND
        p.permission_version=p_version) OR NOT cc.write_capable(p_confirmer,p_customer) THEN 'permission-changed'
    WHEN NOT EXISTS(SELECT 1 FROM cc.google_connection c WHERE c.customer_id=p_customer AND
        c.generation=p_generation AND c.active) THEN 'connection-changed'
  END;
$$;

-- The job failure codes: the codes of the cc.jobs failure CHECK. A finish, a preparation, and the reaper
-- reject any other code before their first lock (round 3, eng-lead ruling 2). A null input yields null.
CREATE FUNCTION cc.job_failure_known(p_failure text) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT p_failure IN ('credential-rejected','delegation-not-authorized','api-not-enabled','policy-restricted',
    'network-failure','scope-mismatch','permission-denied','quota','provider-unavailable','invalid-response',
    'wrong-customer','request-failed','key-unavailable','interrupted','orchestration-unavailable',
    'permission-changed','connection-changed');
$$;

-- Admission order: smallest target count, then oldest creation, then lowest display ID.
CREATE FUNCTION cc.admit_device_update_job(p_customer text,p_held boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; candidates cc.jobs[]:='{}'; admitted jsonb:=NULL; now_at timestamptz; running boolean;
  token uuid; label text;
BEGIN
  -- S2: the admission holds no fence without its customer. A null hold flag rejects before any lock, so an
  -- unknown hold state never admits a job (section 6.5 step 1: admission fails closed).
  IF p_customer IS NULL OR p_held IS NULL THEN
    RAISE EXCEPTION 'The device update job does not exist.' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cc.job-admission:'||p_customer)::bigint);
  -- S1: every pending header locks first, in admission order.
  FOR job IN SELECT j.* FROM cc.jobs j WHERE j.customer_id=p_customer AND j.kind='device-update'
      AND j.status IN ('accepted','queued','held') ORDER BY j.target_count,j.created_at,j.display_id FOR UPDATE LOOP
    candidates:=candidates||job;
  END LOOP;
  -- S1 (round 3, R2-F3): the clock reads after every header wait, before the validation and before the
  -- detail lock, on every path. The admitted path reads it again after its detail wait below.
  now_at:=clock_timestamp();
  -- S1 (round 2): the one-running flag reads after every header wait, so a job that ended in a wait
  -- leaves the write slot free for this admission.
  SELECT EXISTS(SELECT 1 FROM cc.jobs j WHERE j.customer_id=p_customer AND j.kind='device-update' AND j.status='running')
    INTO running;
  -- S1 (round 3): a status change publishes, and the publication row references the connection row. A
  -- credential read holds that row FOR UPDATE (008), so the connection row locks here, after the validation,
  -- and no publication insert waits on it. After that wait the clock and the one-running flag read again.
  IF cardinality(candidates)>0 THEN
    PERFORM 1 FROM cc.google_connection c WHERE c.customer_id=p_customer FOR KEY SHARE;
    now_at:=clock_timestamp();
    SELECT EXISTS(SELECT 1 FROM cc.jobs j WHERE j.customer_id=p_customer AND j.kind='device-update' AND
      j.status='running') INTO running;
  END IF;
  label:=CASE WHEN p_held THEN 'held' ELSE 'queued' END;
  FOREACH job IN ARRAY candidates LOOP
    IF running OR p_held THEN
      IF job.status<>label THEN
        UPDATE cc.jobs SET status=label WHERE job_id=job.job_id;
        PERFORM cc.record_job_change(job.job_id,true);
      END IF;
    ELSIF admitted IS NULL THEN
      -- S1: the detail row locks after the validation. The clock reads again after the header, connection, and
      -- detail waits, so a long wait never consumes the start window (round 2, round 3).
      PERFORM 1 FROM cc.device_update_jobs u WHERE u.job_id=job.job_id FOR UPDATE;
      now_at:=clock_timestamp();
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
DECLARE job cc.jobs; detail cc.device_update_jobs; now_at timestamptz;
BEGIN
  -- S2: a null identifier never matches a header.
  IF p_customer IS NULL OR p_job IS NULL OR p_token IS NULL THEN
    RAISE EXCEPTION 'The device update attempt is fenced.' USING DETAIL='attempt-fenced';
  END IF;
  -- S2 (round 3): the start records the execution that runs the job. A null execution rejects before
  -- any lock.
  IF p_execution IS NULL THEN
    RAISE EXCEPTION 'The device update execution is invalid.' USING ERRCODE='22023';
  END IF;
  -- S1: the header row locks before the detail row, as every other write-job writer takes them.
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  IF job.job_id IS NULL OR job.kind<>'device-update' THEN
    RAISE EXCEPTION 'The device update job does not exist.' USING ERRCODE='22023';
  END IF;
  -- S1: the clock reads after the header lock. The first fence reads the detail row without a lock,
  -- so a superseded call rejects before it waits on that row (round 6, R6-5).
  now_at:=clock_timestamp();
  SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=p_job;
  -- S3: a terminal or superseded call changes no metadata.
  IF job.status<>'running' OR job.finished_at IS NOT NULL THEN RETURN; END IF;
  IF detail.job_id IS NULL OR detail.dispatch_token IS DISTINCT FROM p_token THEN
    RAISE EXCEPTION 'The device update attempt is fenced.' USING DETAIL='attempt-fenced';
  END IF;
  -- S1: the detail row locks after the fence. After that wait the clock reads again (round 3, R2-F4), and
  -- the lifecycle and the token repeat on the locked row before the write.
  SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=p_job FOR UPDATE;
  now_at:=clock_timestamp();
  IF job.status<>'running' OR job.finished_at IS NOT NULL THEN RETURN; END IF;
  IF detail.job_id IS NULL OR detail.dispatch_token IS DISTINCT FROM p_token THEN
    RAISE EXCEPTION 'The device update attempt is fenced.' USING DETAIL='attempt-fenced';
  END IF;
  UPDATE cc.device_update_jobs SET kestra_execution_id=p_execution WHERE job_id=p_job;
END;
$$;

-- A refused start ends the job. The fence is the current token and no first claim.
CREATE FUNCTION cc.abandon_device_update_start(p_customer text,p_job uuid,p_token uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.device_update_jobs; now_at timestamptz;
BEGIN
  -- S2: a null identifier or token never matches a header.
  IF p_customer IS NULL OR p_job IS NULL OR p_token IS NULL THEN
    RAISE EXCEPTION 'The device update attempt is fenced.' USING DETAIL='attempt-fenced';
  END IF;
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  -- S1: a missing scoped header returns at once, before the unscoped detail lock (round 6, R6-6).
  IF job.job_id IS NULL OR job.kind<>'device-update' THEN RETURN; END IF;
  -- S1: the closure clock reads after the header lock, and the fence reads the detail row without a
  -- lock, so a superseded call rejects before it waits on that row.
  now_at:=clock_timestamp();
  SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=p_job;
  -- S3: a terminal job and a superseded call change nothing.
  IF detail.job_id IS NULL OR job.status<>'running' OR job.finished_at IS NOT NULL OR
    detail.dispatch_token IS DISTINCT FROM p_token OR detail.first_claimed_at IS NOT NULL THEN
    RETURN;
  END IF;
  -- S1: the detail row locks after the fence. The post-wait clock and recheck follow the wait.
  SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=p_job FOR UPDATE;
  now_at:=clock_timestamp();
  IF detail.job_id IS NULL OR job.status<>'running' OR job.finished_at IS NOT NULL OR
    detail.dispatch_token IS DISTINCT FROM p_token OR detail.first_claimed_at IS NOT NULL THEN
    RETURN;
  END IF;
  -- S1 (round 2): the pending operation rows lock after the recheck, so no write below waits. The header and
  -- detail locks hold every value that the fence read, and the closure clock reads after this wait. The
  -- connection row locks last, so the publication insert never waits on it (round 3).
  PERFORM 1 FROM cc.device_update_operations o WHERE o.job_id=p_job AND o.status='pending'
    ORDER BY o.operation_number FOR UPDATE;
  PERFORM 1 FROM cc.google_connection c WHERE c.customer_id=p_customer FOR KEY SHARE;
  now_at:=clock_timestamp();
  UPDATE cc.jobs SET status='failed',failure='orchestration-unavailable',finished_at=now_at WHERE job_id=p_job;
  PERFORM cc.skip_device_update_pending(p_job,'orchestration-unavailable');
  PERFORM cc.refresh_device_update_counters(p_job);
  PERFORM cc.record_job_change(p_job,true);
END;
$$;

-- The tick resolves an unclaimed start and a lost runner. At three executions the job ends.
CREATE FUNCTION cc.recover_device_update_jobs(p_customer text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.device_update_jobs; now_at timestamptz; token uuid;
  starts jsonb:='[]'::jsonb; reconciles jsonb:='[]'::jsonb; live boolean;
BEGIN
  -- S2: the tick holds no fence without its customer.
  IF p_customer IS NULL THEN
    RAISE EXCEPTION 'The device update job does not exist.' USING ERRCODE='22023';
  END IF;
  FOR job IN SELECT j.* FROM cc.jobs j WHERE j.customer_id=p_customer AND j.kind='device-update' AND j.status='running'
      ORDER BY j.created_at FOR UPDATE LOOP
    -- S1: the tick reads its clock after the job row lock (review F3).
    now_at:=clock_timestamp();
    SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=job.job_id;
    SELECT EXISTS(SELECT 1 FROM cc.device_update_batches b WHERE b.job_id=job.job_id AND b.lease_expires_at>now_at)
      INTO live;
    IF detail.first_claimed_at IS NULL AND detail.start_deadline_at<=now_at THEN
      IF detail.dispatch_count<3 THEN
        -- S1 (round 2): the rotation locks the detail row after the decision. After that wait the clock
        -- reads again and the decision repeats on the locked row, so a wait never consumes the new window.
        SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=job.job_id FOR UPDATE;
        now_at:=clock_timestamp();
        IF detail.first_claimed_at IS NULL AND detail.start_deadline_at<=now_at AND detail.dispatch_count<3 THEN
          token:=gen_random_uuid();
          UPDATE cc.device_update_jobs SET dispatch_token=token,dispatch_count=dispatch_count+1,
            start_deadline_at=now_at+interval '120 seconds' WHERE job_id=job.job_id;
          starts:=starts||jsonb_build_array(jsonb_build_object('jobId',job.job_id,'displayId',job.display_id,
            'dispatchToken',token,'correlationId',job.correlation_id,'targetCount',job.target_count));
        END IF;
      ELSE
        PERFORM cc.abandon_device_update_start(p_customer,job.job_id,detail.dispatch_token);
      END IF;
    ELSIF detail.first_claimed_at IS NOT NULL AND NOT live AND
      detail.heartbeat_at<=now_at-interval '10 minutes' THEN
      IF detail.dispatch_count<3 THEN
        -- S1 (round 2): the same order for a lost runner. The live lease repeats on the fresh clock too.
        SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=job.job_id FOR UPDATE;
        now_at:=clock_timestamp();
        SELECT EXISTS(SELECT 1 FROM cc.device_update_batches b WHERE b.job_id=job.job_id AND b.lease_expires_at>now_at)
          INTO live;
        IF detail.first_claimed_at IS NOT NULL AND NOT live AND detail.heartbeat_at<=now_at-interval '10 minutes' AND
          detail.dispatch_count<3 THEN
          token:=gen_random_uuid();
          UPDATE cc.device_update_jobs SET dispatch_token=token,dispatch_count=dispatch_count+1,heartbeat_at=now_at,
            start_deadline_at=now_at+interval '120 seconds' WHERE job_id=job.job_id;
          starts:=starts||jsonb_build_array(jsonb_build_object('jobId',job.job_id,'displayId',job.display_id,
            'dispatchToken',token,'correlationId',job.correlation_id,'targetCount',job.target_count));
        END IF;
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
  now_at timestamptz; stopped text:=NULL; lost uuid:=NULL; claim jsonb:='[]'::jsonb; readback jsonb:='[]'::jsonb;
BEGIN
  -- S2 (round 3): a claim records the execution that runs its batch. A null execution rejects before
  -- any lock.
  IF p_execution IS NULL THEN
    RAISE EXCEPTION 'The device update execution is invalid.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  IF job.job_id IS NULL OR job.kind<>'device-update' THEN
    RAISE EXCEPTION 'The device update job does not exist.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=p_job;
  -- S1: the clock and the fence read under the header lock, before the batch and operation locks.
  now_at:=clock_timestamp();
  -- S2: a null token or attempt never matches (review F1, F14).
  IF p_token IS NULL OR p_attempt IS NULL OR detail.job_id IS NULL OR job.status<>'running' OR
    job.finished_at IS NOT NULL OR detail.dispatch_token IS DISTINCT FROM p_token THEN
    RETURN jsonb_build_object('outcome','superseded');
  END IF;
  IF p_batch IS NULL OR p_batch<0 OR p_batch>=detail.batch_count THEN
    RAISE EXCEPTION 'The device update batch is invalid.' USING ERRCODE='22023';
  END IF;
  -- Revalidation before dispatch (section 5.6).
  stopped:=cc.device_update_stop_reason(p_customer,detail.confirmed_by,detail.confirmer_permission_version,
    job.generation);
  IF stopped IS NULL THEN
    -- S1/R6-2: the batch ownership and its lease eligibility read under the header, before the batch
    -- lock. A duplicate claim answers busy instead of waiting on the held batch row.
    SELECT * INTO held FROM cc.device_update_batches b WHERE b.job_id=p_job AND b.batch=p_batch;
    IF held.attempt_id IS NOT NULL AND held.attempt_id<>p_attempt AND
      held.lease_expires_at IS NOT NULL AND held.lease_expires_at+interval '30 seconds'>now_at THEN
      RETURN jsonb_build_object('outcome','busy');
    END IF;
    SELECT * INTO held FROM cc.device_update_batches b WHERE b.job_id=p_job AND b.batch=p_batch FOR UPDATE;
    -- The lease fence reads the clock after the job row lock and the batch row lock (review F3).
    now_at:=clock_timestamp();
    IF held.attempt_id IS NOT NULL AND held.attempt_id<>p_attempt THEN
      IF held.lease_expires_at IS NOT NULL AND held.lease_expires_at+interval '30 seconds'>now_at THEN
        RETURN jsonb_build_object('outcome','busy');
      END IF;
      lost:=held.attempt_id;
    END IF;
    -- S1 (round 2): only the operations that this claim changes lock, in operation_number order: the
    -- pending operations of the batch and the dispatched operations of a lapsed attempt.
    PERFORM 1 FROM cc.device_update_operations o WHERE o.job_id=p_job AND o.batch=p_batch AND
        (o.status='pending' OR (o.status='dispatched' AND o.attempt_id=lost))
      ORDER BY o.operation_number FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','done'); END IF;
    -- S1 (round 2, F1): the detail row locks after the operation rows. After the batch, operation, and
    -- detail waits, the token and the revalidation repeat before any change or credential read.
    SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=p_job FOR UPDATE;
    IF detail.job_id IS NULL OR detail.dispatch_token IS DISTINCT FROM p_token THEN
      RETURN jsonb_build_object('outcome','superseded');
    END IF;
    stopped:=cc.device_update_stop_reason(p_customer,detail.confirmed_by,detail.confirmer_permission_version,
      job.generation);
    IF stopped IS NULL THEN
      -- The credential read locks the connection row last and rejects a changed generation (015). The
      -- revalidation repeats after that wait, so no access change in any wait reaches a dispatch.
      connection:=cc.google_current_generation(p_customer,job.generation);
      stopped:=cc.device_update_stop_reason(p_customer,detail.confirmed_by,detail.confirmer_permission_version,
        job.generation);
    END IF;
    -- The claim writes read the clock after every wait.
    now_at:=clock_timestamp();
  END IF;
  IF stopped IS NOT NULL THEN
    -- S1 (round 3, R2-F2): the stop skips every pending operation of the job, so that complete set locks
    -- first, in operation_number order, and no write below waits. After that wait the clock reads again,
    -- and the token repeats on a fresh read, so a call that the wait superseded changes nothing (S3). A
    -- stop stays a stop: access that returns during the wait reopens no dispatch (section 5.6). The connection
    -- row locks last, so the publication insert never waits on it.
    PERFORM 1 FROM cc.device_update_operations o WHERE o.job_id=p_job AND o.status='pending'
      ORDER BY o.operation_number FOR UPDATE;
    PERFORM 1 FROM cc.google_connection c WHERE c.customer_id=p_customer FOR KEY SHARE;
    now_at:=clock_timestamp();
    SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=p_job;
    IF detail.job_id IS NULL OR detail.dispatch_token IS DISTINCT FROM p_token THEN
      RETURN jsonb_build_object('outcome','superseded');
    END IF;
    UPDATE cc.jobs SET failure=COALESCE(failure,stopped) WHERE job_id=p_job;
    PERFORM cc.skip_device_update_pending(p_job,stopped);
    PERFORM cc.refresh_device_update_counters(p_job);
    PERFORM cc.record_job_change(p_job,false);
    RETURN jsonb_build_object('outcome','stopped','failure',stopped);
  END IF;
  IF lost IS NOT NULL THEN
    readback:=cc.fence_device_update_operations(p_job,p_attempt,
      (SELECT COALESCE(jsonb_agg(o.operation_number),'[]'::jsonb) FROM cc.device_update_operations o
        WHERE o.job_id=p_job AND o.batch=p_batch AND o.status='dispatched' AND o.attempt_id=lost),
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
  -- A claim that fences a lost attempt refreshes the counters of its fenced operations.
  IF jsonb_array_length(readback)>0 THEN PERFORM cc.refresh_device_update_counters(p_job); END IF;
  IF job.started_at IS NULL THEN
    UPDATE cc.jobs SET started_at=now_at WHERE job_id=p_job;
  END IF;
  -- Every reader-visible claim change records one publication row (section 3.6, review F8).
  -- A later batch changes the public operation timestamps, so it records its change too.
  IF job.started_at IS NULL OR jsonb_array_length(claim)>0 OR jsonb_array_length(readback)>0 THEN
    PERFORM cc.record_job_change(p_job,false);
  END IF;
  -- The connection row came from the credential read above, under its lock and before the last revalidation.
  RETURN jsonb_build_object('outcome','claimed','generation',connection.generation,
    'credentialId',connection.credential_id,
    'envelope',(SELECT envelope FROM cc.google_credentials WHERE id=connection.credential_id),
    'batchCount',detail.batch_count,'operations',claim,'readBack',readback);
END;
$$;

CREATE FUNCTION cc.renew_device_update_batch(p_customer text,p_job uuid,p_token uuid,p_batch integer,p_attempt uuid)
RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.device_update_jobs; batch cc.device_update_batches; now_at timestamptz;
BEGIN
  -- S2: a null identifier, token, or attempt never matches a batch.
  IF p_job IS NULL OR p_token IS NULL OR p_attempt IS NULL OR p_batch IS NULL THEN
    RAISE EXCEPTION 'The device update attempt is fenced.' USING DETAIL='attempt-fenced';
  END IF;
  -- S1: the customer-scoped header locks first. A missing scoped header blocks the renewal.
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  IF job.job_id IS NULL OR job.kind<>'device-update' THEN
    RAISE EXCEPTION 'The device update attempt is fenced.' USING DETAIL='attempt-fenced';
  END IF;
  SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=p_job;
  -- The fence reads the clock after the header lock (review F3, S1).
  now_at:=clock_timestamp();
  IF job.status<>'running' OR job.finished_at IS NOT NULL OR detail.dispatch_token IS DISTINCT FROM p_token THEN
    RAISE EXCEPTION 'The device update attempt is fenced.' USING DETAIL='attempt-fenced';
  END IF;
  -- S1/R6-3: the attempt and the live lease read under the header, before the batch lock.
  SELECT * INTO batch FROM cc.device_update_batches b WHERE b.job_id=p_job AND b.batch=p_batch;
  IF batch.attempt_id IS DISTINCT FROM p_attempt OR batch.lease_expires_at IS NULL OR
    batch.lease_expires_at<=now_at THEN
    RAISE EXCEPTION 'The device update attempt is fenced.' USING DETAIL='attempt-fenced';
  END IF;
  SELECT * INTO batch FROM cc.device_update_batches b WHERE b.job_id=p_job AND b.batch=p_batch FOR UPDATE;
  -- The post-batch-wait recheck keeps a lease that lapsed in the wait fenced (review F3).
  now_at:=clock_timestamp();
  IF batch.attempt_id IS DISTINCT FROM p_attempt OR batch.lease_expires_at IS NULL OR batch.lease_expires_at<=now_at THEN
    RAISE EXCEPTION 'The device update attempt is fenced.' USING DETAIL='attempt-fenced';
  END IF;
  -- S1 (round 2): the detail row locks before the renewal writes, so no write waits. After that wait the
  -- clock reads again, and the token and the live lease repeat on the locked rows.
  SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=p_job FOR UPDATE;
  now_at:=clock_timestamp();
  IF detail.job_id IS NULL OR detail.dispatch_token IS DISTINCT FROM p_token OR batch.lease_expires_at<=now_at THEN
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
DECLARE job cc.jobs; detail cc.device_update_jobs; now_at timestamptz;
BEGIN
  -- S2: a null identifier, token, or attempt never matches a batch.
  IF p_job IS NULL OR p_token IS NULL OR p_attempt IS NULL OR p_batch IS NULL THEN
    RAISE EXCEPTION 'The device update attempt is fenced.' USING DETAIL='attempt-fenced';
  END IF;
  -- S1: the customer-scoped header locks first. A missing scoped header blocks the release.
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  IF job.job_id IS NULL OR job.kind<>'device-update' THEN
    RAISE EXCEPTION 'The device update attempt is fenced.' USING DETAIL='attempt-fenced';
  END IF;
  SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=p_job;
  now_at:=clock_timestamp();
  -- S3: a terminal job keeps its batch rows, and a superseded call changes nothing (review F1).
  IF job.status<>'running' OR job.finished_at IS NOT NULL THEN RETURN; END IF;
  IF detail.dispatch_token IS DISTINCT FROM p_token THEN
    RAISE EXCEPTION 'The device update attempt is fenced.' USING DETAIL='attempt-fenced';
  END IF;
  -- S1 (round 2): only the batch row that this attempt owns locks. After that wait the clock reads again,
  -- and the token repeats on a fresh read, so the release never stamps a pre-wait time or a rotated token.
  PERFORM 1 FROM cc.device_update_batches b WHERE b.job_id=p_job AND b.batch=p_batch AND b.attempt_id=p_attempt
    FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  now_at:=clock_timestamp();
  SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=p_job;
  IF detail.dispatch_token IS DISTINCT FROM p_token THEN
    RAISE EXCEPTION 'The device update attempt is fenced.' USING DETAIL='attempt-fenced';
  END IF;
  UPDATE cc.device_update_batches b SET attempt_id=NULL,execution_id=NULL,lease_expires_at=NULL,
    settled_at=now_at
  WHERE b.job_id=p_job AND b.batch=p_batch AND b.attempt_id=p_attempt;
END;
$$;

-- The fenced recording of one batch, or of one read-back. A fenced result changes nothing.
CREATE FUNCTION cc.settle_device_update_operations(p_customer text,p_job uuid,p_token uuid,p_attempt uuid,
  p_kind text,p_results jsonb,p_observed_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.device_update_jobs; now_at timestamptz; bad integer; provenance text;
  before text; after text; first_batch integer; element jsonb:=NULL; candidates integer[];
  settled jsonb:='[]'::jsonb; devices jsonb:='[]'::jsonb; removed jsonb:='[]'::jsonb;
BEGIN
  -- S2 (round 2, F2): a null kind never matches NOT IN, so the kind rejects explicitly before any lock.
  IF p_kind IS NULL OR p_kind NOT IN ('write','read-back') OR jsonb_typeof(p_results) IS DISTINCT FROM 'array' OR
    p_observed_at IS NULL OR p_attempt IS NULL THEN
    RAISE EXCEPTION 'The settlement is invalid.' USING ERRCODE='22023';
  END IF;
  -- The observation source of each kind: a 2xx write answer (section 7.1) or a read (section 5.7).
  provenance:=CASE p_kind WHEN 'write' THEN 'write-response' ELSE 'read-back' END;
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
        ELSE jsonb_typeof(r->'verifyAfter')<>'string' OR NOT pg_input_is_valid(r->>'verifyAfter','timestamptz') END;
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
  -- S2: a write settlement rejects a null token explicitly. A read-back settlement stays
  -- attempt-fenced and token-independent, so a terminal job can settle its review (section 5.7).
  IF p_kind='write' AND (p_token IS NULL OR detail.job_id IS NULL OR job.kind<>'device-update' OR
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
      (p_kind='write' AND o.status='dispatched' AND o.attempt_id=p_attempt AND
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
  -- a result whose lease lapsed in a wait leaves the device lock set.
  now_at:=clock_timestamp();
  IF p_kind='write' AND (detail.job_id IS NULL OR detail.dispatch_token IS DISTINCT FROM p_token) THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  SELECT array_agg(o.operation_number ORDER BY o.operation_number) INTO candidates
  FROM cc.device_update_operations o WHERE o.job_id=p_job AND o.operation_number=ANY(candidates) AND (
      (p_kind='write' AND o.status='dispatched' AND o.attempt_id=p_attempt AND
        EXISTS(SELECT 1 FROM cc.device_update_batches b WHERE b.job_id=o.job_id AND b.batch=o.batch AND
          b.attempt_id=p_attempt AND b.lease_expires_at>now_at)) OR
      (p_kind='read-back' AND o.status='unknown' AND o.verify_attempt=p_attempt AND
        o.verify_lease_expires_at>now_at));
  IF candidates IS NULL THEN
    RETURN jsonb_build_object('outcome','settled','settled',settled,'publication',NULL);
  END IF;
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
  PERFORM 1 FROM cc.device_write_overlays w WHERE w.customer_id=p_customer AND w.field='annotatedLocation' AND
      w.device_id IN (SELECT o.device_id FROM cc.device_update_operations o JOIN jsonb_array_elements(p_results) r
        ON o.operation_number=(r->>'operationNumber')::integer
      WHERE o.job_id=p_job AND o.operation_number=ANY(candidates) AND r->>'outcome'='succeeded')
    ORDER BY w.device_id FOR UPDATE;
  -- The write and read-back lease fences below read the clock after every row lock (review F3, F15).
  now_at:=clock_timestamp();
  WITH results AS (
    SELECT (r->>'operationNumber')::integer AS operation_number,r FROM jsonb_array_elements(p_results) r
  ), eligible AS (
    SELECT res.operation_number,res.r,o.batch,o.device_id,
      CASE WHEN res.r ? 'value' THEN res.r->>'value' ELSE o.requested_value END AS value
    FROM results res JOIN cc.device_update_operations o ON o.job_id=p_job AND o.operation_number=res.operation_number
    -- Only a locked candidate settles, so no write below takes a row lock that the prefix did not decide.
    WHERE o.operation_number=ANY(candidates) AND ((p_kind='write' AND o.status='dispatched' AND o.attempt_id=p_attempt AND
        -- The attempt owns the batch of the operation with a live lease (section 5.4, review F3).
        EXISTS(SELECT 1 FROM cc.device_update_batches b WHERE b.job_id=o.job_id AND b.batch=o.batch AND
          b.attempt_id=p_attempt AND b.lease_expires_at>now_at)) OR
      (p_kind='read-back' AND o.status='unknown' AND o.verify_attempt=p_attempt AND
        o.verify_lease_expires_at>now_at))
  ), applied AS (
    UPDATE cc.device_update_operations o SET status=e.r->>'outcome',
      google_status=(e.r->>'googleStatus')::integer,google_reason=e.r->>'googleReason',
      quota_retries=COALESCE((e.r->>'quotaRetries')::integer,0),
      transient_retries=COALESCE((e.r->>'transientRetries')::integer,0),
      observed_value=e.value,
      observed_at=CASE WHEN e.r->>'outcome'='succeeded' THEN p_observed_at ELSE o.observed_at END,
      verified_by=e.r->>'verifiedBy',outcome_reason=e.r->>'outcomeReason',updated_at=now_at,
      -- An open request keeps the read-back of this attempt and its delay (section 5.7, review F5).
      verify_attempt=CASE WHEN p_kind='write' AND e.r->>'outcome'='unknown' THEN p_attempt END,
      verify_lease_expires_at=CASE WHEN p_kind='write' AND e.r->>'outcome'='unknown'
        THEN p_observed_at+interval '120 seconds' END,
      verify_after=CASE WHEN p_kind='write' AND e.r->>'outcome'='unknown'
        THEN COALESCE((e.r->>'verifyAfter')::timestamptz,p_observed_at+interval '30 seconds') END
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
    SELECT DISTINCT a.device_id FROM applied a WHERE p_kind='read-back' AND a.status='failed' AND
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
DECLARE job cc.jobs; claimed jsonb:='[]'::jsonb; now_at timestamptz; lease_until timestamptz; candidates integer[];
BEGIN
  IF p_attempt IS NULL OR (p_operations IS NOT NULL AND jsonb_typeof(p_operations) IS DISTINCT FROM 'array') THEN
    RAISE EXCEPTION 'The read-back claim is invalid.' USING ERRCODE='22023';
  END IF;
  -- S2 (round 2, round 3): every named operation is a whole number from 1 to the integer limit. A null, a
  -- fraction, or any other element rejects before any lock, so no cast after the header lock rounds or fails.
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_operations) e WHERE
      CASE WHEN jsonb_typeof(e.value)='number' AND pg_input_is_valid(e.value::text,'integer')
        THEN (e.value::text)::integer<1 ELSE true END) THEN
    RAISE EXCEPTION 'The read-back claim is invalid.' USING ERRCODE='22023';
  END IF;
  -- S1: the header row locks first, then the operation rows in operation_number order, and the
  -- clock reads after the header lock. A settlement cannot slip between the fence and the claim.
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  IF job.job_id IS NULL THEN
    RAISE EXCEPTION 'The device update job does not exist.' USING ERRCODE='22023';
  END IF;
  -- S1: the header prefix reads the clock, and eligibility is decided under the header before the
  -- operation locks (round 6, R6-4). A live reservation or a non-unknown operation is not eligible.
  now_at:=clock_timestamp();
  SELECT array_agg(o.operation_number ORDER BY o.operation_number) INTO candidates
  FROM cc.device_update_operations o WHERE o.job_id=p_job AND o.status='unknown' AND
    (o.verify_lease_expires_at IS NULL OR o.verify_lease_expires_at<=now_at) AND
    (p_operations IS NULL OR o.operation_number IN (SELECT (e.value)::integer FROM jsonb_array_elements(p_operations) e));
  IF candidates IS NULL THEN
    RETURN claimed;
  END IF;
  -- S1: only the eligible operations lock, in operation_number order.
  PERFORM 1 FROM cc.device_update_operations o WHERE o.job_id=p_job AND o.operation_number=ANY(candidates)
    ORDER BY o.operation_number FOR UPDATE;
  -- The eligibility fence reads the clock again after the operation locks (review F15). The claim changes only
  -- the rows it locked. An operation that became eligible in the wait waits for a later claim (round 2).
  now_at:=clock_timestamp();
  lease_until:=now_at+interval '120 seconds';
  WITH picked AS (
    UPDATE cc.device_update_operations o SET verify_attempt=p_attempt,
      verify_lease_expires_at=lease_until
    WHERE o.job_id=p_job AND o.operation_number=ANY(candidates) AND o.status='unknown' AND
      (o.verify_lease_expires_at IS NULL OR o.verify_lease_expires_at<=now_at)
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
DECLARE job cc.jobs; detail cc.device_update_jobs; now_at timestamptz;
BEGIN
  -- S2 (round 3, eng-lead ruling 2): a failure outside its enumeration rejects before any lock. A null
  -- failure names no failure.
  IF p_failure IS NOT NULL AND NOT cc.job_failure_known(p_failure) THEN
    RAISE EXCEPTION 'The device update failure is invalid.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  IF job.job_id IS NULL OR job.kind<>'device-update' THEN
    RAISE EXCEPTION 'The device update job does not exist.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=p_job;
  -- The grace fence reads the clock after the job row lock (review F3).
  now_at:=clock_timestamp();
  -- S2: a null token never matches. S3: a terminal job and a superseded call change nothing.
  IF p_token IS NULL OR detail.job_id IS NULL OR detail.dispatch_token IS DISTINCT FROM p_token THEN
    RETURN jsonb_build_object('outcome','superseded');
  END IF;
  IF job.finished_at IS NOT NULL OR job.status<>'running' THEN
    RETURN jsonb_build_object('outcome','finished','status',job.status);
  END IF;
  IF EXISTS(SELECT 1 FROM cc.device_update_batches b WHERE b.job_id=p_job AND
      b.lease_expires_at+interval '30 seconds'>now_at) THEN
    RETURN jsonb_build_object('outcome','busy');
  END IF;
  -- S1 (round 2): the dispatched and pending operation rows lock in operation_number order, so the fence and
  -- the skip below never wait. After that wait the clock reads again. The token and the grace repeat on fresh
  -- reads, and the fence time comes from the post-wait clock. The connection row locks last, so the
  -- publication insert never waits on it (round 3).
  PERFORM 1 FROM cc.device_update_operations o WHERE o.job_id=p_job AND o.status IN ('dispatched','pending')
    ORDER BY o.operation_number FOR UPDATE;
  PERFORM 1 FROM cc.google_connection c WHERE c.customer_id=p_customer FOR KEY SHARE;
  now_at:=clock_timestamp();
  SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=p_job;
  IF detail.job_id IS NULL OR detail.dispatch_token IS DISTINCT FROM p_token THEN
    RETURN jsonb_build_object('outcome','superseded');
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
CREATE FUNCTION cc.finish_device_update_job(p_customer text,p_job uuid,p_token uuid,p_failure text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.device_update_jobs; now_at timestamptz; before text; after text;
BEGIN
  -- S2 (round 3, eng-lead ruling 2): a failure outside its enumeration rejects before any lock. A null
  -- failure names no failure.
  IF p_failure IS NOT NULL AND NOT cc.job_failure_known(p_failure) THEN
    RAISE EXCEPTION 'The device update failure is invalid.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  IF job.job_id IS NULL OR job.kind<>'device-update' THEN
    RAISE EXCEPTION 'The device update job does not exist.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=p_job;
  -- The readiness fences read the clock after the header lock (review F3, S1).
  now_at:=clock_timestamp();
  -- S2: a null token never matches. S3: a superseded or terminal call changes nothing (review F14).
  IF p_token IS NULL OR detail.job_id IS NULL OR detail.dispatch_token IS DISTINCT FROM p_token THEN
    RETURN jsonb_build_object('outcome','superseded','jobId',p_job,'status',job.status);
  END IF;
  IF job.finished_at IS NOT NULL OR job.status NOT IN ('accepted','queued','held','running') THEN
    RETURN jsonb_build_object('outcome','finished','jobId',p_job,'status',job.status);
  END IF;
  -- Section 5.10 step 2: a batch lease within its grace answers busy.
  IF EXISTS(SELECT 1 FROM cc.device_update_batches b WHERE b.job_id=p_job AND
      b.lease_expires_at+interval '30 seconds'>now_at) THEN
    RETURN jsonb_build_object('outcome','busy','jobId',p_job,'status',job.status);
  END IF;
  -- Section 5.5 and 5.10 steps 3 and 4: the final finish never runs before the preparation fenced
  -- every dispatched and pending operation. A terminal job holds neither.
  IF EXISTS(SELECT 1 FROM cc.device_update_operations o WHERE o.job_id=p_job AND o.status IN ('dispatched','pending')) THEN
    RETURN jsonb_build_object('outcome','not-prepared','jobId',p_job,'status',job.status);
  END IF;
  before:=job.status;
  -- S1 (round 3): the finish locks no descendant row. The connection row locks after the validation, so the
  -- publication insert never waits on it. After that wait the clock reads again, and the token and the
  -- grace repeat on fresh reads, as in the preparation. A call that the wait superseded changes nothing (S3).
  PERFORM 1 FROM cc.google_connection c WHERE c.customer_id=p_customer FOR KEY SHARE;
  now_at:=clock_timestamp();
  SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=p_job;
  IF detail.job_id IS NULL OR detail.dispatch_token IS DISTINCT FROM p_token THEN
    RETURN jsonb_build_object('outcome','superseded','jobId',p_job,'status',job.status);
  END IF;
  IF EXISTS(SELECT 1 FROM cc.device_update_batches b WHERE b.job_id=p_job AND
      b.lease_expires_at+interval '30 seconds'>now_at) THEN
    RETURN jsonb_build_object('outcome','busy','jobId',p_job,'status',job.status);
  END IF;
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
DECLARE job cc.jobs; now_at timestamptz; before text; after text;
BEGIN
  -- S2 (round 3, eng-lead ruling 2): a failure outside its enumeration rejects before any lock. A null
  -- failure names no failure.
  IF p_failure IS NOT NULL AND NOT cc.job_failure_known(p_failure) THEN
    RAISE EXCEPTION 'The device update failure is invalid.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  -- S1: the finalizer validates the job kind under the header lock. A refresh header stays untouched.
  IF job.job_id IS NULL OR job.kind<>'device-update' THEN
    RAISE EXCEPTION 'The device update job does not exist.' USING ERRCODE='22023';
  END IF;
  -- S1: the clock reads after the header lock, before the lifecycle and grace validation (review F3, round 3).
  now_at:=clock_timestamp();
  IF job.finished_at IS NOT NULL THEN
    RETURN jsonb_build_object('outcome','finished','jobId',p_job,'status',job.status);
  END IF;
  -- The reaper never acts while a batch lease or its grace lives (section 5.10, review F4).
  IF EXISTS(SELECT 1 FROM cc.device_update_batches b WHERE b.job_id=p_job AND
      b.lease_expires_at+interval '30 seconds'>now_at) THEN
    RETURN jsonb_build_object('outcome','busy','jobId',p_job,'status',job.status);
  END IF;
  -- S1 (round 2): the dispatched and pending operation rows lock in operation_number order, so the fence and
  -- the skip below never wait. After that wait the clock reads again and the grace repeats. The fence time
  -- and finished_at come from the post-wait clock. The connection row locks last, so the publication insert
  -- never waits on it (round 3).
  PERFORM 1 FROM cc.device_update_operations o WHERE o.job_id=p_job AND o.status IN ('dispatched','pending')
    ORDER BY o.operation_number FOR UPDATE;
  PERFORM 1 FROM cc.google_connection c WHERE c.customer_id=p_customer FOR KEY SHARE;
  now_at:=clock_timestamp();
  IF EXISTS(SELECT 1 FROM cc.device_update_batches b WHERE b.job_id=p_job AND
      b.lease_expires_at+interval '30 seconds'>now_at) THEN
    RETURN jsonb_build_object('outcome','busy','jobId',p_job,'status',job.status);
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
  RETURN jsonb_build_object('outcome','finalized','jobId',p_job,'status',after,
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
DECLARE job cc.jobs; detail cc.device_update_jobs; batch cc.device_update_batches; now_at timestamptz;
BEGIN
  -- S2: the fence rejects a null identifier, token, or attempt explicitly.
  IF p_job IS NULL OR p_token IS NULL OR p_attempt IS NULL OR p_batch IS NULL OR p_sequence IS NULL THEN
    RAISE EXCEPTION 'The backoff report is invalid.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  IF job.job_id IS NULL OR job.kind<>'device-update' THEN RETURN false; END IF;
  -- S1/R6-7: the clock reads after the header lock, and the fence reads the detail and batch rows
  -- without a lock, so a superseded report rejects before it waits on the detail row.
  now_at:=clock_timestamp();
  SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=p_job;
  SELECT * INTO batch FROM cc.device_update_batches b WHERE b.job_id=p_job AND b.batch=p_batch;
  IF job.status<>'running' OR job.finished_at IS NOT NULL OR detail.job_id IS NULL OR
    detail.dispatch_token IS DISTINCT FROM p_token OR
    batch.attempt_id IS DISTINCT FROM p_attempt OR batch.lease_expires_at IS NULL OR
    batch.lease_expires_at<=now_at THEN
    RETURN false;
  END IF;
  IF detail.backoff_attempt=p_attempt AND detail.backoff_sequence IS NOT NULL AND
    p_sequence<=detail.backoff_sequence THEN
    RETURN false;
  END IF;
  -- S1: the detail row locks after the fence. The post-wait clock and recheck follow the wait.
  SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=p_job FOR UPDATE;
  now_at:=clock_timestamp();
  IF job.status<>'running' OR job.finished_at IS NOT NULL OR detail.job_id IS NULL OR
    detail.dispatch_token IS DISTINCT FROM p_token THEN
    RETURN false;
  END IF;
  SELECT * INTO batch FROM cc.device_update_batches b WHERE b.job_id=p_job AND b.batch=p_batch;
  IF batch.attempt_id IS DISTINCT FROM p_attempt OR batch.lease_expires_at IS NULL OR
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
DECLARE job cc.jobs; detail cc.device_update_jobs; now_at timestamptz;
BEGIN
  -- S2: the hold reader holds no fence without its customer.
  IF p_customer IS NULL THEN
    RAISE EXCEPTION 'The hold report is invalid.' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cc.job-admission:'||p_customer)::bigint);
  FOR job IN SELECT j.* FROM cc.jobs j WHERE j.customer_id=p_customer AND j.kind='device-update' AND
      j.status='running' ORDER BY j.created_at FOR UPDATE LOOP
    -- The lease fence reads the clock after the job row lock (review F3).
    now_at:=clock_timestamp();
    SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=job.job_id;
    IF detail.backoff_reported_at IS NULL OR detail.backoff_reported_at<now_at-interval '30 seconds' OR
      NOT EXISTS(SELECT 1 FROM cc.device_update_batches b WHERE b.job_id=job.job_id AND
        b.attempt_id=detail.backoff_attempt AND b.lease_expires_at>now_at) OR
      (detail.hold_attempt=detail.backoff_attempt AND detail.hold_sequence>=detail.backoff_sequence) THEN
      CONTINUE;
    END IF;
    -- S1 (round 2, F3): the detail row locks after the prefix. After that wait the clock reads again, and the
    -- report window, the live lease, and the sequence repeat on the locked row before the hold write. A report
    -- that lapsed in the wait takes no hold and leaves the registry unchanged (section 6.3).
    SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=job.job_id FOR UPDATE;
    now_at:=clock_timestamp();
    IF detail.backoff_reported_at IS NULL OR detail.backoff_reported_at<now_at-interval '30 seconds' OR
      NOT EXISTS(SELECT 1 FROM cc.device_update_batches b WHERE b.job_id=job.job_id AND
        b.attempt_id=detail.backoff_attempt AND b.lease_expires_at>now_at) OR
      (detail.hold_attempt=detail.backoff_attempt AND detail.hold_sequence>=detail.backoff_sequence) THEN
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
DECLARE removed integer:=0; job cc.jobs; candidate uuid; state cc.device_sync_state; now_at timestamptz;
  locked text[];
BEGIN
  -- S2: a null customer never matches a job.
  IF p_customer IS NULL THEN
    RAISE EXCEPTION 'The customer is required.' USING ERRCODE='22023';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'The purge limit is invalid.' USING ERRCODE='22023';
  END IF;
  -- S1 (B2b round 2, R1-F1): the sync state row locks once, before every header lock and every connection
  -- lock of this transaction. That includes the implicit KEY SHARE lock of each publication insert. The
  -- lock holds to the end of the transaction, so every loop below reads one stable state.
  SELECT * INTO state FROM cc.device_sync_state s WHERE s.customer_id=p_customer FOR UPDATE;
  -- Every closure publishes, and each publication references the connection row. That row locks after the
  -- state row and before the first clock read, so no closure below waits on it after its clock.
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
  -- A full-sync header without a live sync lease ends as interrupted. S1: the state row is already held,
  -- the header locks second, and the clock reads third. The lease check follows both locks (review F12).
  FOR candidate IN SELECT j.job_id FROM cc.jobs j LEFT JOIN cc.device_sync_state s ON s.customer_id=j.customer_id
      WHERE j.customer_id=p_customer AND j.kind='inventory-refresh' AND j.scope_kind='all-devices' AND
        j.status='running' AND (s.sync_id IS DISTINCT FROM j.job_id OR s.sync_expires_at<=now_at)
      ORDER BY j.job_id LOOP
    SELECT * INTO job FROM cc.jobs j WHERE j.job_id=candidate AND j.customer_id=p_customer FOR UPDATE;
    IF job.job_id IS NULL OR job.status<>'running' OR job.finished_at IS NOT NULL THEN CONTINUE; END IF;
    now_at:=clock_timestamp();
    IF state.sync_id=job.job_id AND state.sync_expires_at>now_at THEN CONTINUE; END IF;
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
  -- S1 (round 6, R6-12): the state row is already held. Every retention candidate takes its header, then
  -- the clock, and it rechecks its eligibility under those locks. The deletion itself stays allowed.
  -- R1-F2 (B2b round 2): the header that the sync state names stays. A replacement request locks and
  -- validates that header, so a purge never leaves the state naming a missing header.
  FOR candidate IN SELECT j.job_id FROM cc.jobs j WHERE j.customer_id=p_customer AND j.kind='inventory-refresh' AND
      j.finished_at IS NOT NULL AND j.finished_at<now_at-interval '7 days' AND j.job_id IS DISTINCT FROM state.sync_id
      ORDER BY j.finished_at LIMIT p_limit LOOP
    SELECT * INTO job FROM cc.jobs j WHERE j.job_id=candidate AND j.customer_id=p_customer FOR UPDATE;
    IF job.job_id IS NULL OR job.finished_at IS NULL THEN CONTINUE; END IF;
    now_at:=clock_timestamp();
    IF job.finished_at>=now_at-interval '7 days' THEN CONTINUE; END IF;
    DELETE FROM cc.jobs WHERE job_id=candidate;
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

REVOKE ALL ON cc.jobs,cc.job_targets,cc.device_update_previews,cc.device_update_preview_targets,
  cc.device_update_jobs,cc.device_update_batches,cc.device_update_operations,cc.device_write_overlays,
  cc.job_activity_seen,cc.job_publications FROM PUBLIC;
REVOKE ALL ON FUNCTION cc.job_display_id(text,bigint),cc.job_visible(uuid,integer,text,uuid),
  cc.visible_device_sync(uuid,integer,text),cc.job_publication_element(cc.jobs,cc.job_publications),
  cc.record_job_change(uuid,boolean,jsonb,jsonb,integer),cc.read_job_publications(text,integer),
  cc.complete_job_publications(text,jsonb),cc.refresh_device_update_counters(uuid),
  cc.device_update_terminal_status(uuid),cc.fence_device_update_operations(uuid,uuid,jsonb,timestamptz,interval),
  cc.skip_device_update_pending(uuid,text),cc.close_refresh_job(uuid,text),cc.write_capable(uuid,text),
  cc.device_update_stop_reason(text,uuid,integer,integer),cc.job_failure_known(text),
  cc.admit_device_update_job(text,boolean),cc.record_device_update_start(text,uuid,uuid,text),
  cc.abandon_device_update_start(text,uuid,uuid),cc.recover_device_update_jobs(text),
  cc.claim_device_update_batch(text,uuid,uuid,integer,uuid,text),
  cc.renew_device_update_batch(text,uuid,uuid,integer,uuid),
  cc.release_device_update_batch(text,uuid,uuid,integer,uuid),
  cc.settle_device_update_operations(text,uuid,uuid,uuid,text,jsonb,timestamptz),
  cc.claim_device_update_verification(text,uuid,jsonb,uuid),
  cc.prepare_device_update_finish(text,uuid,uuid,text),cc.finish_device_update_job(text,uuid,uuid,text),
  cc.finalize_device_update_job(text,uuid,text),
  cc.report_device_update_backoff(text,uuid,uuid,integer,uuid,integer),cc.accept_device_update_hold(text),
  cc.purge_jobs(text,integer) FROM PUBLIC;