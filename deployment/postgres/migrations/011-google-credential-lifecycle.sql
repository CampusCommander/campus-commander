-- Customer ownership survives credential replacement and local disconnect.
ALTER TABLE cc.google_credential_candidates ADD COLUMN expected_customer text;
ALTER TABLE cc.google_credential_candidates ADD COLUMN expected_generation integer;
ALTER TABLE cc.google_credential_candidates ADD CONSTRAINT replacement_context CHECK (
  (expected_customer IS NULL AND expected_generation IS NULL) OR
  (expected_customer IS NOT NULL AND expected_customer ~ '^C[A-Za-z0-9]{4,31}$' AND expected_generation>0));
ALTER TABLE cc.google_credentials ALTER COLUMN envelope DROP NOT NULL;
ALTER TABLE cc.google_credentials DROP CONSTRAINT google_credentials_envelope_check;
ALTER TABLE cc.google_credentials ADD CONSTRAINT google_credentials_envelope_check CHECK(envelope IS NULL OR cc.google_envelope_valid(envelope));
ALTER TABLE cc.google_connection ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE cc.google_connection ADD COLUMN encryption_key_id text;
UPDATE cc.google_connection c SET encryption_key_id=g.envelope->>'keyId' FROM cc.google_credentials g WHERE g.id=c.credential_id;
ALTER TABLE cc.google_connection ALTER COLUMN encryption_key_id SET NOT NULL;
ALTER TABLE cc.google_connection ADD CONSTRAINT encryption_key_id_valid CHECK(encryption_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$');

CREATE FUNCTION cc.google_bound_generation(p_customer text,p_generation integer) RETURNS cc.google_connection
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection;
BEGIN
  PERFORM pg_advisory_xact_lock(7240173008);
  SELECT * INTO connection FROM cc.google_connection WHERE singleton FOR UPDATE;
  IF connection.customer_id IS NULL OR p_customer IS NULL OR p_generation IS NULL OR
    connection.customer_id<>p_customer OR connection.generation<>p_generation THEN
    RAISE EXCEPTION 'The credential generation changed.' USING DETAIL='credential-changed';
  END IF;
  RETURN connection;
END;
$$;

CREATE OR REPLACE FUNCTION cc.google_current_generation(p_customer text,p_generation integer) RETURNS cc.google_connection
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection;
BEGIN
  connection:=cc.google_bound_generation(p_customer,p_generation);
  IF NOT connection.active THEN
    RAISE EXCEPTION 'Background Google access is disconnected.' USING DETAIL='connection-disconnected';
  END IF;
  RETURN connection;
END;
$$;

CREATE FUNCTION cc.stage_google_credential_bound(p_actor uuid,p_version integer,p_id uuid,p_browser_hash text,
  p_client_id text,p_subject text,p_envelope jsonb,p_correlation uuid,p_customer text,p_generation integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE expiry timestamptz; created timestamptz;
BEGIN
  PERFORM cc.google_connection_actor(p_actor,p_version,'connection:manage');
  PERFORM cc.expire_google_candidates(p_correlation);
  IF p_customer IS NULL AND p_generation IS NULL THEN
    IF EXISTS(SELECT 1 FROM cc.google_connection) THEN RAISE EXCEPTION 'The customer is already connected.' USING DETAIL='already-connected'; END IF;
  ELSE
    PERFORM cc.google_bound_generation(p_customer,p_generation);
  END IF;
  IF (SELECT count(*) FROM cc.google_credential_candidates WHERE status IN ('verifying','ready'))>=20 OR
    (SELECT count(*) FROM cc.google_credential_candidates WHERE actor_id=p_actor AND status IN ('verifying','ready'))>=3 THEN
    RAISE EXCEPTION 'Wait for an existing credential check to expire.' USING DETAIL='busy';
  END IF;
  IF EXISTS(SELECT 1 FROM cc.google_credential_candidates WHERE id=p_id) THEN
    RAISE EXCEPTION 'The credential transaction already exists.' USING DETAIL='candidate-changed';
  END IF;
  created:=clock_timestamp();
  IF (SELECT count(*) FROM cc.google_credential_candidates WHERE created_at>created-interval '10 minutes')>=100 OR
    (SELECT count(*) FROM cc.google_credential_candidates WHERE actor_id=p_actor AND created_at>created-interval '10 minutes')>=10 THEN
    RAISE EXCEPTION 'Wait before starting another credential check.' USING DETAIL='busy';
  END IF;
  INSERT INTO cc.google_credential_candidates(id,actor_id,actor_version,browser_hash,client_id,delegated_subject,status,envelope,created_at,expires_at,expected_customer,expected_generation)
    VALUES(p_id,p_actor,p_version,p_browser_hash,p_client_id,p_subject,'verifying',p_envelope,created,created+interval '10 minutes',p_customer,p_generation) RETURNING expires_at INTO expiry;
  INSERT INTO cc.security_events(id,actor_id,event,correlation_id,target_id,resource_scope)
    VALUES(gen_random_uuid(),p_actor,'connection-staged',p_correlation,p_id,'{"kind":"platform"}');
  RETURN jsonb_build_object('id',p_id,'status','verifying','expiresAt',expiry);
END;
$$;

CREATE OR REPLACE FUNCTION cc.stage_google_credential(p_actor uuid,p_version integer,p_id uuid,p_browser_hash text,
  p_client_id text,p_subject text,p_envelope jsonb,p_correlation uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT cc.stage_google_credential_bound(p_actor,p_version,p_id,p_browser_hash,p_client_id,p_subject,p_envelope,p_correlation,NULL,NULL);
$$;

CREATE FUNCTION cc.stage_google_replacement(p_actor uuid,p_version integer,p_id uuid,p_browser_hash text,
  p_client_id text,p_subject text,p_envelope jsonb,p_correlation uuid,p_customer text,p_generation integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
BEGIN
  IF p_customer IS NULL OR p_generation IS NULL THEN RAISE EXCEPTION 'The replacement requires a customer and generation.' USING ERRCODE='22023'; END IF;
  RETURN cc.stage_google_credential_bound(p_actor,p_version,p_id,p_browser_hash,p_client_id,p_subject,p_envelope,p_correlation,p_customer,p_generation);
END;
$$;

CREATE OR REPLACE FUNCTION cc.finish_google_candidate(p_actor uuid,p_version integer,p_id uuid,p_browser_hash text,
  p_observation jsonb,p_failure text,p_correlation uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE candidate cc.google_credential_candidates;
BEGIN
  candidate:=cc.google_candidate_for_actor(p_actor,p_version,p_id,p_browser_hash);
  IF candidate.status<>'verifying' OR (p_observation IS NULL)=(p_failure IS NULL) THEN
    RAISE EXCEPTION 'The credential transaction changed.' USING DETAIL='candidate-changed';
  END IF;
  IF candidate.expected_customer IS NOT NULL THEN
    PERFORM cc.google_bound_generation(candidate.expected_customer,candidate.expected_generation);
    IF p_failure IS NULL AND p_observation->>'customerId' IS DISTINCT FROM candidate.expected_customer THEN
      p_failure:='wrong-customer';
      p_observation:=NULL;
    END IF;
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

CREATE OR REPLACE FUNCTION cc.read_google_candidate(p_actor uuid,p_version integer,p_id uuid,p_browser_hash text) RETURNS jsonb
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
    'observedAt',candidate.observed_at,'failure',candidate.failure,'envelope',candidate.envelope,'expectedCustomerId',candidate.expected_customer,'expectedGeneration',candidate.expected_generation);
END;
$$;

CREATE OR REPLACE FUNCTION cc.confirm_google_customer(p_actor uuid,p_version integer,p_id uuid,p_browser_hash text,
  p_customer_id text,p_envelope jsonb,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE candidate cc.google_credential_candidates;
BEGIN
  candidate:=cc.google_candidate_for_actor(p_actor,p_version,p_id,p_browser_hash);
  IF candidate.expected_customer IS NOT NULL OR candidate.status<>'ready' OR p_customer_id IS NULL OR candidate.observation->>'customerId'<>p_customer_id THEN
    RAISE EXCEPTION 'Confirm the observed customer identity.' USING DETAIL='candidate-changed';
  END IF;
  IF EXISTS(SELECT 1 FROM cc.google_connection) THEN RAISE EXCEPTION 'The customer is already connected.' USING DETAIL='already-connected'; END IF;
  INSERT INTO cc.google_credentials(id,generation,customer_id,envelope,client_id,delegated_subject)
    VALUES(p_id,1,p_customer_id,p_envelope,candidate.client_id,candidate.delegated_subject);
  INSERT INTO cc.google_connection(customer_id,credential_id,generation,observation,observed_at,confirmed_by,encryption_key_id)
    VALUES(p_customer_id,p_id,1,candidate.observation,candidate.observed_at,p_actor,p_envelope->>'keyId');
  UPDATE cc.google_credential_candidates SET status='consumed',envelope=NULL WHERE id=p_id;
  INSERT INTO cc.security_events(id,actor_id,event,correlation_id,target_id,resource_scope)
    VALUES(gen_random_uuid(),p_actor,'customer-confirmed',p_correlation,p_id,jsonb_build_object('kind','district','customerId',p_customer_id)),
      (gen_random_uuid(),p_actor,'connection-authorized',p_correlation,p_id,jsonb_build_object('kind','district','customerId',p_customer_id));
  RETURN jsonb_build_object('customerId',p_customer_id,'generation',1,'credentialId',p_id,'confirmedAt',now());
END;
$$;

-- Only management functions can read this private projection.
CREATE FUNCTION cc.read_google_credential_management(p_actor uuid,p_version integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE result jsonb;
BEGIN
  PERFORM cc.google_connection_actor(p_actor,p_version,'connection:manage');
  SELECT jsonb_build_object('customerId',c.customer_id,'generation',c.generation,'credentialId',c.credential_id,
    'active',c.active,'keyId',c.encryption_key_id,'envelope',g.envelope)
    INTO result FROM cc.google_connection c JOIN cc.google_credentials g ON g.id=c.credential_id;
  RETURN result;
END;
$$;

-- Callers validate current authority and the expected generation before this private transition.
CREATE FUNCTION cc.advance_google_credential(p_actor uuid,p_customer text,p_generation integer,p_id uuid,p_envelope jsonb,
  p_client text,p_subject text,p_observation jsonb,p_observed_at timestamptz,p_key text,p_active boolean,p_event text,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE old_id uuid; candidate_id uuid; next_generation integer:=p_generation+1;
BEGIN
  SELECT credential_id INTO old_id FROM cc.google_connection WHERE singleton;
  IF p_event NOT IN ('connection-replaced','credential-key-rotated','connection-revoked') OR
    p_correlation IS NULL OR p_active IS NULL OR p_active<>(p_envelope IS NOT NULL) THEN
    RAISE EXCEPTION 'The credential transition is invalid.' USING ERRCODE='22023';
  END IF;
  DELETE FROM cc.google_access_tokens;
  DELETE FROM cc.google_health_checks;
  INSERT INTO cc.google_credentials(id,generation,customer_id,envelope,client_id,delegated_subject)
    VALUES(p_id,next_generation,p_customer,p_envelope,p_client,p_subject);
  UPDATE cc.google_connection SET credential_id=p_id,generation=next_generation,active=p_active,
    observation=p_observation,observed_at=p_observed_at,encryption_key_id=p_key WHERE singleton;
  DELETE FROM cc.google_credentials WHERE id=old_id;
  FOR candidate_id IN UPDATE cc.google_credential_candidates SET status='expired',envelope=NULL
    WHERE status IN ('verifying','ready') RETURNING id
  LOOP
    INSERT INTO cc.security_events(id,actor_id,event,correlation_id,target_id,resource_scope)
      VALUES(gen_random_uuid(),p_actor,'connection-stage-expired',p_correlation,candidate_id,
        jsonb_build_object('kind','district','customerId',p_customer));
  END LOOP;
  IF p_event IN ('credential-key-rotated','connection-revoked') THEN
    INSERT INTO cc.google_capability_health(customer_id,generation,capability,scope_verified,failure,checked_at,last_succeeded_at,correlation_id)
      SELECT customer_id,next_generation,capability,scope_verified,failure,checked_at,last_succeeded_at,correlation_id
        FROM cc.google_capability_health WHERE customer_id=p_customer AND generation=p_generation;
  END IF;
  INSERT INTO cc.security_events(id,actor_id,event,correlation_id,target_id,resource_scope,detail)
    VALUES(gen_random_uuid(),p_actor,p_event,p_correlation,p_id,
      jsonb_build_object('kind','district','customerId',p_customer),CASE WHEN p_event='connection-revoked' THEN 'local-disconnect' ELSE 'generation-advanced' END);
  RETURN jsonb_build_object('customerId',p_customer,'generation',next_generation,'credentialId',p_id,'active',p_active,'keyId',p_key);
END;
$$;

CREATE FUNCTION cc.activate_google_replacement(p_actor uuid,p_version integer,p_id uuid,p_browser_hash text,
  p_customer text,p_generation integer,p_envelope jsonb,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE candidate cc.google_credential_candidates; connection cc.google_connection;
BEGIN
  candidate:=cc.google_candidate_for_actor(p_actor,p_version,p_id,p_browser_hash);
  connection:=cc.google_bound_generation(p_customer,p_generation);
  IF candidate.status<>'ready' OR candidate.expected_customer IS DISTINCT FROM p_customer OR
    candidate.expected_generation IS DISTINCT FROM p_generation OR candidate.observation->>'customerId' IS DISTINCT FROM p_customer OR
    p_envelope IS NULL OR NOT cc.google_envelope_valid(p_envelope) THEN
    RAISE EXCEPTION 'The replacement review changed.' USING DETAIL='candidate-changed';
  END IF;
  UPDATE cc.google_credential_candidates SET status='consumed',envelope=NULL WHERE id=p_id;
  RETURN cc.advance_google_credential(p_actor,p_customer,p_generation,p_id,p_envelope,candidate.client_id,
    candidate.delegated_subject,candidate.observation,candidate.observed_at,p_envelope->>'keyId',true,'connection-replaced',p_correlation);
END;
$$;

CREATE FUNCTION cc.rotate_google_credential_key(p_actor uuid,p_version integer,p_customer text,p_generation integer,
  p_id uuid,p_envelope jsonb,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection; credential cc.google_credentials; prior_token cc.google_access_tokens; result jsonb;
BEGIN
  PERFORM cc.google_connection_actor(p_actor,p_version,'connection:manage');
  connection:=cc.google_current_generation(p_customer,p_generation);
  SELECT * INTO credential FROM cc.google_credentials WHERE id=connection.credential_id;
  IF p_envelope IS NULL OR p_envelope->>'keyId' IS NOT DISTINCT FROM connection.encryption_key_id THEN
    RAISE EXCEPTION 'Select a different encryption key.' USING DETAIL='credential-changed';
  END IF;
  SELECT * INTO prior_token FROM cc.google_access_tokens WHERE singleton;
  result:=cc.advance_google_credential(p_actor,p_customer,p_generation,p_id,p_envelope,credential.client_id,
    credential.delegated_subject,connection.observation,connection.observed_at,p_envelope->>'keyId',true,'credential-key-rotated',p_correlation);
  IF prior_token.failure IS NOT NULL THEN
    INSERT INTO cc.google_access_tokens(singleton,credential_id,generation,customer_id,failure,retry_at)
      VALUES(true,p_id,p_generation+1,p_customer,prior_token.failure,prior_token.retry_at);
  END IF;
  RETURN result;
END;
$$;

CREATE FUNCTION cc.disconnect_google_credential(p_actor uuid,p_version integer,p_customer text,p_generation integer,p_id uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection; credential cc.google_credentials;
BEGIN
  PERFORM cc.google_connection_actor(p_actor,p_version,'connection:manage');
  connection:=cc.google_current_generation(p_customer,p_generation);
  SELECT * INTO credential FROM cc.google_credentials WHERE id=connection.credential_id;
  RETURN cc.advance_google_credential(p_actor,p_customer,p_generation,p_id,NULL,credential.client_id,
    credential.delegated_subject,connection.observation,connection.observed_at,connection.encryption_key_id,false,'connection-revoked',p_correlation);
END;
$$;

REVOKE ALL ON FUNCTION cc.google_bound_generation(text,integer),
  cc.stage_google_credential_bound(uuid,integer,uuid,text,text,text,jsonb,uuid,text,integer),
  cc.stage_google_replacement(uuid,integer,uuid,text,text,text,jsonb,uuid,text,integer),
  cc.read_google_credential_management(uuid,integer),
  cc.advance_google_credential(uuid,text,integer,uuid,jsonb,text,text,jsonb,timestamptz,text,boolean,text,uuid),
  cc.activate_google_replacement(uuid,integer,uuid,text,text,integer,jsonb,uuid),
  cc.rotate_google_credential_key(uuid,integer,text,integer,uuid,jsonb,uuid),
  cc.disconnect_google_credential(uuid,integer,text,integer,uuid,uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION cc.finish_google_access(p_customer text,p_generation integer,p_lease uuid,p_envelope jsonb,
  p_expires_at timestamptz,p_failure text,p_correlation uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection; token cc.google_access_tokens; checked_at timestamptz;
BEGIN
  connection:=cc.google_current_generation(p_customer,p_generation);
  SELECT * INTO token FROM cc.google_access_tokens WHERE singleton FOR UPDATE;
  checked_at:=clock_timestamp();
  IF p_lease IS NULL OR token.lease_id IS DISTINCT FROM p_lease OR token.lease_until<=checked_at OR
    token.generation<>p_generation OR token.credential_id<>connection.credential_id THEN
    RAISE EXCEPTION 'The renewal lease changed.' USING DETAIL='credential-changed';
  END IF;
  IF p_failure IS NULL THEN
    IF p_envelope IS NULL OR p_envelope->>'keyId' IS DISTINCT FROM connection.encryption_key_id OR p_expires_at IS NULL OR p_expires_at<=checked_at+interval '60 seconds' OR
      p_expires_at>checked_at+interval '1 hour 5 seconds' THEN RAISE EXCEPTION 'The access token expiry is invalid.'; END IF;
  ELSIF p_envelope IS NOT NULL OR p_expires_at IS NOT NULL THEN RAISE EXCEPTION 'Failed renewal cannot contain a token.';
  END IF;
  UPDATE cc.google_access_tokens SET envelope=p_envelope,expires_at=p_expires_at,token_id=CASE WHEN p_failure IS NULL THEN p_lease ELSE NULL END,
    lease_id=NULL,lease_until=NULL,failure=p_failure,
    retry_at=CASE WHEN p_failure IN ('network-failure','quota','provider-unavailable','request-failed') THEN checked_at+interval '30 seconds' ELSE NULL END
    WHERE singleton;
  INSERT INTO cc.security_events(id,event,correlation_id,target_id,resource_scope,detail)
    VALUES(gen_random_uuid(),CASE WHEN p_failure IS NULL THEN 'connection-token-renewed' ELSE 'connection-token-failed' END,
      p_correlation,connection.credential_id,jsonb_build_object('kind','district','customerId',p_customer),COALESCE(p_failure,'token-renewed'));
END;
$$;

CREATE OR REPLACE FUNCTION cc.google_health_state() RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT jsonb_build_object('customerId',c.customer_id,'generation',c.generation,'observedAt',clock_timestamp(),
    'connectionState',CASE WHEN c.active THEN 'active' ELSE 'disconnected' END,'backgroundFailure',t.failure,
    'check',CASE WHEN h.id IS NULL THEN NULL ELSE jsonb_build_object('id',h.id,'capabilities',h.capabilities,
      'expiresAt',h.expires_at,'finishedAt',h.finished_at,'retryAt',h.retry_at) END,
    'capabilities',(SELECT jsonb_agg(jsonb_build_object('capability',v.capability,
      'scopeVerified',COALESCE(r.scope_verified,true),'failure',r.failure,
      'checkedAt',COALESCE(r.checked_at,c.observed_at),'lastSucceededAt',COALESCE(r.last_succeeded_at,c.observed_at),
      'correlationId',r.correlation_id) ORDER BY v.capability)
      FROM unnest(ARRAY['customer-identity','domain-observations']) AS v(capability)
      LEFT JOIN cc.google_capability_health r ON r.customer_id=c.customer_id AND r.generation=c.generation AND r.capability=v.capability))
    FROM cc.google_connection c
    LEFT JOIN cc.google_health_checks h ON h.customer_id=c.customer_id AND h.generation=c.generation
    LEFT JOIN cc.google_access_tokens t ON t.customer_id=c.customer_id AND t.generation=c.generation;
$$;
