ALTER TABLE cc.security_events DROP CONSTRAINT security_events_event_check;
ALTER TABLE cc.security_events ADD CONSTRAINT security_events_event_check CHECK (event IN (
  'login-started','login-succeeded','login-denied','logout','access-denied',
  'session-expired','access-granted','access-revoked','identity-replaced',
  'diagnostic-started','diagnostic-passed','diagnostic-failed','preferences-changed',
  'platform-administrator-confirmed','grants-changed','principal-disabled','principal-enabled',
  'invitation-created','invitation-redeemed','invitation-confirmed','invitation-revoked','invitation-expired',
  'customer-confirmed','customer-settings-changed','connection-authorized','connection-replaced',
  'connection-staged','connection-stage-failed','connection-stage-expired',
  'connection-revoked','connection-checked','credential-key-rotated','school-scope-changed','recovery-required'
));

CREATE FUNCTION cc.google_envelope_valid(p_value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT COALESCE(jsonb_typeof(p_value)='object' AND
    p_value-ARRAY['format','keyId','iv','tag','ciphertext']='{}'::jsonb AND
    p_value->'format'='1'::jsonb AND
    jsonb_typeof(p_value->'keyId')='string' AND p_value->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' AND
    jsonb_typeof(p_value->'iv')='string' AND p_value->>'iv' ~ '^[A-Za-z0-9_-]{16}$' AND
    jsonb_typeof(p_value->'tag')='string' AND p_value->>'tag' ~ '^[A-Za-z0-9_-]{22}$' AND
    jsonb_typeof(p_value->'ciphertext')='string' AND length(p_value->>'ciphertext') BETWEEN 1 AND 32768 AND
    p_value->>'ciphertext' ~ '^[A-Za-z0-9_-]+$',false);
$$;

CREATE FUNCTION cc.google_observation_valid(p_value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE domain jsonb; alias jsonb; primary_count integer:=0;
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value)<>'object' OR
    p_value-ARRAY['customerId','primaryDomain','domains']<>'{}'::jsonb OR
    jsonb_typeof(p_value->'customerId') IS DISTINCT FROM 'string' OR
    (p_value->>'customerId' ~ '^C[A-Za-z0-9]{4,31}$') IS DISTINCT FROM true OR
    jsonb_typeof(p_value->'primaryDomain') IS DISTINCT FROM 'string' OR
    length(p_value->>'primaryDomain') NOT BETWEEN 1 AND 253 OR
    jsonb_typeof(p_value->'domains') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(p_value->'domains') NOT BETWEEN 1 AND 1000 THEN RETURN false; END IF;
  FOR domain IN SELECT * FROM jsonb_array_elements(p_value->'domains') LOOP
    IF jsonb_typeof(domain)<>'object' OR domain-ARRAY['name','primary','verified','aliases']<>'{}'::jsonb OR
      jsonb_typeof(domain->'name') IS DISTINCT FROM 'string' OR
      length(domain->>'name') NOT BETWEEN 1 AND 253 OR
      (domain->>'name' ~ '^[a-z0-9][a-z0-9.-]*[a-z0-9]$') IS DISTINCT FROM true OR
      jsonb_typeof(domain->'primary') IS DISTINCT FROM 'boolean' OR
      jsonb_typeof(domain->'verified') IS DISTINCT FROM 'boolean' OR
      jsonb_typeof(domain->'aliases') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(domain->'aliases')>1000 THEN RETURN false; END IF;
    IF domain->'primary'='true'::jsonb THEN
      primary_count:=primary_count+1;
      IF domain->>'name'<>p_value->>'primaryDomain' THEN RETURN false; END IF;
    END IF;
    FOR alias IN SELECT * FROM jsonb_array_elements(domain->'aliases') LOOP
      IF jsonb_typeof(alias)<>'object' OR alias-ARRAY['name','verified']<>'{}'::jsonb OR
        jsonb_typeof(alias->'name') IS DISTINCT FROM 'string' OR length(alias->>'name') NOT BETWEEN 1 AND 253 OR
        (alias->>'name' ~ '^[a-z0-9][a-z0-9.-]*[a-z0-9]$') IS DISTINCT FROM true OR
        jsonb_typeof(alias->'verified') IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
    END LOOP;
  END LOOP;
  RETURN primary_count=1;
END;
$$;

CREATE TABLE cc.google_credential_candidates (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES cc.application_principals(id),
  actor_version integer NOT NULL CHECK(actor_version>0),
  browser_hash text NOT NULL CHECK(browser_hash ~ '^[a-f0-9]{64}$'),
  client_id text NOT NULL CHECK(client_id ~ '^[0-9]{1,32}$'),
  delegated_subject text NOT NULL CHECK(length(delegated_subject) BETWEEN 3 AND 254),
  status text NOT NULL CHECK(status IN ('verifying','ready','failed','expired','consumed')),
  envelope jsonb CHECK(envelope IS NULL OR cc.google_envelope_valid(envelope)),
  observation jsonb CHECK(observation IS NULL OR cc.google_observation_valid(observation)),
  failure text CHECK(failure IN ('credential-rejected','scope-mismatch','permission-denied','quota','provider-unavailable','invalid-response','wrong-customer','request-failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',
  observed_at timestamptz,
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '10 minutes'),
  CHECK((status IN ('verifying','ready'))=(envelope IS NOT NULL)),
  CHECK(status<>'ready' OR (observation IS NOT NULL AND observed_at IS NOT NULL)),
  CHECK(status<>'failed' OR failure IS NOT NULL)
);
CREATE INDEX google_candidate_expiry ON cc.google_credential_candidates(expires_at) WHERE status IN ('verifying','ready');

CREATE INDEX google_candidate_terminal_expiry ON cc.google_credential_candidates(expires_at,id) WHERE status IN ('expired','failed','consumed');
CREATE INDEX google_candidate_created ON cc.google_credential_candidates(created_at);
CREATE INDEX google_candidate_actor_created ON cc.google_credential_candidates(actor_id,created_at);

CREATE TABLE cc.google_credentials (
  id uuid PRIMARY KEY,
  generation integer NOT NULL UNIQUE CHECK(generation>0),
  customer_id text NOT NULL CHECK(customer_id ~ '^C[A-Za-z0-9]{4,31}$'),
  envelope jsonb NOT NULL CHECK(cc.google_envelope_valid(envelope)),
  client_id text NOT NULL CHECK(client_id ~ '^[0-9]{1,32}$'),
  delegated_subject text NOT NULL CHECK(length(delegated_subject) BETWEEN 3 AND 254),
  activated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,generation,customer_id)
);
CREATE TABLE cc.google_connection (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  customer_id text NOT NULL UNIQUE,
  credential_id uuid NOT NULL,
  generation integer NOT NULL,
  observation jsonb NOT NULL CHECK(cc.google_observation_valid(observation)),
  observed_at timestamptz NOT NULL,
  confirmed_by uuid NOT NULL REFERENCES cc.application_principals(id),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  CHECK(customer_id=observation->>'customerId'),
  FOREIGN KEY(credential_id,generation,customer_id) REFERENCES cc.google_credentials(id,generation,customer_id)
);

CREATE FUNCTION cc.google_connection_actor(p_actor uuid,p_version integer,p_action text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE actor cc.application_principals;
BEGIN
  PERFORM pg_advisory_xact_lock(7240173008);
  SELECT * INTO actor FROM cc.application_principals WHERE id=p_actor FOR UPDATE;
  IF actor.id IS NULL OR p_version IS NULL OR NOT actor.enabled OR actor.permission_version<>p_version OR NOT EXISTS(
    SELECT 1 FROM cc.application_grants g WHERE g.principal_id=p_actor AND g.action=p_action AND (
      g.scope='{"kind":"platform"}'::jsonb OR (g.scope->>'kind'='district' AND EXISTS(
        SELECT 1 FROM cc.google_connection c WHERE c.customer_id=g.scope->>'customerId'))
    )
  ) THEN RAISE EXCEPTION 'Current connection authority is required.' USING ERRCODE='42501'; END IF;
END;
$$;

CREATE FUNCTION cc.expire_google_candidates(p_correlation uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE candidate_id uuid; expired integer:=0; cutoff timestamptz;
BEGIN
  IF p_correlation IS NULL THEN RAISE EXCEPTION 'Correlation is required.'; END IF;
  PERFORM pg_advisory_xact_lock(7240173008);
  cutoff:=clock_timestamp();
  FOR candidate_id IN UPDATE cc.google_credential_candidates SET status='expired',envelope=NULL
    WHERE status IN ('verifying','ready') AND expires_at<=cutoff RETURNING id
  LOOP
    expired:=expired+1;
    INSERT INTO cc.security_events(id,event,correlation_id,target_id,resource_scope)
      VALUES(gen_random_uuid(),'connection-stage-expired',p_correlation,candidate_id,'{"kind":"platform"}');
  END LOOP;
  DELETE FROM cc.google_credential_candidates WHERE id IN (
    SELECT id FROM cc.google_credential_candidates
    WHERE expires_at<cutoff-interval '1 day' AND status IN ('expired','failed','consumed')
    ORDER BY expires_at,id LIMIT 500
  );
  RETURN expired;
END;
$$;

CREATE FUNCTION cc.stage_google_credential(p_actor uuid,p_version integer,p_id uuid,p_browser_hash text,
  p_client_id text,p_subject text,p_envelope jsonb,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE expiry timestamptz; created timestamptz;
BEGIN
  PERFORM cc.google_connection_actor(p_actor,p_version,'connection:manage');
  PERFORM cc.expire_google_candidates(p_correlation);
  IF EXISTS(SELECT 1 FROM cc.google_connection) THEN RAISE EXCEPTION 'The customer is already connected.' USING DETAIL='already-connected'; END IF;
  IF (SELECT count(*) FROM cc.google_credential_candidates WHERE status IN ('verifying','ready'))>=20 OR
    (SELECT count(*) FROM cc.google_credential_candidates WHERE actor_id=p_actor AND status IN ('verifying','ready'))>=3 THEN
    RAISE EXCEPTION 'Wait for an existing credential check to expire.' USING DETAIL='busy';
  END IF;
  created:=clock_timestamp();
  IF (SELECT count(*) FROM cc.google_credential_candidates WHERE created_at>created-interval '10 minutes')>=100 OR
    (SELECT count(*) FROM cc.google_credential_candidates WHERE actor_id=p_actor AND created_at>created-interval '10 minutes')>=10 THEN
    RAISE EXCEPTION 'Wait before starting another credential check.' USING DETAIL='busy';
  END IF;
  INSERT INTO cc.google_credential_candidates(id,actor_id,actor_version,browser_hash,client_id,delegated_subject,status,envelope,created_at,expires_at)
    VALUES(p_id,p_actor,p_version,p_browser_hash,p_client_id,p_subject,'verifying',p_envelope,created,created+interval '10 minutes') RETURNING expires_at INTO expiry;
  INSERT INTO cc.security_events(id,actor_id,event,correlation_id,target_id,resource_scope)
    VALUES(gen_random_uuid(),p_actor,'connection-staged',p_correlation,p_id,'{"kind":"platform"}');
  RETURN jsonb_build_object('id',p_id,'status','verifying','expiresAt',expiry);
END;
$$;

CREATE FUNCTION cc.google_candidate_for_actor(p_actor uuid,p_version integer,p_id uuid,p_browser_hash text) RETURNS cc.google_credential_candidates
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE candidate cc.google_credential_candidates;
BEGIN
  PERFORM cc.google_connection_actor(p_actor,p_version,'connection:manage');
  SELECT * INTO candidate FROM cc.google_credential_candidates WHERE id=p_id FOR UPDATE;
  IF candidate.id IS NULL OR candidate.actor_id<>p_actor OR candidate.actor_version<>p_version OR
    p_browser_hash IS NULL OR candidate.browser_hash<>p_browser_hash THEN
    RAISE EXCEPTION 'The credential transaction is unavailable.' USING ERRCODE='42501';
  END IF;
  IF candidate.expires_at<=clock_timestamp() OR candidate.status NOT IN ('verifying','ready') THEN
    RAISE EXCEPTION 'The credential transaction expired or changed.' USING DETAIL='candidate-changed';
  END IF;
  RETURN candidate;
END;
$$;

CREATE FUNCTION cc.finish_google_candidate(p_actor uuid,p_version integer,p_id uuid,p_browser_hash text,
  p_observation jsonb,p_failure text,p_correlation uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE candidate cc.google_credential_candidates;
BEGIN
  candidate:=cc.google_candidate_for_actor(p_actor,p_version,p_id,p_browser_hash);
  IF candidate.status<>'verifying' OR (p_observation IS NULL)=(p_failure IS NULL) THEN
    RAISE EXCEPTION 'The credential transaction changed.' USING DETAIL='candidate-changed';
  END IF;
  IF p_failure IS NULL THEN
    UPDATE cc.google_credential_candidates SET status='ready',observation=p_observation,observed_at=now() WHERE id=p_id;
  ELSE
    UPDATE cc.google_credential_candidates SET status='failed',failure=p_failure,envelope=NULL WHERE id=p_id;
  END IF;
  INSERT INTO cc.security_events(id,actor_id,event,correlation_id,target_id,resource_scope,detail)
    VALUES(gen_random_uuid(),p_actor,CASE WHEN p_failure IS NULL THEN 'connection-checked' ELSE 'connection-stage-failed' END,
      p_correlation,p_id,'{"kind":"platform"}',COALESCE(p_failure,'candidate-ready'));
END;
$$;

CREATE FUNCTION cc.read_google_candidate(p_actor uuid,p_version integer,p_id uuid,p_browser_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE candidate cc.google_credential_candidates;
BEGIN
  PERFORM cc.google_connection_actor(p_actor,p_version,'connection:manage');
  SELECT * INTO candidate FROM cc.google_credential_candidates WHERE id=p_id FOR UPDATE;
  IF candidate.id IS NULL OR candidate.actor_id<>p_actor OR candidate.actor_version<>p_version OR
    p_browser_hash IS NULL OR candidate.browser_hash<>p_browser_hash THEN
    RAISE EXCEPTION 'The credential transaction is unavailable.' USING ERRCODE='42501';
  END IF;
  IF candidate.status IN ('verifying','ready') AND candidate.expires_at<=clock_timestamp() THEN
    candidate.status:='expired';
    candidate.envelope:=NULL;
  END IF;
  RETURN jsonb_build_object('id',candidate.id,'status',candidate.status,'expiresAt',candidate.expires_at,
    'clientId',candidate.client_id,'subject',candidate.delegated_subject,'observation',candidate.observation,
    'observedAt',candidate.observed_at,'failure',candidate.failure,'envelope',candidate.envelope);
END;
$$;

CREATE FUNCTION cc.confirm_google_customer(p_actor uuid,p_version integer,p_id uuid,p_browser_hash text,
  p_customer_id text,p_envelope jsonb,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE candidate cc.google_credential_candidates;
BEGIN
  candidate:=cc.google_candidate_for_actor(p_actor,p_version,p_id,p_browser_hash);
  IF candidate.status<>'ready' OR p_customer_id IS NULL OR candidate.observation->>'customerId'<>p_customer_id THEN
    RAISE EXCEPTION 'Confirm the observed customer identity.' USING DETAIL='candidate-changed';
  END IF;
  IF EXISTS(SELECT 1 FROM cc.google_connection) THEN RAISE EXCEPTION 'The customer is already connected.' USING DETAIL='already-connected'; END IF;
  INSERT INTO cc.google_credentials(id,generation,customer_id,envelope,client_id,delegated_subject)
    VALUES(p_id,1,p_customer_id,p_envelope,candidate.client_id,candidate.delegated_subject);
  INSERT INTO cc.google_connection(customer_id,credential_id,generation,observation,observed_at,confirmed_by)
    VALUES(p_customer_id,p_id,1,candidate.observation,candidate.observed_at,p_actor);
  UPDATE cc.google_credential_candidates SET status='consumed',envelope=NULL WHERE id=p_id;
  INSERT INTO cc.security_events(id,actor_id,event,correlation_id,target_id,resource_scope)
    VALUES(gen_random_uuid(),p_actor,'customer-confirmed',p_correlation,p_id,jsonb_build_object('kind','district','customerId',p_customer_id)),
      (gen_random_uuid(),p_actor,'connection-authorized',p_correlation,p_id,jsonb_build_object('kind','district','customerId',p_customer_id));
  RETURN jsonb_build_object('customerId',p_customer_id,'generation',1,'credentialId',p_id,'confirmedAt',now());
END;
$$;

CREATE FUNCTION cc.read_google_connection(p_actor uuid,p_version integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE result jsonb;
BEGIN
  PERFORM cc.google_connection_actor(p_actor,p_version,'connection:read');
  SELECT jsonb_build_object('customerId',c.customer_id,'generation',c.generation,'observation',c.observation,
    'observedAt',c.observed_at,'confirmedAt',c.confirmed_at,'clientId',g.client_id,'subject',g.delegated_subject)
    INTO result FROM cc.google_connection c JOIN cc.google_credentials g ON g.id=c.credential_id;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION cc.application_scope_verified(p_scope jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT p_scope='{"kind":"platform"}'::jsonb OR (
    p_scope->>'kind'='district' AND p_scope-ARRAY['kind','customerId']='{}'::jsonb AND
    EXISTS(SELECT 1 FROM cc.google_connection WHERE customer_id=p_scope->>'customerId')
  );
$$;

REVOKE ALL ON FUNCTION cc.google_envelope_valid(jsonb),cc.google_observation_valid(jsonb),
  cc.google_connection_actor(uuid,integer,text),cc.expire_google_candidates(uuid),
  cc.stage_google_credential(uuid,integer,uuid,text,text,text,jsonb,uuid),
  cc.google_candidate_for_actor(uuid,integer,uuid,text),
  cc.finish_google_candidate(uuid,integer,uuid,text,jsonb,text,uuid),
  cc.read_google_candidate(uuid,integer,uuid,text),
  cc.confirm_google_customer(uuid,integer,uuid,text,text,jsonb,uuid),
  cc.read_google_connection(uuid,integer) FROM PUBLIC;
