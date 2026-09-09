CREATE TABLE cc.artifacts (
  id text PRIMARY KEY,
  backend text NOT NULL,
  locator text NOT NULL UNIQUE,
  sha256 text CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes bigint CHECK (size_bytes >= 0),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  job_id text,
  attempt_id text NOT NULL,
  retention_until timestamptz,
  publication_state text NOT NULL DEFAULT 'staging'
    CHECK (publication_state IN ('staging', 'ready', 'deleting', 'corrupt')),
  active boolean NOT NULL DEFAULT true,
  reference_count integer NOT NULL DEFAULT 0 CHECK (reference_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (publication_state <> 'ready' OR (sha256 IS NOT NULL AND size_bytes IS NOT NULL)),
  CHECK (publication_state <> 'deleting' OR (NOT active AND reference_count = 0))
);

CREATE TABLE cc.bootstrap_access (
  id integer PRIMARY KEY CHECK (id = 1),
  generation bigint NOT NULL,
  credential_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
