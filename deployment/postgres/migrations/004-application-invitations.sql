CREATE TABLE cc.application_invitations (
  id uuid PRIMARY KEY,
  created_by uuid NOT NULL REFERENCES cc.application_principals(id),
  issuer text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 2048),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  expected_subject text CHECK (length(expected_subject) BETWEEN 1 AND 512),
  token_hash text UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  browser_hash text UNIQUE CHECK (browser_hash ~ '^[a-f0-9]{64}$'),
  intended_grants jsonb NOT NULL CHECK (jsonb_typeof(intended_grants) = 'array' AND jsonb_array_length(intended_grants) <= 11),
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','redeeming','pending','accepted','revoked','expired')),
  candidate_subject text CHECK (length(candidate_subject) BETWEEN 1 AND 512),
  candidate_name text CHECK (length(candidate_name) BETWEEN 1 AND 200),
  principal_id uuid REFERENCES cc.application_principals(id),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days'),
  CHECK (status <> 'issued' OR token_hash IS NOT NULL),
  CHECK (status NOT IN ('pending','accepted') OR (candidate_subject IS NOT NULL AND candidate_name IS NOT NULL))
);
CREATE INDEX application_invitations_created ON cc.application_invitations(created_at DESC);
CREATE INDEX application_invitations_expiry ON cc.application_invitations(expires_at) WHERE status IN ('issued','redeeming','pending');

CREATE FUNCTION cc.invitation_actor(p_actor uuid, p_version integer, p_action text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, cc AS $$
DECLARE actor cc.application_principals;
BEGIN
  PERFORM pg_advisory_xact_lock(7240173008);
  SELECT * INTO actor FROM cc.application_principals WHERE id=p_actor FOR UPDATE;
  IF actor.id IS NULL OR p_version IS NULL OR NOT actor.enabled OR actor.permission_version <> p_version OR NOT EXISTS (
    SELECT 1 FROM cc.application_grants WHERE principal_id=p_actor AND action=p_action AND scope='{"kind":"platform"}'::jsonb
  ) THEN RAISE EXCEPTION 'Current platform authority is required.' USING ERRCODE='42501'; END IF;
  RETURN actor.issuer;
END;
$$;

CREATE FUNCTION cc.expire_invitations(p_correlation uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, cc AS $$
DECLARE invitation_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(7240173008);
  FOR invitation_id IN UPDATE cc.application_invitations SET status='expired',token_hash=NULL,version=version+1
    WHERE status IN ('issued','redeeming','pending') AND expires_at <= now() RETURNING id
  LOOP
    INSERT INTO cc.security_events(id,event,correlation_id,target_id,resource_scope)
      VALUES(gen_random_uuid(),'invitation-expired',p_correlation,invitation_id,'{"kind":"platform"}');
  END LOOP;
END;
$$;

CREATE FUNCTION cc.invitation_grants_allowed(p_actor uuid, p_grants jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, cc AS $$
  SELECT jsonb_typeof(p_grants)='array' AND jsonb_array_length(p_grants)<=11 AND
    (SELECT count(DISTINCT g->>'action') FROM jsonb_array_elements(p_grants) AS g)=jsonb_array_length(p_grants) AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_grants) AS g WHERE
      jsonb_typeof(g) <> 'object' OR g - ARRAY['action','scope'] <> '{}'::jsonb OR
      g->'scope' IS DISTINCT FROM '{"kind":"platform"}'::jsonb OR NOT EXISTS (
        SELECT 1 FROM cc.application_grants a
          WHERE a.principal_id=p_actor AND a.action=g->>'action' AND a.scope=g->'scope'
      )
  );
$$;

CREATE FUNCTION cc.create_invitation(p_actor uuid, p_version integer, p_label text, p_subject text,
  p_hash text, p_grants jsonb, p_hours integer, p_correlation uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, cc AS $$
DECLARE invitation_id uuid := gen_random_uuid(); actor_issuer text;
BEGIN
  actor_issuer := cc.invitation_actor(p_actor,p_version,'platform-users:invite');
  PERFORM cc.expire_invitations(p_correlation);
  IF p_hours NOT BETWEEN 1 AND 168 OR p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$' OR
    cc.invitation_grants_allowed(p_actor,p_grants) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'The invitation exceeds its authority.' USING ERRCODE='42501';
  END IF;
  IF (SELECT count(*) FROM cc.application_invitations WHERE created_by=p_actor AND status IN ('issued','redeeming','pending')) >= 50 THEN
    RAISE EXCEPTION 'Revoke an active invitation before creating another.';
  END IF;
  INSERT INTO cc.application_invitations(id,created_by,issuer,label,expected_subject,token_hash,intended_grants,expires_at)
    VALUES(invitation_id,p_actor,actor_issuer,p_label,p_subject,p_hash,p_grants,now()+make_interval(hours=>p_hours));
  INSERT INTO cc.security_events(id,actor_id,event,correlation_id,target_id,resource_scope)
    VALUES(gen_random_uuid(),p_actor,'invitation-created',p_correlation,invitation_id,'{"kind":"platform"}');
  RETURN invitation_id;
END;
$$;

CREATE FUNCTION cc.list_invitations(p_actor uuid,p_version integer,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, cc AS $$
DECLARE result jsonb;
BEGIN
  PERFORM cc.invitation_actor(p_actor,p_version,'platform-users:read');
  PERFORM cc.expire_invitations(p_correlation);
  SELECT COALESCE(jsonb_agg(item ORDER BY created_at DESC),'[]'::jsonb) INTO result FROM (
    SELECT created_at,jsonb_build_object('id',id,'createdBy',created_by,'label',label,'issuer',issuer,
      'expectedSubject',expected_subject,'grants',intended_grants,'status',status,'candidateSubject',candidate_subject,
      'candidateName',candidate_name,'version',version,'expiresAt',expires_at,'createdAt',created_at) AS item
    FROM cc.application_invitations ORDER BY created_at DESC,id DESC LIMIT 200
  ) AS items;
  RETURN result;
END;
$$;

CREATE FUNCTION cc.claim_invitation(p_hash text,p_browser_hash text,p_issuer text,p_correlation uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, cc AS $$
DECLARE invitation_id uuid;
BEGIN
  PERFORM cc.expire_invitations(p_correlation);
  IF p_browser_hash IS NULL OR p_browser_hash !~ '^[a-f0-9]{64}$' THEN RETURN NULL; END IF;
  UPDATE cc.application_invitations SET status='redeeming',token_hash=NULL,browser_hash=p_browser_hash,version=version+1
    WHERE token_hash=p_hash AND status='issued' AND issuer=p_issuer AND expires_at>now()
    RETURNING id INTO invitation_id;
  IF invitation_id IS NOT NULL THEN
    INSERT INTO cc.security_events(id,event,correlation_id,target_id,detail,resource_scope)
      VALUES(gen_random_uuid(),'invitation-redeemed',p_correlation,invitation_id,'sign-in-started','{"kind":"platform"}');
  END IF;
  RETURN invitation_id;
END;
$$;

CREATE FUNCTION cc.verify_invitation(p_id uuid,p_browser_hash text,p_issuer text,p_subject text,p_name text,p_correlation uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, cc AS $$
DECLARE changed uuid;
BEGIN
  PERFORM cc.expire_invitations(p_correlation);
  UPDATE cc.application_invitations SET status='pending',candidate_subject=p_subject,candidate_name=p_name,version=version+1
    WHERE id=p_id AND browser_hash=p_browser_hash AND issuer=p_issuer AND status='redeeming' AND expires_at>now()
      AND (expected_subject IS NULL OR expected_subject=p_subject)
    RETURNING id INTO changed;
  IF changed IS NULL THEN RETURN false; END IF;
  INSERT INTO cc.security_events(id,event,correlation_id,target_id,detail,resource_scope)
    VALUES(gen_random_uuid(),'invitation-redeemed',p_correlation,p_id,'identity-verified','{"kind":"platform"}');
  RETURN true;
END;
$$;

CREATE FUNCTION cc.invitation_browser_status(p_browser_hash text,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, cc AS $$
DECLARE result jsonb;
BEGIN
  PERFORM cc.expire_invitations(p_correlation);
  SELECT jsonb_build_object('status',status,'candidate',CASE WHEN candidate_subject IS NULL THEN NULL ELSE
    jsonb_build_object('issuer',issuer,'subject',candidate_subject,'displayName',candidate_name) END)
    INTO result FROM cc.application_invitations WHERE browser_hash=p_browser_hash;
  RETURN result;
END;
$$;

CREATE FUNCTION cc.confirm_invitation(p_actor uuid,p_version integer,p_id uuid,p_invitation_version integer,p_subject text,p_correlation uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, cc AS $$
DECLARE invitation cc.application_invitations; principal uuid := gen_random_uuid();
BEGIN
  PERFORM cc.invitation_actor(p_actor,p_version,'platform-users:invite');
  PERFORM cc.expire_invitations(p_correlation);
  SELECT * INTO invitation FROM cc.application_invitations WHERE id=p_id FOR UPDATE;
  IF invitation.id IS NULL OR invitation.created_by <> p_actor OR invitation.status <> 'pending' OR
    p_invitation_version IS NULL OR invitation.version <> p_invitation_version OR invitation.candidate_subject IS DISTINCT FROM p_subject OR
    invitation.expires_at<=now() THEN RETURN NULL; END IF;
  IF cc.invitation_grants_allowed(p_actor,invitation.intended_grants) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'The invitation exceeds current authority.' USING ERRCODE='42501';
  END IF;
  IF EXISTS (SELECT 1 FROM cc.application_principals WHERE issuer=invitation.issuer AND subject=invitation.candidate_subject) THEN
    RAISE EXCEPTION 'The identity already has an application record.';
  END IF;
  INSERT INTO cc.application_principals(id,issuer,subject,display_name)
    VALUES(principal,invitation.issuer,invitation.candidate_subject,invitation.candidate_name);
  INSERT INTO cc.application_grants(principal_id,action,scope)
    SELECT DISTINCT principal,g->>'action',g->'scope' FROM jsonb_array_elements(invitation.intended_grants) AS g;
  UPDATE cc.application_invitations SET status='accepted',principal_id=principal,version=version+1 WHERE id=p_id;
  INSERT INTO cc.security_events(id,actor_id,event,correlation_id,target_id,resource_scope)
    VALUES(gen_random_uuid(),p_actor,'invitation-confirmed',p_correlation,p_id,'{"kind":"platform"}');
  INSERT INTO cc.security_events(id,actor_id,event,correlation_id,target_id,resource_scope)
    VALUES(gen_random_uuid(),p_actor,'access-granted',p_correlation,principal,'{"kind":"platform"}');
  RETURN principal;
END;
$$;

CREATE FUNCTION cc.revoke_invitation(p_actor uuid,p_version integer,p_id uuid,p_invitation_version integer,p_correlation uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, cc AS $$
DECLARE changed uuid;
BEGIN
  PERFORM cc.invitation_actor(p_actor,p_version,'platform-users:invite');
  PERFORM cc.expire_invitations(p_correlation);
  UPDATE cc.application_invitations SET status='revoked',token_hash=NULL,version=version+1
    WHERE id=p_id AND version=p_invitation_version AND status IN ('issued','redeeming','pending') RETURNING id INTO changed;
  IF changed IS NULL THEN RETURN false; END IF;
  INSERT INTO cc.security_events(id,actor_id,event,correlation_id,target_id,resource_scope)
    VALUES(gen_random_uuid(),p_actor,'invitation-revoked',p_correlation,p_id,'{"kind":"platform"}');
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION cc.invitation_actor(uuid,integer,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION cc.expire_invitations(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION cc.invitation_grants_allowed(uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION cc.create_invitation(uuid,integer,text,text,text,jsonb,integer,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION cc.list_invitations(uuid,integer,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION cc.claim_invitation(text,text,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION cc.verify_invitation(uuid,text,text,text,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION cc.invitation_browser_status(text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION cc.confirm_invitation(uuid,integer,uuid,integer,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION cc.revoke_invitation(uuid,integer,uuid,integer,uuid) FROM PUBLIC;
