-- User inventory keeps one row per Google user with the time of its last Google read.
-- A full sync enumerates the inventory under a lease. An entity sync refreshes a list of users in batches.
-- Nothing is deleted. removed_at marks a user that Google no longer returns.
-- The category cache holds one row per Google schema. Each schemas.list read replaces the whole set.
INSERT INTO cc.application_actions(action,scope_kinds) VALUES('users:read',ARRAY['platform','district']);

-- It copies cc.device_sync_state without telemetry: the lease, the last enumeration, the count, and the failure.
CREATE TABLE cc.user_sync_state (
  customer_id text PRIMARY KEY REFERENCES cc.google_connection(customer_id),
  generation integer,
  observed_at timestamptz,
  user_count integer NOT NULL DEFAULT 0 CHECK(user_count>=0),
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
  CHECK((sync_id IS NULL)=(sync_expires_at IS NULL)),
  CHECK((failure IS NULL)=(failure_requested_by IS NULL))
);

CREATE TABLE cc.users (
  customer_id text NOT NULL REFERENCES cc.google_connection(customer_id),
  user_id text NOT NULL CHECK(length(user_id) BETWEEN 1 AND 128),
  primary_email text NOT NULL CHECK(length(primary_email) BETWEEN 3 AND 254),
  org_unit_path text NOT NULL CHECK(left(org_unit_path,1)='/' AND length(org_unit_path)<=4096),
  given_name text CHECK(length(given_name)<=256),
  family_name text CHECK(length(family_name)<=256),
  full_name text CHECK(length(full_name)<=4096),
  suspended boolean NOT NULL,
  suspension_reason text CHECK(length(suspension_reason)<=4096),
  archived boolean NOT NULL,
  -- The last sign-in time stays null for a user that never signed in.
  last_login_time timestamptz,
  creation_time timestamptz,
  two_step_enrolled boolean NOT NULL,
  department text CHECK(length(department)<=4096),
  title text CHECK(length(title)<=4096),
  aliases jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK(jsonb_typeof(aliases)='array' AND jsonb_array_length(aliases)<=1000),
  -- The raw customSchemas object of the user, stored and served unchanged.
  custom_schemas jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(custom_schemas)='object'),
  last_entity_sync timestamptz NOT NULL,
  removed_at timestamptz,
  -- Raises by one when any other column changes. See the trigger below.
  record_version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY(customer_id,user_id)
);
CREATE INDEX users_name ON cc.users(customer_id,full_name,user_id);
CREATE INDEX users_email ON cc.users(customer_id,primary_email,user_id);
CREATE INDEX users_org_unit ON cc.users(customer_id,org_unit_path text_pattern_ops);
CREATE INDEX users_last_login ON cc.users(customer_id,last_login_time,user_id);
CREATE INDEX users_freshness ON cc.users(customer_id,last_entity_sync);
-- The attribute equality and has-a-value filters read the raw values of one customer.
CREATE INDEX users_custom_schemas ON cc.users USING gin(custom_schemas jsonb_path_ops);

-- Every writer raises the record version. An update that changes no other column keeps it.
-- The trigger takes no lock: it reads the row values that the update already holds.
CREATE FUNCTION cc.bump_user_record_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
BEGIN
  NEW.record_version:=CASE
    WHEN (to_jsonb(NEW)-'record_version') IS DISTINCT FROM (to_jsonb(OLD)-'record_version')
      THEN OLD.record_version+1
    ELSE OLD.record_version END;
  RETURN NEW;
END;
$$;
CREATE TRIGGER users_record_version BEFORE UPDATE ON cc.users
FOR EACH ROW EXECUTE FUNCTION cc.bump_user_record_version();

-- One cached Google schema (document B section 9). A category that Google no longer lists leaves the
-- cache. The fields array holds the SchemaFieldSpec answers of the category, unchanged.
CREATE TABLE cc.user_attribute_categories (
  customer_id text NOT NULL REFERENCES cc.google_connection(customer_id),
  schema_id text NOT NULL CHECK(length(schema_id) BETWEEN 1 AND 200),
  schema_name text NOT NULL CHECK(schema_name ~ '^[A-Za-z0-9_-]{1,200}$'),
  display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 200),
  etag text CHECK(etag IS NULL OR length(etag) BETWEEN 1 AND 200),
  fields jsonb NOT NULL CHECK(jsonb_typeof(fields)='array' AND jsonb_array_length(fields) BETWEEN 1 AND 100),
  read_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(customer_id,schema_id)
);
-- Google holds the schema name unique in the customer, and a call may name the category by its name.
CREATE UNIQUE INDEX user_attribute_categories_name ON cc.user_attribute_categories(customer_id,schema_name);
CREATE INDEX user_attribute_categories_read ON cc.user_attribute_categories(customer_id,read_at);

-- A refresh job of either entity type shares cc.entity_sync_jobs. Entity type user joins device.
ALTER TABLE cc.entity_sync_jobs DROP CONSTRAINT entity_sync_jobs_entity_type_check;
ALTER TABLE cc.entity_sync_jobs ADD CONSTRAINT entity_sync_jobs_entity_type_check
  CHECK(entity_type IN ('device','user'));

-- The read gate of one entity type. A device refresh needs devices:read and a user refresh needs
-- users:read (document A section 8). The message of a device refusal stays as 016 answers it.
CREATE FUNCTION cc.entity_job_reader(p_actor uuid,p_version integer,p_type text) RETURNS cc.google_connection
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection; required text;
BEGIN
  required:=CASE p_type WHEN 'device' THEN 'devices:read' WHEN 'user' THEN 'users:read' END;
  IF required IS NULL THEN
    RAISE EXCEPTION 'The entity type is invalid.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO connection FROM cc.google_connection WHERE singleton;
  IF NOT EXISTS(SELECT 1 FROM cc.application_principals p
      WHERE p.id=p_actor AND p.enabled AND p.permission_version=p_version) OR
    NOT EXISTS(SELECT 1 FROM cc.application_grants g WHERE g.principal_id=p_actor AND g.action=required AND (
      g.scope='{"kind":"platform"}'::jsonb OR
      (g.scope->>'kind'='district' AND g.scope->>'customerId'=connection.customer_id))) THEN
    RAISE EXCEPTION '%',CASE p_type WHEN 'user' THEN 'User read authority is required.'
      ELSE 'Device read authority is required.' END USING ERRCODE='42501';
  END IF;
  RETURN connection;
END;
$$;

-- The refresh job of either entity type. It repeats 016 cc.create_entity_sync_job with the typed read
-- gate (document A section 8). An explicit ID list keeps the header scope of an entity list.
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

-- It repeats 016 cc.abandon_entity_sync_job with the typed read gate of the job entity type (document A
-- section 8). A missing job falls back to the device gate, and the fence below answers it.
CREATE OR REPLACE FUNCTION cc.abandon_entity_sync_job(p_actor uuid,p_version integer,p_customer text,p_job uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE header record; job cc.entity_sync_jobs; now_at timestamptz;
BEGIN
  PERFORM cc.entity_job_reader(p_actor,p_version,COALESCE((SELECT u.entity_type FROM cc.entity_sync_jobs u
    WHERE u.job_id=p_job AND u.customer_id=p_customer),'device'));
  -- S2: a null identifier never matches a header.
  IF p_customer IS NULL OR p_job IS NULL THEN
    RAISE EXCEPTION 'The job changed.' USING DETAIL='entity-sync-changed';
  END IF;
  -- S1: the job header locks before the detail row and before the clock. A header waiter holds no detail lock.
  -- The header type stays dynamic here, because this file runs after 017 creates cc.jobs.
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

REVOKE ALL ON cc.user_sync_state,cc.users,cc.user_attribute_categories FROM PUBLIC;
REVOKE ALL ON FUNCTION cc.entity_job_reader(uuid,integer,text),cc.bump_user_record_version() FROM PUBLIC;