ALTER TABLE cc.security_events DROP CONSTRAINT security_events_event_check;
ALTER TABLE cc.security_events ADD CONSTRAINT security_events_event_check CHECK (event IN (
  'login-started','login-succeeded','login-denied','logout','access-denied',
  'session-expired','access-granted','access-revoked','identity-replaced',
  'diagnostic-started','diagnostic-passed','diagnostic-failed','preferences-changed',
  'platform-administrator-confirmed','grants-changed','principal-disabled','principal-enabled',
  'invitation-created','invitation-redeemed','invitation-confirmed','invitation-revoked','invitation-expired',
  'customer-confirmed','customer-settings-changed','connection-authorized','connection-replaced',
  'connection-staged','connection-stage-failed','connection-stage-expired',
  'connection-token-renewed','connection-token-failed',
  'connection-revoked','connection-checked','credential-key-rotated','school-scope-changed','recovery-required'
));

CREATE TABLE cc.google_access_tokens (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  credential_id uuid NOT NULL,
  generation integer NOT NULL,
  customer_id text NOT NULL,
  token_id uuid,
  envelope jsonb CHECK(envelope IS NULL OR cc.google_envelope_valid(envelope)),
  expires_at timestamptz,
  lease_id uuid,
  lease_until timestamptz,
  failure text CHECK(failure IN ('credential-rejected','delegation-not-authorized','api-not-enabled','policy-restricted','network-failure','scope-mismatch','permission-denied','quota','provider-unavailable','invalid-response','wrong-customer','request-failed')),
  retry_at timestamptz,
  CHECK((envelope IS NOT NULL)=(expires_at IS NOT NULL)),
  CHECK((envelope IS NOT NULL)=(token_id IS NOT NULL)),
  CHECK((lease_id IS NOT NULL)=(lease_until IS NOT NULL)),
  CHECK(envelope IS NULL OR (failure IS NULL AND lease_id IS NULL)),
  FOREIGN KEY(credential_id,generation,customer_id) REFERENCES cc.google_credentials(id,generation,customer_id)
);

CREATE FUNCTION cc.google_current_generation(p_customer text,p_generation integer) RETURNS cc.google_connection
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

CREATE FUNCTION cc.acquire_google_access(p_customer text,p_generation integer,p_lease uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection; token cc.google_access_tokens; credential jsonb; checked_at timestamptz;
BEGIN
  connection:=cc.google_current_generation(p_customer,p_generation);
  IF p_lease IS NULL THEN RAISE EXCEPTION 'A renewal lease is required.'; END IF;
  INSERT INTO cc.google_access_tokens(singleton,credential_id,generation,customer_id)
    VALUES(true,connection.credential_id,connection.generation,connection.customer_id)
    ON CONFLICT(singleton) DO UPDATE SET credential_id=EXCLUDED.credential_id,generation=EXCLUDED.generation,
      customer_id=EXCLUDED.customer_id,token_id=NULL,envelope=NULL,expires_at=NULL,lease_id=NULL,lease_until=NULL,failure=NULL,retry_at=NULL
      WHERE cc.google_access_tokens.credential_id<>EXCLUDED.credential_id OR cc.google_access_tokens.generation<>EXCLUDED.generation;
  SELECT * INTO token FROM cc.google_access_tokens WHERE singleton FOR UPDATE;
  checked_at:=clock_timestamp();
  IF token.failure IS NOT NULL AND (token.retry_at IS NULL OR token.retry_at>checked_at) THEN
    RETURN jsonb_build_object('status','failed','failure',token.failure);
  END IF;
  IF token.envelope IS NOT NULL AND token.expires_at>checked_at+interval '60 seconds' THEN
    RETURN jsonb_build_object('status','cached','credentialId',token.credential_id,'tokenId',token.token_id,
      'envelope',token.envelope,'expiresAt',floor(extract(epoch FROM token.expires_at)*1000));
  END IF;
  IF token.lease_until>checked_at THEN RETURN jsonb_build_object('status','pending'); END IF;
  UPDATE cc.google_access_tokens SET lease_id=p_lease,lease_until=checked_at+interval '30 seconds',
    token_id=NULL,envelope=NULL,expires_at=NULL,failure=NULL,retry_at=NULL WHERE singleton;
  SELECT envelope INTO credential FROM cc.google_credentials WHERE id=connection.credential_id;
  RETURN jsonb_build_object('status','renew','credentialId',connection.credential_id,'envelope',credential);
END;
$$;

CREATE FUNCTION cc.finish_google_access(p_customer text,p_generation integer,p_lease uuid,p_envelope jsonb,
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
    IF p_envelope IS NULL OR p_expires_at IS NULL OR p_expires_at<=checked_at+interval '60 seconds' OR
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

CREATE FUNCTION cc.reject_google_access(p_customer text,p_generation integer,p_token uuid,p_failure text,p_correlation uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection;
BEGIN
  connection:=cc.google_current_generation(p_customer,p_generation);
  IF p_failure IS NULL THEN RAISE EXCEPTION 'A failure category is required.'; END IF;
  UPDATE cc.google_access_tokens SET token_id=NULL,envelope=NULL,expires_at=NULL,failure=p_failure,
    retry_at=CASE WHEN p_failure IN ('network-failure','quota','provider-unavailable','request-failed') THEN clock_timestamp()+interval '30 seconds' ELSE NULL END
    WHERE singleton AND token_id=p_token AND credential_id=connection.credential_id AND generation=p_generation;
  IF FOUND THEN
    INSERT INTO cc.security_events(id,event,correlation_id,target_id,resource_scope,detail)
      VALUES(gen_random_uuid(),'connection-token-failed',p_correlation,connection.credential_id,
        jsonb_build_object('kind','district','customerId',p_customer),p_failure);
  END IF;
END;
$$;

CREATE FUNCTION cc.record_google_observation(p_customer text,p_generation integer,p_observation jsonb,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection; observed timestamptz;
BEGIN
  connection:=cc.google_current_generation(p_customer,p_generation);
  IF p_observation IS NULL OR p_observation->>'customerId' IS DISTINCT FROM p_customer THEN
    RAISE EXCEPTION 'The observed customer differs from the binding.' USING DETAIL='credential-changed';
  END IF;
  observed:=clock_timestamp();
  UPDATE cc.google_connection SET observation=p_observation,observed_at=observed WHERE singleton;
  INSERT INTO cc.security_events(id,event,correlation_id,target_id,resource_scope,detail)
    VALUES(gen_random_uuid(),'connection-checked',p_correlation,connection.credential_id,
      jsonb_build_object('kind','district','customerId',p_customer),'background-read');
  RETURN jsonb_build_object('customerId',p_customer,'generation',p_generation,'observedAt',observed,'observation',p_observation);
END;
$$;

CREATE FUNCTION cc.reset_google_access(p_actor uuid,p_version integer,p_customer text,p_generation integer,p_correlation uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection;
BEGIN
  PERFORM cc.google_connection_actor(p_actor,p_version,'connection:diagnose');
  connection:=cc.google_current_generation(p_customer,p_generation);
  UPDATE cc.google_access_tokens SET failure=NULL,retry_at=NULL WHERE singleton AND generation=p_generation;
  INSERT INTO cc.security_events(id,actor_id,event,correlation_id,target_id,resource_scope,detail)
    VALUES(gen_random_uuid(),p_actor,'connection-checked',p_correlation,connection.credential_id,
      jsonb_build_object('kind','district','customerId',p_customer),'retry-authorized');
END;
$$;

REVOKE ALL ON FUNCTION cc.google_current_generation(text,integer),cc.acquire_google_access(text,integer,uuid),
  cc.finish_google_access(text,integer,uuid,jsonb,timestamptz,text,uuid),cc.reject_google_access(text,integer,uuid,text,uuid),
  cc.record_google_observation(text,integer,jsonb,uuid),cc.reset_google_access(uuid,integer,text,integer,uuid) FROM PUBLIC;
