ALTER TABLE cc.application_access_changes ADD COLUMN revoked_invitation_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE FUNCTION cc.revoke_principal_invitations(p_principal uuid,p_actor uuid,p_correlation uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE invitation_id uuid; revoked integer:=0;
BEGIN
  PERFORM pg_advisory_xact_lock(7240173008);
  FOR invitation_id IN UPDATE cc.application_invitations SET status='revoked',token_hash=NULL,version=version+1
    WHERE created_by=p_principal AND status IN ('issued','redeeming','pending') RETURNING id
  LOOP
    INSERT INTO cc.security_events(id,actor_id,event,correlation_id,target_id,resource_scope,detail)
      VALUES(gen_random_uuid(),p_actor,'invitation-revoked',p_correlation,invitation_id,'{"kind":"platform"}','authority-changed');
    revoked:=revoked+1;
  END LOOP;
  RETURN revoked;
END;
$$;
REVOKE ALL ON FUNCTION cc.revoke_principal_invitations(uuid,uuid,uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION cc.review_platform_access(p_actor uuid,p_version integer,p_target uuid,p_target_version integer,
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
    'actorVersion',p_version,'targetVersion',p_target_version,
    'invitationsToRevoke',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'label',label) ORDER BY id) FROM cc.application_invitations WHERE created_by=p_target AND status IN ('issued','redeeming','pending')),'[]'::jsonb));
END;
$$;

DROP FUNCTION cc.change_platform_access(uuid,integer,uuid,integer,boolean,jsonb,uuid);

CREATE FUNCTION cc.change_platform_access(p_actor uuid,p_version integer,p_target uuid,p_target_version integer,
  p_enabled boolean,p_grants jsonb,p_correlation uuid,p_invitation_ids jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE review jsonb; receipt uuid:=gen_random_uuid(); next_version integer; invitation_ids jsonb;
BEGIN
  review:=cc.review_platform_access(p_actor,p_version,p_target,p_target_version,p_enabled,p_grants);
  SELECT COALESCE(jsonb_agg(i->'id' ORDER BY i->>'id'),'[]'::jsonb) INTO invitation_ids FROM jsonb_array_elements(review->'invitationsToRevoke') i;
  IF p_invitation_ids IS DISTINCT FROM invitation_ids THEN
    RAISE EXCEPTION 'The pending invitations changed. Review access again.' USING DETAIL='invitations-changed';
  END IF;
  PERFORM cc.revoke_principal_invitations(p_target,p_actor,p_correlation);
  DELETE FROM cc.application_grants WHERE principal_id=p_target;
  INSERT INTO cc.application_grants(principal_id,action,scope)
    SELECT p_target,g->>'action',g->'scope' FROM jsonb_array_elements(review->'proposed'->'grants') AS g;
  UPDATE cc.application_principals SET enabled=p_enabled,permission_version=permission_version+1
    WHERE id=p_target RETURNING permission_version INTO next_version;
  INSERT INTO cc.application_access_changes(id,actor_id,principal_id,correlation_id,previous_version,permission_version,
    previous_enabled,enabled,previous_grants,grants,revoked_invitation_ids)
    VALUES(receipt,p_actor,p_target,p_correlation,p_target_version,next_version,(review->'current'->>'enabled')::boolean,
      p_enabled,review->'current'->'grants',review->'proposed'->'grants',invitation_ids);
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

REVOKE ALL ON FUNCTION cc.change_platform_access(uuid,integer,uuid,integer,boolean,jsonb,uuid,jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION cc.list_platform_access_receipts(p_actor uuid,p_version integer,p_target uuid,p_offset integer) RETURNS jsonb
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
      'createdAt',r.created_at,'revokedInvitationIds',r.revoked_invitation_ids,'previousVersion',r.previous_version,'permissionVersion',r.permission_version,
      'previous',jsonb_build_object('enabled',r.previous_enabled,'grants',r.previous_grants),
      'applied',jsonb_build_object('enabled',r.enabled,'grants',r.grants)
    ) ORDER BY r.permission_version DESC),'[]'::jsonb)) INTO result
    FROM (SELECT * FROM cc.application_access_changes WHERE principal_id=p_target ORDER BY permission_version DESC OFFSET p_offset LIMIT 20) r;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION cc.list_platform_access_receipts(uuid,integer,uuid,integer) FROM PUBLIC;
