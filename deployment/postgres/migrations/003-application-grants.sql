CREATE TABLE cc.application_actions (
  action text PRIMARY KEY,
  scope_kinds text[] NOT NULL
);
INSERT INTO cc.application_actions(action, scope_kinds) VALUES
  ('customer:read', ARRAY['platform','district']),
  ('customer:write', ARRAY['platform','district']),
  ('connection:read', ARRAY['platform','district']),
  ('connection:diagnose', ARRAY['platform','district']),
  ('connection:manage', ARRAY['platform']),
  ('platform-users:read', ARRAY['platform']),
  ('platform-users:invite', ARRAY['platform']),
  ('platform-users:manage', ARRAY['platform']),
  ('schools:read', ARRAY['platform','district','school']),
  ('schools:manage', ARRAY['platform','district']),
  ('security-events:read', ARRAY['platform','district','school']);

CREATE TABLE cc.application_grants (
  principal_id uuid NOT NULL REFERENCES cc.application_principals(id),
  action text NOT NULL REFERENCES cc.application_actions(action),
  scope jsonb NOT NULL CHECK (
    jsonb_typeof(scope) = 'object' AND (
      scope = '{"kind":"platform"}'::jsonb OR (
        scope->>'kind' IN ('district','school') AND
        jsonb_typeof(scope->'customerId') = 'string' AND
        COALESCE(scope->>'customerId', '') ~ '^[A-Za-z0-9_-]{1,128}$' AND (
          (scope->>'kind' = 'district' AND scope - ARRAY['kind','customerId'] = '{}'::jsonb) OR
          (scope->>'kind' = 'school' AND
            jsonb_typeof(scope->'schoolId') = 'string' AND
            COALESCE(scope->>'schoolId', '') ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' AND
            scope - ARRAY['kind','customerId','schoolId'] = '{}'::jsonb)
        )
      )
    ) IS TRUE
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, action, scope)
);

CREATE FUNCTION cc.validate_application_grant() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, cc AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM cc.application_actions
    WHERE action = NEW.action AND NEW.scope->>'kind' = ANY(scope_kinds)
  ) THEN
    RAISE EXCEPTION 'The action does not support this resource scope.';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION cc.validate_application_grant() FROM PUBLIC;
CREATE TRIGGER application_grant_scope BEFORE INSERT OR UPDATE ON cc.application_grants
FOR EACH ROW EXECUTE FUNCTION cc.validate_application_grant();

ALTER TABLE cc.security_events DROP CONSTRAINT security_events_event_check;
ALTER TABLE cc.security_events ADD CONSTRAINT security_events_event_check CHECK (event IN (
  'login-started','login-succeeded','login-denied','logout','access-denied',
  'session-expired','access-granted','access-revoked','identity-replaced',
  'diagnostic-started','diagnostic-passed','diagnostic-failed','preferences-changed',
  'platform-administrator-confirmed','grants-changed','principal-disabled','principal-enabled',
  'invitation-created','invitation-redeemed','invitation-confirmed','invitation-revoked','invitation-expired',
  'customer-confirmed','customer-settings-changed','connection-authorized','connection-replaced',
  'connection-revoked','connection-checked','credential-key-rotated','school-scope-changed','recovery-required'
));
ALTER TABLE cc.security_events ADD COLUMN target_id uuid;
ALTER TABLE cc.security_events ADD COLUMN resource_scope jsonb;
