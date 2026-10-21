-- B6: the write-access routes resolve the connected customer through a device write read.
-- The caller holds devices:write, devices:commands, or devices:status at the platform scope or at the
-- district scope of the customer. The function reads no credential, so it takes no advisory lock.
CREATE FUNCTION cc.device_writer(p_actor uuid,p_version integer) RETURNS cc.google_connection
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection;
BEGIN
  SELECT * INTO connection FROM cc.google_connection WHERE singleton;
  IF NOT EXISTS(SELECT 1 FROM cc.application_principals p
      WHERE p.id=p_actor AND p.enabled AND p.permission_version=p_version) OR
    NOT EXISTS(SELECT 1 FROM cc.application_grants g WHERE g.principal_id=p_actor AND
      g.action IN ('devices:write','devices:commands','devices:status') AND (
      g.scope='{"kind":"platform"}'::jsonb OR
      (g.scope->>'kind'='district' AND g.scope->>'customerId'=connection.customer_id))) THEN
    RAISE EXCEPTION 'Update devices requires permission.' USING ERRCODE='42501';
  END IF;
  RETURN connection;
END;
$$;

-- B6: the in-process write check opens the active credential of one generation.
-- The global access lock comes first, so an access change commits before the person
-- check runs. A revoked caller answers 403 before a moved generation answers 409.
-- The envelope stays encrypted and the route decides the state.
CREATE FUNCTION cc.device_write_credential(p_actor uuid,p_version integer,
  p_customer text,p_generation integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection; encrypted jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(7240173008);
  IF NOT EXISTS(SELECT 1 FROM cc.application_principals p
      WHERE p.id=p_actor AND p.enabled AND p.permission_version=p_version) OR
    NOT EXISTS(SELECT 1 FROM cc.application_grants g
      WHERE g.principal_id=p_actor AND g.action IN ('devices:write','devices:commands','devices:status') AND
      (g.scope='{"kind":"platform"}'::jsonb OR
      (g.scope->>'kind'='district' AND g.scope->>'customerId'=p_customer))) THEN
    RAISE EXCEPTION 'Update devices requires permission.' USING ERRCODE='42501';
  END IF;
  connection:=cc.google_current_generation(p_customer,p_generation);
  SELECT envelope INTO encrypted FROM cc.google_credentials WHERE id=connection.credential_id;
  RETURN jsonb_build_object('customerId',p_customer,'generation',p_generation,
    'credentialId',connection.credential_id,'envelope',encrypted);
END;
$$;

REVOKE ALL ON FUNCTION cc.device_writer(uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION cc.device_write_credential(uuid,integer,text,integer) FROM PUBLIC;