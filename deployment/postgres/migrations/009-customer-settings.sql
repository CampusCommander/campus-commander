-- Customer settings are local configuration. Credentials and preferences remain separate.
CREATE FUNCTION cc.customer_settings_valid(p_value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,cc AS $$
  SELECT COALESCE(jsonb_typeof(p_value)='object' AND
    p_value-ARRAY['displayName']='{}'::jsonb AND
    jsonb_typeof(p_value->'displayName')='string' AND
    length(p_value->>'displayName') BETWEEN 1 AND 256 AND
    length(btrim(p_value->>'displayName'))>0 AND
    (p_value->>'displayName') !~ '[[:cntrl:]]',false);
$$;

CREATE TABLE cc.customer_settings_revisions (
  request_id uuid PRIMARY KEY,
  customer_id text NOT NULL REFERENCES cc.google_connection(customer_id),
  revision integer NOT NULL CHECK(revision>0),
  settings jsonb NOT NULL CHECK(cc.customer_settings_valid(settings)),
  actor_id uuid NOT NULL REFERENCES cc.application_principals(id),
  actor_version integer NOT NULL CHECK(actor_version>0),
  saved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  correlation_id uuid NOT NULL,
  UNIQUE(customer_id,revision)
);

CREATE FUNCTION cc.customer_settings_receipt(p_id uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT jsonb_build_object('requestId',request_id,'customerId',customer_id,
    'revision',revision,'settings',settings,'savedAt',saved_at)
    FROM cc.customer_settings_revisions WHERE request_id=p_id;
$$;

CREATE FUNCTION cc.read_customer_settings(p_actor uuid,p_version integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection; latest cc.customer_settings_revisions; first_saved timestamptz;
BEGIN
  PERFORM cc.google_connection_actor(p_actor,p_version,'customer:read');
  SELECT * INTO connection FROM cc.google_connection;
  IF connection.customer_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO latest FROM cc.customer_settings_revisions
    WHERE customer_id=connection.customer_id ORDER BY revision DESC LIMIT 1;
  SELECT saved_at INTO first_saved FROM cc.customer_settings_revisions
    WHERE customer_id=connection.customer_id AND revision=1;
  RETURN jsonb_build_object('customerId',connection.customer_id,
    'primaryDomain',connection.observation->>'primaryDomain',
    'settings',COALESCE(latest.settings,jsonb_build_object('displayName',connection.observation->>'primaryDomain')),
    'revision',COALESCE(latest.revision,0),'lastRequestId',latest.request_id,
    'onboarding',jsonb_build_object('customerConfirmedAt',connection.confirmed_at,
      'settingsConfirmedAt',first_saved,'lastGoogleObservationAt',connection.observed_at));
END;
$$;

CREATE FUNCTION cc.save_customer_settings(p_actor uuid,p_version integer,p_customer text,
  p_expected integer,p_request uuid,p_settings jsonb,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE prior cc.customer_settings_revisions; current_revision integer;
BEGIN
  PERFORM cc.google_connection_actor(p_actor,p_version,'customer:write');
  IF p_customer IS NULL OR NOT EXISTS(SELECT 1 FROM cc.google_connection WHERE customer_id=p_customer) THEN
    RAISE EXCEPTION 'The confirmed customer is required.' USING ERRCODE='42501';
  END IF;
  IF p_expected IS NULL OR p_expected<0 OR p_expected>=2147483647 OR p_request IS NULL OR
    p_correlation IS NULL OR NOT cc.customer_settings_valid(p_settings) THEN
    RAISE EXCEPTION 'The customer settings are invalid.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO prior FROM cc.customer_settings_revisions WHERE request_id=p_request;
  IF prior.request_id IS NOT NULL THEN
    IF prior.actor_id<>p_actor OR prior.customer_id<>p_customer OR
      prior.revision<>p_expected+1 OR prior.settings<>p_settings THEN
      RAISE EXCEPTION 'The request identifier was already used.' USING DETAIL='request-conflict';
    END IF;
    RETURN cc.customer_settings_receipt(p_request);
  END IF;
  SELECT COALESCE(max(revision),0) INTO current_revision FROM cc.customer_settings_revisions WHERE customer_id=p_customer;
  IF current_revision<>p_expected THEN
    RAISE EXCEPTION 'The customer settings changed.' USING DETAIL='revision-conflict';
  END IF;
  INSERT INTO cc.customer_settings_revisions(request_id,customer_id,revision,settings,actor_id,actor_version,correlation_id)
    VALUES(p_request,p_customer,current_revision+1,p_settings,p_actor,p_version,p_correlation);
  INSERT INTO cc.security_events(id,actor_id,event,correlation_id,target_id,resource_scope,detail)
    VALUES(gen_random_uuid(),p_actor,'customer-settings-changed',p_correlation,p_request,
      jsonb_build_object('kind','district','customerId',p_customer),'revision:'||(current_revision+1)::text);
  RETURN cc.customer_settings_receipt(p_request);
END;
$$;

CREATE FUNCTION cc.read_customer_settings_receipt(p_actor uuid,p_version integer,p_request uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
BEGIN
  PERFORM cc.google_connection_actor(p_actor,p_version,'customer:read');
  RETURN cc.customer_settings_receipt(p_request);
END;
$$;

REVOKE ALL ON cc.customer_settings_revisions FROM PUBLIC;
REVOKE ALL ON FUNCTION cc.customer_settings_valid(jsonb),cc.customer_settings_receipt(uuid),
  cc.read_customer_settings(uuid,integer),cc.save_customer_settings(uuid,integer,text,integer,uuid,jsonb,uuid),
  cc.read_customer_settings_receipt(uuid,integer,uuid) FROM PUBLIC;
