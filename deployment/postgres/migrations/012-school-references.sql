-- School references remain separate from managed inventory and customer token state.
CREATE FUNCTION cc.school_reference_units_valid(p_units jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE item jsonb; current_unit jsonb; parent_unit jsonb; units_by_id jsonb:='{}';
  seen text[]; paths text[]:=ARRAY[]::text[]; roots integer:=0;
BEGIN
  IF p_units IS NULL OR jsonb_typeof(p_units)<>'array' THEN RETURN false; END IF;
  IF jsonb_array_length(p_units) NOT BETWEEN 1 AND 10000 THEN RETURN false; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(p_units) LOOP
    IF jsonb_typeof(item)<>'object' OR item-ARRAY['id','name','path','parentId']<>'{}'::jsonb OR
      jsonb_typeof(item->'id') IS DISTINCT FROM 'string' OR
      COALESCE(item->>'id','') !~ '^[A-Za-z0-9:_-]{1,128}$' OR
      jsonb_typeof(item->'name') IS DISTINCT FROM 'string' OR length(item->>'name') NOT BETWEEN 1 AND 256 OR
      jsonb_typeof(item->'path') IS DISTINCT FROM 'string' OR length(item->>'path') NOT BETWEEN 1 AND 4096 OR
      NOT item ? 'parentId' OR COALESCE(jsonb_typeof(item->'parentId'),'') NOT IN ('string','null') OR
      (item->>'parentId' IS NOT NULL AND item->>'parentId' !~ '^[A-Za-z0-9:_-]{1,128}$') OR
      units_by_id ? (item->>'id') OR item->>'path'=ANY(paths) THEN RETURN false; END IF;
    IF item->>'parentId' IS NULL THEN
      roots:=roots+1;
      IF item->>'path'<>'/' THEN RETURN false; END IF;
    END IF;
    paths:=array_append(paths,item->>'path');
    units_by_id:=units_by_id||jsonb_build_object(item->>'id',item);
  END LOOP;
  IF roots<>1 THEN RETURN false; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(p_units) LOOP
    current_unit:=item;
    seen:=ARRAY[item->>'id'];
    WHILE current_unit->>'parentId' IS NOT NULL LOOP
      parent_unit:=units_by_id->(current_unit->>'parentId');
      IF parent_unit IS NULL OR parent_unit->>'id'=ANY(seen) OR cardinality(seen)>35 OR
        strpos(current_unit->>'name','/')>0 OR current_unit->>'path' IS DISTINCT FROM
        ((CASE WHEN parent_unit->>'path'='/' THEN '' ELSE parent_unit->>'path' END)||'/'||(current_unit->>'name')) THEN RETURN false; END IF;
      seen:=array_append(seen,parent_unit->>'id');
      current_unit:=parent_unit;
    END LOOP;
  END LOOP;
  RETURN true;
END;
$$;

CREATE TABLE cc.school_reference_state (
  customer_id text PRIMARY KEY REFERENCES cc.google_connection(customer_id),
  observation jsonb,
  observed_at timestamptz,
  failure text CHECK(failure IN ('credential-rejected','delegation-not-authorized','api-not-enabled','policy-restricted',
    'network-failure','scope-mismatch','permission-denied','quota','provider-unavailable','invalid-response',
    'wrong-customer','request-failed','key-unavailable')),
  checked_at timestamptz,
  lease_id uuid,
  lease_actor uuid REFERENCES cc.application_principals(id),
  lease_version integer,
  lease_generation integer,
  lease_expires_at timestamptz,
  retry_at timestamptz,
  correlation_id uuid,
  CHECK((observation IS NULL)=(observed_at IS NULL)),
  CHECK(observation IS NULL OR cc.school_reference_units_valid(observation->'units'))
);

CREATE FUNCTION cc.school_reference_projection() RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT jsonb_build_object('customerId',c.customer_id,'generation',c.generation,
    'observation',r.observation,'failure',r.failure,'checkedAt',r.checked_at,
    'fresh',COALESCE(c.active AND r.failure IS NULL AND r.observation->>'generation'=c.generation::text
      AND r.observed_at>clock_timestamp()-interval '10 minutes',false),
    'checking',COALESCE(r.lease_id IS NOT NULL AND r.lease_generation=c.generation
      AND r.lease_expires_at>clock_timestamp(),false),'retryAt',r.retry_at)
  FROM cc.google_connection c LEFT JOIN cc.school_reference_state r ON r.customer_id=c.customer_id;
$$;

CREATE FUNCTION cc.read_school_references(p_actor uuid,p_version integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
BEGIN
  PERFORM cc.google_connection_actor(p_actor,p_version,'schools:manage');
  RETURN cc.school_reference_projection();
END;
$$;

CREATE FUNCTION cc.claim_school_references(p_actor uuid,p_version integer,p_customer text,p_generation integer,
  p_id uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection; prior cc.school_reference_state; observed timestamptz;
BEGIN
  PERFORM cc.google_connection_actor(p_actor,p_version,'schools:manage');
  connection:=cc.google_current_generation(p_customer,p_generation);
  IF p_id IS NULL OR p_correlation IS NULL THEN
    RAISE EXCEPTION 'The reference check identifier is required.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO prior FROM cc.school_reference_state WHERE customer_id=p_customer FOR UPDATE;
  observed:=clock_timestamp();
  IF prior.lease_id IS NOT NULL AND prior.lease_generation=p_generation AND prior.lease_expires_at>observed THEN
    RAISE EXCEPTION 'A school reference check is running.' USING DETAIL='reference-check-running';
  END IF;
  IF prior.lease_generation=p_generation AND prior.retry_at>observed THEN
    RAISE EXCEPTION 'Wait before another reference check.' USING DETAIL='reference-rate-limited';
  END IF;
  INSERT INTO cc.school_reference_state(customer_id,lease_id,lease_actor,lease_version,lease_generation,lease_expires_at,retry_at,correlation_id)
    VALUES(p_customer,p_id,p_actor,p_version,p_generation,observed+interval '45 seconds',observed+interval '30 seconds',p_correlation)
    ON CONFLICT(customer_id) DO UPDATE SET lease_id=EXCLUDED.lease_id,lease_actor=EXCLUDED.lease_actor,
      lease_version=EXCLUDED.lease_version,lease_generation=EXCLUDED.lease_generation,lease_expires_at=EXCLUDED.lease_expires_at,
      retry_at=EXCLUDED.retry_at,correlation_id=EXCLUDED.correlation_id;
  INSERT INTO cc.security_events(id,actor_id,event,correlation_id,target_id,resource_scope,detail)
    VALUES(gen_random_uuid(),p_actor,'connection-checked',p_correlation,connection.credential_id,
      jsonb_build_object('kind','district','customerId',p_customer),'school-references-started');
  RETURN jsonb_build_object('id',p_id,'credentialId',connection.credential_id,
    'envelope',(SELECT envelope FROM cc.google_credentials WHERE id=connection.credential_id));
END;
$$;

CREATE FUNCTION cc.finish_school_references(p_actor uuid,p_version integer,p_customer text,p_generation integer,
  p_id uuid,p_observation jsonb,p_failure text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection; pending cc.school_reference_state; observed timestamptz;
BEGIN
  PERFORM cc.google_connection_actor(p_actor,p_version,'schools:manage');
  connection:=cc.google_current_generation(p_customer,p_generation);
  SELECT * INTO pending FROM cc.school_reference_state WHERE customer_id=p_customer FOR UPDATE;
  observed:=clock_timestamp();
  IF p_id IS NULL OR pending.lease_id IS DISTINCT FROM p_id OR pending.lease_actor IS DISTINCT FROM p_actor OR
    pending.lease_version IS DISTINCT FROM p_version OR pending.lease_generation IS DISTINCT FROM p_generation OR
    pending.lease_expires_at<=observed THEN
    RAISE EXCEPTION 'The reference check expired or changed.' USING DETAIL='reference-check-changed';
  END IF;
  IF (p_observation IS NULL)=(p_failure IS NULL) THEN
    RAISE EXCEPTION 'Supply one reference observation or failure.' USING ERRCODE='22023';
  END IF;
  IF p_observation IS NOT NULL THEN
    IF jsonb_typeof(p_observation)<>'object' OR
      p_observation-ARRAY['customerId','generation','revision','observedAt','verified','complete','units']<>'{}'::jsonb OR
      p_observation->>'customerId' IS DISTINCT FROM p_customer OR
      p_observation->'generation' IS DISTINCT FROM to_jsonb(p_generation) OR
      p_observation->'verified' IS DISTINCT FROM 'true'::jsonb OR p_observation->'complete' IS DISTINCT FROM 'true'::jsonb OR
      NOT cc.school_reference_units_valid(p_observation->'units') THEN
      RAISE EXCEPTION 'The school reference observation is invalid.' USING ERRCODE='22023';
    END IF;
    UPDATE cc.school_reference_state SET observation=jsonb_build_object('customerId',p_customer,'generation',p_generation,
      'revision',gen_random_uuid(),'observedAt',observed,'verified',true,'complete',true,'units',p_observation->'units'),
      observed_at=observed WHERE customer_id=p_customer;
  END IF;
  UPDATE cc.school_reference_state SET failure=p_failure,checked_at=observed,lease_id=NULL WHERE customer_id=p_customer;
  INSERT INTO cc.security_events(id,actor_id,event,correlation_id,target_id,resource_scope,detail)
    VALUES(gen_random_uuid(),p_actor,'connection-checked',pending.correlation_id,connection.credential_id,
      jsonb_build_object('kind','district','customerId',p_customer),
      CASE WHEN p_failure IS NULL THEN 'school-references-ready' ELSE 'school-references-failed' END);
  RETURN cc.school_reference_projection();
END;
$$;

REVOKE ALL ON cc.school_reference_state FROM PUBLIC;
REVOKE ALL ON FUNCTION cc.school_reference_units_valid(jsonb),cc.school_reference_projection(),
  cc.read_school_references(uuid,integer),cc.claim_school_references(uuid,integer,text,integer,uuid,uuid),
  cc.finish_school_references(uuid,integer,text,integer,uuid,jsonb,text) FROM PUBLIC;
