-- K14: category change plans, the `user-schema-change` job kind, and `users:schema-manage`.
-- Document B sections 6, 7, 10, and 11. One plan freezes one Google category call. A confirmed
-- plan gives one category job. That job shares the one write slot of the device jobs (E8).
-- The plan routes (K15) and the category worker (K16) build the behavior over these rows.

-- The domain-wide schema permission of document B section 11. Bootstrap confirms a platform
-- administrator by granting every row of cc.application_actions at the platform scope.
INSERT INTO cc.application_actions(action,scope_kinds) VALUES('users:schema-manage',ARRAY['platform','district']);

-- The display IDs of a category job. The number carries at least three digits, as every job does.
CREATE SEQUENCE cc.job_number_cat;

-- The category job kind joins the header vocabulary, the display ID rule, and the write slot.
ALTER TABLE cc.jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE cc.jobs ADD CONSTRAINT jobs_kind_check CHECK(kind IN ('inventory-refresh','device-update',
  'device-command','device-status','device-export','device-import','user-schema-change'));
ALTER TABLE cc.jobs DROP CONSTRAINT jobs_display_id_check;
ALTER TABLE cc.jobs ADD CONSTRAINT jobs_display_id_check
  CHECK(display_id ~ '^(UPD|REF|CMD|STS|EXP|IMP|CAT)-[0-9]{3,}$');
-- A running category job holds the write slot of the device jobs, so the two kinds never call the
-- Directory schema write together (E8).
DROP INDEX cc.jobs_one_running;
CREATE UNIQUE INDEX jobs_one_running ON cc.jobs(customer_id)
  WHERE kind IN ('device-update','device-command','device-status','user-schema-change') AND status='running';

-- One category change plan: the frozen editor save of document B section 6.1. It holds the body
-- that the worker sends, the base `etag` that it compares first, and the plan answer of section 10.
-- A create names no cached category, because Google assigns the `schemaId` on insert. A `schemaId`
-- stays an opaque string (C8), so no column checks its characters.
CREATE TABLE cc.user_category_plans (
  plan_id uuid PRIMARY KEY,
  customer_id text NOT NULL REFERENCES cc.google_connection(customer_id),
  created_by uuid NOT NULL REFERENCES cc.application_principals(id),
  permission_version integer NOT NULL CHECK(permission_version>=1),
  generation integer NOT NULL,
  action text NOT NULL CHECK(action IN ('create-category','edit-category','delete-category')),
  schema_id text CHECK(schema_id IS NULL OR length(schema_id) BETWEEN 1 AND 200),
  schema_name text NOT NULL CHECK(schema_name ~ '^[A-Za-z0-9_-]{1,200}$'),
  base_etag text CHECK(base_etag IS NULL OR length(base_etag) BETWEEN 1 AND 200),
  -- The body of `schemas.insert` or `schemas.update`. A delete sends none.
  body jsonb CHECK(body IS NULL OR jsonb_typeof(body)='object'),
  -- Each attribute change, the removed attributes with their holder counts, and the two limit
  -- counts after the save (document B section 10).
  changes jsonb NOT NULL CHECK(jsonb_typeof(changes)='array' AND jsonb_array_length(changes)<=200),
  limits jsonb NOT NULL CHECK(jsonb_typeof(limits)='object'),
  -- The phrase that the person types: an attribute name, or the category display name on a delete.
  phrase text CHECK(phrase IS NULL OR length(phrase) BETWEEN 1 AND 200),
  digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
  prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  CHECK((action='create-category')=(schema_id IS NULL)),
  CHECK((action='create-category')=(base_etag IS NULL)),
  CHECK((action='delete-category')=(body IS NULL)),
  CHECK(expires_at>prepared_at),
  CHECK(confirmed_at IS NULL OR confirmed_at>=prepared_at)
);
-- A plan is read by its creator, and an open plan lapses 15 minutes after it was prepared.
CREATE INDEX user_category_plans_expiry ON cc.user_category_plans(expires_at)
  WHERE confirmed_at IS NULL;

-- One category job of the header kind `user-schema-change`. The plan owns the action, and the row
-- keeps the confirmer that the worker revalidates (document B section 6.2 step 1). The job stores
-- `scope_kind` `devices` with `target_count` 1, because one plan is one operation.
CREATE TABLE cc.user_schema_change_jobs (
  job_id uuid PRIMARY KEY REFERENCES cc.jobs(job_id) ON DELETE CASCADE,
  plan_id uuid NOT NULL UNIQUE REFERENCES cc.user_category_plans(plan_id),
  confirmed_by uuid NOT NULL REFERENCES cc.application_principals(id),
  confirmer_permission_version integer NOT NULL CHECK(confirmer_permission_version>=1)
);

REVOKE ALL ON cc.user_category_plans, cc.user_schema_change_jobs FROM PUBLIC;