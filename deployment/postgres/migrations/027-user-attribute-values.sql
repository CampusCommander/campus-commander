-- K22: value preview storage, the `user-attribute-update` job kind, and the two value actions.
-- Document B sections 7.2, 8, 10, and 11. One preview freezes the final value of each user and
-- attribute. A confirmed preview gives one value job. That job shares the one write slot of the
-- device and category jobs (E8). The preview routes (K23) and the value worker (K24) build the
-- behavior over these rows.

-- The two value permissions of document B section 11. Bootstrap confirms a platform administrator
-- by granting every row of cc.application_actions at the platform scope.
INSERT INTO cc.application_actions(action,scope_kinds) VALUES('users:write',ARRAY['platform','district']),
  ('users:bulk-actions',ARRAY['platform','district']);

-- The display IDs of a value job. The number carries at least three digits, as every job does.
CREATE SEQUENCE cc.job_number_uat;

-- The value job kind joins the header vocabulary, the display ID rule, and the write slot.
ALTER TABLE cc.jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE cc.jobs ADD CONSTRAINT jobs_kind_check CHECK(kind IN ('inventory-refresh','device-update',
  'device-command','device-status','device-export','device-import','user-schema-change',
  'user-attribute-update'));
ALTER TABLE cc.jobs DROP CONSTRAINT jobs_display_id_check;
ALTER TABLE cc.jobs ADD CONSTRAINT jobs_display_id_check
  CHECK(display_id ~ '^(UPD|REF|CMD|STS|EXP|IMP|CAT|UAT)-[0-9]{3,}$');
-- A running value job holds the write slot of the device and category jobs, so the Directory write
-- calls never overlap (E8).
DROP INDEX cc.jobs_one_running;
CREATE UNIQUE INDEX jobs_one_running ON cc.jobs(customer_id)
  WHERE kind IN ('device-update','device-command','device-status','user-schema-change',
    'user-attribute-update') AND status='running';

-- One value preview: the frozen final value of each user and attribute (B sections 8.4 and 10). A
-- selection reads the cached values, and an edit list carries a baseline for each edit. The digest
-- stays null while the preview holds pages, and the seal writes it (B section 10).
CREATE TABLE cc.user_attribute_previews (
  preview_id uuid PRIMARY KEY,
  customer_id text NOT NULL REFERENCES cc.google_connection(customer_id),
  created_by uuid NOT NULL REFERENCES cc.application_principals(id),
  permission_version integer NOT NULL CHECK(permission_version>=1),
  generation integer NOT NULL,
  source text NOT NULL CHECK(source IN ('selection','edit-list')),
  -- The frozen grid and tab of a selection (B section 10). An edit list names neither.
  selection jsonb CHECK(selection IS NULL OR jsonb_typeof(selection)='object'),
  selected integer NOT NULL CHECK(selected>=0),
  eligible integer NOT NULL CHECK(eligible>=0),
  unchanged integer NOT NULL CHECK(unchanged>=0),
  conflicts integer NOT NULL DEFAULT 0 CHECK(conflicts>=0),
  -- The number of eligible user-attribute rows that the confirm writes.
  attribute_changes integer NOT NULL DEFAULT 0 CHECK(attribute_changes>=0),
  oldest_observed_at timestamptz,
  manifest_digest text CHECK(manifest_digest IS NULL OR length(manifest_digest) BETWEEN 1 AND 256),
  prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CHECK((source='selection')=(selection IS NOT NULL)),
  -- The three dispositions of B section 8.4 cover every frozen user.
  CHECK(selected=eligible+unchanged+conflicts),
  CHECK(expires_at>prepared_at)
);

-- One attribute change of one preview (B sections 8.3 and 10). A clear carries no value, every other
-- mode carries one or more values, and Set value carries one.
CREATE TABLE cc.user_attribute_preview_changes (
  preview_id uuid NOT NULL REFERENCES cc.user_attribute_previews(preview_id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK(ordinal>=0),
  schema_name text NOT NULL CHECK(schema_name ~ '^[A-Za-z0-9_-]{1,200}$'),
  field_name text NOT NULL CHECK(field_name ~ '^[A-Za-z0-9_-]{1,200}$'),
  mode text NOT NULL CHECK(mode IN ('set','clear','add','remove','replace')),
  -- The entered values, in order. A list holds at most 150 entries (B section 3).
  values jsonb NOT NULL CHECK(jsonb_typeof(values)='array' AND jsonb_array_length(values)<=150),
  PRIMARY KEY(preview_id,ordinal),
  UNIQUE(preview_id,schema_name,field_name),
  CHECK((mode='clear')=(jsonb_array_length(values)=0)),
  CHECK(mode<>'set' OR jsonb_array_length(values)=1)
);

-- One frozen user of one preview (B sections 8.4 and 10). Its value rows decide the disposition, and
-- the column repeats it for the routes. A preview reads the cached values, so each row names its
-- observation time.
CREATE TABLE cc.user_attribute_preview_targets (
  preview_id uuid NOT NULL REFERENCES cc.user_attribute_previews(preview_id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK(ordinal>=0),
  user_id text NOT NULL CHECK(length(user_id) BETWEEN 1 AND 128),
  primary_email text NOT NULL CHECK(length(primary_email) BETWEEN 3 AND 254),
  disposition text NOT NULL CHECK(disposition IN ('eligible','unchanged','conflict')),
  observed_at timestamptz,
  PRIMARY KEY(preview_id,ordinal),
  UNIQUE(preview_id,user_id)
);

-- One frozen user and attribute of one preview (B section 8.4). `current_value` is the value that
-- the preview read (C), and `requested_value` is the final value that confirmation writes (R). Both
-- keep the Google form: a scalar, or a list of `{value,type?,customType?}` entries, so an existing
-- entry keeps its two keys (B section 8.2). A SQL null means no value, and a clear stores it.
CREATE TABLE cc.user_attribute_target_values (
  preview_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK(ordinal>=0),
  schema_name text NOT NULL CHECK(schema_name ~ '^[A-Za-z0-9_-]{1,200}$'),
  field_name text NOT NULL CHECK(field_name ~ '^[A-Za-z0-9_-]{1,200}$'),
  current_value jsonb,
  requested_value jsonb,
  disposition text NOT NULL CHECK(disposition IN ('eligible','unchanged','conflict')),
  PRIMARY KEY(preview_id,ordinal,schema_name,field_name),
  FOREIGN KEY(preview_id,ordinal)
    REFERENCES cc.user_attribute_preview_targets(preview_id,ordinal) ON DELETE CASCADE,
  CHECK(current_value IS NULL OR jsonb_typeof(current_value)<>'null'),
  CHECK(requested_value IS NULL OR jsonb_typeof(requested_value)<>'null')
);

-- One value job of the header kind `user-attribute-update`. The preview owns the frozen changes, and
-- the row keeps the confirmer that the worker revalidates. The header stores `scope_kind` `devices`
-- with the eligible user count, because the jobs grid reads a device scope for every job, and the
-- `entity_type` `user`, because the change touches users. One operation runs for each eligible user
-- (B section 7.2).
CREATE TABLE cc.user_attribute_update_jobs (
  job_id uuid PRIMARY KEY REFERENCES cc.jobs(job_id) ON DELETE CASCADE,
  preview_id uuid NOT NULL UNIQUE REFERENCES cc.user_attribute_previews(preview_id),
  confirmed_by uuid NOT NULL REFERENCES cc.application_principals(id),
  confirmer_permission_version integer NOT NULL CHECK(confirmer_permission_version>=1)
);

REVOKE ALL ON cc.user_attribute_previews, cc.user_attribute_preview_changes,
  cc.user_attribute_preview_targets, cc.user_attribute_target_values,
  cc.user_attribute_update_jobs FROM PUBLIC;