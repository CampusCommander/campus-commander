-- The job header, the write-job tables, the fenced functions, the overlays, the purge, and the three actions.
-- 016 keeps the device inventory and the refresh job model. This file adds new objects only.
-- The only statement below that alters a 016 object is the dependency-forced foreign key of cc.entity_sync_jobs.
INSERT INTO cc.application_actions(action,scope_kinds) VALUES('devices:write',ARRAY['platform','district']),
  ('devices:bulk-actions',ARRAY['platform','district']),('jobs:read',ARRAY['platform','district']),
  ('devices:commands',ARRAY['platform','district']),('devices:status',ARRAY['platform','district']);

CREATE SEQUENCE cc.job_number_upd;
CREATE SEQUENCE cc.job_number_ref;
CREATE SEQUENCE cc.job_number_cmd;
CREATE SEQUENCE cc.job_number_sts;
CREATE SEQUENCE cc.preview_number_pv;

-- One header row per background job. Refresh jobs keep cc.entity_sync_jobs as their detail table.
-- Every device write kind shares the tables below: an update, a command, or a status change.
CREATE TABLE cc.jobs (
  job_id uuid PRIMARY KEY,
  display_id text NOT NULL UNIQUE CHECK(display_id ~ '^(UPD|REF|CMD|STS)-[0-9]{3,}$'),
  customer_id text NOT NULL REFERENCES cc.google_connection(customer_id),
  kind text NOT NULL CHECK(kind IN ('inventory-refresh','device-update','device-command','device-status')),
  scope_kind text NOT NULL CHECK(scope_kind IN ('devices','all-devices')),
  status text NOT NULL CHECK(status IN ('accepted','queued','held','running','awaiting-devices','completed',
    'completed-with-errors','failed','needs-review')),
  requested_by uuid NOT NULL REFERENCES cc.application_principals(id),
  generation integer NOT NULL,
  target_count integer CHECK(target_count IS NULL OR target_count>=0),
  target_org_unit_paths text[],
  succeeded integer NOT NULL DEFAULT 0 CHECK(succeeded>=0),
  failed integer NOT NULL DEFAULT 0 CHECK(failed>=0),
  unknown integer NOT NULL DEFAULT 0 CHECK(unknown>=0),
  skipped integer NOT NULL DEFAULT 0 CHECK(skipped>=0),
  expired integer NOT NULL DEFAULT 0 CHECK(expired>=0),
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
-- The write slot: one running device write job per customer. An awaiting-devices command job holds none.
CREATE UNIQUE INDEX jobs_one_running ON cc.jobs(customer_id)
  WHERE kind IN ('device-update','device-command','device-status') AND status='running';
CREATE INDEX jobs_admission ON cc.jobs(customer_id,target_count,created_at,display_id)
  WHERE kind IN ('device-update','device-command','device-status') AND status IN ('accepted','queued','held');
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

-- One prepared preview of a device write. An annotated-location update carries field and mode; a
-- command or status preview carries neither and freezes the action alone.
CREATE TABLE cc.device_update_previews (
  preview_id uuid PRIMARY KEY,
  display_id text NOT NULL UNIQUE CHECK(display_id ~ '^PV-[0-9]{3,}$'),
  customer_id text NOT NULL REFERENCES cc.google_connection(customer_id),
  created_by uuid NOT NULL REFERENCES cc.application_principals(id),
  permission_version integer NOT NULL,
  generation integer NOT NULL,
  action text NOT NULL CHECK(action IN ('annotated-location','reboot','disable','reenable')),
  field text CHECK(field IN ('annotatedLocation')),
  mode text CHECK(mode IN ('replace','clear')),
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
  CHECK((action='annotated-location')=(field IS NOT NULL AND mode IS NOT NULL)),
  CHECK(action<>'annotated-location' OR (mode='clear')=(value IS NULL))
);

-- The frozen target list of one preview. For a command or a status change, observed_value holds the
-- cached device status. Section 2 names the exclusion reasons; the column stays open text.
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
  action text NOT NULL CHECK(action IN ('annotated-location','reboot','disable','reenable')),
  field text CHECK(field IN ('annotatedLocation')),
  mode text CHECK(mode IN ('replace','clear')),
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
  -- The lease of the one poll flow of a command job (section 4 step 5). The identity fences a
  -- delayed flow of a previous lease from recording, using, or releasing its replacement's lease.
  poll_lease_id uuid,
  poll_execution_id text,
  poll_lease_expires_at timestamptz,
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
  result_artifact_id text,
  scope_observations integer NOT NULL DEFAULT 0 CHECK(scope_observations>=0),
  scope_failure text CHECK(scope_failure IS NULL OR scope_failure IN ('delegation-not-authorized','scope-mismatch')),
  CHECK((scope_observations=0)=(scope_failure IS NULL)),
  CHECK((action='annotated-location')=(field IS NOT NULL AND mode IS NOT NULL))
);
CREATE INDEX device_update_jobs_scope_observations ON cc.device_update_jobs(job_id)
  WHERE scope_observations>0;

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
  status text NOT NULL CHECK(status IN ('pending','dispatched','issued','succeeded','failed','unknown','skipped','expired')),
  attempt_id uuid,
  -- The HTTP status of Google's answer, or null when no answer arrived (fix D1). Both settlement
  -- writers normalize a status outside 100 to 599 to null.
  google_status integer CHECK(google_status IS NULL OR google_status BETWEEN 100 AND 599),
  google_reason text,
  quota_retries integer NOT NULL DEFAULT 0 CHECK(quota_retries>=0),
  transient_retries integer NOT NULL DEFAULT 0 CHECK(transient_retries>=0),
  observed_value text,
  observed_at timestamptz,
  verified_by text CHECK(verified_by IN ('write-response','read-back')),
  outcome_reason text,
  -- The Google command of an issued operation (section 1, command operation states).
  command_id text CHECK(command_id ~ '^[0-9]{1,20}$'),
  command_state text CHECK(command_state IN ('pending-delivery','sent','acknowledged')),
  command_expires_at timestamptz,
  command_executed_at timestamptz,
  -- The number of polls that observed this command (section 4 step 7). The schedule reads it.
  poll_count integer NOT NULL DEFAULT 0 CHECK(poll_count>=0),
  poll_after timestamptz,
  poll_deadline_at timestamptz,
  poll_attempt uuid,
  poll_lease_expires_at timestamptz,
  verify_attempt uuid,
  verify_lease_expires_at timestamptz,
  verify_after timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(job_id,operation_number),
  CHECK(status<>'issued' OR (command_id IS NOT NULL AND poll_after IS NOT NULL))
);
CREATE INDEX device_update_operations_activity
  ON cc.device_update_operations(job_id,status,updated_at DESC,operation_number);
-- The poll claim reads the due issued operations of one job (section 4 step 6).
CREATE INDEX device_update_operations_polls ON cc.device_update_operations(job_id,poll_after)
  WHERE status='issued';

-- One field row of one eligible operation: its baseline, its request, and the value Google reported
-- (addendum section 2). Every row of one device carries the result of that device's one PATCH, so the
-- operation keeps the outcome and the field rows keep the values. The field IDs follow section 1.
CREATE TABLE cc.device_update_operation_fields (
  job_id uuid NOT NULL,
  operation_number integer NOT NULL CHECK(operation_number>=1),
  field text NOT NULL CHECK(field IN ('annotatedLocation','annotatedUser','notes','orgUnitPath')),
  baseline_value text CHECK(baseline_value IS NULL OR length(baseline_value)<=4096),
  requested_value text CHECK(requested_value IS NULL OR length(requested_value)<=4096),
  observed_value text CHECK(observed_value IS NULL OR length(observed_value)<=4096),
  PRIMARY KEY(job_id,operation_number,field),
  FOREIGN KEY(job_id,operation_number)
    REFERENCES cc.device_update_operations(job_id,operation_number) ON DELETE CASCADE
);

-- The accepted value of one device, until a list converges or the overlay expires.
CREATE TABLE cc.device_write_overlays (
  customer_id text NOT NULL REFERENCES cc.google_connection(customer_id),
  device_id text NOT NULL,
  field text NOT NULL CHECK(field IN ('annotatedLocation','annotatedUser','notes','orgUnitPath','status')),
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
    skipped=(SELECT count(*) FROM cc.device_update_operations o WHERE o.job_id=p_job AND o.status='skipped'),
    expired=(SELECT count(*) FROM cc.device_update_operations o WHERE o.job_id=p_job AND o.status='expired')
  WHERE j.job_id=p_job;
END;
$$;

-- The status rule of section 5.10, with expired beside failed. It reads only counters.
CREATE FUNCTION cc.device_update_terminal_status(p_job uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT CASE WHEN j.unknown>0 THEN 'needs-review'
    WHEN j.succeeded=j.target_count THEN 'completed'
    WHEN j.succeeded>0 AND j.failed+j.expired+j.skipped>0 THEN 'completed-with-errors'
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
    'serialNumber',c.serial_number,'baselineValue',c.baseline_value,'requestedValue',c.requested_value,
    -- The field rows of the operation, in contract order (addendum section 4).
    'fields',(SELECT COALESCE(jsonb_agg(jsonb_build_object('field',f.field,'baselineValue',f.baseline_value,
        'requestedValue',f.requested_value)
        ORDER BY array_position(ARRAY['annotatedLocation','annotatedUser','notes','orgUnitPath']::text[],f.field)),
        '[]'::jsonb)
      FROM cc.device_update_operation_fields f
      WHERE f.job_id=p_job AND f.operation_number=c.operation_number))),'[]'::jsonb)
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

-- The confirmer of a write job still holds both write actions at the connection scope. The job action
-- names the action permission: an update needs devices:write, a command devices:commands, and a status
-- change devices:status. An unknown action holds no pair, so the answer is false.
CREATE FUNCTION cc.write_capable(p_actor uuid,p_customer text,p_action text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT count(DISTINCT g.action)=2 FROM cc.application_grants g
  WHERE g.principal_id=p_actor AND g.action IN ('devices:bulk-actions',
      CASE p_action WHEN 'annotated-location' THEN 'devices:write'
        WHEN 'reboot' THEN 'devices:commands'
        WHEN 'disable' THEN 'devices:status'
        WHEN 'reenable' THEN 'devices:status' END)
    AND (g.scope='{"kind":"platform"}'::jsonb OR
    (g.scope->>'kind'='district' AND g.scope->>'customerId'=p_customer));
$$;

-- The revalidation of section 5.6: the confirmer, its two write actions, and the connection generation.
-- A batch claim reads it under the header lock and again after its waits (round 2, F1). It reads without a
-- lock, and it returns null when the claim may dispatch.
CREATE FUNCTION cc.device_update_stop_reason(p_customer text,p_confirmer uuid,p_version integer,
  p_generation integer,p_action text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT CASE
    WHEN NOT EXISTS(SELECT 1 FROM cc.application_principals p WHERE p.id=p_confirmer AND p.enabled AND
        p.permission_version=p_version) OR NOT cc.write_capable(p_confirmer,p_customer,p_action) THEN 'permission-changed'
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
  FOR job IN SELECT j.* FROM cc.jobs j WHERE j.customer_id=p_customer AND j.kind IN ('device-update','device-command','device-status')
      AND j.status IN ('accepted','queued','held') ORDER BY j.target_count,j.created_at,j.display_id FOR UPDATE LOOP
    candidates:=candidates||job;
  END LOOP;
  -- S1 (round 3, R2-F3): the clock reads after every header wait, before the validation and before the
  -- detail lock, on every path. The admitted path reads it again after its detail wait below.
  now_at:=clock_timestamp();
  -- S1 (round 2): the one-running flag reads after every header wait, so a job that ended in a wait
  -- leaves the write slot free for this admission.
  SELECT EXISTS(SELECT 1 FROM cc.jobs j WHERE j.customer_id=p_customer AND j.kind IN ('device-update','device-command','device-status') AND j.status='running')
    INTO running;
  -- S1 (round 3): a status change publishes, and the publication row references the connection row. A
  -- credential read holds that row FOR UPDATE (008), so the connection row locks here, after the validation,
  -- and no publication insert waits on it. After that wait the clock and the one-running flag read again.
  IF cardinality(candidates)>0 THEN
    PERFORM 1 FROM cc.google_connection c WHERE c.customer_id=p_customer FOR KEY SHARE;
    now_at:=clock_timestamp();
    SELECT EXISTS(SELECT 1 FROM cc.jobs j WHERE j.customer_id=p_customer AND j.kind IN ('device-update','device-command','device-status') AND
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
  IF job.job_id IS NULL OR job.kind NOT IN ('device-update','device-command','device-status') THEN
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
  IF job.job_id IS NULL OR job.kind NOT IN ('device-update','device-command','device-status') THEN RETURN; END IF;
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
  FOR job IN SELECT j.* FROM cc.jobs j WHERE j.customer_id=p_customer AND j.kind IN ('device-update','device-command','device-status') AND j.status='running'
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
        -- A command job keeps its unknown operations. Record default 4 gives it no Reconcile and no
        -- repeat, so the reaper starts no read-back for it (section 4 step 11).
        IF job.kind<>'device-command' AND EXISTS(SELECT 1 FROM cc.device_update_operations o WHERE o.job_id=job.job_id AND o.status='unknown') THEN
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
  -- Rule G (B2b round 3): the credential read below reaches the global access lock (advisory lock
  -- 7240173008), so the claim takes that lock first, before any row lock.
  PERFORM pg_advisory_xact_lock(7240173008);
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  IF job.job_id IS NULL OR job.kind NOT IN ('device-update','device-command','device-status') THEN
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
  -- Revalidation before dispatch (section 5.6). A recorded job failure is the first stop reason
  -- (B2c ruling 4): the job never dispatches again after the settlement that recorded it.
  stopped:=COALESCE(job.failure,cc.device_update_stop_reason(p_customer,detail.confirmed_by,
        detail.confirmer_permission_version,job.generation,detail.action));
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
    -- S1 (round 2, R1-F1): the operations that this call changes lock in one pass, in operation_number
    -- order: the job's pending operations, which a stop below skips, and the dispatched operations of a
    -- lapsed attempt. A stop that a later wait finds then holds every row it changes already, so the
    -- detail row below is the last row lock of the path. The header lock makes these statuses stable, so
    -- the eligibility read needs no lock.
    IF EXISTS(SELECT 1 FROM cc.device_update_operations o WHERE o.job_id=p_job AND o.batch=p_batch AND
        (o.status='pending' OR (o.status='dispatched' AND o.attempt_id=lost))) THEN
      PERFORM 1 FROM cc.device_update_operations o WHERE o.job_id=p_job AND
          (o.status='pending' OR (o.status='dispatched' AND o.batch=p_batch AND o.attempt_id=lost))
        ORDER BY o.operation_number FOR UPDATE;
    ELSE
      -- S1 (B2c ruling 7): the detail row locks after the batch and operation rows. The clock reads
      -- after that wait, and the token repeats on the locked row, so a call that a wait superseded
      -- writes nothing.
      SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=p_job FOR UPDATE;
      now_at:=clock_timestamp();
      IF detail.job_id IS NULL OR detail.dispatch_token IS DISTINCT FROM p_token THEN
        RETURN jsonb_build_object('outcome','superseded');
      END IF;
      -- B2c ruling 7: a done answer proves that this execution still runs the job.
      UPDATE cc.device_update_jobs SET heartbeat_at=now_at,first_claimed_at=COALESCE(first_claimed_at,now_at)
      WHERE job_id=p_job;
      RETURN jsonb_build_object('outcome','done');
    END IF;
    -- S1 (round 2, F1): the detail row locks after the operation rows. After the batch, operation, and
    -- detail waits, the token and the revalidation repeat before any change or credential read.
    SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=p_job FOR UPDATE;
    IF detail.job_id IS NULL OR detail.dispatch_token IS DISTINCT FROM p_token THEN
      RETURN jsonb_build_object('outcome','superseded');
    END IF;
    stopped:=cc.device_update_stop_reason(p_customer,detail.confirmed_by,detail.confirmer_permission_version,
      job.generation,detail.action);
    IF stopped IS NULL THEN
      -- The credential read locks the connection row last and rejects a changed generation (015). The
      -- revalidation repeats after that wait, so no access change in any wait reaches a dispatch.
      connection:=cc.google_current_generation(p_customer,job.generation);
      stopped:=cc.device_update_stop_reason(p_customer,detail.confirmed_by,detail.confirmer_permission_version,
        job.generation,detail.action);
    END IF;
    -- The claim writes read the clock after every wait.
    now_at:=clock_timestamp();
  END IF;
  IF stopped IS NOT NULL THEN
    -- S1 (round 3, R2-F2): the stop skips every pending operation of the job, so that complete set locks
    -- first, in operation_number order, and no write below waits. A stop found at the first decision locks
    -- the set here; a stop found after the batch or detail wait re-locks rows that this call already holds
    -- (R1-F1). After that wait the clock reads again, and the token repeats on the locked detail row, so a
    -- call that the wait superseded changes nothing (S3). A stop stays a stop: access that returns during
    -- the wait reopens no dispatch (section 5.6). The connection row locks last, so the publication insert
    -- never waits on it; a stop found after the credential read holds it already.
    PERFORM 1 FROM cc.device_update_operations o WHERE o.job_id=p_job AND o.status='pending'
      ORDER BY o.operation_number FOR UPDATE;
    -- S1 (B2c contract C4): the detail row locks after the operation rows and before the connection row.
    -- After both waits the clock reads again, and the token repeats on the locked detail row.
    SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=p_job FOR UPDATE;
    PERFORM 1 FROM cc.google_connection c WHERE c.customer_id=p_customer FOR KEY SHARE;
    now_at:=clock_timestamp();
    IF detail.job_id IS NULL OR detail.dispatch_token IS DISTINCT FROM p_token THEN
      RETURN jsonb_build_object('outcome','superseded');
    END IF;
    -- B2c ruling 7: the heartbeat and the first claim of a stopped answer prove the execution is live.
    UPDATE cc.device_update_jobs SET heartbeat_at=now_at,first_claimed_at=COALESCE(first_claimed_at,now_at)
    WHERE job_id=p_job;
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
    'serialNumber',c.serial_number,'baselineValue',c.baseline_value,'requestedValue',c.requested_value,
    -- The field rows of the operation, in contract order (addendum section 4).
    'fields',(SELECT COALESCE(jsonb_agg(jsonb_build_object('field',f.field,'baselineValue',f.baseline_value,
        'requestedValue',f.requested_value)
        ORDER BY array_position(ARRAY['annotatedLocation','annotatedUser','notes','orgUnitPath']::text[],f.field)),
        '[]'::jsonb)
      FROM cc.device_update_operation_fields f
      WHERE f.job_id=p_job AND f.operation_number=c.operation_number))),'[]'::jsonb)
  INTO claim FROM claimed c;
  IF jsonb_array_length(claim)=0 AND jsonb_array_length(readback)=0 THEN
    -- B2c ruling 7: the detail row is held from the claim path, and the clock reads after its wait. The
    -- write of a done answer proves that this execution still runs the job.
    UPDATE cc.device_update_jobs SET heartbeat_at=now_at,first_claimed_at=COALESCE(first_claimed_at,now_at)
    WHERE job_id=p_job;
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
    'batchCount',detail.batch_count,'action',detail.action,'operations',claim,'readBack',readback);
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
  IF job.job_id IS NULL OR job.kind NOT IN ('device-update','device-command','device-status') THEN
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
  IF job.job_id IS NULL OR job.kind NOT IN ('device-update','device-command','device-status') THEN
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
-- A write settlement also records the job failure and the scope observation of its results.
CREATE FUNCTION cc.settle_device_update_operations(p_customer text,p_job uuid,p_token uuid,p_attempt uuid,
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
  -- The action names the observation column of a command or status job. An update action publishes
  -- each field row into its own column instead, so `write_field` stays null for it (section 4).
  write_field:=CASE detail.action WHEN 'disable' THEN 'status' WHEN 'reenable' THEN 'status' END;
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
    array_position(ARRAY['annotatedLocation','annotatedUser','notes','orgUnitPath'],f.field)
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
      -- 15 s from this settlement, and the 7-day cap counts from the issue answer.
      command_id=CASE WHEN p_kind='issue' AND e.r->>'outcome'='issued' THEN e.r->>'commandId' ELSE o.command_id END,
      command_state=CASE WHEN p_kind='issue' AND e.r->>'outcome'='issued' THEN 'pending-delivery' ELSE o.command_state END,
      poll_after=CASE WHEN p_kind='issue' AND e.r->>'outcome'='issued' THEN now_at+interval '15 seconds' ELSE o.poll_after END,
      poll_deadline_at=CASE WHEN p_kind='issue' AND e.r->>'outcome'='issued' THEN p_observed_at+interval '7 days' ELSE o.poll_deadline_at END,
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
      v.has_annotated_location,v.annotated_location,v.has_annotated_user,v.annotated_user,
      v.has_notes,v.notes,v.has_org_unit_path,v.org_unit_path,v.has_status,v.status_value
  ), overlay AS (
    INSERT INTO cc.device_write_overlays(customer_id,device_id,field,value,observed_at,source,job_id,
      operation_number,expires_at)
    SELECT p_customer,p.device_id,v.field,v.value,p_observed_at,p.verified_by,p_job,p.operation_number,
      p_observed_at+interval '36 hours'
    FROM published p
    CROSS JOIN LATERAL (VALUES
      ('annotatedLocation',p.annotated_location,p.has_annotated_location),
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
  ), soft AS (
    UPDATE cc.devices d SET removed_at=COALESCE(d.removed_at,now_at) FROM missing m
    WHERE d.customer_id=p_customer AND d.device_id=m.device_id RETURNING d.device_id
  )
  SELECT (SELECT COALESCE(jsonb_agg(jsonb_build_object('operationNumber',a.operation_number,'deviceId',a.device_id,
      'status',a.status,'batch',a.batch) ORDER BY a.operation_number),'[]'::jsonb) FROM applied a),
    (SELECT COALESCE(jsonb_agg(p.device_id ORDER BY p.device_id),'[]'::jsonb) FROM published p),
    (SELECT COALESCE(jsonb_agg(m.device_id ORDER BY m.device_id),'[]'::jsonb) FROM missing m)
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

-- One read-back claim of the named unknown operations, or of every unknown operation. A caller may
-- claim the next chunk after a cursor, with a limit of 1 to 250 operations (B2c ruling 3).
CREATE FUNCTION cc.claim_device_update_verification(p_customer text,p_job uuid,p_operations jsonb,p_attempt uuid,
  p_after integer DEFAULT NULL,p_limit integer DEFAULT NULL)
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
  -- S2 (B2c ruling 3): a negative cursor and a limit outside 1 to 250 reject before any lock.
  IF (p_after IS NOT NULL AND p_after<0) OR (p_limit IS NOT NULL AND p_limit NOT BETWEEN 1 AND 250) THEN
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
  -- The cursor and the limit pick the chunk: the first p_limit candidates after p_after.
  now_at:=clock_timestamp();
  SELECT array_agg(n ORDER BY n) INTO candidates FROM (
    SELECT o.operation_number AS n
    FROM cc.device_update_operations o WHERE o.job_id=p_job AND o.status='unknown' AND
      (o.verify_lease_expires_at IS NULL OR o.verify_lease_expires_at<=now_at) AND
      (p_after IS NULL OR o.operation_number>p_after) AND
      (p_operations IS NULL OR o.operation_number IN (SELECT (e.value)::integer FROM jsonb_array_elements(p_operations) e))
    ORDER BY o.operation_number LIMIT p_limit) chunk;
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
    'verifyAfter',c.verify_after,
    -- The field rows of the operation, in contract order (addendum section 4).
    'fields',(SELECT COALESCE(jsonb_agg(jsonb_build_object('field',f.field,'baselineValue',f.baseline_value,
        'requestedValue',f.requested_value)
        ORDER BY array_position(ARRAY['annotatedLocation','annotatedUser','notes','orgUnitPath']::text[],f.field)),
        '[]'::jsonb)
      FROM cc.device_update_operation_fields f
      WHERE f.job_id=p_job AND f.operation_number=c.operation_number)) ORDER BY c.operation_number),'[]'::jsonb)
  INTO claimed FROM picked c;
  RETURN claimed;
END;
$$;

-- The verification read of one read-back attempt (B2c ruling 1). It returns the envelope of the job
-- generation beside the listed operations that the attempt holds under a live read-back lease.
CREATE FUNCTION cc.read_device_update_verification(p_customer text,p_job uuid,p_attempt uuid,p_operations jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.device_update_jobs; connection cc.google_connection; now_at timestamptz; operations jsonb;
BEGIN
  -- S2: every input holds a value of its domain, or the call rejects before its first lock. A null
  -- input names no operation to hold, so it never answers not-held.
  IF p_customer IS NULL OR p_job IS NULL OR p_attempt IS NULL OR p_operations IS NULL OR
    jsonb_typeof(p_operations) IS DISTINCT FROM 'array' OR
    jsonb_array_length(p_operations) NOT BETWEEN 1 AND 250 OR
    EXISTS(SELECT 1 FROM jsonb_array_elements(p_operations) e WHERE
      CASE WHEN jsonb_typeof(e.value)='number' AND pg_input_is_valid(e.value::text,'integer')
        THEN (e.value::text)::integer<1 ELSE true END) THEN
    RAISE EXCEPTION 'The verification read is invalid.' USING ERRCODE='22023';
  END IF;
  -- Rule G: the credential read below reaches the global access lock, so this read takes it first,
  -- before every row lock.
  PERFORM pg_advisory_xact_lock(7240173008);
  -- S1: the header reads without a lock. This call changes no job row.
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer;
  IF job.job_id IS NULL OR job.kind NOT IN ('device-update','device-command','device-status') THEN
    RAISE EXCEPTION 'The device update job does not exist.' USING ERRCODE='22023';
  END IF;
  -- The action of the job selects the compared field of a read-back (addendum section 5). The read
  -- returns it to the caller, which compares `status` for a status job.
  SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=p_job;
  IF detail.job_id IS NULL THEN
    RAISE EXCEPTION 'The device update job does not exist.' USING ERRCODE='22023';
  END IF;
  -- The clock and the held operations read without a lock.
  now_at:=clock_timestamp();
  SELECT jsonb_agg(jsonb_build_object('operationNumber',o.operation_number,'deviceId',o.device_id,
      'serialNumber',o.serial_number,'baselineValue',o.baseline_value,'requestedValue',o.requested_value,
      'verifyAfter',o.verify_after,'verifyLeaseExpiresAt',o.verify_lease_expires_at,
      'fields',(SELECT COALESCE(jsonb_agg(jsonb_build_object('field',f.field,'baselineValue',f.baseline_value,
          'requestedValue',f.requested_value)
          ORDER BY array_position(ARRAY['annotatedLocation','annotatedUser','notes','orgUnitPath']::text[],f.field)),
          '[]'::jsonb)
        FROM cc.device_update_operation_fields f
        WHERE f.job_id=p_job AND f.operation_number=o.operation_number)) ORDER BY o.operation_number)
    INTO operations
  FROM cc.device_update_operations o
  WHERE o.job_id=p_job AND o.status='unknown' AND o.verify_attempt=p_attempt AND o.verify_lease_expires_at>now_at
    AND o.operation_number IN (SELECT (e.value)::integer FROM jsonb_array_elements(p_operations) e);
  IF operations IS NULL THEN RETURN jsonb_build_object('outcome','not-held'); END IF;
  -- The credential read locks the connection row FOR UPDATE and raises the detail of a changed
  -- generation, a disconnected connection, or a restored credential that needs revalidation.
  connection:=cc.google_current_generation(p_customer,job.generation);
  -- The clock reads again after the connection wait, and the held operations repeat on it. A hold
  -- that lapsed in that wait answers not-held and returns no envelope (open question 4).
  now_at:=clock_timestamp();
  SELECT jsonb_agg(jsonb_build_object('operationNumber',o.operation_number,'deviceId',o.device_id,
      'serialNumber',o.serial_number,'baselineValue',o.baseline_value,'requestedValue',o.requested_value,
      'verifyAfter',o.verify_after,'verifyLeaseExpiresAt',o.verify_lease_expires_at,
      'fields',(SELECT COALESCE(jsonb_agg(jsonb_build_object('field',f.field,'baselineValue',f.baseline_value,
          'requestedValue',f.requested_value)
          ORDER BY array_position(ARRAY['annotatedLocation','annotatedUser','notes','orgUnitPath']::text[],f.field)),
          '[]'::jsonb)
        FROM cc.device_update_operation_fields f
        WHERE f.job_id=p_job AND f.operation_number=o.operation_number)) ORDER BY o.operation_number)
    INTO operations
  FROM cc.device_update_operations o
  WHERE o.job_id=p_job AND o.status='unknown' AND o.verify_attempt=p_attempt AND o.verify_lease_expires_at>now_at
    AND o.operation_number IN (SELECT (e.value)::integer FROM jsonb_array_elements(p_operations) e);
  IF operations IS NULL THEN RETURN jsonb_build_object('outcome','not-held'); END IF;
  RETURN jsonb_build_object('outcome','held','checkedAt',now_at,'generation',connection.generation,
    'credentialId',connection.credential_id,'action',detail.action,
    'envelope',(SELECT g.envelope FROM cc.google_credentials g WHERE g.id=connection.credential_id),
    'operations',operations);
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
  IF job.job_id IS NULL OR job.kind NOT IN ('device-update','device-command','device-status') THEN
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
  -- B2c ruling 4: the skip reason is the recorded job failure after that update, or interrupted.
  PERFORM cc.skip_device_update_pending(p_job,
    COALESCE((SELECT j.failure FROM cc.jobs j WHERE j.job_id=p_job),'interrupted'));
  PERFORM cc.refresh_device_update_counters(p_job);
  PERFORM cc.record_job_change(p_job,false);
  -- A command job skips the read-back, so the caller learns the action here (section 4 step 4).
  RETURN jsonb_build_object('outcome','ready',
    'failure',(SELECT j.failure FROM cc.jobs j WHERE j.job_id=p_job),'action',detail.action);
END;
$$;

-- Finish steps 6 and 7. The status rule reads only the counters.
CREATE FUNCTION cc.finish_device_update_job(p_customer text,p_job uuid,p_token uuid,p_failure text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.device_update_jobs; now_at timestamptz; before text; after text; element jsonb;
BEGIN
  -- S2 (round 3, eng-lead ruling 2): a failure outside its enumeration rejects before any lock. A null
  -- failure names no failure.
  IF p_failure IS NOT NULL AND NOT cc.job_failure_known(p_failure) THEN
    RAISE EXCEPTION 'The device update failure is invalid.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  IF job.job_id IS NULL OR job.kind NOT IN ('device-update','device-command','device-status') THEN
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
  -- A command job that still waits for Google keeps no write slot and no finished time (section 1).
  -- The issue settlement leaves its accepted operations issued, so this branch frees the slot.
  IF job.kind='device-command' AND EXISTS(SELECT 1 FROM cc.device_update_operations o
      WHERE o.job_id=p_job AND o.status='issued') THEN
    after:='awaiting-devices';
    UPDATE cc.jobs SET status=after WHERE job_id=p_job;
    element:=cc.record_job_change(p_job,after IS DISTINCT FROM before);
    RETURN jsonb_build_object('jobId',p_job,'status',after,
      'succeeded',(SELECT j.succeeded FROM cc.jobs j WHERE j.job_id=p_job),
      'failed',(SELECT j.failed FROM cc.jobs j WHERE j.job_id=p_job),
      'unknown',(SELECT j.unknown FROM cc.jobs j WHERE j.job_id=p_job),
      'skipped',(SELECT j.skipped FROM cc.jobs j WHERE j.job_id=p_job),
      'expired',(SELECT j.expired FROM cc.jobs j WHERE j.job_id=p_job),
      'finishedAt',NULL,'publication',element);
  END IF;
  after:=cc.device_update_terminal_status(p_job);
  UPDATE cc.jobs SET status=after,finished_at=COALESCE(finished_at,now_at) WHERE job_id=p_job;
  -- B2c ruling 6: the terminal answer carries the element of the publication row that this call records,
  -- so the worker publishes it at once.
  element:=cc.record_job_change(p_job,after IS DISTINCT FROM before);
  RETURN jsonb_build_object('jobId',p_job,'status',after,
    'succeeded',(SELECT j.succeeded FROM cc.jobs j WHERE j.job_id=p_job),
    'failed',(SELECT j.failed FROM cc.jobs j WHERE j.job_id=p_job),
    'unknown',(SELECT j.unknown FROM cc.jobs j WHERE j.job_id=p_job),
    'skipped',(SELECT j.skipped FROM cc.jobs j WHERE j.job_id=p_job),
    'expired',(SELECT j.expired FROM cc.jobs j WHERE j.job_id=p_job),
    'finishedAt',(SELECT j.finished_at FROM cc.jobs j WHERE j.job_id=p_job),'publication',element);
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
  IF job.job_id IS NULL OR job.kind NOT IN ('device-update','device-command','device-status') THEN
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
  -- B2c ruling 4: the skip reason is the recorded job failure after that update, or interrupted.
  PERFORM cc.skip_device_update_pending(p_job,
    COALESCE((SELECT j.failure FROM cc.jobs j WHERE j.job_id=p_job),'interrupted'));
  PERFORM cc.refresh_device_update_counters(p_job);
  -- A command job that still waits for Google leaves the reaper in awaiting-devices (section 1).
  IF job.kind='device-command' AND EXISTS(SELECT 1 FROM cc.device_update_operations o
      WHERE o.job_id=p_job AND o.status='issued') THEN
    after:='awaiting-devices';
    UPDATE cc.jobs SET status=after WHERE job_id=p_job;
    PERFORM cc.record_job_change(p_job,after IS DISTINCT FROM before);
    RETURN jsonb_build_object('outcome','finalized','jobId',p_job,'status',after,
      'succeeded',(SELECT j.succeeded FROM cc.jobs j WHERE j.job_id=p_job),
      'failed',(SELECT j.failed FROM cc.jobs j WHERE j.job_id=p_job),
      'unknown',(SELECT j.unknown FROM cc.jobs j WHERE j.job_id=p_job),
      'skipped',(SELECT j.skipped FROM cc.jobs j WHERE j.job_id=p_job),
      'expired',(SELECT j.expired FROM cc.jobs j WHERE j.job_id=p_job),
      'finishedAt',NULL);
  END IF;
  after:=cc.device_update_terminal_status(p_job);
  UPDATE cc.jobs SET status=after,finished_at=now_at WHERE job_id=p_job;
  PERFORM cc.record_job_change(p_job,true);
  RETURN jsonb_build_object('outcome','finalized','jobId',p_job,'status',after,
    'succeeded',(SELECT j.succeeded FROM cc.jobs j WHERE j.job_id=p_job),
    'failed',(SELECT j.failed FROM cc.jobs j WHERE j.job_id=p_job),
    'unknown',(SELECT j.unknown FROM cc.jobs j WHERE j.job_id=p_job),
    'skipped',(SELECT j.skipped FROM cc.jobs j WHERE j.job_id=p_job),
    'expired',(SELECT j.expired FROM cc.jobs j WHERE j.job_id=p_job),
    'finishedAt',(SELECT j.finished_at FROM cc.jobs j WHERE j.job_id=p_job));
END;
$$;

-- The wait after one non-terminal observation (section 4 step 7): 15 s, 30 s, 60 s, 2 min, 5 min,
-- 15 min, then 60 min each time. The poll count of the operation indexes the list.
CREATE FUNCTION cc.device_command_poll_delay(p_count integer) RETURNS interval
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE LEAST(GREATEST(COALESCE(p_count,1),1),7)
    WHEN 1 THEN interval '15 seconds'
    WHEN 2 THEN interval '30 seconds'
    WHEN 3 THEN interval '60 seconds'
    WHEN 4 THEN interval '2 minutes'
    WHEN 5 THEN interval '5 minutes'
    WHEN 6 THEN interval '15 minutes'
    ELSE interval '60 minutes' END;
$$;

-- Complete an awaiting-devices command job when no issued operation stays (section 4 step 10). The
-- caller holds the header lock and has refreshed the counters. A job that keeps an issued operation
-- answers null and stays awaiting-devices.
CREATE FUNCTION cc.complete_device_command_job(p_job uuid,p_now timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; after text; element jsonb;
BEGIN
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job;
  IF job.job_id IS NULL THEN
    RAISE EXCEPTION 'The device command job does not exist.' USING ERRCODE='22023';
  END IF;
  IF job.status<>'awaiting-devices' OR job.finished_at IS NOT NULL OR
    EXISTS(SELECT 1 FROM cc.device_update_operations o WHERE o.job_id=p_job AND o.status='issued') THEN
    RETURN NULL;
  END IF;
  after:=cc.device_update_terminal_status(p_job);
  UPDATE cc.jobs SET status=after,finished_at=COALESCE(finished_at,p_now) WHERE job_id=p_job;
  element:=cc.record_job_change(p_job,true);
  RETURN jsonb_build_object('outcome','completed','status',after,
    'succeeded',(SELECT j.succeeded FROM cc.jobs j WHERE j.job_id=p_job),
    'failed',(SELECT j.failed FROM cc.jobs j WHERE j.job_id=p_job),
    'unknown',(SELECT j.unknown FROM cc.jobs j WHERE j.job_id=p_job),
    'expired',(SELECT j.expired FROM cc.jobs j WHERE j.job_id=p_job),
    'finishedAt',(SELECT j.finished_at FROM cc.jobs j WHERE j.job_id=p_job),'publication',element);
END;
$$;

-- The poll start of one job service tick (section 4 step 5). It returns at most ten awaiting-devices
-- jobs with a due issued operation and no live poll lease, and sets the ten-minute lease of each
-- under a fresh identity. A job whose flow never starts waits for that lease to lapse, and the next
-- tick retries under a new identity.
CREATE FUNCTION cc.due_device_command_polls(p_customer text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE now_at timestamptz; leased jsonb:='[]'::jsonb;
BEGIN
  IF p_customer IS NULL THEN
    RAISE EXCEPTION 'The device command polls are invalid.' USING ERRCODE='22023';
  END IF;
  now_at:=clock_timestamp();
  WITH picked AS (
    SELECT j.job_id FROM cc.jobs j
    WHERE j.customer_id=p_customer AND j.kind='device-command' AND j.status='awaiting-devices'
      AND EXISTS(SELECT 1 FROM cc.device_update_operations o
        WHERE o.job_id=j.job_id AND o.status='issued' AND o.poll_after<=now_at)
      AND EXISTS(SELECT 1 FROM cc.device_update_jobs u WHERE u.job_id=j.job_id AND
        (u.poll_lease_expires_at IS NULL OR u.poll_lease_expires_at<=now_at))
    ORDER BY j.created_at,j.display_id LIMIT 10
    FOR UPDATE OF j SKIP LOCKED
  ), updated AS (
    UPDATE cc.device_update_jobs u SET poll_lease_expires_at=now_at+interval '10 minutes',
      poll_lease_id=gen_random_uuid(),poll_execution_id=NULL
    FROM picked p WHERE u.job_id=p.job_id
    RETURNING u.job_id,u.poll_lease_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('jobId',u.job_id,'leaseId',u.poll_lease_id,
    'leaseExpiresAt',now_at+interval '10 minutes') ORDER BY u.job_id),'[]'::jsonb)
  INTO leased FROM updated u;
  RETURN leased;
END;
$$;

-- The lease of one poll flow is recorded after its start (section 4 step 5). Only the flow that holds
-- the lease identity records it. A lapsed or replaced lease records nothing.
CREATE FUNCTION cc.record_device_command_poll_start(p_customer text,p_job uuid,p_lease_id uuid,
  p_execution text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE changed integer;
BEGIN
  IF p_customer IS NULL OR p_job IS NULL OR p_lease_id IS NULL OR p_execution IS NULL OR
    length(p_execution) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'The device command poll start is invalid.' USING ERRCODE='22023';
  END IF;
  UPDATE cc.device_update_jobs u SET poll_execution_id=p_execution
  WHERE u.job_id=p_job AND u.poll_lease_id=p_lease_id AND u.poll_lease_expires_at>clock_timestamp() AND
    EXISTS(SELECT 1 FROM cc.jobs j WHERE j.job_id=u.job_id AND j.customer_id=p_customer AND
      j.status='awaiting-devices' AND j.finished_at IS NULL);
  GET DIAGNOSTICS changed=ROW_COUNT;
  RETURN changed>0;
END;
$$;

-- Release the poll lease at the end of one poll run (section 4 step 6). Only the flow that holds the
-- lease identity releases it, so a delayed run leaves its replacement's lease alone. The operation
-- leases stay: an operation whose GET got no final answer keeps its 120 s lease, so the next poll
-- repeats it then.
CREATE FUNCTION cc.release_device_command_poll(p_customer text,p_job uuid,p_lease_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE changed integer;
BEGIN
  IF p_customer IS NULL OR p_job IS NULL OR p_lease_id IS NULL THEN
    RAISE EXCEPTION 'The device command poll release is invalid.' USING ERRCODE='22023';
  END IF;
  UPDATE cc.device_update_jobs u SET poll_lease_expires_at=NULL,poll_execution_id=NULL,poll_lease_id=NULL
  WHERE u.job_id=p_job AND u.poll_lease_id=p_lease_id AND
    EXISTS(SELECT 1 FROM cc.jobs j WHERE j.job_id=u.job_id AND j.customer_id=p_customer);
  GET DIAGNOSTICS changed=ROW_COUNT;
  RETURN changed>0;
END;
$$;

-- One poll claim of at most 250 due issued operations under a 120 s lease (section 4 step 6). The
-- claim settles an operation that passed its deadline as unknown with not-observed, and it completes
-- the job when that leaves no issued operation. Those two steps need no credential, so a job with no
-- usable connection still settles at its deadline.
CREATE FUNCTION cc.claim_device_command_polls(p_customer text,p_job uuid,p_attempt uuid,p_lease_id uuid)
  RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.device_update_jobs; connection cc.google_connection; now_at timestamptz;
  numbers integer[]; overdue integer:=0; claimed jsonb:='[]'::jsonb; completed jsonb;
BEGIN
  IF p_customer IS NULL OR p_job IS NULL OR p_attempt IS NULL OR p_lease_id IS NULL THEN
    RAISE EXCEPTION 'The device command poll claim is invalid.' USING ERRCODE='22023';
  END IF;
  -- Rule G: the credential read below reaches the global access lock, so this claim takes that lock
  -- first, before any row lock.
  PERFORM pg_advisory_xact_lock(7240173008);
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  IF job.job_id IS NULL OR job.kind<>'device-command' THEN
    RAISE EXCEPTION 'The device command job does not exist.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=p_job FOR UPDATE;
  now_at:=clock_timestamp();
  -- A finished job, a job without a live poll lease, and a lease held under another identity answer
  -- not-held and change nothing.
  IF detail.job_id IS NULL OR job.status<>'awaiting-devices' OR job.finished_at IS NOT NULL OR
    detail.poll_lease_expires_at IS NULL OR detail.poll_lease_expires_at<=now_at OR
    detail.poll_lease_id IS DISTINCT FROM p_lease_id THEN
    RETURN jsonb_build_object('outcome','not-held','status',job.status);
  END IF;
  UPDATE cc.device_update_operations o SET status='unknown',outcome_reason='not-observed',
    poll_attempt=NULL,poll_lease_expires_at=NULL,updated_at=now_at
  WHERE o.job_id=p_job AND o.status='issued' AND o.poll_deadline_at IS NOT NULL AND o.poll_deadline_at<=now_at;
  GET DIAGNOSTICS overdue=ROW_COUNT;
  IF overdue>0 THEN
    PERFORM cc.refresh_device_update_counters(p_job);
    completed:=cc.complete_device_command_job(p_job,now_at);
    IF completed IS NOT NULL THEN RETURN completed; END IF;
  END IF;
  -- The candidates read under the header lock, so the row lock below waits on no other poll.
  SELECT array_agg(o.operation_number ORDER BY o.operation_number) INTO numbers
  FROM (SELECT o.operation_number FROM cc.device_update_operations o
    WHERE o.job_id=p_job AND o.status='issued' AND o.poll_after<=now_at AND
      (o.poll_lease_expires_at IS NULL OR o.poll_lease_expires_at<=now_at)
    ORDER BY o.operation_number LIMIT 250) o;
  IF numbers IS NULL THEN
    RETURN jsonb_build_object('outcome','idle','status',job.status,'operations',claimed);
  END IF;
  PERFORM 1 FROM cc.device_update_operations o WHERE o.job_id=p_job AND o.operation_number=ANY(numbers)
    ORDER BY o.operation_number FOR UPDATE;
  -- The credential read locks the connection row last and raises for a changed or disconnected
  -- generation. Section 4 step 12 keeps those polls failing: the sweep above already committed the
  -- deadline settlements, and the answer leaves the operations unleased for the next poll.
  BEGIN
    connection:=cc.google_current_generation(p_customer,job.generation);
  EXCEPTION WHEN raise_exception THEN
    RETURN jsonb_build_object('outcome','unavailable','status',job.status,'detail',SQLERRM);
  END;
  now_at:=clock_timestamp();
  WITH picked AS (
    UPDATE cc.device_update_operations o SET poll_attempt=p_attempt,poll_lease_expires_at=now_at+interval '120 seconds',
      poll_count=poll_count+1,updated_at=now_at
    WHERE o.job_id=p_job AND o.operation_number=ANY(numbers) AND o.status='issued' AND o.poll_after<=now_at AND
      (o.poll_lease_expires_at IS NULL OR o.poll_lease_expires_at<=now_at)
    RETURNING o.operation_number,o.device_id,o.command_id)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('operationNumber',c.operation_number,'deviceId',c.device_id,
    'commandId',c.command_id) ORDER BY c.operation_number),'[]'::jsonb)
  INTO claimed FROM picked c;
  IF jsonb_array_length(claimed)=0 THEN
    RETURN jsonb_build_object('outcome','idle','status',job.status,'operations',claimed);
  END IF;
  RETURN jsonb_build_object('outcome','claimed','generation',connection.generation,
    'credentialId',connection.credential_id,
    'envelope',(SELECT g.envelope FROM cc.google_credentials g WHERE g.id=connection.credential_id),
    'operations',claimed);
END;
$$;

-- The settlement of one poll chunk (section 4 steps 8, 9, and 10). A non-terminal answer keeps the
-- operation issued with the next scheduled poll. A terminal answer settles it. The settlement that
-- leaves no issued operation derives the terminal status and finishes the job in this transaction.
CREATE FUNCTION cc.settle_device_command_polls(p_customer text,p_job uuid,p_attempt uuid,p_lease_id uuid,
  p_results jsonb,p_observed_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.device_update_jobs; now_at timestamptz; bad integer; numbers integer[];
  settled jsonb:='[]'::jsonb; element jsonb; completed jsonb;
BEGIN
  IF p_customer IS NULL OR p_job IS NULL OR p_attempt IS NULL OR p_lease_id IS NULL OR
    p_observed_at IS NULL OR jsonb_typeof(p_results) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'The command poll settlement is invalid.' USING ERRCODE='22023';
  END IF;
  -- Every result field holds a value of its domain, or the call rejects before any lock.
  SELECT count(*) INTO bad FROM jsonb_array_elements(p_results) r
    WHERE jsonb_typeof(r) IS DISTINCT FROM 'object' OR
      CASE WHEN jsonb_typeof(r->'operationNumber')='number' AND pg_input_is_valid(r->>'operationNumber','integer')
        THEN (r->>'operationNumber')::integer<1 ELSE true END OR
      jsonb_typeof(r->'outcome') IS DISTINCT FROM 'string' OR
      r->>'outcome' NOT IN ('succeeded','failed','expired','unknown','pending') OR
      (r->'commandState' IS NOT NULL AND (jsonb_typeof(r->'commandState')<>'string' OR
        r->>'commandState' NOT IN ('pending-delivery','sent','acknowledged'))) OR
      ((r->>'outcome'='pending')<>(r->'commandState' IS NOT NULL)) OR
      (r->'outcomeReason' IS NOT NULL AND (jsonb_typeof(r->'outcomeReason')<>'string' OR
        length(r->>'outcomeReason')>64)) OR
      (r->'googleReason' IS NOT NULL AND (jsonb_typeof(r->'googleReason')<>'string' OR
        length(r->>'googleReason')>256)) OR
      CASE WHEN r->>'googleStatus' IS NULL THEN false
        ELSE jsonb_typeof(r->'googleStatus')<>'number' OR NOT pg_input_is_valid(r->>'googleStatus','integer') END OR
      CASE WHEN r->>'commandExecutedAt' IS NULL THEN false
        ELSE jsonb_typeof(r->'commandExecutedAt')<>'string' OR
          NOT pg_input_is_valid(r->>'commandExecutedAt','timestamptz') END OR
      CASE WHEN r->>'commandExpiresAt' IS NULL THEN false
        ELSE jsonb_typeof(r->'commandExpiresAt')<>'string' OR
          NOT pg_input_is_valid(r->>'commandExpiresAt','timestamptz') END;
  IF bad>0 THEN
    RAISE EXCEPTION 'The command poll results are invalid.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  IF job.job_id IS NULL OR job.kind<>'device-command' THEN
    RAISE EXCEPTION 'The device command job does not exist.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=p_job;
  now_at:=clock_timestamp();
  -- A finished job, a job that left awaiting-devices, a lapsed poll lease, and a lease held under
  -- another identity fence the settlement.
  IF detail.job_id IS NULL OR job.status<>'awaiting-devices' OR job.finished_at IS NOT NULL OR
    detail.poll_lease_expires_at IS NULL OR detail.poll_lease_expires_at<=now_at OR
    detail.poll_lease_id IS DISTINCT FROM p_lease_id THEN
    RETURN jsonb_build_object('outcome','fenced');
  END IF;
  -- The prefix names the settled operations under the header. Only they lock below.
  SELECT array_agg(DISTINCT o.operation_number ORDER BY o.operation_number) INTO numbers
  FROM cc.device_update_operations o JOIN jsonb_array_elements(p_results) r
      ON o.operation_number=(r->>'operationNumber')::integer
  WHERE o.job_id=p_job AND o.status='issued' AND o.poll_attempt=p_attempt AND o.poll_lease_expires_at>now_at;
  IF numbers IS NULL THEN
    RETURN jsonb_build_object('outcome','settled','settled',settled,'publication',NULL);
  END IF;
  PERFORM 1 FROM cc.device_update_operations o WHERE o.job_id=p_job AND o.operation_number=ANY(numbers)
    ORDER BY o.operation_number FOR UPDATE;
  -- After those waits the clock reads again, and the lease and attempt repeat on the locked rows.
  now_at:=clock_timestamp();
  SELECT array_agg(o.operation_number ORDER BY o.operation_number) INTO numbers
  FROM cc.device_update_operations o WHERE o.job_id=p_job AND o.operation_number=ANY(numbers) AND
    o.status='issued' AND o.poll_attempt=p_attempt AND o.poll_lease_expires_at>now_at;
  IF numbers IS NULL THEN
    RETURN jsonb_build_object('outcome','settled','settled',settled,'publication',NULL);
  END IF;
  -- The first successful poll stores Google's expiry, and the deadline becomes that expiry plus 24
  -- hours (section 4 step 8). A JSON null or a missing expiry names no provider expiry, so the
  -- stored deadline keeps its value. A terminal answer settles with its evidence; a non-terminal
  -- answer keeps the operation issued with the observed command state.
  WITH results AS (
    SELECT (r->>'operationNumber')::integer AS operation_number,
      CASE WHEN jsonb_typeof(r->'commandExpiresAt')='string'
        THEN (r->>'commandExpiresAt')::timestamptz END AS expires_at,
      r
    FROM jsonb_array_elements(p_results) r
  ), applied AS (
    UPDATE cc.device_update_operations o SET
      status=CASE WHEN res.r->>'outcome'='pending' THEN 'issued' ELSE res.r->>'outcome' END,
      command_state=CASE WHEN res.r->>'outcome'='pending' THEN res.r->>'commandState' ELSE o.command_state END,
      outcome_reason=CASE WHEN res.r->>'outcome'='pending' THEN o.outcome_reason
        ELSE res.r->>'outcomeReason' END,
      -- A stored status is an HTTP status from 100 to 599, or null when no answer arrived (fix D1).
      google_status=CASE WHEN (res.r->>'googleStatus')::integer BETWEEN 100 AND 599
        THEN (res.r->>'googleStatus')::integer END,
      google_reason=res.r->>'googleReason',
      command_expires_at=COALESCE(o.command_expires_at,res.expires_at),
      command_executed_at=CASE WHEN res.r->>'outcome'='succeeded'
        THEN COALESCE((res.r->>'commandExecutedAt')::timestamptz,p_observed_at) ELSE o.command_executed_at END,
      poll_deadline_at=CASE WHEN o.command_expires_at IS NULL AND res.expires_at IS NOT NULL
        THEN res.expires_at+interval '24 hours' ELSE o.poll_deadline_at END,
      poll_attempt=NULL,poll_lease_expires_at=NULL,updated_at=now_at
    FROM results res
    WHERE o.job_id=p_job AND o.operation_number=res.operation_number AND o.operation_number=ANY(numbers)
    RETURNING o.operation_number,o.device_id,o.status)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('operationNumber',a.operation_number,'deviceId',a.device_id,
    'status',a.status) ORDER BY a.operation_number),'[]'::jsonb) INTO settled FROM applied a;
  -- An operation that no terminal answer reached by its deadline settles unknown (section 4 step 9).
  UPDATE cc.device_update_operations o SET status='unknown',outcome_reason='not-observed',updated_at=now_at
  WHERE o.job_id=p_job AND o.status='issued' AND o.operation_number=ANY(numbers) AND o.poll_attempt IS NULL
    AND o.poll_deadline_at IS NOT NULL AND o.poll_deadline_at<=now_at;
  -- Every operation that stays issued takes the next scheduled poll. One poll lands at the stored
  -- expiry plus 60 s (section 4 step 7).
  UPDATE cc.device_update_operations o SET
    poll_after=GREATEST(now_at+interval '1 second',
      LEAST(now_at+cc.device_command_poll_delay(o.poll_count),
        COALESCE(CASE WHEN o.command_expires_at IS NOT NULL AND
            o.command_expires_at+interval '60 seconds'>now_at
          THEN o.command_expires_at+interval '60 seconds' END,'infinity'::timestamptz))),
    updated_at=now_at
  WHERE o.job_id=p_job AND o.status='issued' AND o.operation_number=ANY(numbers) AND o.poll_attempt IS NULL;
  PERFORM cc.refresh_device_update_counters(p_job);
  -- The settlement that leaves no issued operation completes the job in this transaction (step 10).
  completed:=cc.complete_device_command_job(p_job,now_at);
  IF completed IS NOT NULL THEN
    RETURN jsonb_build_object('outcome','settled','settled',settled,'publication',completed->'publication',
      'status',completed->'status','jobStatusChanged',true);
  END IF;
  element:=cc.record_job_change(p_job,false);
  RETURN jsonb_build_object('outcome','settled','settled',settled,'publication',element,
    'status','awaiting-devices','jobStatusChanged',false);
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
  IF job.job_id IS NULL OR job.kind NOT IN ('device-update','device-command','device-status') THEN RETURN false; END IF;
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
  FOR job IN SELECT j.* FROM cc.jobs j WHERE j.customer_id=p_customer AND j.kind IN ('device-update','device-command','device-status') AND
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

-- The job service marks the hold registry entry of one cleaned job. It runs after the compare-and-delete
-- script, so hold_cleaned_at names a hold that the job service already tried to delete. A previous owner
-- never marks a newer owner's hold: the release script keeps that hold, and this mark only records the
-- cleanup of this job's registry entry.
CREATE FUNCTION cc.clean_device_update_hold(p_customer text,p_job uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.jobs; detail cc.device_update_jobs; now_at timestamptz;
BEGIN
  -- S2: a null identifier never matches a header.
  IF p_customer IS NULL OR p_job IS NULL THEN
    RAISE EXCEPTION 'The hold cleanup is invalid.' USING ERRCODE='22023';
  END IF;
  -- The hold write and the admission take the same customer lock, so cleanup never interleaves with them.
  PERFORM pg_advisory_xact_lock(hashtext('cc.job-admission:'||p_customer)::bigint);
  -- S1: the header row locks before the detail row, as every other write-job writer takes them.
  SELECT * INTO job FROM cc.jobs j WHERE j.job_id=p_job AND j.customer_id=p_customer FOR UPDATE;
  IF job.job_id IS NULL OR job.kind NOT IN ('device-update','device-command','device-status') THEN RETURN false; END IF;
  -- The caller's own filter names these four terminal statuses. The fence repeats it here, so a direct
  -- call never marks the registry entry of a live job (round 2, eng-lead ruling 3).
  IF job.status NOT IN ('completed','completed-with-errors','failed','needs-review') THEN RETURN false; END IF;
  SELECT * INTO detail FROM cc.device_update_jobs u WHERE u.job_id=p_job FOR UPDATE;
  now_at:=clock_timestamp();
  -- S3: only a job with a written hold and no cleanup mark takes the mark.
  IF detail.job_id IS NULL OR detail.hold_written_at IS NULL OR detail.hold_cleaned_at IS NOT NULL THEN
    RETURN false;
  END IF;
  UPDATE cc.device_update_jobs SET hold_cleaned_at=now_at WHERE job_id=p_job;
  RETURN true;
END;
$$;

-- The receipt of one accepted job. B3 returns it on creation and on a duplicate confirmation.
CREATE FUNCTION cc.device_update_receipt(p_job uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT jsonb_build_object('jobId',j.job_id,'displayId',j.display_id,'status','accepted',
    'deviceCount',j.target_count,
    'updateCount',(SELECT count(*)::integer FROM cc.device_update_operations o WHERE o.job_id=j.job_id))
  FROM cc.jobs j WHERE j.job_id=p_job AND j.kind IN ('device-update','device-command','device-status');
$$;

-- One prepared preview and its frozen targets, in one transaction. The caller resolves the stored
-- selection and computes the values and the digest. This function freezes that result.
-- An annotated-location update carries a mode and a value. A command or status preview carries neither.
CREATE FUNCTION cc.create_device_update_preview(p_actor uuid,p_version integer,p_customer text,
  p_generation integer,p_action text,p_mode text,p_value text,p_digest text,p_targets jsonb,p_expires_minutes integer)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE preview cc.device_update_previews; now_at timestamptz; selected integer; eligible integer;
  unchanged integer; excluded integer; oldest timestamptz; bad integer; number bigint;
BEGIN
  -- S2: every input holds a value of its domain, or the call rejects before any lock or write.
  IF p_actor IS NULL OR p_version IS NULL OR p_customer IS NULL OR p_generation IS NULL OR
    p_action IS NULL OR p_action NOT IN ('annotated-location','reboot','disable','reenable') OR
    p_digest IS NULL OR
    p_digest !~ '^[a-f0-9]{64}$' OR p_targets IS NULL OR jsonb_typeof(p_targets)<>'array' OR
    p_expires_minutes IS NULL OR p_expires_minutes NOT BETWEEN 1 AND 1440 THEN
    RAISE EXCEPTION 'The preview request is invalid.' USING ERRCODE='22023';
  END IF;
  IF p_action='annotated-location' THEN
    IF p_mode IS NULL OR p_mode NOT IN ('replace','clear') OR
      (p_mode='clear') <> (p_value IS NULL) OR
      (p_mode='replace' AND (char_length(p_value) NOT BETWEEN 1 AND 200 OR btrim(p_value)='')) THEN
      RAISE EXCEPTION 'The preview value is invalid.' USING ERRCODE='22023';
    END IF;
  ELSIF p_mode IS NOT NULL OR p_value IS NOT NULL THEN
    RAISE EXCEPTION 'The preview request is invalid.' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(p_targets)>100000 THEN
    RAISE EXCEPTION 'The preview selection is too large.' USING ERRCODE='22023';
  END IF;
  -- Each target row carries every field of the frozen target domain.
  SELECT count(*) INTO bad FROM jsonb_array_elements(p_targets) e
    WHERE jsonb_typeof(e) IS DISTINCT FROM 'object' OR
      CASE WHEN jsonb_typeof(e->'ordinal')='number' AND pg_input_is_valid(e->>'ordinal','integer')
        THEN (e->>'ordinal')::integer<0 ELSE true END OR
      jsonb_typeof(e->'device_id') IS DISTINCT FROM 'string' OR char_length(e->>'device_id') NOT BETWEEN 1 AND 128 OR
      jsonb_typeof(e->'serial_number') IS DISTINCT FROM 'string' OR char_length(e->>'serial_number')>256 OR
      jsonb_typeof(e->'org_unit_path') IS DISTINCT FROM 'string' OR char_length(e->>'org_unit_path')>4096 OR
      (e->'observed_value' IS NOT NULL AND e->'observed_value'<>'null'::jsonb AND
        jsonb_typeof(e->'observed_value')<>'string') OR
      char_length(e->>'observed_value')>4096 OR
      (e->'observed_at' IS NOT NULL AND e->'observed_at'<>'null'::jsonb AND
        (jsonb_typeof(e->'observed_at')<>'string' OR
        NOT pg_input_is_valid(e->>'observed_at','timestamptz'))) OR
      jsonb_typeof(e->'disposition') IS DISTINCT FROM 'string' OR
      e->>'disposition' NOT IN ('eligible','unchanged','excluded') OR
      (e->'exclusion_reason' IS NOT NULL AND e->'exclusion_reason'<>'null'::jsonb AND
        jsonb_typeof(e->'exclusion_reason')<>'string') OR
      char_length(e->>'exclusion_reason')>64 OR
      (e->>'disposition'<>'excluded' AND e->'exclusion_reason' IS NOT NULL AND
        e->'exclusion_reason'<>'null'::jsonb);
  IF bad>0 THEN
    RAISE EXCEPTION 'The preview targets are invalid.' USING ERRCODE='22023';
  END IF;
  IF (SELECT count(DISTINCT e->>'ordinal') FROM jsonb_array_elements(p_targets) e)<>jsonb_array_length(p_targets) OR
    (SELECT count(DISTINCT e->>'device_id') FROM jsonb_array_elements(p_targets) e)<>jsonb_array_length(p_targets) THEN
    RAISE EXCEPTION 'The preview targets repeat an ordinal or a device.' USING ERRCODE='22023';
  END IF;
  -- Rule G (round 3, R1-F2): advisory lock 7240173008 is the global access lock. Every access change
  -- takes it first. This function takes it before the person check and before every row lock, so an
  -- access change cannot commit between the check and the INSERT of the preview and its targets.
  PERFORM pg_advisory_xact_lock(7240173008);
  -- The person check of the preview route. A caller without both write actions receives no preview.
  IF NOT EXISTS(SELECT 1 FROM cc.application_principals p
      WHERE p.id=p_actor AND p.enabled AND p.permission_version=p_version) OR
    NOT cc.write_capable(p_actor,p_customer,p_action) THEN
    RETURN jsonb_build_object('outcome','forbidden');
  END IF;
  SELECT count(*),count(*) FILTER (WHERE e->>'disposition'='eligible'),
      count(*) FILTER (WHERE e->>'disposition'='unchanged'),
      count(*) FILTER (WHERE e->>'disposition'='excluded'),
      min(CASE WHEN e->>'disposition'='eligible' AND e->>'observed_at' IS NOT NULL
        THEN (e->>'observed_at')::timestamptz END)
  INTO selected,eligible,unchanged,excluded,oldest FROM jsonb_array_elements(p_targets) e;
  now_at:=clock_timestamp();
  number:=nextval('cc.preview_number_pv');
  INSERT INTO cc.device_update_previews(preview_id,display_id,customer_id,created_by,permission_version,
    generation,action,field,mode,value,selected,eligible,unchanged,excluded,oldest_observed_at,manifest_digest,
    prepared_at,expires_at)
  VALUES(gen_random_uuid(),cc.job_display_id('PV',number),p_customer,p_actor,p_version,p_generation,
    p_action,CASE WHEN p_action='annotated-location' THEN 'annotatedLocation' END,p_mode,p_value,
    selected,eligible,unchanged,excluded,oldest,p_digest,now_at,
    now_at+make_interval(mins=>p_expires_minutes))
  RETURNING * INTO preview;
  INSERT INTO cc.device_update_preview_targets(preview_id,ordinal,device_id,serial_number,org_unit_path,
    observed_value,observed_at,disposition,exclusion_reason)
  SELECT preview.preview_id,t.ordinal,t.device_id,t.serial_number,t.org_unit_path,t.observed_value,
    t.observed_at,t.disposition,t.exclusion_reason
  FROM jsonb_to_recordset(p_targets) AS t(ordinal integer,device_id text,serial_number text,
    org_unit_path text,observed_value text,observed_at timestamptz,disposition text,exclusion_reason text)
  ORDER BY t.ordinal;
  RETURN jsonb_build_object('outcome','created','preview',to_jsonb(preview));
END;
$$;

-- The frozen manifest that confirmation stores before it creates a job (section 5.9).
CREATE FUNCTION cc.read_device_update_preview_manifest(p_actor uuid,p_version integer,p_customer text,
  p_preview uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE preview cc.device_update_previews; targets jsonb;
BEGIN
  IF p_actor IS NULL OR p_version IS NULL OR p_customer IS NULL OR p_preview IS NULL THEN
    RAISE EXCEPTION 'The preview manifest request is invalid.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO preview FROM cc.device_update_previews p WHERE p.preview_id=p_preview;
  -- Another person receives the same answer as a missing preview.
  IF preview.preview_id IS NULL OR preview.created_by<>p_actor OR preview.customer_id<>p_customer THEN
    RETURN jsonb_build_object('outcome','not-found');
  END IF;
  -- R1-F1 and R1-F3 (round 3): current authority and the frozen versions come before the existing
  -- receipt and before any manifest is stored. A changed permission version or action version stores
  -- no artifact and creates no job.
  IF NOT EXISTS(SELECT 1 FROM cc.application_principals p
      WHERE p.id=p_actor AND p.enabled AND p.permission_version=p_version) OR
    NOT cc.write_capable(p_actor,p_customer,preview.action) OR preview.permission_version<>p_version THEN
    RETURN jsonb_build_object('outcome','permission-changed');
  END IF;
  -- The current action version of this slice is 1. A preview prepared under other semantics never
  -- confirms (section 2.4).
  IF preview.action_version<>1 THEN
    RETURN jsonb_build_object('outcome','preview-changed');
  END IF;
  IF preview.job_id IS NOT NULL THEN
    RETURN jsonb_build_object('outcome','existing','receipt',cc.device_update_receipt(preview.job_id));
  END IF;
  IF preview.expires_at<=clock_timestamp() THEN
    RETURN jsonb_build_object('outcome','preview-expired','expiresAt',preview.expires_at);
  END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.ordinal),'[]'::jsonb) INTO targets
  FROM cc.device_update_preview_targets t WHERE t.preview_id=p_preview;
  RETURN jsonb_build_object('outcome','manifest','manifest',jsonb_build_object('preview',
    jsonb_build_object('previewId',preview.preview_id,'displayId',preview.display_id,
      'customerId',preview.customer_id,'createdBy',preview.created_by,
      'permissionVersion',preview.permission_version,'generation',preview.generation,
      'action',preview.action,'field',preview.field,'mode',preview.mode,'value',preview.value,
      'selected',preview.selected,'eligible',preview.eligible,'unchanged',preview.unchanged,
      'excluded',preview.excluded,'oldestObservedAt',preview.oldest_observed_at,
      'preparedAt',preview.prepared_at,'expiresAt',preview.expires_at,
      'manifestDigest',preview.manifest_digest),
    'targets',targets,'requester',preview.created_by,'confirmer',p_actor));
END;
$$;

-- The confirmation of section 2.4. It revalidates the person, the grants, the expiry, the digest, and
-- the connection, then creates one accepted job with its operations. A repeated call returns the job.
CREATE FUNCTION cc.confirm_device_update_preview(p_actor uuid,p_version integer,p_customer text,
  p_preview uuid,p_digest text,p_artifact text,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE preview cc.device_update_previews; connection cc.google_connection; job cc.jobs;
  subject text; eligible integer; now_at timestamptz; number bigint; artifact cc.artifacts;
  job_kind text; prefix text;
BEGIN
  -- S2: every input holds a value of its domain, or the call rejects before any lock.
  IF p_actor IS NULL OR p_version IS NULL OR p_customer IS NULL OR p_preview IS NULL OR
    p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$' OR p_artifact IS NULL OR
    char_length(p_artifact) NOT BETWEEN 1 AND 256 OR p_correlation IS NULL THEN
    RAISE EXCEPTION 'The confirmation request is invalid.' USING ERRCODE='22023';
  END IF;
  -- Rule G: the connection read below reaches the global access lock. This function takes that lock
  -- first, before any row lock.
  PERFORM pg_advisory_xact_lock(7240173008);
  -- S1: the preview row locks before the connection row. The first confirmation of a preview holds the
  -- row until its commit, so a second confirmation reads the committed job below.
  SELECT * INTO preview FROM cc.device_update_previews p WHERE p.preview_id=p_preview FOR UPDATE;
  IF preview.preview_id IS NULL OR preview.created_by<>p_actor OR preview.customer_id<>p_customer THEN
    RETURN jsonb_build_object('outcome','not-found');
  END IF;
  -- S3: a preview that holds a job never creates another one. R1-F3 (round 3): current authority and
  -- the frozen versions are checked before the existing receipt, so a revoked grant, a disabled
  -- principal, or an obsolete version never receives the receipt of a job it no longer may see.
  IF NOT EXISTS(SELECT 1 FROM cc.application_principals p
      WHERE p.id=p_actor AND p.enabled AND p.permission_version=p_version) OR
    NOT cc.write_capable(p_actor,p_customer,preview.action) OR preview.permission_version<>p_version THEN
    RETURN jsonb_build_object('outcome','permission-changed');
  END IF;
  -- R1-F1 (round 3): the preview's frozen action version must still be current. This slice runs
  -- action version 1.
  IF preview.action_version<>1 THEN
    RETURN jsonb_build_object('outcome','preview-changed');
  END IF;
  IF preview.job_id IS NOT NULL THEN
    RETURN jsonb_build_object('outcome','existing','receipt',cc.device_update_receipt(preview.job_id));
  END IF;
  -- The clock reads after the preview lock. This fast path refuses an already expired preview
  -- without the connection and artifact waits. The clock reads again after those waits.
  IF preview.expires_at<=clock_timestamp() THEN
    RETURN jsonb_build_object('outcome','preview-expired','expiresAt',preview.expires_at);
  END IF;
  IF p_digest<>preview.manifest_digest THEN
    RETURN jsonb_build_object('outcome','preview-changed');
  END IF;
  -- The connection row locks after the preview row, before the job rows. The subject stays inside
  -- this function, so no principal needs connection:read.
  SELECT * INTO connection FROM cc.google_connection c WHERE c.singleton FOR KEY SHARE;
  IF connection.customer_id IS DISTINCT FROM p_customer OR NOT connection.active OR
    connection.generation<>preview.generation THEN
    RETURN jsonb_build_object('outcome','connection-changed');
  END IF;
  SELECT g.delegated_subject INTO subject FROM cc.google_credentials g WHERE g.id=connection.credential_id;
  IF subject IS NULL THEN
    RETURN jsonb_build_object('outcome','connection-changed');
  END IF;
  SELECT count(*)::integer INTO eligible FROM cc.device_update_preview_targets t
  WHERE t.preview_id=p_preview AND t.disposition='eligible';
  IF eligible=0 THEN
    RETURN jsonb_build_object('outcome','nothing-to-update');
  END IF;
  -- R1-F4 (round 3): the manifest must be a published, live artifact. Take the artifact store's
  -- advisory lock before the artifact row, so a concurrent remove cannot delete the file between this
  -- check and the commit that adds the job's reference.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_artifact,0));
  SELECT * INTO artifact FROM cc.artifacts a WHERE a.id=p_artifact FOR UPDATE;
  IF artifact.id IS NULL OR artifact.publication_state<>'ready' OR artifact.active THEN
    RETURN jsonb_build_object('outcome','artifact-missing');
  END IF;
  -- R2-F1 (round 4): the connection and artifact locks above can wait. The clock has no lock, so it
  -- reads again after the last blocking lock and before the first write. A wait that crosses the
  -- expiry leaves no job, no operation, and no artifact reference.
  now_at:=clock_timestamp();
  IF preview.expires_at<=now_at THEN
    RETURN jsonb_build_object('outcome','preview-expired','expiresAt',preview.expires_at);
  END IF;
  -- The action names the header kind, the display prefix, and the number sequence (section 1).
  job_kind:=CASE preview.action WHEN 'annotated-location' THEN 'device-update'
    WHEN 'reboot' THEN 'device-command' ELSE 'device-status' END;
  prefix:=CASE preview.action WHEN 'annotated-location' THEN 'UPD' WHEN 'reboot' THEN 'CMD' ELSE 'STS' END;
  number:=CASE preview.action WHEN 'annotated-location' THEN nextval('cc.job_number_upd')
    WHEN 'reboot' THEN nextval('cc.job_number_cmd') ELSE nextval('cc.job_number_sts') END;
  INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,status,requested_by,generation,
    target_count,target_org_unit_paths,correlation_id)
  VALUES(gen_random_uuid(),cc.job_display_id(prefix,number),p_customer,job_kind,'devices','accepted',
    p_actor,preview.generation,eligible,
    (SELECT COALESCE(array_agg(DISTINCT t.org_unit_path ORDER BY t.org_unit_path),'{}'::text[])
      FROM cc.device_update_preview_targets t
      WHERE t.preview_id=p_preview AND t.disposition='eligible'),
    p_correlation)
  RETURNING * INTO job;
  INSERT INTO cc.device_update_jobs(job_id,preview_id,action,field,mode,value,confirmed_by,
    confirmer_permission_version,delegated_subject,batch_size,batch_count,manifest_artifact_id)
  VALUES(job.job_id,p_preview,preview.action,preview.field,preview.mode,preview.value,p_actor,p_version,subject,250,
    ceil(eligible/250.0),p_artifact);
  -- An update carries its values in the operation's field rows, so its value columns stay null
  -- (addendum sections 2 and 4). A command and a status change keep the columns.
  INSERT INTO cc.device_update_operations(job_id,operation_number,device_id,serial_number,org_unit_path,
    baseline_value,requested_value,batch,status)
  SELECT job.job_id,(row_number() OVER (ORDER BY t.ordinal))::integer,t.device_id,t.serial_number,
    t.org_unit_path,
    CASE WHEN preview.action='annotated-location' THEN NULL ELSE t.observed_value END,
    CASE preview.action
      WHEN 'disable' THEN 'DISABLED'
      WHEN 'reenable' THEN 'ACTIVE' END,
    ((row_number() OVER (ORDER BY t.ordinal)-1)/250)::integer,'pending'
  FROM cc.device_update_preview_targets t
  WHERE t.preview_id=p_preview AND t.disposition='eligible' ORDER BY t.ordinal;
  -- Until U6, a preview carries one change, so confirm writes one annotatedLocation field row per
  -- operation from the preview columns (design card plan U5).
  INSERT INTO cc.device_update_operation_fields(job_id,operation_number,field,baseline_value,requested_value)
  SELECT o.job_id,o.operation_number,'annotatedLocation',t.observed_value,
    CASE preview.mode WHEN 'clear' THEN NULL ELSE preview.value END
  FROM cc.device_update_operations o
  JOIN cc.device_update_preview_targets t ON t.preview_id=p_preview AND t.device_id=o.device_id
  WHERE o.job_id=job.job_id AND preview.action='annotated-location';
  UPDATE cc.device_update_previews SET job_id=job.job_id WHERE preview_id=p_preview;
  -- The reference keeps the manifest artifact alive for the job. remove() refuses while the count is
  -- above zero. The increment belongs to this transaction, so a rollback releases the reference.
  UPDATE cc.artifacts SET reference_count=reference_count+1,job_id=job.job_id::text
  WHERE id=p_artifact;
  PERFORM cc.record_job_change(job.job_id,true);
  RETURN jsonb_build_object('outcome','created','receipt',cc.device_update_receipt(job.job_id));
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

-- Eng-lead ruling 1: the connected customer for a caller with jobs:read or devices:read.
-- It copies cc.device_reader of 016 and accepts either action.
CREATE FUNCTION cc.job_reader(p_actor uuid,p_version integer) RETURNS cc.google_connection
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection;
BEGIN
  SELECT * INTO connection FROM cc.google_connection WHERE singleton;
  IF NOT EXISTS(SELECT 1 FROM cc.application_principals p
      WHERE p.id=p_actor AND p.enabled AND p.permission_version=p_version) OR
    NOT EXISTS(SELECT 1 FROM cc.application_grants g WHERE g.principal_id=p_actor AND
      g.action IN ('jobs:read','devices:read') AND (
      g.scope='{"kind":"platform"}'::jsonb OR
      (g.scope->>'kind'='district' AND g.scope->>'customerId'=connection.customer_id))) THEN
    RAISE EXCEPTION 'Job read authority is required.' USING ERRCODE='42501';
  END IF;
  RETURN connection;
END;
$$;

-- Eng-lead ruling 2: store the caller's activity seen time and return it. It locks only that row.
CREATE FUNCTION cc.record_job_activity_seen(p_actor uuid,p_version integer) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE seen timestamptz;
BEGIN
  PERFORM cc.job_reader(p_actor,p_version);
  INSERT INTO cc.job_activity_seen(principal_id,seen_at) VALUES(p_actor,clock_timestamp())
    ON CONFLICT(principal_id) DO UPDATE SET seen_at=excluded.seen_at
    RETURNING seen_at INTO seen;
  RETURN seen;
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
  cc.skip_device_update_pending(uuid,text),cc.close_refresh_job(uuid,text),cc.write_capable(uuid,text,text),
  cc.device_update_stop_reason(text,uuid,integer,integer,text),cc.job_failure_known(text),
  cc.admit_device_update_job(text,boolean),cc.record_device_update_start(text,uuid,uuid,text),
  cc.abandon_device_update_start(text,uuid,uuid),cc.recover_device_update_jobs(text),
  cc.claim_device_update_batch(text,uuid,uuid,integer,uuid,text),
  cc.renew_device_update_batch(text,uuid,uuid,integer,uuid),
  cc.release_device_update_batch(text,uuid,uuid,integer,uuid),
  cc.settle_device_update_operations(text,uuid,uuid,uuid,text,jsonb,timestamptz,text,text),
  cc.claim_device_update_verification(text,uuid,jsonb,uuid,integer,integer),
  cc.read_device_update_verification(text,uuid,uuid,jsonb),
  cc.prepare_device_update_finish(text,uuid,uuid,text),cc.finish_device_update_job(text,uuid,uuid,text),
  cc.finalize_device_update_job(text,uuid,text),
  cc.report_device_update_backoff(text,uuid,uuid,integer,uuid,integer),cc.accept_device_update_hold(text),
  cc.clean_device_update_hold(text,uuid),
  cc.purge_jobs(text,integer),cc.device_update_receipt(uuid),
  cc.create_device_update_preview(uuid,integer,text,integer,text,text,text,text,jsonb,integer),
  cc.read_device_update_preview_manifest(uuid,integer,text,uuid),
  cc.confirm_device_update_preview(uuid,integer,text,uuid,text,text,uuid),
  cc.device_command_poll_delay(integer),cc.complete_device_command_job(uuid,timestamptz),
  cc.due_device_command_polls(text),cc.record_device_command_poll_start(text,uuid,uuid,text),
  cc.release_device_command_poll(text,uuid,uuid),
  cc.claim_device_command_polls(text,uuid,uuid,uuid),
  cc.settle_device_command_polls(text,uuid,uuid,uuid,jsonb,timestamptz),
  cc.job_reader(uuid,integer),cc.record_job_activity_seen(uuid,integer) FROM PUBLIC;