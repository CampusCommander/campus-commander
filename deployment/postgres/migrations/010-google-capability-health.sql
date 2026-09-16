-- Health observations never grant application authority or change customer ownership.
CREATE FUNCTION cc.google_health_capabilities_valid(p_value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE item jsonb;
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value)<>'array' THEN RETURN false; END IF;
  IF jsonb_array_length(p_value) NOT BETWEEN 1 AND 2 THEN RETURN false; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(p_value) LOOP
    IF item NOT IN ('"customer-identity"'::jsonb,'"domain-observations"'::jsonb) THEN RETURN false; END IF;
  END LOOP;
  RETURN (SELECT count(DISTINCT value)=jsonb_array_length(p_value) FROM jsonb_array_elements(p_value));
END;
$$;

CREATE TABLE cc.google_health_checks (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  id uuid NOT NULL UNIQUE,
  customer_id text NOT NULL,
  generation integer NOT NULL,
  actor_id uuid NOT NULL REFERENCES cc.application_principals(id),
  actor_version integer NOT NULL CHECK(actor_version>0),
  capabilities jsonb NOT NULL CHECK(cc.google_health_capabilities_valid(capabilities)),
  correlation_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  retry_at timestamptz NOT NULL,
  finished_at timestamptz,
  FOREIGN KEY(customer_id) REFERENCES cc.google_connection(customer_id)
);

CREATE TABLE cc.google_capability_health (
  customer_id text NOT NULL,
  generation integer NOT NULL,
  capability text NOT NULL CHECK(capability IN ('customer-identity','domain-observations')),
  scope_verified boolean NOT NULL,
  failure text CHECK(failure IN ('credential-rejected','delegation-not-authorized','api-not-enabled','policy-restricted','network-failure','scope-mismatch','permission-denied','quota','provider-unavailable','invalid-response','wrong-customer','request-failed','license-restricted','key-unavailable')),
  checked_at timestamptz NOT NULL,
  last_succeeded_at timestamptz,
  correlation_id uuid NOT NULL,
  PRIMARY KEY(customer_id,generation,capability),
  CHECK(failure IS NOT NULL OR scope_verified),
  FOREIGN KEY(customer_id) REFERENCES cc.google_connection(customer_id)
);

CREATE FUNCTION cc.google_health_state() RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT jsonb_build_object('customerId',c.customer_id,'generation',c.generation,'observedAt',clock_timestamp(),
    'backgroundFailure',t.failure,
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

CREATE FUNCTION cc.read_google_health(p_actor uuid,p_version integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
BEGIN
  PERFORM cc.google_connection_actor(p_actor,p_version,'connection:read');
  RETURN cc.google_health_state();
END;
$$;

CREATE FUNCTION cc.claim_google_health(p_actor uuid,p_version integer,p_customer text,p_generation integer,
  p_id uuid,p_capabilities jsonb,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection; prior cc.google_health_checks; observed timestamptz; encrypted jsonb;
BEGIN
  PERFORM cc.google_connection_actor(p_actor,p_version,'connection:diagnose');
  connection:=cc.google_current_generation(p_customer,p_generation);
  IF p_id IS NULL OR p_correlation IS NULL OR NOT cc.google_health_capabilities_valid(p_capabilities) THEN
    RAISE EXCEPTION 'Select an enabled capability.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO prior FROM cc.google_health_checks WHERE singleton FOR UPDATE;
  observed:=clock_timestamp();
  IF prior.finished_at IS NULL AND prior.expires_at>observed THEN
    RAISE EXCEPTION 'A Google check is running.' USING DETAIL='health-check-running';
  END IF;
  IF prior.retry_at>observed THEN
    RAISE EXCEPTION 'Wait before another Google check.' USING DETAIL='health-rate-limited';
  END IF;
  INSERT INTO cc.google_health_checks(singleton,id,customer_id,generation,actor_id,actor_version,capabilities,correlation_id,expires_at,retry_at)
    VALUES(true,p_id,p_customer,p_generation,p_actor,p_version,p_capabilities,p_correlation,observed+interval '45 seconds',observed+interval '30 seconds')
    ON CONFLICT(singleton) DO UPDATE SET id=EXCLUDED.id,customer_id=EXCLUDED.customer_id,generation=EXCLUDED.generation,
      actor_id=EXCLUDED.actor_id,actor_version=EXCLUDED.actor_version,capabilities=EXCLUDED.capabilities,
      correlation_id=EXCLUDED.correlation_id,expires_at=EXCLUDED.expires_at,retry_at=EXCLUDED.retry_at,finished_at=NULL;
  INSERT INTO cc.security_events(id,actor_id,event,correlation_id,target_id,resource_scope,detail)
    VALUES(gen_random_uuid(),p_actor,'connection-checked',p_correlation,connection.credential_id,
      jsonb_build_object('kind','district','customerId',p_customer),'health-started');
  SELECT envelope INTO encrypted FROM cc.google_credentials WHERE id=connection.credential_id;
  RETURN jsonb_build_object('id',p_id,'credentialId',connection.credential_id,'envelope',encrypted);
END;
$$;

CREATE FUNCTION cc.finish_google_health(p_actor uuid,p_version integer,p_customer text,p_generation integer,
  p_id uuid,p_results jsonb,p_observation jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection; pending cc.google_health_checks; observed timestamptz; result jsonb; names jsonb;
BEGIN
  PERFORM cc.google_connection_actor(p_actor,p_version,'connection:diagnose');
  connection:=cc.google_current_generation(p_customer,p_generation);
  SELECT * INTO pending FROM cc.google_health_checks WHERE singleton FOR UPDATE;
  observed:=clock_timestamp();
  IF p_id IS NULL OR pending.id IS DISTINCT FROM p_id OR pending.actor_id IS DISTINCT FROM p_actor OR
    pending.actor_version IS DISTINCT FROM p_version OR pending.generation IS DISTINCT FROM p_generation OR
    pending.customer_id IS DISTINCT FROM p_customer OR pending.finished_at IS NOT NULL OR pending.expires_at<=observed THEN
    RAISE EXCEPTION 'The Google check expired or changed.' USING DETAIL='health-check-changed';
  END IF;
  IF p_results IS NULL OR jsonb_typeof(p_results)<>'array' THEN
    RAISE EXCEPTION 'The capability results are invalid.' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(p_results) NOT BETWEEN 0 AND 2 THEN
    RAISE EXCEPTION 'The capability result count is invalid.' USING ERRCODE='22023';
  END IF;
  -- An inconclusive combined read preserves every capability observation.
  IF jsonb_array_length(p_results)>0 THEN
  SELECT jsonb_agg(value->'capability') INTO names FROM jsonb_array_elements(p_results);
  IF NOT cc.google_health_capabilities_valid(names) OR NOT (names @> pending.capabilities AND pending.capabilities @> names) THEN
    RAISE EXCEPTION 'The checked capabilities differ from the request.' USING ERRCODE='22023';
  END IF;
  END IF;
  FOR result IN SELECT * FROM jsonb_array_elements(p_results) LOOP
    IF jsonb_typeof(result)<>'object' OR result-ARRAY['capability','scopeVerified','failure']<>'{}'::jsonb OR
      jsonb_typeof(result->'scopeVerified') IS DISTINCT FROM 'boolean' OR
      NOT (result ? 'failure') OR jsonb_typeof(result->'failure') NOT IN ('string','null') OR
      (result->'failure'='null'::jsonb AND result->'scopeVerified'<>'true'::jsonb) THEN
      RAISE EXCEPTION 'The capability result is invalid.' USING ERRCODE='22023';
    END IF;
    INSERT INTO cc.google_capability_health(customer_id,generation,capability,scope_verified,failure,checked_at,last_succeeded_at,correlation_id)
      VALUES(p_customer,p_generation,result->>'capability',(result->>'scopeVerified')::boolean,result->>'failure',observed,
        CASE WHEN result->>'failure' IS NULL THEN observed ELSE connection.observed_at END,pending.correlation_id)
      ON CONFLICT(customer_id,generation,capability) DO UPDATE SET scope_verified=EXCLUDED.scope_verified,failure=EXCLUDED.failure,
        checked_at=EXCLUDED.checked_at,correlation_id=EXCLUDED.correlation_id,
        last_succeeded_at=CASE WHEN EXCLUDED.failure IS NULL THEN observed ELSE cc.google_capability_health.last_succeeded_at END;
  END LOOP;
  IF p_observation IS NOT NULL THEN
    IF jsonb_array_length(p_results)<>2 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_results) WHERE value->>'failure' IS NOT NULL) OR
      NOT cc.google_observation_valid(p_observation) OR p_observation->>'customerId' IS DISTINCT FROM p_customer THEN
      RAISE EXCEPTION 'The successful observation is invalid.' USING ERRCODE='22023';
    END IF;
    UPDATE cc.google_connection SET observation=p_observation,observed_at=observed WHERE singleton;
    PERFORM cc.reset_google_access(p_actor,p_version,p_customer,p_generation,pending.correlation_id);
  END IF;
  UPDATE cc.google_health_checks SET finished_at=observed WHERE singleton;
  INSERT INTO cc.security_events(id,actor_id,event,correlation_id,target_id,resource_scope,detail)
    VALUES(gen_random_uuid(),p_actor,'connection-checked',pending.correlation_id,connection.credential_id,
      jsonb_build_object('kind','district','customerId',p_customer),
      CASE WHEN jsonb_array_length(p_results)=0 THEN 'health-inconclusive' ELSE 'health-completed' END);
  RETURN cc.google_health_state();
END;
$$;

REVOKE ALL ON cc.google_health_checks,cc.google_capability_health FROM PUBLIC;
REVOKE ALL ON FUNCTION cc.google_health_capabilities_valid(jsonb),cc.google_health_state(),
  cc.read_google_health(uuid,integer),cc.claim_google_health(uuid,integer,text,integer,uuid,jsonb,uuid),
  cc.finish_google_health(uuid,integer,text,integer,uuid,jsonb,jsonb) FROM PUBLIC;
