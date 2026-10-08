CREATE TABLE cc.application_access_changes (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES cc.application_principals(id),
  principal_id uuid NOT NULL REFERENCES cc.application_principals(id),
  correlation_id uuid NOT NULL,
  previous_version integer NOT NULL,
  permission_version integer NOT NULL,
  previous_enabled boolean NOT NULL,
  enabled boolean NOT NULL,
  previous_grants jsonb NOT NULL,
  grants jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (permission_version=previous_version+1)
);

CREATE FUNCTION cc.platform_principal(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT jsonb_build_object('id',p.id,'issuer',p.issuer,'subject',p.subject,'displayName',p.display_name,
    'enabled',p.enabled,'permissionVersion',p.permission_version,'permissions',p.permissions,
    'grants',COALESCE((SELECT jsonb_agg(jsonb_build_object('action',g.action,'scope',g.scope) ORDER BY g.action,g.scope)
      FROM cc.application_grants g WHERE g.principal_id=p.id),'[]'::jsonb))
  FROM cc.application_principals p WHERE p.id=p_id;
$$;

CREATE FUNCTION cc.full_platform_administrator(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT EXISTS(SELECT 1 FROM cc.application_principals p WHERE p.id=p_id AND p.enabled AND NOT EXISTS(
    SELECT 1 FROM cc.application_actions a WHERE NOT EXISTS(
      SELECT 1 FROM cc.application_grants g WHERE g.principal_id=p.id AND g.action=a.action AND g.scope='{"kind":"platform"}'::jsonb
    )
  ));
$$;

-- Customer and school owners extend this check with their verified resource records.
CREATE FUNCTION cc.application_scope_verified(p_scope jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT p_scope='{"kind":"platform"}'::jsonb;
$$;

CREATE FUNCTION cc.access_grants_allowed(p_actor uuid,p_grants jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
BEGIN
  IF p_grants IS NULL OR jsonb_typeof(p_grants)<>'array' THEN RETURN false; END IF;
  IF jsonb_array_length(p_grants)>256 OR
    (SELECT count(DISTINCT g) FROM jsonb_array_elements(p_grants) AS g)<>jsonb_array_length(p_grants) THEN RETURN false; END IF;
  RETURN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_grants) AS g WHERE
    jsonb_typeof(g)<>'object' OR g-ARRAY['action','scope']<>'{}'::jsonb OR
    cc.application_scope_verified(g->'scope') IS DISTINCT FROM true OR NOT EXISTS(
      SELECT 1 FROM cc.application_actions a WHERE a.action=g->>'action' AND g->'scope'->>'kind'=ANY(a.scope_kinds)
    ) OR NOT EXISTS(
      SELECT 1 FROM cc.application_grants own WHERE own.principal_id=p_actor AND own.action=g->>'action' AND (
        own.scope='{"kind":"platform"}'::jsonb OR own.scope=g->'scope' OR (
          own.scope->>'kind'='district' AND g->'scope'->>'kind'='school' AND own.scope->>'customerId'=g->'scope'->>'customerId'
        )
      )
    )
  );
END;
$$;

CREATE FUNCTION cc.list_platform_principals(p_actor uuid,p_version integer,p_offset integer,p_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE result jsonb;
BEGIN
  PERFORM cc.invitation_actor(p_actor,p_version,'platform-users:read');
  IF p_offset IS NULL OR p_offset<0 OR p_offset>1000000 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'The requested page is invalid.';
  END IF;
  SELECT jsonb_build_object('total',(SELECT count(*) FROM cc.application_principals),'offset',p_offset,'limit',p_limit,
    'items',COALESCE(jsonb_agg(cc.platform_principal(id) ORDER BY id),'[]'::jsonb)) INTO result
    FROM (SELECT id FROM cc.application_principals ORDER BY id OFFSET p_offset LIMIT p_limit) AS page;
  RETURN result;
END;
$$;

CREATE FUNCTION cc.read_platform_principal(p_actor uuid,p_version integer,p_target uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
BEGIN
  PERFORM cc.invitation_actor(p_actor,p_version,'platform-users:read');
  RETURN cc.platform_principal(p_target);
END;
$$;

CREATE FUNCTION cc.review_platform_access(p_actor uuid,p_version integer,p_target uuid,p_target_version integer,
  p_enabled boolean,p_grants jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE current_principal jsonb; proposed_grants jsonb;
BEGIN
  PERFORM cc.invitation_actor(p_actor,p_version,'platform-users:manage');
  current_principal:=cc.platform_principal(p_target);
  IF current_principal IS NULL OR p_target_version IS NULL OR
    (current_principal->>'permissionVersion')::integer<>p_target_version OR p_enabled IS NULL THEN
    RAISE EXCEPTION 'The principal changed. Refresh its current access.' USING DETAIL='conflict';
  END IF;
  IF NOT cc.access_grants_allowed(p_actor,p_grants) OR NOT cc.access_grants_allowed(p_actor,current_principal->'grants') THEN
    RAISE EXCEPTION 'The change exceeds current delegation authority.' USING ERRCODE='42501', DETAIL='delegation';
  END IF;
  SELECT COALESCE(jsonb_agg(g ORDER BY g->>'action',g->'scope'),'[]'::jsonb) INTO proposed_grants FROM jsonb_array_elements(p_grants) AS g;
  IF (current_principal->>'enabled')::boolean=p_enabled AND current_principal->'grants'=proposed_grants THEN
    RAISE EXCEPTION 'Select an access change before review.' USING DETAIL='unchanged';
  END IF;
  IF cc.full_platform_administrator(p_target) AND (
    NOT p_enabled OR EXISTS(SELECT 1 FROM cc.application_actions a WHERE NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(proposed_grants) AS g WHERE g->>'action'=a.action AND g->'scope'='{"kind":"platform"}'::jsonb
    ))
  ) AND NOT EXISTS(SELECT 1 FROM cc.application_principals p WHERE p.id<>p_target AND cc.full_platform_administrator(p.id)) THEN
    RAISE EXCEPTION 'Keep one enabled platform administrator.' USING ERRCODE='42501', DETAIL='last-administrator';
  END IF;
  RETURN jsonb_build_object('current',current_principal,'proposed',jsonb_build_object('enabled',p_enabled,'grants',proposed_grants),
    'actorVersion',p_version,'targetVersion',p_target_version);
END;
$$;

CREATE FUNCTION cc.change_platform_access(p_actor uuid,p_version integer,p_target uuid,p_target_version integer,
  p_enabled boolean,p_grants jsonb,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE review jsonb; receipt uuid:=gen_random_uuid(); next_version integer;
BEGIN
  review:=cc.review_platform_access(p_actor,p_version,p_target,p_target_version,p_enabled,p_grants);
  DELETE FROM cc.application_grants WHERE principal_id=p_target;
  INSERT INTO cc.application_grants(principal_id,action,scope)
    SELECT p_target,g->>'action',g->'scope' FROM jsonb_array_elements(review->'proposed'->'grants') AS g;
  UPDATE cc.application_principals SET enabled=p_enabled,permission_version=permission_version+1
    WHERE id=p_target RETURNING permission_version INTO next_version;
  INSERT INTO cc.application_access_changes(id,actor_id,principal_id,correlation_id,previous_version,permission_version,
    previous_enabled,enabled,previous_grants,grants)
    VALUES(receipt,p_actor,p_target,p_correlation,p_target_version,next_version,(review->'current'->>'enabled')::boolean,
      p_enabled,review->'current'->'grants',review->'proposed'->'grants');
  INSERT INTO cc.security_events(id,actor_id,event,correlation_id,target_id,resource_scope)
    VALUES(gen_random_uuid(),p_actor,'grants-changed',p_correlation,p_target,'{"kind":"platform"}');
  IF (review->'current'->>'enabled')::boolean<>p_enabled THEN
    INSERT INTO cc.security_events(id,actor_id,event,correlation_id,target_id,resource_scope)
      VALUES(gen_random_uuid(),p_actor,CASE WHEN p_enabled THEN 'principal-enabled' ELSE 'principal-disabled' END,
        p_correlation,p_target,'{"kind":"platform"}');
  END IF;
  RETURN jsonb_build_object('receiptId',receipt,'correlationId',p_correlation,'principal',cc.platform_principal(p_target));
END;
$$;

REVOKE ALL ON FUNCTION cc.platform_principal(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION cc.full_platform_administrator(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION cc.application_scope_verified(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION cc.access_grants_allowed(uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION cc.list_platform_principals(uuid,integer,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION cc.read_platform_principal(uuid,integer,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION cc.review_platform_access(uuid,integer,uuid,integer,boolean,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION cc.change_platform_access(uuid,integer,uuid,integer,boolean,jsonb,uuid) FROM PUBLIC;

CREATE FUNCTION cc.list_platform_access_receipts(p_actor uuid,p_version integer,p_target uuid,p_offset integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE result jsonb;
BEGIN
  PERFORM cc.invitation_actor(p_actor,p_version,'platform-users:read');
  IF p_offset IS NULL OR p_offset<0 OR p_offset>1000000 THEN
    RAISE EXCEPTION 'The requested page is invalid.';
  END IF;
  SELECT jsonb_build_object('offset',p_offset,
    'total',(SELECT count(*) FROM cc.application_access_changes WHERE principal_id=p_target),
    'items',COALESCE(jsonb_agg(jsonb_build_object(
      'id',r.id,'actorId',r.actor_id,'principalId',r.principal_id,'correlationId',r.correlation_id,
      'createdAt',r.created_at,'previousVersion',r.previous_version,'permissionVersion',r.permission_version,
      'previous',jsonb_build_object('enabled',r.previous_enabled,'grants',r.previous_grants),
      'applied',jsonb_build_object('enabled',r.enabled,'grants',r.grants)
    ) ORDER BY r.permission_version DESC),'[]'::jsonb)) INTO result
    FROM (SELECT * FROM cc.application_access_changes WHERE principal_id=p_target ORDER BY permission_version DESC OFFSET p_offset LIMIT 20) r;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION cc.list_platform_access_receipts(uuid,integer,uuid,integer) FROM PUBLIC;
