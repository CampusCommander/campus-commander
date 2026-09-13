CREATE TABLE cc.application_principals (
  id uuid PRIMARY KEY,
  issuer text NOT NULL,
  subject text NOT NULL,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  enabled boolean NOT NULL DEFAULT true,
  permission_version integer NOT NULL DEFAULT 1 CHECK (permission_version > 0),
  permissions text[] NOT NULL DEFAULT ARRAY['identity:read']::text[]
    CHECK (permissions <@ ARRAY['identity:read','diagnostics:read','diagnostics:run']::text[]),
  preferences jsonb NOT NULL DEFAULT '{"theme":"system","navigationCollapsed":false}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject)
);

CREATE TABLE cc.security_events (
  id uuid PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid REFERENCES cc.application_principals(id),
  event text NOT NULL CHECK (event IN (
    'login-started','login-succeeded','login-denied','logout','access-denied',
    'session-expired','access-granted','access-revoked','identity-replaced',
    'diagnostic-started','diagnostic-passed','diagnostic-failed','preferences-changed'
  )),
  correlation_id uuid NOT NULL,
  detail text CHECK (detail IS NULL OR length(detail) <= 100)
);
CREATE INDEX security_events_time ON cc.security_events (occurred_at);
CREATE INDEX security_events_correlation ON cc.security_events (correlation_id);
